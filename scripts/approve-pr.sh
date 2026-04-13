#!/usr/bin/env bash
# =============================================================================
# Symphony PR Approve & Merge Script
# 用法: ./approve-pr.sh [review_comment]
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

REVIEW_COMMENT="${1:-LGTM! Code looks good, merging automatically.}"

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_OWNER="${GITHUB_OWNER:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
LINEAR_API_KEY="${SYMPHONY_TRACKER_API_KEY:-}"
LINEAR_DONE_STATE_ID="8abac616-912a-44d5-8be0-fad6f2403807"  # Done

ISSUE_IDENTIFIER="$(basename "$(pwd)")"
echo "[approve-pr] Issue: $ISSUE_IDENTIFIER"

# 找到当前分支的 PR number
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
echo "[approve-pr] Branch: $BRANCH_NAME"

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
  echo "[approve-pr] ERROR: No open PR found for branch $BRANCH_NAME"
  exit 1
fi

echo "[approve-pr] PR #$PR_NUMBER found, submitting review..."

# 提交 approve review
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/pulls/$PR_NUMBER/reviews" \
  --max-time 15 \
  -d "$(python3 -c "import json; print(json.dumps({'body': '$REVIEW_COMMENT', 'event': 'APPROVE'}))")" > /dev/null

echo "[approve-pr] Review approved. Merging PR #$PR_NUMBER..."

# 合并 PR
MERGE_RESPONSE=$(curl -s -X PUT \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/pulls/$PR_NUMBER/merge" \
  --max-time 15 \
  -d "$(python3 -c "import json; print(json.dumps({
    'commit_title': 'Merge PR #$PR_NUMBER: $ISSUE_IDENTIFIER',
    'commit_message': 'Auto-merged by Symphony after code review.',
    'merge_method': 'squash'
  }))")")

MERGE_MERGED=$(echo "$MERGE_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('merged', False))
except: print(False)
" 2>/dev/null || echo "False")

if [ "$MERGE_MERGED" = "True" ]; then
  echo "[approve-pr] PR #$PR_NUMBER merged successfully."
else
  echo "[approve-pr] ERROR: Merge failed: $MERGE_RESPONSE"
  exit 1
fi

# 更新 Linear Issue 为 Done
echo "[approve-pr] Updating Linear issue $ISSUE_IDENTIFIER to Done..."

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
    -d "{\"query\": \"mutation { issueUpdate(id: \\\"$ISSUE_ID\\\", input: { stateId: \\\"$LINEAR_DONE_STATE_ID\\\" }) { success } }\"}" > /dev/null
  echo "[approve-pr] Linear issue $ISSUE_IDENTIFIER marked as Done."
else
  echo "[approve-pr] WARNING: Could not find Linear issue ID."
fi

echo "[approve-pr] All done! PR merged and issue closed."
