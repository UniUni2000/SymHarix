#!/usr/bin/env bash
# =============================================================================
# Symphony PR Reject Script
# 用法: ./reject-pr.sh "具体问题描述"
# 在 workspace 目录中执行，自动推断 issue/PR
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  set -o allexport
  source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE")
  set +o allexport
fi

REJECT_REASON="${1:-Code review failed. Please fix the issues and resubmit.}"

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_OWNER="${GITHUB_OWNER:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
LINEAR_API_KEY="${SYMPHONY_TRACKER_API_KEY:-}"
LINEAR_IN_PROGRESS_STATE_ID="d66c7727-7626-4da1-9d08-7189a226fee6"  # In Progress

ISSUE_IDENTIFIER="$(basename "$(pwd)")"
echo "[reject-pr] Issue: $ISSUE_IDENTIFIER"

BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
echo "[reject-pr] Branch: $BRANCH_NAME"

# 找到 PR number
PR_DATA=$(curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/pulls?head=$GITHUB_OWNER:$BRANCH_NAME&state=open" \
  --max-time 15)

PR_NUMBER=$(echo "$PR_DATA" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d[0]['number'] if d else '')
except: print('')
" 2>/dev/null || echo "")

if [ -z "$PR_NUMBER" ]; then
  echo "[reject-pr] WARNING: No open PR found for branch $BRANCH_NAME"
else
  echo "[reject-pr] Submitting review rejection on PR #$PR_NUMBER..."

  # 提交 request_changes review
  curl -s -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/pulls/$PR_NUMBER/reviews" \
    --max-time 15 \
    -d "$(python3 -c "
import json, sys
print(json.dumps({
  'body': '''## Code Review: Changes Requested

$REJECT_REASON

Please address the above issues and push new commits to this branch.''',
  'event': 'REQUEST_CHANGES'
}))")" > /dev/null

  echo "[reject-pr] Review submitted: changes requested on PR #$PR_NUMBER."
fi

# 更新 Linear Issue 回 In Progress
echo "[reject-pr] Updating Linear issue $ISSUE_IDENTIFIER back to In Progress..."

LINEAR_RESP=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 15 \
  -d "{\"query\": \"{ issues(filter: { identifier: { eq: \\\"$ISSUE_IDENTIFIER\\\" } }) { nodes { id } } }\"}")

ISSUE_ID=$(echo "$LINEAR_RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    n = d.get('data',{}).get('issues',{}).get('nodes',[])
    print(n[0]['id'] if n else '')
except: print('')
" 2>/dev/null || echo "")

if [ -n "$ISSUE_ID" ]; then
  curl -s -X POST https://api.linear.app/graphql \
    -H "Authorization: $LINEAR_API_KEY" \
    -H "Content-Type: application/json" \
    --max-time 15 \
    -d "{\"query\": \"mutation { issueUpdate(id: \\\"$ISSUE_ID\\\", input: { stateId: \\\"$LINEAR_IN_PROGRESS_STATE_ID\\\" }) { success } }\"}" > /dev/null
  echo "[reject-pr] Linear issue $ISSUE_IDENTIFIER moved back to In Progress."
else
  echo "[reject-pr] WARNING: Could not find Linear issue ID."
fi

echo "[reject-pr] Done. Agent will pick up the issue again for fixes."
