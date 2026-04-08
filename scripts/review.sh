#!/usr/bin/env bash
# review.sh - Loads rules, assembles prompt, calls Gemini, parses response
# Reads context files from $WORK_DIR/ (produced by gather-context.sh)
# Outputs $WORK_DIR/review.json

# shellcheck source=/dev/null
source "$(dirname "$0")/lib.sh"

# ── Functions ─────────────────────────────────────────────

load_rules() {
  log_group "Loading coding standards"

  local rules=""
  local found=false

  IFS=',' read -ra paths <<< "$RULES_PATHS"
  for path in "${paths[@]}"; do
    path=$(echo "$path" | xargs) # trim whitespace
    validate_path "$path" || continue
    if [[ -d "$path" ]]; then
      for f in "$path"/*.md "$path"/*.txt; do
        if [[ -f "$f" ]]; then
          log_info "Found rules: ${f}"
          rules+=$'\n\n'"--- Rules from ${f} ---"$'\n'
          rules+="$(cat "$f")"
          found=true
        fi
      done
    elif [[ -f "$path" ]]; then
      log_info "Found rules: ${path}"
      rules+=$'\n\n'"--- Rules from ${path} ---"$'\n'
      rules+="$(cat "$path")"
      found=true
    fi
  done

  echo "$rules" > "$WORK_DIR/rules_content.txt"

  if [[ "$found" == "false" ]]; then
    log_warning "No coding standards files found. Review will suggest creating them."
    echo "true" > "$WORK_DIR/no_rules.txt"
  else
    echo "false" > "$WORK_DIR/no_rules.txt"
  fi

  log_endgroup
}

# ── Assemble prompt and build API request ──────────────────
build_request() {
  log_group "Assembling prompt"

  local no_rules_section=""
  if [[ "$(cat "$WORK_DIR/no_rules.txt")" == "true" ]]; then
    local tech_stack
    tech_stack=$(safe_read "$WORK_DIR/tech_stack.txt")
    no_rules_section="**IMPORTANT:** No coding standards files were found in this repository. In your review, include a missing_guardrails section recommending which standards files to create for this ${tech_stack} project, with starter content for each."
  fi

  # Strip $schema (not accepted by Gemini). Keep title and description: Gemini uses them for steering.
  local review_schema
  review_schema=$(jq 'del(."$schema")' "$ACTION_PATH/schemas/review-output.json")

  # Use jq with --rawfile for safe variable injection (no shell interpolation issues)
  # jq's gsub does literal string replacement, safe for any content
  jq -n \
    --rawfile template    "$ACTION_PATH/prompts/code-review.md" \
    --rawfile tech_stack  "$WORK_DIR/tech_stack.txt" \
    --rawfile tree        "$WORK_DIR/project_tree.txt" \
    --rawfile rules       "$WORK_DIR/rules_content.txt" \
    --rawfile changed     "$WORK_DIR/changed_files_content.txt" \
    --rawfile related     "$WORK_DIR/related_files_content.txt" \
    --rawfile pr_title    "$WORK_DIR/pr_title.txt" \
    --rawfile pr_body     "$WORK_DIR/pr_body.txt" \
    --rawfile pr_author   "$WORK_DIR/pr_author.txt" \
    --rawfile diff        "$WORK_DIR/diff.txt" \
    --rawfile ctx_notes   "$WORK_DIR/context_notes.txt" \
    --arg no_rules        "$no_rules_section" \
    --argjson schema      "$review_schema" \
    '
      # Strip the template header (everything before <!-- END HEADER --> delimiter)
      ($template | split("<!-- END HEADER -->") | .[1:] | join("")) as $tmpl |

      # Replace all template variables safely
      ($tmpl
        | gsub("{{tech_stack}}";       $tech_stack       | rtrimstr("\n"))
        | gsub("{{project_tree}}";     $tree             | rtrimstr("\n"))
        | gsub("{{rules_content}}";    $rules            | rtrimstr("\n"))
        | gsub("{{no_rules_section}}"; $no_rules)
        | gsub("{{changed_files}}";    $changed          | rtrimstr("\n"))
        | gsub("{{related_files}}";    $related          | rtrimstr("\n"))
        | gsub("{{pr_title}}";        $pr_title          | rtrimstr("\n"))
        | gsub("{{pr_body}}";         $pr_body           | rtrimstr("\n"))
        | gsub("{{pr_author}}";       $pr_author         | rtrimstr("\n"))
        | gsub("{{diff}}";            $diff              | rtrimstr("\n"))
        | gsub("{{context_notes}}";   $ctx_notes         | rtrimstr("\n"))
      ) as $prompt |

      {
        contents: [{parts: [{text: $prompt}]}],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: $schema,
          temperature: 0.2,
          maxOutputTokens: 16384
        },
        safetySettings: [
          {category: "HARM_CATEGORY_HATE_SPEECH",          threshold: "BLOCK_ONLY_HIGH"},
          {category: "HARM_CATEGORY_DANGEROUS_CONTENT",    threshold: "BLOCK_ONLY_HIGH"},
          {category: "HARM_CATEGORY_HARASSMENT",           threshold: "BLOCK_ONLY_HIGH"},
          {category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",    threshold: "BLOCK_ONLY_HIGH"}
        ]
      }
    ' > "$WORK_DIR/request.json"

  local prompt_size
  prompt_size=$(jq -r '.contents[0].parts[0].text | length' "$WORK_DIR/request.json")
  log_info "Prompt assembled: ~${prompt_size} characters"
  log_endgroup
}

# ── Call Gemini API ────────────────────────────────────────
call_gemini() {
  log_group "Calling Gemini API (${MODEL})"

  local http_code
  http_code=$(curl -s -o "$WORK_DIR/response.json" -w "%{http_code}" \
    --max-time 120 \
    -X POST "$API_URL" \
    -H "x-goog-api-key: ${GEMINI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @"$WORK_DIR/request.json")

  if [[ "$http_code" -ne 200 ]]; then
    local error_status error_msg
    error_status=$(jq -r '.error.status // "UNKNOWN"' "$WORK_DIR/response.json")
    error_msg=$(jq -r '.error.message // "No error message"' "$WORK_DIR/response.json")
    log_error "Gemini API returned ${http_code}: ${error_status} - ${error_msg}"

    # Retry on transient errors
    if [[ "$http_code" -eq 429 || "$http_code" -eq 500 || "$http_code" -eq 503 ]]; then
      return 1
    fi
    exit 1
  fi

  # Check finish reason
  local finish_reason
  finish_reason=$(jq -r '.candidates[0].finishReason // "UNKNOWN"' "$WORK_DIR/response.json")

  if [[ "$finish_reason" == "SAFETY" || "$finish_reason" == "RECITATION" || "$finish_reason" == "OTHER" ]]; then
    log_warning "Review blocked or stopped early (reason: ${finish_reason}). Posting fallback comment."
    jq -n --arg reason "$finish_reason" \
      '{"summary": ("AI review was blocked (reason: " + $reason + "). Manual review required."), "verdict": "comment", "findings": []}' \
      > "$WORK_DIR/review.json"
    log_endgroup
    return 0
  fi

  if [[ "$finish_reason" == "MAX_TOKENS" ]]; then
    log_warning "Review output was truncated (hit token limit). Results may be incomplete."
  fi

  # Extract the review JSON from the response
  local review_text
  review_text=$(jq -r '.candidates[0].content.parts[0].text // empty' "$WORK_DIR/response.json")

  if [[ -z "$review_text" ]]; then
    log_error "Gemini returned empty response. Finish reason: ${finish_reason}"
    exit 1
  fi

  # Validate it parses as JSON
  if ! echo "$review_text" | jq . > "$WORK_DIR/review.json" 2>/dev/null; then
    log_error "Gemini response is not valid JSON"
    log_debug "$review_text"
    exit 1
  fi

  # Log token usage and cost estimate
  # Gemini 2.5 Flash Standard tier: $0.30/M input, $2.50/M output
  # thoughtsTokenCount (thinking tokens) are billed at the output rate and must be added separately
  local prompt_tokens output_tokens thinking_tokens
  prompt_tokens=$(jq '.usageMetadata.promptTokenCount // 0' "$WORK_DIR/response.json")
  output_tokens=$(jq '.usageMetadata.candidatesTokenCount // 0' "$WORK_DIR/response.json")
  thinking_tokens=$(jq '.usageMetadata.thoughtsTokenCount // 0' "$WORK_DIR/response.json")
  local cost
  cost=$(echo "scale=4; ($prompt_tokens * 0.30 + ($output_tokens + $thinking_tokens) * 2.50) / 1000000" | bc)

  log_info "Tokens: ${prompt_tokens} input, ${output_tokens} output, ${thinking_tokens} thinking. Estimated cost: \$${cost}"

  # Write cost info for step summary
  {
    echo "prompt_tokens=${prompt_tokens}"
    echo "output_tokens=${output_tokens}"
    echo "thinking_tokens=${thinking_tokens}"
    echo "estimated_cost=${cost}"
    echo "model=${MODEL}"
    echo "finish_reason=${finish_reason}"
  } > "$WORK_DIR/usage.txt"

  log_endgroup
}

# ── Main ───────────────────────────────────────────────────

main() {
  # ── Required inputs ────────────────────────────────────────
  GEMINI_API_KEY="${GEMINI_API_KEY:?Missing GEMINI_API_KEY}"
  MODEL="${MODEL:-gemini-2.5-flash}"
  RULES_PATHS="${RULES_PATHS:-review-rules.md,CLAUDE.md,AGENTS.md,GEMINI.md,vibe-coding-rules/,.cursor/rules/}"
  ACTION_PATH="${ACTION_PATH:?Missing ACTION_PATH}"

  # Validate model name to prevent URL path injection
  if [[ ! "$MODEL" =~ ^gemini-[a-zA-Z0-9._-]+$ ]]; then
    log_error "Invalid model name: '${MODEL}'. Must match gemini-[alphanumeric/._-]"
    exit 1
  fi

  API_URL="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent"

  load_rules
  build_request

  # Call with retry (3 attempts, 5s base delay for exponential backoff)
  if ! retry 3 5 call_gemini; then
    log_error "Gemini API failed after retries. Posting fallback comment."
    jq -n '{"summary": "AI review is temporarily unavailable (API error). Manual review required.", "verdict": "comment", "findings": []}' \
      > "$WORK_DIR/review.json"
  fi

  # Log summary
  local verdict
  verdict=$(jq -r '.verdict' "$WORK_DIR/review.json")
  local finding_count
  finding_count=$(jq '.findings | length' "$WORK_DIR/review.json")
  log_info "Review complete: verdict=${verdict}, findings=${finding_count}"
}

main "$@"
