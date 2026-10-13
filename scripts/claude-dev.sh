#!/usr/bin/env bash
# Launch Claude Code against the LOCAL gateway without touching your real
# ~/.claude config or login. Uses an isolated config dir (.claude-test/).
#
#   ./scripts/claude-dev.sh            # interactive; first run: /login -> Cloud gateway
#   ./scripts/claude-dev.sh -p "hi"    # any claude args pass through
#
# Sign in as alice@example.com or bob@example.com, password "changeme".
set -euo pipefail
cd "$(dirname "$0")/.."

export CLAUDE_CONFIG_DIR="$PWD/.claude-test"
mkdir -p "$CLAUDE_CONFIG_DIR"

# Gateway login keys are honoured from user settings on v2.1.295+.
cat > "$CLAUDE_CONFIG_DIR/settings.json" <<EOF
{
  "forceLoginMethod": "gateway",
  "forceLoginGatewayUrl": "${GATEWAY_URL:-http://localhost:8791}"
}
EOF

# Make sure nothing in the environment bypasses the gateway.
unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_BEDROCK

exec claude "$@"
