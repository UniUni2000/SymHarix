#!/usr/bin/env bash
# =============================================================================
# Symphony After-Run Hook
# 在 Agent 完成任务后自动执行：
#   1. git commit & push 分支到 GitHub
#   2. 创建 GitHub Pull Request
#   3. 更新 Linear Issue 状态为 "In Review"
#
# Output: Prints API call counts at the end for statistics tracking:
#   SYMPHONY_STATS:{"linear_api_calls":N,"github_api_calls":N}
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# 加载环境变量（从项目根目录的 .env）
# -----------------------------------------------------------------------------
# Get absolute path to this script (works even when run via bash script.sh)
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_SOURCE="${BASH_SOURCE[0]}"
else
  SCRIPT_SOURCE="$0"
fi
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
PROJECT_ROOT="${SYMPHONY_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  # 加载所有环境变量（非注释、非空行会被bash正确处理）
  set -o allexport
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +o allexport
fi

# -----------------------------------------------------------------------------
# 从工作区路径推断 Issue Identifier（例如 INT-10）
# 当前工作目录就是 workspace 目录（orchestrator 以 cwd=workspacePath 运行 hook）
# -----------------------------------------------------------------------------
WORKSPACE_PATH="$(pwd)"
ISSUE_IDENTIFIER="$(basename "$WORKSPACE_PATH")"

echo "[after-run] Workspace: $WORKSPACE_PATH"
echo "[after-run] Issue: $ISSUE_IDENTIFIER"

# -----------------------------------------------------------------------------
# 必要变量校验
# -----------------------------------------------------------------------------
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_OWNER="${SYMPHONY_GITHUB_OWNER:-${GITHUB_OWNER:-}}"
GITHUB_REPO="${SYMPHONY_GITHUB_REPO:-${GITHUB_REPO:-}}"
GITHUB_DEFAULT_BRANCH="${GITHUB_DEFAULT_BRANCH:-main}"
LINEAR_API_KEY="${SYMPHONY_TRACKER_API_KEY:-}"

# 动态获取 Linear 状态 ID（从环境变量或 API）
getLinearStateId() {
  local state_name="$1"
  local cache_key="linear_state_${state_name}"

  # 先尝试从环境变量获取
  case "$state_name" in
    "In Review") echo "${LINEAR_IN_REVIEW_STATE_ID:-${SYMPHONY_STATE_IN_REVIEW:-}}" ;;
    "Done") echo "${LINEAR_DONE_STATE_ID:-${SYMPHONY_STATE_DONE:-}}" ;;
    "In Progress") echo "${LINEAR_IN_PROGRESS_STATE_ID:-${SYMPHONY_STATE_IN_PROGRESS:-}}" ;;
    *) echo "" ;;
  esac
}

