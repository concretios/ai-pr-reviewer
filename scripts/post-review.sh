#!/usr/bin/env bash
# Copyright 2026 Concret.io
# Licensed under the Apache License, Version 2.0
# https://www.apache.org/licenses/LICENSE-2.0
#
# post-review.sh - Posts review results to the PR
# Reads $WORK_DIR/review.json and $WORK_DIR/diff.txt
# Posts: summary comment (update-in-place) + inline review comments

# shellcheck source=/dev/null
source "$(dirname "$0")/lib.sh"

# ── Functions ─────────────────────────────────────────────

# ── Severity ranking (lower = more severe) ─────────────────
severity_rank() {
  case "$1" in
    critical) echo 0 ;;
    high)     echo 1 ;;
    medium)   echo 2 ;;
    low)      echo 3 ;;
    *)        echo 4 ;;
  esac
}

# ── Build valid-lines manifest from diff ───────────────────
# Parses diff hunks to build a list of (file, line) tuples that are
# valid targets for inline review comments.
# GitHub rejects the ENTIRE review if one comment targets an invalid line.
build_valid_lines() {
  log_group "Building valid-lines manifest from diff"

  awk '
    /^diff --git/ {
      n = split($0, parts, " ")
      file = parts[n]
      sub(/^b\//, "", file)
      new_line = 0
      next
    }
    /^--- / || /^\+\+\+ / || /^index / { next }
    /^@@/ {
      # Parse +NN,LL from @@ header
      for (i = 1; i <= NF; i++) {
        if (substr($i, 1, 1) == "+") {
          split($i, arr, ",")
          sub(/^\+/, "", arr[1])
          new_line = arr[1] + 0
          break
        }
      }
      # The @@ line itself is not commentable, but the lines after it are
      next
    }
    new_line > 0 && /^\+/ {
      # Added line: valid on RIGHT side
      print file "\t" new_line
      new_line++
      next
    }
    new_line > 0 && /^-/ {
      # Deleted line: does not increment new-file line counter
      next
    }
    new_line > 0 && /^ / {
      # Context line: valid on RIGHT side
      print file "\t" new_line
      new_line++
      next
    }
  ' "$DIFF_FILE" | sort -u > "$WORK_DIR/valid_lines.tsv"

  local count
  count=$(wc -l < "$WORK_DIR/valid_lines.tsv" | tr -d ' ')
  log_info "Valid comment targets: ${count} lines across $(cut -f1 "$WORK_DIR/valid_lines.tsv" | sort -u | wc -l | tr -d ' ') files"
  log_endgroup
}

# ── Format summary comment ─────────────────────────────────
format_summary() {
  log_group "Formatting summary comment"

  local summary verdict finding_count
  summary=$(jq -r '.summary' "$REVIEW_FILE")
  verdict=$(jq -r '.verdict' "$REVIEW_FILE")
  finding_count=$(jq '.findings | length' "$REVIEW_FILE")

  # Verdict badge
  local verdict_icon
  case "$verdict" in
    approve)          verdict_icon="🟢 Approved" ;;
    request_changes)  verdict_icon="🔴 Changes Requested" ;;
    *)                verdict_icon="💬 Reviewed" ;;
  esac

  # Start building the comment body
  local body="${MARKER}
## 🩺 Dr. Concret.io — ${verdict_icon}

${summary}
"

  # Highlights section
  local highlights
  highlights=$(jq -r '.highlights // [] | .[]' "$REVIEW_FILE" 2>/dev/null)
  if [[ -n "$highlights" ]]; then
    body+="
### Highlights
$(printf '%s\n' "$highlights" | while IFS= read -r h; do echo "- $h"; done)
"
  fi

  # Findings summary table
  if [[ "$finding_count" -gt 0 ]]; then
    local critical high medium low
    critical=$(jq '[.findings[] | select(.severity == "critical")] | length' "$REVIEW_FILE")
    high=$(jq '[.findings[] | select(.severity == "high")] | length' "$REVIEW_FILE")
    medium=$(jq '[.findings[] | select(.severity == "medium")] | length' "$REVIEW_FILE")
    low=$(jq '[.findings[] | select(.severity == "low")] | length' "$REVIEW_FILE")

    body+="
### Findings (${finding_count})

| Severity | Count |
|----------|-------|"

    [[ "$critical" -gt 0 ]] && body+="
| Critical | ${critical} |"
    [[ "$high" -gt 0 ]] && body+="
| High | ${high} |"
    [[ "$medium" -gt 0 ]] && body+="
| Medium | ${medium} |"
    [[ "$low" -gt 0 ]] && body+="
| Low | ${low} |"

    body+="
