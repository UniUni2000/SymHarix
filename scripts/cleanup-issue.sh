#!/usr/bin/env bash
# Cleanup script for cancelled/completed issues

set -euo pipefail

ISSUE_IDENTIFIER="${1:-}"
ACTION="${2:-}"  # "cancel" or "done"

if [ -z "$ISSUE_IDENTIFIER" ]; then
  echo "Usage: cleanup-issue.sh <issue-identifier> <cancel|done>"
  exit 1
fi

# Load env
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
PROJECT_ROOT="${SYMPHONY_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  set -o allexport
  source "$ENV_FILE"
  set +o allexport
fi

# Get workspace paths
WORKSPACE_ROOT="${SYMPHONY_WORKSPACE_ROOT:-/tmp/symphony_workspaces}"
PROJECT_NAME="$(basename "$(dirname "$(pwd)")")"
WORKTREE_PATH="$WORKSPACE_ROOT/$PROJECT_NAME/$ISSUE_IDENTIFIER"
MAIN_WORKDIR="$WORKSPACE_ROOT/$PROJECT_NAME"

# Remove worktree
removeWorktree() {
  if [ -d "$WORKTREE_PATH" ]; then
    # Use git worktree remove if inside the main workdir
    if [ -d "$MAIN_WORKDIR" ]; then
      git -C "$MAIN_WORKDIR" worktree remove "$WORKTREE_PATH" --force 2>/dev/null || true
    fi
    rm -rf "$WORKTREE_PATH"
    echo "[cleanup] Removed worktree: $WORKTREE_PATH"
  else
    echo "[cleanup] No worktree found at: $WORKTREE_PATH"
  fi
}

# Close GitHub PR
closeGitHubPR() {
  local branch="feature/${ISSUE_IDENTIFIER}"
  local pr_response=$(curl -s -X GET \
    "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?state=open&head=${GITHUB_OWNER}:${branch}" \
    -H "Authorization: token $GITHUB_TOKEN" \
    --max-time 10 2>/dev/null || echo "[]")

  local pr_number=$(echo "$pr_response" | python3 -c "
import sys,json
prs = json.load(sys.stdin)
for pr in prs:
    print(pr.get('number',''))
" 2>/dev/null || echo "")

  if [ -n "$pr_number" ]; then
    curl -s -X PATCH \
      "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls/${pr_number}" \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"state":"closed"}' \
      --max-time 10 2>/dev/null
    echo "[cleanup] Closed PR #${pr_number}"
  fi
}

# Close GitHub Issue
closeGitHubIssue() {
  local issue_number=$(echo "$ISSUE_IDENTIFIER" | grep -oE '[0-9]+$')
  if [ -n "$issue_number" ]; then
    curl -s -X PATCH \
      "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${issue_number}" \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"state":"closed"}' \
      --max-time 10 2>/dev/null
    echo "[cleanup] Closed GitHub Issue #${issue_number}"
  fi
}

# Execute cleanup
removeWorktree
if [ "$ACTION" = "cancel" ]; then
  closeGitHubPR
  closeGitHubIssue
fi

echo "[cleanup] Done."