# 尝试从 Linear API 获取状态 ID
fetchLinearStateIds() {
  if [ -z "$LINEAR_API_KEY" ]; then
    echo "[after-run] Linear API key not set, using defaults"
    return
  fi

  echo "[after-run] Fetching Linear state IDs..."

  # 从 Linear API 获取团队的工作流状态
  local team_response=$(curl -s -X POST https://api.linear.app/graphql \
    -H "Authorization: $LINEAR_API_KEY" \
    -H "Content-Type: application/json" \
    --max-time 15 \
    -d '{"query": "{ teams { nodes { name states { nodes { id name type } } } } }"}' 2>/dev/null || echo "{}")

  LINEAR_API_CALLS=${LINEAR_API_CALLS:-0}
LINEAR_API_CALLS=$((LINEAR_API_CALLS + 1))

  # 解析状态 ID（从响应中提取）
  # 这里简化处理，假设状态名称唯一
  LINEAR_DONE_STATE_ID=$(echo "$team_response" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for team in d.get('data', {}).get('teams', {}).get('nodes', []):
        for state in team.get('states', {}).get('nodes', []):
            if state.get('name') == 'Done' and state.get('type') == 'completed':
                print(state.get('id', ''))
                break
except:
    print('')
" 2>/dev/null || echo "")

  LINEAR_IN_PROGRESS_STATE_ID=$(echo "$team_response" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for team in d.get('data', {}).get('teams', {}).get('nodes', []):
        for state in team.get('states', {}).get('nodes', []):
            if state.get('name') == 'In Progress' and state.get('type') == 'started':
                print(state.get('id', ''))
                break
except:
    print('')
" 2>/dev/null || echo "")

  if [ -n "$LINEAR_DONE_STATE_ID" ]; then
    echo "[after-run] Found Done state ID: $LINEAR_DONE_STATE_ID"
  fi
  if [ -n "$LINEAR_IN_PROGRESS_STATE_ID" ]; then
    echo "[after-run] Found In Progress state ID: $LINEAR_IN_PROGRESS_STATE_ID"
  fi
}

# 如果环境变量未设置，则从 API 获取
if [ -z "${LINEAR_DONE_STATE_ID:-}" ] || [ -z "${LINEAR_IN_PROGRESS_STATE_ID:-}" ]; then
  fetchLinearStateIds
fi

# 如果仍然没有设置，使用默认值（fallback）
LINEAR_IN_REVIEW_STATE_ID="${LINEAR_IN_REVIEW_STATE_ID:-2d55ad60-e9a3-4490-a78d-d8ddd0f5e45a}"
LINEAR_DONE_STATE_ID="${LINEAR_DONE_STATE_ID:-8abac616-912a-44d5-8be0-fad6f2403807}"
LINEAR_IN_PROGRESS_STATE_ID="${LINEAR_IN_PROGRESS_STATE_ID:-d66c7727-7626-4da1-9d08-7189a226fee6}"

# API call counters
LINEAR_API_CALLS=0
GITHUB_API_CALLS=0

# -----------------------------------------------------------------------------
# Helper: Post comment to Linear issue
# -----------------------------------------------------------------------------
postLinearComment() {
  local issue_id="$1"
  local comment="$2"

  if [ -z "$LINEAR_API_KEY" ]; then
    echo "[after-run] Linear API key not set, skipping comment"
    return 1
  fi

  # Escape the comment for JSON
  local escaped_comment=$(echo "$comment" | python3 -c "
import sys
import json
comment = sys.stdin.read()
print(json.dumps(comment))
")

  local mutation="{\"query\": \"mutation { issueCommentCreate(input: {issueId: \\\"$issue_id\\\", body: $escaped_comment}) { success } }\"}"

  local response=$(curl -s -X POST https://api.linear.app/graphql \
    -H "Authorization: $LINEAR_API_KEY" \
    -H "Content-Type: application/json" \
    --max-time 15 \
    -d "$mutation" 2>/dev/null || echo "{}")

  local success=$(echo "$response" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('success' if d.get('data', {}).get('issueCommentCreate', {}).get('success') else 'failed')
except:
    print('error')
" 2>/dev/null || echo "error")

  if [ "$success" = "success" ]; then
    echo "[after-run] Posted comment to Linear issue $issue_id"
  else
    echo "[after-run] Failed to post comment: $response"
  fi
}

if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_OWNER" ] || [ -z "$GITHUB_REPO" ]; then
  echo "[after-run] WARNING: GitHub config missing (GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO), skipping PR creation."
  exit 0
fi

# -----------------------------------------------------------------------------
# Step 1: Git commit & push
# -----------------------------------------------------------------------------
echo "[after-run] Staging and committing changes..."

# 检查是否有改动
if git diff --quiet && git diff --staged --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "[after-run] No changes to commit, skipping."
else
  git add -A
  # 排除 Symphony 工作区配置文件，不提交到 GitHub
  git reset ISSUE_CONTEXT.md .mcp.json 2>/dev/null || true
  git commit -m "feat($ISSUE_IDENTIFIER): agent completed task

Automated commit by Symphony Agent Platform.
Issue: $ISSUE_IDENTIFIER" --allow-empty || true
fi

# 获取当前分支名
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"
echo "[after-run] Pushing branch: $BRANCH_NAME"

# 配置 remote URL
REMOTE_URL="https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"
git remote set-url origin "$REMOTE_URL" 2>/dev/null || git remote add origin "$REMOTE_URL"

# 使用 GIT_ASKPASS 脚本安全传递 token（避免 token 在 ps 或 log 中暴露）
ASKPASS_SCRIPT="/tmp/git-askpass-$$.sh"
cat << 'ASKSCRIPT' > "$ASKPASS_SCRIPT"
#!/bin/bash
echo "password=$GITHUB_TOKEN"
ASKSCRIPT
chmod 700 "$ASKPASS_SCRIPT"
export GIT_ASKPASS="$ASKPASS_SCRIPT"
export GIT_TERMINAL_PROMPT=0

if git push origin "$BRANCH_NAME" --force-with-lease 2>&1; then
  echo "[after-run] Push successful."
elif git push origin "$BRANCH_NAME" --force 2>&1; then
  echo "[after-run] Push (force) successful."
else
  echo "[after-run] WARNING: GitHub push failed (network unreachable). Continuing anyway to update Linear..."
fi

# 清理 ASKPASS 脚本
rm -f "$ASKPASS_SCRIPT"

# -----------------------------------------------------------------------------
# Step 2: 获取 Linear Issue 标题（用于 PR 标题）
# -----------------------------------------------------------------------------
echo "[after-run] Fetching Linear issue info..."

LINEAR_RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 15 \
  -d "{\"query\": \"{ issues(filter: { identifier: { eq: \\\"$ISSUE_IDENTIFIER\\\" } }) { nodes { id title description } } }\"}" 2>/dev/null || echo "{}")
LINEAR_API_CALLS=${LINEAR_API_CALLS:-0}
LINEAR_API_CALLS=$((LINEAR_API_CALLS + 1))

ISSUE_ID=$(echo "$LINEAR_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    nodes = d.get('data', {}).get('issues', {}).get('nodes', [])
    print(nodes[0]['id'] if nodes else '')
except:
    print('')
" 2>/dev/null || echo "")

ISSUE_TITLE=$(echo "$LINEAR_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    nodes = d.get('data', {}).get('issues', {}).get('nodes', [])
    print(nodes[0]['title'] if nodes else '$ISSUE_IDENTIFIER')
except:
    print('$ISSUE_IDENTIFIER')
" 2>/dev/null || echo "$ISSUE_IDENTIFIER")

echo "[after-run] Issue title: $ISSUE_TITLE"

# -----------------------------------------------------------------------------
# Step 3: 创建 GitHub Pull Request
# -----------------------------------------------------------------------------
echo "[after-run] Creating GitHub PR..."

# Build PR data using Python with proper JSON escaping
PR_DATA=$(python3 - "$ISSUE_IDENTIFIER" "$ISSUE_TITLE" "$BRANCH_NAME" "$GITHUB_DEFAULT_BRANCH" << 'PYTHON_SCRIPT'
import json
import sys
issue_id = sys.argv[1]
issue_title = sys.argv[2]
branch = sys.argv[3]
base = sys.argv[4]

data = {
    "title": f"[{issue_id}] {issue_title}",
    "body": f"""## Summary

Automated PR created by Symphony Agent Platform.

**Linear Issue:** {issue_id}
**Branch:** `{branch}`

## Changes

Agent completed the task for issue [{issue_id}](https://linear.app/inteliway-symphony/issue/{issue_id}).

> This PR was automatically generated by Symphony. Please review before merging.
""",
    "head": branch,
    "base": base,
    "draft": False
}
print(json.dumps(data))
PYTHON_SCRIPT
)

GITHUB_API_RESPONSE=$(curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/pulls" \
  --max-time 15 \
  -d "$PR_DATA" 2>/dev/null || echo "{}")
GITHUB_API_CALLS=${GITHUB_API_CALLS:-0}
GITHUB_API_CALLS=$((GITHUB_API_CALLS + 1))

PR_URL=$(echo "$GITHUB_API_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('html_url', ''))
except:
    print('')
" 2>/dev/null || echo "")

PR_ERROR=$(echo "$GITHUB_API_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('message', '') or d.get('errors', [{}])[0].get('message', ''))
except:
    print('')
" 2>/dev/null || echo "")

if [ -n "$PR_URL" ]; then
  echo "[after-run] PR created: $PR_URL"

  # -----------------------------------------------------------------------------
  # Step 3b: Wait for CI checks to pass (optional, configurable)
  # -----------------------------------------------------------------------------
  if [ "${SYMPHONY_WAIT_FOR_CI:-false}" = "true" ]; then
    echo "[after-run] Waiting for CI checks to pass..."

    # Extract PR number from URL
    PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')

    if [ -n "$PR_NUMBER" ]; then
      # Poll CI status until all checks pass or timeout
      CI_TIMEOUT=600  # 10 minutes
      CI_INTERVAL=30  # Check every 30 seconds
      CI_ELAPSED=0

      while [ $CI_ELAPSED -lt $CI_TIMEOUT ]; do
        echo "[after-run] Checking CI status for PR #$PR_NUMBER..."

        CI_RESPONSE=$(curl -s -X GET \
          -H "Authorization: token $GITHUB_TOKEN" \
          -H "Content-Type: application/json" \
          "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/commits/$BRANCH_NAME/status" \
          --max-time 15 2>/dev/null || echo "{}")
        GITHUB_API_CALLS=${GITHUB_API_CALLS:-0}
GITHUB_API_CALLS=$((GITHUB_API_CALLS + 1))

        CI_STATE=$(echo "$CI_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('state', 'unknown'))
except:
    print('unknown')
" 2>/dev/null || echo "unknown")

        echo "[after-run] CI state: $CI_STATE"

        if [ "$CI_STATE" = "success" ]; then
          echo "[after-run] CI checks passed!"
          break
        elif [ "$CI_STATE" = "failure" ]; then
          echo "[after-run] CI checks failed!"
          echo "[after-run] CI Response: $CI_RESPONSE"
          break
        else
          echo "[after-run] CI checks still pending, waiting..."
          sleep $CI_INTERVAL
          CI_ELAPSED=$((CI_ELAPSED + CI_INTERVAL))
        fi
      done

      if [ $CI_ELAPSED -ge $CI_TIMEOUT ]; then
        echo "[after-run] WARNING: CI checks timed out after ${CI_TIMEOUT}s"
      fi
    fi
  fi

elif echo "$PR_ERROR" | grep -qi "already exists"; then
  echo "[after-run] PR already exists for this branch, skipping creation."
else
  echo "[after-run] WARNING: PR creation failed: $PR_ERROR"
fi

# -----------------------------------------------------------------------------
# Step 4: 更新 Linear Issue 状态
# - Dev agent 完成（In Progress → In Review）：触发 review agent
# - Review agent 完成：
#   - 通过/Approve → Done
#   - 打回/Changes Requested → In Progress（dev agent 重新修改）
# -----------------------------------------------------------------------------

# Fetch current issue state to determine agent type and target state
# Linear API requires fetching all issues and filtering by identifier
CURRENT_STATE_RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 15 \
  -d "{\"query\": \"{ issues { nodes { id identifier state { name } } } }\"}" 2>/dev/null || echo "{}")
LINEAR_API_CALLS=${LINEAR_API_CALLS:-0}
LINEAR_API_CALLS=$((LINEAR_API_CALLS + 1))

# Parse response to find matching issue by identifier
CURRENT_STATE=$(echo "$CURRENT_STATE_RESPONSE" | python3 -c "
import sys, json
identifier = '$ISSUE_IDENTIFIER'
try:
    d = json.load(sys.stdin)
    nodes = d.get('data', {}).get('issues', {}).get('nodes', [])
    for node in nodes:
        if node.get('identifier') == identifier:
            print(node.get('state', {}).get('name', ''))
            break
    else:
        print('')
except:
    print('')
" 2>/dev/null || echo "")

# Also get ISSUE_ID for later use
ISSUE_ID=$(echo "$CURRENT_STATE_RESPONSE" | python3 -c "
import sys, json
identifier = '$ISSUE_IDENTIFIER'
try:
    d = json.load(sys.stdin)
    nodes = d.get('data', {}).get('issues', {}).get('nodes', [])
    for node in nodes:
        if node.get('identifier') == identifier:
            print(node.get('id', ''))
            break
    else:
        print('')
except:
    print('')
" 2>/dev/null || echo "")

if [ -z "$ISSUE_ID" ]; then
  echo "[after-run] ERROR: Could not find Linear issue ID for $ISSUE_IDENTIFIER"
  exit 0
fi

echo "[after-run] Current Linear state: $CURRENT_STATE"

# Use the state IDs fetched earlier (from env or API)
if [ "$CURRENT_STATE" = "In Review" ]; then
  # Review agent completed - check PR status to decide pass/fail
  echo "[after-run] Review agent completed, checking PR status..."

  # Get PR status for this branch
  PR_RESPONSE=$(curl -s -X GET \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/pulls?head=$GITHUB_OWNER:$BRANCH_NAME&state=open" \
    --max-time 15 2>/dev/null || echo "[]")
  GITHUB_API_CALLS=${GITHUB_API_CALLS:-0}
GITHUB_API_CALLS=$((GITHUB_API_CALLS + 1))

  # Check if PR has been merged
  PR_REVIEW_STATUS=$(echo "$PR_RESPONSE" | python3 -c "
import sys, json
try:
    prs = json.load(sys.stdin)
    if prs and len(prs) > 0:
        pr = prs[0]
        merged = pr.get('merged', False)
        if merged:
            print('merged')
        else:
            print('needs_review')
    else:
        print('no_pr')
except:
    print('error')
" 2>/dev/null || echo "error")

  echo "[after-run] PR review status: $PR_REVIEW_STATUS"

  if [ "$PR_REVIEW_STATUS" = "merged" ]; then
    TARGET_STATE_ID="$LINEAR_DONE_STATE_ID"
    TARGET_STATE_NAME="Done"
    echo "[after-run] PR already merged, updating to Done"
  elif [ "$PR_REVIEW_STATUS" = "needs_review" ]; then
    # Fetch latest review state for this PR
    PR_NUMBER=$(echo "$PR_RESPONSE" | python3 -c "
import sys, json
try:
    prs = json.load(sys.stdin)
    if prs and len(prs) > 0:
        url = prs[0].get('url', '')
        print(url.split('/')[-1])
    else:
        print('')
except:
    print('')
" 2>/dev/null || echo "")

    if [ -n "$PR_NUMBER" ]; then
      # Get formal reviews for this PR
      REVIEWS_RESPONSE=$(curl -s -X GET \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Content-Type: application/json" \
        "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/pulls/$PR_NUMBER/reviews" \
        --max-time 15 2>/dev/null || echo "[]")
      GITHUB_API_CALLS=${GITHUB_API_CALLS:-0}
GITHUB_API_CALLS=$((GITHUB_API_CALLS + 1))

      # Determine final review outcome - check formal reviews first, then comments
      REVIEW_DECISION=$(echo "$REVIEWS_RESPONSE" | python3 -c "
import sys, json
try:
    reviews = json.load(sys.stdin)
    latest_by_user = {}
    if reviews:
        for r in reviews:
            user = r.get('user', {}).get('login', '')
            state = r.get('state', '')
            if user and state in ('APPROVED', 'CHANGES_REQUESTED'):
                latest_by_user[user] = state

    if latest_by_user:
        if 'CHANGES_REQUESTED' in latest_by_user.values():
            print('changes_requested')
        elif 'APPROVED' in latest_by_user.values():
            print('approved')
        else:
            print('pending')
    else:
        print('no_reviews')
except:
    print('error')
" 2>/dev/null || echo "error")

      echo "[after-run] Review decision: $REVIEW_DECISION (from $PR_NUMBER)"

      # If no formal reviews, check PR comments for review feedback
      if [ "$REVIEW_DECISION" = "no_reviews" ]; then
        COMMENTS_RESPONSE=$(curl -s -X GET \
          -H "Authorization: token $GITHUB_TOKEN" \
          -H "Content-Type: application/json" \
          "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/issues/$PR_NUMBER/comments" \
          --max-time 15 2>/dev/null || echo "[]")
        GITHUB_API_CALLS=${GITHUB_API_CALLS:-0}
GITHUB_API_CALLS=$((GITHUB_API_CALLS + 1))

        REVIEW_DECISION=$(echo "$COMMENTS_RESPONSE" | python3 -c "
import sys, json
import re
try:
    comments = json.load(sys.stdin)
    # Patterns for approval signals in review comments
    approval_pattern = re.compile(r'(?i)(status:\s*approved|✅.*approve|approve.*✅|lgtm|looks good|all checks passed|code review.*approved)', re.DOTALL)
    # Patterns for rejection/changes requested signals
    reject_pattern = re.compile(r'(?i)(status:\s*changes? requested|🔴.*changes? requested|changes?.*🔴|cannot approve|request.*changes|code review.*changes)', re.DOTALL)

    latest_approval = None
    latest_rejection = None

    for c in comments:
        body = c.get('body', '')
        if approval_pattern.search(body):
            latest_approval = c.get('created_at', '')
        if reject_pattern.search(body):
            latest_rejection = c.get('created_at', '')

    if latest_rejection and (not latest_approval or latest_rejection > latest_approval):
        print('changes_requested')
    elif latest_approval and (not latest_rejection or latest_approval > latest_rejection):
        print('approved')
    else:
        print('pending')
except:
    print('pending')
" 2>/dev/null || echo "pending")
        echo "[after-run] Comment-based review decision: $REVIEW_DECISION"
      fi

      if [ "$REVIEW_DECISION" = "approved" ]; then
        TARGET_STATE_ID="$LINEAR_DONE_STATE_ID"
        TARGET_STATE_NAME="Done"
        echo "[after-run] PR approved, merging PR #$PR_NUMBER..."

        # Merge the PR
        MERGE_RESPONSE=$(curl -s -X PUT \
          -H "Authorization: token $GITHUB_TOKEN" \
          -H "Content-Type: application/json" \
          "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/pulls/$PR_NUMBER/merge" \
          --max-time 15 \
          -d "{\"merge_method\":\"squash\",\"commit_title\":\"feat($ISSUE_IDENTIFIER): merge PR #$PR_NUMBER\"}" \
          2>/dev/null || echo "{}")
        GITHUB_API_CALLS=${GITHUB_API_CALLS:-0}
GITHUB_API_CALLS=$((GITHUB_API_CALLS + 1))

        MERGE_SUCCESS=$(echo "$MERGE_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('merged'):
        print('merged')
    else:
        print('failed: ' + str(d.get('message', 'unknown')))
except:
    print('error')
" 2>/dev/null || echo "error")

        if [ "$MERGE_SUCCESS" = "merged" ]; then
          echo "[after-run] PR #$PR_NUMBER merged successfully!"
        else
          # Merge failed - send back to dev to fix
          TARGET_STATE_ID="$LINEAR_IN_PROGRESS_STATE_ID"
          TARGET_STATE_NAME="In Progress"
          MERGE_REASON=$(echo "$MERGE_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('message', 'merge conflict'))
except:
    print('unknown')
" 2>/dev/null || echo "unknown")
          echo "[after-run] PR merge failed ($MERGE_REASON), sending back to In Progress"

          # Add a comment on the PR explaining the conflict so DEV agent knows what to fix
          if [ -n "$PR_NUMBER" ] && [ "$MERGE_REASON" != "unknown" ]; then
            CONFLICT_COMMENT="## ⚠️ Merge Conflict Detected

**Reason**: ${MERGE_REASON}

The PR cannot be merged due to conflicts with the base branch. Please resolve the conflicts by rebasing or merging the base branch into your feature branch.

Automated comment by Symphony Agent."
            curl -s -X POST \
              -H "Authorization: token $GITHUB_TOKEN" \
              -H "Content-Type: application/json" \
              "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/issues/$PR_NUMBER/comments" \
              --max-time 15 \
              -d "$(python3 -c "import json; print(json.dumps({\"body\": '''$CONFLICT_COMMENT'''}))")" \
              2>/dev/null || true
            GITHUB_API_CALLS=${GITHUB_API_CALLS:-0}
GITHUB_API_CALLS=$((GITHUB_API_CALLS + 1))
            echo "[after-run] Added conflict comment on PR #$PR_NUMBER"
          fi
        fi
      elif [ "$REVIEW_DECISION" = "changes_requested" ]; then
        TARGET_STATE_ID="$LINEAR_IN_PROGRESS_STATE_ID"
        TARGET_STATE_NAME="In Progress"
        echo "[after-run] Changes requested, sending back to In Progress"
      else
        # No formal review decision - send back to DEV with review feedback
        # This prevents infinite Review loop when review agent only comments but doesn't approve
        TARGET_STATE_ID="$LINEAR_IN_PROGRESS_STATE_ID"
        TARGET_STATE_NAME="In Progress"
        echo "[after-run] No formal review decision (pending/no reviews), sending back to DEV to address review feedback"
      fi
    else
      TARGET_STATE_ID="$LINEAR_IN_REVIEW_STATE_ID"
      TARGET_STATE_NAME="In Review"
      echo "[after-run] Could not determine PR number, staying in In Review"
    fi
  else
    # PR has conflicts or not approved - send back to dev
    TARGET_STATE_ID="$LINEAR_IN_PROGRESS_STATE_ID"
    TARGET_STATE_NAME="In Progress"
    echo "[after-run] PR needs work, sending back to dev (In Progress)"
  fi

  # If there's a REVIEW_REPORT.md, use its decision to determine state
  if [ -f "REVIEW_REPORT.md" ]; then
    echo "[after-run] Found REVIEW_REPORT.md, posting to Linear..."

    # Extract decision for the comment and state determination
    DECISION_DISPLAY=$(grep "## 评审结果:" REVIEW_REPORT.md | sed 's/.*: //' | tr -d ' ')

    # Parse decision to determine TARGET_STATE
    # APPROVE/approve -> Done, APPROVE_MINOR -> Done, REQUEST_CHANGES_* / REQUEST_TESTS / reject -> In Progress
    case "${DECISION_DISPLAY}" in
      APPROVE|APPROVE_MINOR)
        TARGET_STATE_ID="$LINEAR_DONE_STATE_ID"
        TARGET_STATE_NAME="Done"
        echo "[after-run] Review decision: $DECISION_DISPLAY - PR approved, will merge"
        ;;
      REQUEST_CHANGES_MINOR|REQUEST_CHANGES_MAJOR|REQUEST_TESTS|REJECT)
        TARGET_STATE_ID="$LINEAR_IN_PROGRESS_STATE_ID"
        TARGET_STATE_NAME="In Progress"
        echo "[after-run] Review decision: $DECISION_DISPLAY - needs rework"
        ;;
      *)
        # Default to staying in review if can't parse
        TARGET_STATE_ID="$LINEAR_IN_REVIEW_STATE_ID"
        TARGET_STATE_NAME="In Review"
        echo "[after-run] Review decision: $DECISION_DISPLAY - staying in Review"
        ;;
    esac

    # Build summary from the report
    SUMMARY=$(grep -A3 "## 总结" REVIEW_REPORT.md 2>/dev/null | tail -n +2 | head -3 | tr '\n' ' ' | sed 's/"/\\"/g')

    if [ -n "$DECISION_DISPLAY" ]; then
      COMMENT="## Code Review 🤖 **$DECISION_DISPLAY**

**Summary**: $SUMMARY

*Automated review by Symphony Agent - see REVIEW_REPORT.md for details*"

      postLinearComment "$ISSUE_ID" "$COMMENT"
    fi
  fi
else
  # Dev agent completed - update to In Review for review agent
  TARGET_STATE_ID="$LINEAR_IN_REVIEW_STATE_ID"
  TARGET_STATE_NAME="In Review"
  echo "[after-run] Dev agent completed, updating to In Review"
fi

echo "[after-run] Updating Linear issue $ISSUE_IDENTIFIER from '$CURRENT_STATE' to '$TARGET_STATE_NAME'..."

LINEAR_UPDATE_RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 15 \
  -d "{\"query\": \"mutation { issueUpdate(id: \\\"$ISSUE_ID\\\", input: { stateId: \\\"$TARGET_STATE_ID\\\" }) { success issue { identifier state { name } } } }\"}" 2>/dev/null || echo "{}")
LINEAR_API_CALLS=${LINEAR_API_CALLS:-0}
LINEAR_API_CALLS=$((LINEAR_API_CALLS + 1))

UPDATE_SUCCESS=$(echo "$LINEAR_UPDATE_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    r = d.get('data', {}).get('issueUpdate', {})
    print(r.get('success', False))
except:
    print(False)
" 2>/dev/null || echo "False")

if [ "$UPDATE_SUCCESS" = "True" ]; then
  echo "[after-run] Linear issue $ISSUE_IDENTIFIER updated to '$TARGET_STATE_NAME'."
  FINAL_STATE="$TARGET_STATE_NAME"
else
  echo "[after-run] WARNING: Failed to update Linear issue state."
  echo "[after-run] Response: $LINEAR_UPDATE_RESPONSE"
  FINAL_STATE="$CURRENT_STATE"
fi

echo "[after-run] Done."

# -----------------------------------------------------------------------------
# Output API call statistics for orchestrator parsing
# Format: SYMPHONY_STATS:{"linear_api_calls":N,"github_api_calls":N,"final_state":"..."}
# -----------------------------------------------------------------------------
echo "SYMPHONY_STATS:{\"linear_api_calls\":${LINEAR_API_CALLS},\"github_api_calls\":${GITHUB_API_CALLS},\"final_state\":\"${FINAL_STATE}\"}"
