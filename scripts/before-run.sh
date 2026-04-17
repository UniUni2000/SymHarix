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

# Create issue context file for Claude to read
cat << EOF > ISSUE_CONTEXT.md
# Issue: $SYMPHONY_ISSUE_IDENTIFIER

**State**: $SYMPHONY_ISSUE_STATE

**Instructions**:
- This is an automated Symphony workflow
- Your task is defined by issue $SYMPHONY_ISSUE_IDENTIFIER in Linear
- If state is "Todo" or "In Progress": Implement the feature/fix
- If state is "In Review": Review the PR and provide feedback

**Available Tools**:
- Bash: Execute shell commands
- Glob: Find files by pattern
- Read: Read file contents
- Write: Create/modify files
- WebFetch: Access external URLs (including Linear API)

**Workflow**:
1. Understand the issue requirements
2. Explore the codebase if needed
3. Implement changes or review code
4. When done, the after_run hook will handle git/PR operations
EOF

echo "[before-run] Created ISSUE_CONTEXT.md"

# Check if DEVELOPMENT_LOG.md exists (resuming previous work)
if [ -f "DEVELOPMENT_LOG.md" ]; then
  echo "[before-run] Found existing DEVELOPMENT_LOG.md, will resume from last position"
  # Parse complexity from existing log if present
  COMPLEXITY=$(grep -i "复杂度:" DEVELOPMENT_LOG.md | head -1 | sed 's/.*: //' | tr -d ' ')
  if [ -n "$COMPLEXITY" ]; then
    echo "[before-run] Resuming with complexity: $COMPLEXITY"
  fi
else
  echo "[before-run] No existing log, starting fresh"

  # Create DEVELOPMENT_LOG.md
  cat << 'DEVLOG' > DEVELOPMENT_LOG.md
# Development Log: $SYMPHONY_ISSUE_IDENTIFIER

## 基本信息
- **Issue**: $SYMPHONY_ISSUE_IDENTIFIER
- **状态**: $SYMPHONY_ISSUE_STATE
- **开始时间**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- **复杂度**: pending（AI 将自动判断）

## 进度追踪

### 已完成
- （待填充）

### 待办
- （待填充）

### 已尝试但失败
- （无）

## Review 历史
- （无）

## 下次继续
收到 issue 后，首先分析需求和代码改动范围，判断复杂度。
DEVLOG
  echo "[before-run] DEVELOPMENT_LOG.md created"
fi

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
  # Use sed with empty backup suffix for macOS compatibility
  sed -i '' "s/replace_me_if_needed_or_rely_on_system_env/${GITHUB_TOKEN}/g" .mcp.json
fi

echo "[before-run] .mcp.json generated successfully."
