#!/bin/bash
# =============================================================================
# Output Secret Filter (PostToolUse)
# =============================================================================
# Purpose: Scan tool output for accidentally exposed secrets/tokens/keys.
#          Does NOT block execution (exits 0 always). Logs detections and
#          prints warnings to stderr for visibility.
#
# Detection: 20+ regex patterns covering AWS, Supabase, OpenAI, GitHub, etc.
# Log file: scripts/hooks/secret-detections.log (covered by .gitignore *.log)
#
# Massu secret filter hook
# =============================================================================

# --- Require jq ---
command -v jq >/dev/null 2>&1 || exit 0

# Read tool input from stdin
INPUT=$(cat)

# Extract tool output from PostToolUse JSON schema:
#   Bash:  .tool_response.stdout / .tool_response.stderr
#   Read:  .tool_response.content
#   MCP:   .tool_response (stringified, may contain .result)
BASH_OUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty' 2>/dev/null)
BASH_ERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // empty' 2>/dev/null)
READ_OUT=$(echo "$INPUT" | jq -r '.tool_response.content // empty' 2>/dev/null)
MCP_OUT=$(echo "$INPUT" | jq -r '.tool_response | if type == "object" then tostring else (. // empty) end' 2>/dev/null)

# Combine all output sources for scanning
OUTPUT="${BASH_OUT}${BASH_ERR:+
$BASH_ERR}${READ_OUT:+
$READ_OUT}${MCP_OUT:+
$MCP_OUT}"

# Early exit if no output to scan
if [ -z "$OUTPUT" ]; then
  exit 0
fi

# Extract tool name for logging
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)

# Log file location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/secret-detections.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Track if any secret was detected
DETECTED=0

# Detection function: check pattern and log if found
check_pattern() {
  local PATTERN="$1"
  local LABEL="$2"
  if echo "$OUTPUT" | grep -qE "$PATTERN" 2>/dev/null; then
    DETECTED=1
    echo "$TIMESTAMP | $TOOL_NAME | $LABEL | session:$PPID" >> "$LOG_FILE" 2>/dev/null
    echo "[SECURITY] Potential secret detected in tool output: $LABEL. Review conversation for exposed credentials." >&2
  fi
}

# AWS keys
check_pattern 'AKIA[A-Z0-9]{16,}' "AWS_ACCESS_KEY"
check_pattern 'AWS_SECRET_ACCESS_KEY=[^\s]+' "AWS_SECRET_KEY"

# Supabase service keys (long JWTs)
check_pattern 'eyJ[a-zA-Z0-9_-]{100,}' "SUPABASE_SERVICE_KEY_OR_JWT"

# OpenAI keys
check_pattern 'sk-[a-zA-Z0-9_-]{20,}' "OPENAI_API_KEY"

# Anthropic keys
check_pattern 'sk-ant-[a-zA-Z0-9_-]{20,}' "ANTHROPIC_API_KEY"

# GitHub tokens
check_pattern 'gh[ps]_[a-zA-Z0-9]{36,}' "GITHUB_TOKEN"
check_pattern 'github_pat_[a-zA-Z0-9_]{20,}' "GITHUB_PAT"

# Slack tokens
check_pattern 'xox[bpras]-[a-zA-Z0-9-]+' "SLACK_TOKEN"

# Bearer tokens
check_pattern 'Bearer [a-zA-Z0-9_.-]{20,}' "BEARER_TOKEN"

# Private key blocks
check_pattern '-----BEGIN.*PRIVATE KEY-----' "PRIVATE_KEY_BLOCK"

# Password fields
check_pattern 'password=[^ &]{8,}' "PASSWORD_FIELD"
check_pattern 'passwd=[^ &]{8,}' "PASSWORD_FIELD"

# Database URLs with credentials
check_pattern 'postgres(ql)?://[^ ]+@[^ ]+' "DATABASE_URL"

# Generic API keys (case-insensitive check via grep -i)
if echo "$OUTPUT" | grep -qiE '(api_key|apikey|api-key)=[^ &]{16,}' 2>/dev/null; then
  DETECTED=1
  echo "$TIMESTAMP | $TOOL_NAME | GENERIC_API_KEY | session:$PPID" >> "$LOG_FILE" 2>/dev/null
  echo "[SECURITY] Potential secret detected in tool output: GENERIC_API_KEY. Review conversation for exposed credentials." >&2
fi

# NPM tokens
check_pattern 'npm_[a-zA-Z0-9]{36,}' "NPM_TOKEN"

# Stripe keys
check_pattern 'sk_live_[a-zA-Z0-9]{20,}' "STRIPE_LIVE_KEY"
check_pattern 'rk_live_[a-zA-Z0-9]{20,}' "STRIPE_RESTRICTED_KEY"

# Sendgrid keys
check_pattern 'SG\.[a-zA-Z0-9_-]{20,}' "SENDGRID_KEY"

# Twilio tokens
check_pattern 'SK[a-f0-9]{32}' "TWILIO_KEY"

# Vercel tokens
check_pattern 'vc_[a-zA-Z0-9_-]{20,}' "VERCEL_TOKEN"

# Webhook secrets (Stripe, Svix, etc.)
check_pattern 'whsec_[a-zA-Z0-9_-]{20,}' "WEBHOOK_SECRET"

# Google API keys
check_pattern 'AIza[a-zA-Z0-9_-]{35}' "GOOGLE_API_KEY"

# Never block execution
exit 0
