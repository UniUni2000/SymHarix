#!/usr/bin/env bash
# =============================================================================
# Symphony Before Run Hook - Dynamic MCP Plugin Injection
# Executed in the workspace directory before claude-code runs.
# Environmental Variables available:
#   SYMPHONY_ISSUE_IDENTIFIER: The ID of the issue (e.g. INT-10)
#   SYMPHONY_ISSUE_STATE: The current state of the issue (e.g. "In Progress", "In Review")
# =============================================================================

set -euo pipefail

echo "[before-run] Initializing for issue $SYMPHONY_ISSUE_IDENTIFIER in state: $SYMPHONY_ISSUE_STATE"

# Check the state and generate a tailored .mcp.json
if [[ "$SYMPHONY_ISSUE_STATE" == "In Review" ]]; then
  echo "[before-run] Role: Reviewer. Generating reviewer MCP config..."
  cat << 'EOF' > .mcp.json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "replace_me_if_needed_or_rely_on_system_env"
      }
    }
    // Add sequential thinker, diff analyzer, or other review-focused MCPs here
  }
}
EOF

else
  echo "[before-run] Role: Developer. Generating developer MCP config..."
  cat << 'EOF' > .mcp.json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-fetch"
      ]
    }
    // Add testing, documentation, or other dev-focused MCPs here
  }
}
EOF

fi

# Replace github token in reviewer config using the system environment variable
if [ -n "${GITHUB_TOKEN:-}" ] && [ -f ".mcp.json" ]; then
  sed -i "s/replace_me_if_needed_or_rely_on_system_env/${GITHUB_TOKEN}/g" .mcp.json
fi

echo "[before-run] .mcp.json generated successfully."
