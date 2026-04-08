#!/usr/bin/env bash
# mock-review.sh - Local integration test with mocked external commands
# Runs the full pipeline (gather-context -> review -> post-review) without
# requiring GitHub Actions, a GitHub token, or a Gemini API key.
#
# Usage: bash test/mock-review.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

echo "=== AI PR Reviewer: Integration Test ==="
echo "Script dir: $SCRIPT_DIR"
echo "Test dir:   $TEST_DIR"

# ── Create mock gh command ─────────────────────────────────
mkdir -p "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/gh" << 'MOCK_GH'
#!/usr/bin/env bash
# Mock gh CLI - returns canned responses for all commands used by the scripts
case "$*" in
  "pr view"*"--json"*)
    echo '{"title":"Add user authentication","body":"Implements JWT-based auth for the API","author":{"login":"dev-user"},"headRefOid":"abc123def456"}'
    ;;
  "pr diff"*"--name-only"*)
    echo "src/auth.ts"
    echo "src/middleware.ts"
    ;;
  "pr diff"*)
    cat << 'DIFF'
diff --git a/src/auth.ts b/src/auth.ts
index 1234567..abcdefg 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,5 +1,12 @@
 import express from 'express';
+import jwt from 'jsonwebtoken';

-export function auth() {
-  return true;
+const SECRET = "hardcoded-secret-123";
+
+export function auth(token: string) {
+  try {
+    return jwt.verify(token, SECRET);
+  } catch {
+    return null;
+  }
 }
diff --git a/src/middleware.ts b/src/middleware.ts
index 2345678..bcdefgh 100644
--- a/src/middleware.ts
+++ b/src/middleware.ts
@@ -1,4 +1,8 @@
 import { auth } from './auth';

 export function requireAuth(req, res, next) {
+  const result = auth(req.headers.authorization);
+  if (!result) {
+    return res.status(401).json({ error: 'Unauthorized' });
+  }
   next();
 }
DIFF
    ;;
  "pr comment"*)
    echo "[mock] Posted PR comment"
    ;;
  "api"*"issues"*"comments"*)
    echo "[]"
    ;;
  "api"*"reviews"*)
    echo '{"id":1}'
    ;;
  *)
    echo "[mock] gh $*" >&2
    ;;
esac
MOCK_GH
chmod +x "$TEST_DIR/bin/gh"

# ── Create mock curl command ───────────────────────────────
# Returns a canned Gemini API response with realistic review findings
cat > "$TEST_DIR/bin/curl" << 'MOCK_CURL'
#!/usr/bin/env bash
# Mock curl - returns a canned Gemini API response
# Finds the -o output file flag and writes the response there
output_file=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    output_file="$arg"
    break
  fi
  prev="$arg"
done

if [[ -n "$output_file" ]]; then
  cat > "$output_file" << 'RESPONSE'
{
  "candidates": [{
    "content": {
      "parts": [{"text": "{\"summary\":\"This PR adds JWT authentication but hardcodes the secret key, which is a critical security vulnerability. The middleware integration is clean.\",\"verdict\":\"request_changes\",\"findings\":[{\"file\":\"src/auth.ts\",\"line\":4,\"severity\":\"critical\",\"category\":\"security\",\"title\":\"Hardcoded JWT secret\",\"comment\":\"The JWT secret is hardcoded as a string literal and will be committed to version control. Anyone with repo access can extract and forge tokens.\",\"suggestion\":\"Use an environment variable: const SECRET = process.env.JWT_SECRET;\"},{\"file\":\"src/middleware.ts\",\"line\":4,\"severity\":\"medium\",\"category\":\"correctness\",\"title\":\"Missing Bearer prefix stripping\",\"comment\":\"The Authorization header typically contains 'Bearer <token>' but the code passes the full header value to auth(). JWT verification will fail for standard clients.\",\"suggestion\":\"const token = req.headers.authorization?.replace('Bearer ', '');\"}],\"highlights\":[\"Good use of try/catch for JWT verification errors\",\"Clean middleware pattern with early return on auth failure\"],\"missing_guardrails\":[]}"}],
      "role": "model"
    },
    "finishReason": "STOP"
  }],
  "usageMetadata": {
    "promptTokenCount": 1250,
    "candidatesTokenCount": 340,
    "totalTokenCount": 1590
  }
}
RESPONSE
fi

# Output the HTTP status code (curl -w "%{http_code}" writes this to stdout)
echo -n "200"
MOCK_CURL
chmod +x "$TEST_DIR/bin/curl"

# Mock bc for cost calculation
cat > "$TEST_DIR/bin/bc" << 'MOCK_BC'
#!/usr/bin/env bash
echo "0.0004"
MOCK_BC
chmod +x "$TEST_DIR/bin/bc"

# Put mocks first in PATH so they shadow the real commands
export PATH="$TEST_DIR/bin:$PATH"

# ── Create a minimal test repo structure ───────────────────
mkdir -p "$TEST_DIR/repo/src"

cat > "$TEST_DIR/repo/src/auth.ts" << 'TS'
import express from 'express';
import jwt from 'jsonwebtoken';

const SECRET = "hardcoded-secret-123";

export function auth(token: string) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}
TS

cat > "$TEST_DIR/repo/src/middleware.ts" << 'TS'
import { auth } from './auth';

export function requireAuth(req, res, next) {
  const result = auth(req.headers.authorization);
  if (!result) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
TS

cat > "$TEST_DIR/repo/package.json" << 'JSON'
{"name":"test-app","dependencies":{"express":"^4.18.0","jsonwebtoken":"^9.0.0"}}
JSON

# ── Run the pipeline ───────────────────────────────────────
cd "$TEST_DIR/repo"

export PR_NUMBER="42"
export CONTEXT_DEPTH="changed-files"
export MAX_FILES="20"
export MAX_DIFF_SIZE="10000"
export GEMINI_API_KEY="mock-key-for-testing"
export MODEL="gemini-2.5-flash"
export RULES_PATHS="review-rules.md,CLAUDE.md"
export ACTION_PATH="$SCRIPT_DIR"
export WORK_DIR="$TEST_DIR/work"
export POST_INLINE="true"
export SEVERITY_THRESHOLD="low"
export BOT_NAME="ai-reviewer"
export SUBMIT_REVIEW_VERDICT="false"
export GITHUB_STEP_SUMMARY="$TEST_DIR/step-summary.md"

mkdir -p "$WORK_DIR"

echo ""
echo "=== Step 1: Gather Context ==="
bash "$SCRIPT_DIR/scripts/gather-context.sh"

echo ""
echo "=== Step 2: Run Review ==="
bash "$SCRIPT_DIR/scripts/review.sh"

echo ""
echo "=== Step 3: Post Review ==="
bash "$SCRIPT_DIR/scripts/post-review.sh"

echo ""
echo "=== Results ==="
echo ""
echo "--- Review JSON ---"
jq . "$TEST_DIR/work/review.json"

echo ""
echo "--- Summary Comment ---"
cat "$TEST_DIR/work/summary_comment.md"

echo ""
echo "--- Valid Lines Manifest ---"
cat "$TEST_DIR/work/valid_lines.tsv"

echo ""
echo "--- Step Summary ---"
cat "$TEST_DIR/step-summary.md"

echo ""
echo "=== Integration test PASSED ==="