"

    # If inline comments are disabled, list findings in the summary
    if [[ "$POST_INLINE" != "true" ]]; then
      body+="
<details>
<summary>Details</summary>

"
      body+="$(jq -r '.findings[] | "**[\(.severity | ascii_upcase)] \(.category)** \(.file):\(.line) - \(.title)**\n\(.comment)\n"' "$REVIEW_FILE")"
      body+="
</details>
"
    fi
  else
    body+="
No issues found.
"
  fi

  # Missing guardrails section
  local guardrails_count
  guardrails_count=$(jq '.missing_guardrails // [] | length' "$REVIEW_FILE")
  if [[ "$guardrails_count" -gt 0 ]]; then
    body+="
### Missing Coding Standards

This repository has no coding standards files. Consider creating:

$(jq -r '.missing_guardrails[] | "- **\(.file)**: \(.reason)"' "$REVIEW_FILE")
"
  fi

  # Usage footer
  local usage_info=""
  if [[ -f "$WORK_DIR/usage.txt" ]]; then
    local model prompt_tokens output_tokens cost
    model=$(grep '^model=' "$WORK_DIR/usage.txt" | cut -d= -f2)
    prompt_tokens=$(grep '^prompt_tokens=' "$WORK_DIR/usage.txt" | cut -d= -f2)
    output_tokens=$(grep '^output_tokens=' "$WORK_DIR/usage.txt" | cut -d= -f2)
    cost=$(grep '^estimated_cost=' "$WORK_DIR/usage.txt" | cut -d= -f2)
    usage_info="
---
<sub>🩺 Dr. Concret.io · Model: ${model} · Tokens: ${prompt_tokens} in, ${output_tokens} out · Cost: ~\$${cost}</sub>"
  fi

  body+="${usage_info}"

  echo "$body" > "$WORK_DIR/summary_comment.md"
  log_endgroup
}

# ── Post or update summary comment ─────────────────────────
post_summary() {
  log_group "Posting summary comment"

  # Find existing bot comment by marker, update by ID if found.
  # --paginate outputs one JSON array per page; jq -s slurps all pages into one array-of-arrays,
  # then [.[][]] flattens them so the filter works across all pages correctly.
  local comment_id
  comment_id=$(gh api "repos/{owner}/{repo}/issues/${PR_NUMBER}/comments" \
    --paginate 2>/dev/null \
    | jq -s "[.[][] | select(.body | contains(\"$MARKER\"))] | last | .id")

  if [[ -n "$comment_id" && "$comment_id" != "null" ]]; then
    gh api "repos/{owner}/{repo}/issues/comments/${comment_id}" \
      --method PATCH -F body=@"$WORK_DIR/summary_comment.md"
    log_info "Updated existing review comment (ID: ${comment_id})"
  else
    gh pr comment "$PR_NUMBER" --body-file "$WORK_DIR/summary_comment.md"
    log_info "Created new review comment"
  fi

  log_endgroup
}

