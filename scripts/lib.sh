#!/usr/bin/env bash
# Copyright 2026 Concret.io
# Licensed under the Apache License, Version 2.0
# https://www.apache.org/licenses/LICENSE-2.0
#
# lib.sh - Shared utilities for ai-pr-reviewer scripts
# Source this file: source "$(dirname "$0")/lib.sh"

set -euo pipefail

# ── Logging ────────────────────────────────────────────────
log_info()    { echo "::notice::$*"; }
log_warning() { echo "::warning::$*"; }
log_error()   { echo "::error::$*"; }
log_debug()   { echo "[debug] $*" >&2; }
log_group()   { echo "::group::$1"; }
log_endgroup(){ echo "::endgroup::"; }

# ── Work directory ─────────────────────────────────────────
WORK_DIR="${WORK_DIR:-${RUNNER_TEMP:-/tmp}/ai-pr-reviewer}"
mkdir -p "$WORK_DIR"

# ── Input validation ───────────────────────────────────────
validate_enum() {
  local name="$1"
  local value="$2"
  shift 2
  local allowed=("$@")

  for v in "${allowed[@]}"; do
    if [[ "$value" == "$v" ]]; then
      return 0
    fi
  done

  log_error "Invalid ${name}: '${value}'. Allowed: ${allowed[*]}"
  exit 1
}

# ── Retry with exponential backoff ─────────────────────────
# Usage: retry 3 5 curl ...
# Retries up to N times with exponential backoff starting at S seconds
retry() {
  local max_attempts="$1"
  local base_delay="$2"
  shift 2

  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi

    if [[ "$attempt" -ge "$max_attempts" ]]; then
      log_error "Command failed after ${max_attempts} attempts: $*"
      return 1
    fi

    local delay
    delay=$(( base_delay * (2 ** (attempt - 1)) ))
    log_warning "Attempt ${attempt}/${max_attempts} failed. Retrying in ${delay}s..."
    sleep "$delay"
    attempt=$(( attempt + 1 ))
  done
}

# ── Path validation ────────────────────────────────────────
# Blocks absolute paths and directory traversal in user-supplied paths
validate_path() {
  local path="$1"
  if [[ "$path" == /* ]] || [[ "$path" == *..* ]]; then
    log_error "Invalid path (must be relative, no '..'): ${path}"
    return 1
  fi
  return 0
}

# ── Safe file read (returns empty string if file missing) ──
safe_read() {
  cat "$1" 2>/dev/null || echo ""
}
