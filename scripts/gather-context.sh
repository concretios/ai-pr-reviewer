#!/usr/bin/env bash
# Copyright 2026 Concret.io
# Licensed under the Apache License, Version 2.0
# https://www.apache.org/licenses/LICENSE-2.0
#
# gather-context.sh - Collects PR context for AI review
# Outputs files to $WORK_DIR/ for consumption by review.sh

# shellcheck source=/dev/null
source "$(dirname "$0")/lib.sh"

# ── Functions ──────────────────────────────────────────────

find_related_files() {
  local related_tmp="$WORK_DIR/related_files_raw.txt"
  : > "$related_tmp"

  while IFS= read -r file; do
    [[ -f "$file" ]] || continue
    case "$file" in
      *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
        # Match: import ... from './path'  |  require('./path')
        # grep returns exit 1 when no matches — || true prevents pipefail from
        # killing the outer loop when a file has no import statements.
        grep -oE "(from|require\()\s*['\"][^'\"]+['\"]" "$file" 2>/dev/null \
          | grep -oE "['\"][^'\"]+['\"]" \
          | tr -d "'" | tr -d '"' \
          | (while IFS= read -r imp; do
              [[ "$imp" == ./* || "$imp" == ../* ]] || continue
              local dir
              dir=$(dirname "$file")
              for ext in "" ".ts" ".tsx" ".js" ".jsx" "/index.ts" "/index.tsx" "/index.js"; do
                local candidate="${dir}/${imp}${ext}"
                if [[ -f "$candidate" ]]; then
                  echo "$candidate" >> "$related_tmp"
                  break
                fi
              done
            done; true)
        ;;
      *.py)
        # Match: from module import ... | import module
        # grep returns exit 1 when no matches — || true prevents pipefail kill.
        grep -oE "^(from|import)\s+[a-zA-Z_][a-zA-Z0-9_.]*" "$file" 2>/dev/null \
          | awk '{print $2}' \
          | tr '.' '/' \
          | (while IFS= read -r mod; do
              for ext in ".py" "/__init__.py"; do
                if [[ -f "${mod}${ext}" ]]; then
                  echo "${mod}${ext}" >> "$related_tmp"
                fi
              done
            done; true)
        ;;
      *.go)
        # For Go: include other files in the same package directory
        local dir
        dir=$(dirname "$file")
        find "$dir" -maxdepth 1 -name '*.go' -not -name "$(basename "$file")" >> "$related_tmp" 2>/dev/null
        ;;
    esac
  done < "$WORK_DIR/changed_files.txt"

  # Deduplicate and exclude already-changed files.
  # Two pipefail hazards handled here:
  #   1. sort -u on an empty file exits 0 but produces no output — safe.
  #   2. The while subshell's exit code is that of the last `grep -qxF` call.
  #      When grep finds a match (file IS in changed_files) it exits 0 (skip);
  #      when it finds no match it exits 1 (emit the file). With pipefail the
  #      pipeline would be killed the moment any file is NOT a duplicate.
  #      Wrapping in a subshell that always exits 0 via `; true` is safe because
  #      we don't need the pipeline's exit code — the output file is what matters.
  # If related_tmp is empty, produce an empty related_files.txt (not missing).
  if [[ ! -s "$related_tmp" ]]; then
    : > "$WORK_DIR/related_files.txt"
  else
    sort -u "$related_tmp" \
      | (while IFS= read -r rf; do
          if ! grep -qxF "$rf" "$WORK_DIR/changed_files.txt" 2>/dev/null; then
            echo "$rf"
          fi
        done; true) > "$WORK_DIR/related_files.txt"
  fi

  # Read related file contents
  local count=0
  {
    while IFS= read -r file; do
      if [[ -f "$file" ]]; then
        echo "=== FILE: ${file} ==="
        cat "$file"
        echo ""
        count=$(( count + 1 ))
      fi
    done < "$WORK_DIR/related_files.txt"
  } > "$WORK_DIR/related_files_content.txt"

  log_info "Found ${count} related files"
}

detect_tech_stack() {
  local stack=()

  [[ -f "package.json" ]]    && stack+=("Node.js")
  [[ -f "tsconfig.json" ]]   && stack+=("TypeScript")
  [[ -f "requirements.txt" || -f "pyproject.toml" || -f "setup.py" || -f "Pipfile" ]] && stack+=("Python")
  [[ -f "go.mod" ]]          && stack+=("Go")
  [[ -f "Cargo.toml" ]]      && stack+=("Rust")
  [[ -f "Gemfile" ]]         && stack+=("Ruby")
  [[ -f "composer.json" ]]   && stack+=("PHP")
  [[ -f "pom.xml" || -f "build.gradle" || -f "build.gradle.kts" ]] && stack+=("Java/Kotlin")

  # Framework detection from package.json
  if [[ -f "package.json" ]]; then
    local pkg
    pkg=$(cat package.json)
    echo "$pkg" | jq -e '.dependencies.react // .devDependencies.react' &>/dev/null && stack+=("React")
    echo "$pkg" | jq -e '.dependencies.next // .devDependencies.next' &>/dev/null && stack+=("Next.js")
    echo "$pkg" | jq -e '.dependencies.vue // .devDependencies.vue' &>/dev/null && stack+=("Vue")
    echo "$pkg" | jq -e '.dependencies.express // .devDependencies.express' &>/dev/null && stack+=("Express")
    echo "$pkg" | jq -e '.dependencies["@angular/core"] // .devDependencies["@angular/core"]' &>/dev/null && stack+=("Angular")
  fi

  # Framework detection from Python
  if [[ -f "requirements.txt" ]]; then
    grep -qi "django"  "requirements.txt" 2>/dev/null && stack+=("Django")
    grep -qi "flask"   "requirements.txt" 2>/dev/null && stack+=("Flask")
    grep -qi "fastapi" "requirements.txt" 2>/dev/null && stack+=("FastAPI")
  fi

  if [[ ${#stack[@]} -eq 0 ]]; then
    echo "Unknown"
  else
    local IFS=", "
    echo "${stack[*]}"
  fi
}

generate_tree() {
  find . -type f \
    -not -path './.git/*' \
    -not -path './node_modules/*' \
    -not -path './__pycache__/*' \
    -not -path './vendor/*' \
    -not -path './.next/*' \
    -not -path './dist/*' \
    -not -path './build/*' \
    -not -path './.venv/*' \
    -not -path './venv/*' \
    -not -path './.env/*' \
    -not -path './.terraform/*' \
    -not -name '*.pyc' \
    -not -name '.DS_Store' \
    | sort \
    | head -200
}

# ── Main ──────────────────────────────────────────────────

main() {
  # ── Required inputs ────────────────────────────────────────
  PR_NUMBER="${PR_NUMBER:?Missing PR_NUMBER}"
  CONTEXT_DEPTH="${CONTEXT_DEPTH:-changed-files}"
  MAX_FILES="${MAX_FILES:-20}"
  MAX_DIFF_SIZE="${MAX_DIFF_SIZE:-10000}"

  validate_enum "context_depth" "$CONTEXT_DEPTH" "diff-only" "changed-files" "related"

  # ── PR metadata ────────────────────────────────────────────
  log_group "Gathering PR metadata"

  local pr_json
  pr_json=$(gh pr view "$PR_NUMBER" --json title,body,author,headRefOid)
  echo "$pr_json" | jq -r '.title'         > "$WORK_DIR/pr_title.txt"
  echo "$pr_json" | jq -r '.body // ""'    > "$WORK_DIR/pr_body.txt"
  echo "$pr_json" | jq -r '.author.login'  > "$WORK_DIR/pr_author.txt"
  echo "$pr_json" | jq -r '.headRefOid'    > "$WORK_DIR/commit_sha.txt"

  log_info "PR #${PR_NUMBER}: $(cat "$WORK_DIR/pr_title.txt") by $(cat "$WORK_DIR/pr_author.txt")"
  log_endgroup

  # ── Diff ───────────────────────────────────────────────────
  log_group "Getting diff"

  gh pr diff "$PR_NUMBER" > "$WORK_DIR/diff.txt"
  local diff_lines
  diff_lines=$(wc -l < "$WORK_DIR/diff.txt" | tr -d ' ')

  local context_notes=""

  if [[ "$diff_lines" -gt "$MAX_DIFF_SIZE" ]]; then
    log_warning "Diff is ${diff_lines} lines (limit: ${MAX_DIFF_SIZE}). Large PR, review may be less precise."
    context_notes+="NOTE: This PR has a large diff (${diff_lines} lines). Focus your review on the highest-risk changes."$'\n'
  fi

  log_info "Diff: ${diff_lines} lines"
  log_endgroup

  # ── Changed files list ─────────────────────────────────────
  log_group "Identifying changed files"

  gh pr diff "$PR_NUMBER" --name-only > "$WORK_DIR/changed_files.txt"
  local file_count
  file_count=$(wc -l < "$WORK_DIR/changed_files.txt" | tr -d ' ')

  if [[ "$file_count" -gt "$MAX_FILES" ]]; then
    log_warning "PR touches ${file_count} files (limit: ${MAX_FILES}). Reviewing first ${MAX_FILES} only."
    head -n "$MAX_FILES" "$WORK_DIR/changed_files.txt" > "$WORK_DIR/changed_files_trimmed.txt"
    mv "$WORK_DIR/changed_files_trimmed.txt" "$WORK_DIR/changed_files.txt"
    context_notes+="NOTE: This PR touches ${file_count} files. Only the first ${MAX_FILES} are included for review."$'\n'
  fi

  log_info "Changed files: ${file_count}"
  log_endgroup

  # ── Changed file contents ──────────────────────────────────
  if [[ "$CONTEXT_DEPTH" != "diff-only" ]]; then
    log_group "Reading changed file contents"
    {
      while IFS= read -r file; do
        if [[ -f "$file" ]]; then
          echo "=== FILE: ${file} ==="
          cat "$file"
          echo ""
        else
          echo "=== FILE: ${file} (deleted) ==="
          echo ""
        fi
      done < "$WORK_DIR/changed_files.txt"
    } > "$WORK_DIR/changed_files_content.txt"
    log_info "Read contents of $(wc -l < "$WORK_DIR/changed_files.txt" | tr -d ' ') files"
    log_endgroup
  else
    echo "" > "$WORK_DIR/changed_files_content.txt"
  fi

  # ── Related files (import graph) ───────────────────────────
  if [[ "$CONTEXT_DEPTH" == "related" ]]; then
    log_group "Finding related files"
    find_related_files
    log_endgroup
  else
    echo "" > "$WORK_DIR/related_files_content.txt"
  fi

  # ── Tech stack detection ───────────────────────────────────
  log_group "Detecting tech stack"
  detect_tech_stack > "$WORK_DIR/tech_stack.txt"
  log_info "Tech stack: $(cat "$WORK_DIR/tech_stack.txt")"
  log_endgroup

  # ── Project tree ───────────────────────────────────────────
  log_group "Generating project tree"
  generate_tree > "$WORK_DIR/project_tree.txt"
  log_endgroup

  # ── Write context notes ───────────────────────────────────
  printf '%s' "$context_notes" > "$WORK_DIR/context_notes.txt"

  log_info "Context gathering complete. Depth: ${CONTEXT_DEPTH}"
}

main "$@"