# ── Post inline review comments ────────────────────────────
post_inline_comments() {
  [[ "$POST_INLINE" == "true" ]] || return 0

  local finding_count
  finding_count=$(jq '.findings | length' "$REVIEW_FILE")
  # Return early only if there are no findings AND no verdict to submit.
  # SUBMIT_REVIEW_VERDICT=true requires reaching the review API even on clean PRs.
  [[ "$finding_count" -gt 0 || "${SUBMIT_REVIEW_VERDICT:-false}" == "true" ]] || return 0

  log_group "Posting inline review comments"

  local threshold_rank
  threshold_rank=$(severity_rank "$SEVERITY_THRESHOLD")

  # Filter findings: must meet severity threshold and have valid diff lines
  local valid_comments skipped=0 posted=0
  valid_comments=$(jq -c --arg threshold "$threshold_rank" '
    def sev_rank:
      if . == "critical" then 0
      elif . == "high" then 1
      elif . == "medium" then 2
      elif . == "low" then 3
      else 4 end;

    [.findings[]
      | select((.severity | sev_rank) <= ($threshold | tonumber))
      | select(.line > 0)
      | {
          path: .file,
          line: .line,
          side: "RIGHT",
          body: (
            "**🩺 [\(.severity | ascii_upcase)] \(.category):** \(.title)\n\n\(.comment)" +
            (if .suggestion and .suggestion != "" then "\n\n**Suggestion:**\n```suggestion\n\(.suggestion)\n```" else "" end)
          )
        }
    ]
  ' "$REVIEW_FILE")

  # Validate each comment against the valid-lines manifest
  local validated_comments="[]"
  while IFS= read -r comment; do
    [[ -z "$comment" ]] && continue
    local file line
    file=$(echo "$comment" | jq -r '.path')
    line=$(echo "$comment" | jq -r '.line')

    if grep -q "^${file}"$'\t'"${line}$" "$WORK_DIR/valid_lines.tsv" 2>/dev/null; then
      validated_comments=$(echo "$validated_comments" | jq --argjson c "$comment" '. + [$c]')
      posted=$(( posted + 1 ))
    else
      local title
      title=$(echo "$comment" | jq -r '.body' | head -1)
      log_warning "Skipping inline comment: ${file}:${line} not in diff (${title})"
      skipped=$(( skipped + 1 ))
    fi
  done < <(echo "$valid_comments" | jq -c '.[]')

  local validated_count
  validated_count=$(echo "$validated_comments" | jq 'length')

  # Map AI verdict to GitHub review event (only when SUBMIT_REVIEW_VERDICT is true)
  local review_event="COMMENT"
  if [[ "${SUBMIT_REVIEW_VERDICT:-false}" == "true" ]]; then
    local ai_verdict
    ai_verdict=$(jq -r '.verdict' "$REVIEW_FILE")
    case "$ai_verdict" in
      approve)          review_event="APPROVE" ;;
      request_changes)  review_event="REQUEST_CHANGES" ;;
      *)                review_event="COMMENT" ;;
    esac
  fi

  # Post the review if there are inline comments OR if we need to submit a non-COMMENT verdict.
  # APPROVE with zero inline comments must still fire the review API — otherwise the verdict is lost.
  if [[ "$validated_count" -gt 0 || "$review_event" != "COMMENT" ]]; then
    local commit_sha
    commit_sha=$(safe_read "$WORK_DIR/commit_sha.txt")

    local review_body="AI review: see individual comments below."
    if [[ "$validated_count" -eq 0 ]]; then
      review_body="AI review complete. See summary comment for details."
    fi

    jq -n \
      --arg body "$review_body" \
      --arg event "$review_event" \
      --arg commit_id "$commit_sha" \
      --argjson comments "$validated_comments" \
      '{
        body: $body,
        event: $event,
        commit_id: $commit_id,
        comments: $comments
      }' > "$WORK_DIR/review_payload.json"

    if ! gh api "repos/{owner}/{repo}/pulls/${PR_NUMBER}/reviews" \
         --method POST \
         --input "$WORK_DIR/review_payload.json" > "$WORK_DIR/review_api_out.json" 2>"$WORK_DIR/review_api_error.txt"; then
      log_warning "Failed to post inline review: $(cat "$WORK_DIR/review_api_error.txt")"
      # The summary comment is already posted, so this is not a fatal error
    fi
  fi

  log_info "Inline comments: ${posted} posted, ${skipped} skipped (not in diff)"
  log_endgroup
}

# ── Write step summary ─────────────────────────────────────
write_step_summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### 🩺 Dr. Concret.io: Review Results"
      echo ""
      echo "| Metric | Value |"
      echo "|--------|-------|"
      echo "| Verdict | $(jq -r '.verdict' "$REVIEW_FILE") |"
      echo "| Findings | $(jq '.findings | length' "$REVIEW_FILE") |"
      if [[ -f "$WORK_DIR/usage.txt" ]]; then
        echo "| Model | $(grep '^model=' "$WORK_DIR/usage.txt" | cut -d= -f2) |"
        echo "| Cost | ~\$$(grep '^estimated_cost=' "$WORK_DIR/usage.txt" | cut -d= -f2) |"
      fi
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

# ── Main ───────────────────────────────────────────────────

main() {
  # ── Required inputs ────────────────────────────────────────
  PR_NUMBER="${PR_NUMBER:?Missing PR_NUMBER}"
  POST_INLINE="${POST_INLINE:-true}"
  SEVERITY_THRESHOLD="${SEVERITY_THRESHOLD:-low}"
  BOT_NAME="${BOT_NAME:-dr-concretio}"
  # Sanitize BOT_NAME: only allow alphanumeric, hyphens, underscores.
  # Unsanitized values containing --> would break the HTML comment marker used for dedup.
  BOT_NAME="${BOT_NAME//[^a-zA-Z0-9_-]/}"
  SUBMIT_REVIEW_VERDICT="${SUBMIT_REVIEW_VERDICT:-false}"

  REVIEW_FILE="$WORK_DIR/review.json"
  DIFF_FILE="$WORK_DIR/diff.txt"
  MARKER="<!-- concretio-ai-reviewer:${BOT_NAME} -->"

  build_valid_lines
  format_summary
  post_summary
  post_inline_comments
  write_step_summary

  log_info "Review posted successfully"
}

main "$@"
