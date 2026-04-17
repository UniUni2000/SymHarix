# Symphony E2E Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现从 Linear Issue 分配到 GitHub PR Merge 的完整 E2E 流程

**Architecture:**
- Workspace 结构改为 bare repo + main 工作目录 + 多个 issue worktree
- GitHub Issue 作为主要信息源，Linear 作为备份
- 所有状态更新通过 after-run.sh 或 orchestrator 完成
- REVIEW_REPORT.md 和 DEVELOPMENT_LOG.md 不提交到 git

**Tech Stack:** TypeScript, Bash scripts, GitHub REST API, Linear GraphQL API

---

## File Structure

```
src/
├── github/
│   └── client.ts              # 已有：repoExists, createRepo, getDefaultBranch
│   └── issue-client.ts       # 新建：GitHub Issue 管理
├── tracker/
│   └── linear-client.ts      # 已有：修改 addComment 方法
├── workspace/
│   └── manager.ts            # 修改：bare repo + worktree 结构
├── orchestrator/
│   └── index.ts              # 修改：E2E 流程编排
├── hooks/
│   ├── review-prompt.ts      # 修改：Review Agent prompt
│   └── dev-prompt.ts         # 新建：DEV Agent prompt
├── config/
│   └── loader.ts             # 修改：支持 dev_policy, review_policy
└── linear/
    └── sync.ts               # 新建：Linear 同步工具

scripts/
├── before-run.sh              # 修改：准备 GitHub Issue 上下文
├── after-run.sh              # 修改：PR 创建、状态更新、Review 意见同步
└── cleanup-issue.sh           # 新建：取消/完成后的清理

WORKFLOW.md                    # 修改：添加 dev_policy, review_policy 配置
```

---

### Task 1: 更新 Workspace Manager - Bare Repo 结构

**Files:**
- Modify: `src/workspace/manager.ts`

**Context:** 当前 workspace 结构是 `workspaces/{project}/{issue}/`，需要改为 bare repo + main 工作目录 + worktrees。

**新结构：**
```
workspaces/
├── repos/                    # bare repos
│   └── {project}.git/      # bare repository
└── {project}/               # 主工作目录 (main 分支)
    ├── INT-23/             # issue worktree
    └── INT-24/             # another worktree
```

- [ ] **Step 1: 修改 prepareWorkspace 方法**

在 `src/workspace/manager.ts` 中，更新 `prepareWorkspace` 方法：

```typescript
/**
 * Prepare workspace with bare repo structure
 * 1. Create bare repo if not exists (workspaces/repos/{project}.git)
 * 2. Clone to main working directory (workspaces/{project}/)
 * 3. Create worktree for the issue
 */
async prepareWorkspace(issue: Pick<Issue, 'identifier' | 'project_slug'>): Promise<WorkspaceResult> {
  const projectName = issue.project_slug ? sanitizeWorkspaceKey(issue.project_slug) : 'main';
  const bareRepoPath = path.join(this.workspaceRoot, 'repos', `${projectName}.git`);
  const mainWorkDir = path.join(this.workspaceRoot, projectName);
  const workspaceKey = sanitizeWorkspaceKey(issue.identifier);
  const worktreePath = path.join(mainWorkDir, workspaceKey);

  // Step 1: Create bare repo if not exists
  if (!await this.pathExists(bareRepoPath)) {
    await this.createBareRepo(bareRepoPath);
  }

  // Step 2: Clone to main working directory if not exists
  if (!await this.pathExists(mainWorkDir)) {
    await this.cloneToMain(mainWorkDir, bareRepoPath);
  }

  // Step 3: Create worktree for issue
  const branchName = `feature/${workspaceKey.toLowerCase()}`;
  await this.createWorktree(mainWorkDir, worktreePath, branchName);

  return {
    success: true,
    workspace: {
      path: worktreePath,
      workspace_key: workspaceKey,
      created_now: true,
      git_branch: branchName
    }
  };
}

private async createBareRepo(bareRepoPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(bareRepoPath), { recursive: true });
  await execAsync(`git init --bare "${bareRepoPath}"`);
}

private async cloneToMain(mainWorkDir: string, bareRepoPath: string): Promise<void> {
  await execAsync(`git clone "${bareRepoPath}" "${mainWorkDir}"`);
}
```

- [ ] **Step 2: 添加辅助方法**

```typescript
private async pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

private async createWorktree(mainWorkDir: string, worktreePath: string, branchName: string): Promise<void> {
  // Create worktree with new branch
  await execAsync(`git -C "${mainWorkDir}" worktree add -b "${branchName}" "${worktreePath}"`);
}
```

- [ ] **Step 3: 提交**

```bash
git add src/workspace/manager.ts
git commit -m "feat(workspace): implement bare repo + worktree structure

- Create bare repo in workspaces/repos/{project}.git
- Main working directory in workspaces/{project}/
- Each issue gets own worktree

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: 创建 GitHub Issue Client

**Files:**
- Create: `src/github/issue-client.ts`

**Context:** DEV Agent 需要从 GitHub Issue 获取上下文，需要创建 GitHub Issue 同步 Linear Issue 信息。

- [ ] **Step 1: 创建 GitHubIssueClient 类**

```typescript
// src/github/issue-client.ts
export interface GitHubIssueOptions {
  token: string;
  owner: string;
  repo: string;
}

export interface CreateIssueParams {
  title: string;
  body: string;
  labels?: string[];
}

export class GitHubIssueClient {
  private token: string;
  private owner: string;
  private repo: string;

  constructor(options: GitHubIssueOptions) {
    this.token = options.token;
    this.owner = options.owner;
    this.repo = options.repo;
  }

  async issueExists(issueNumber: number): Promise<boolean> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
      {
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept': 'application/vnd.github.v3+json'
        },
        signal: AbortSignal.timeout(10000)
      }
    );
    return response.status === 200;
  }

  async createIssue(params: CreateIssueParams): Promise<{ number: number; url: string }> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues`,
      {
        method: 'POST',
        headers: {
          'Authorization': `token ${this.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          title: params.title,
          body: params.body,
          labels: params.labels || []
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status !== 201) {
      const error = await response.json();
      throw new Error(`Failed to create issue: ${error.message}`);
    }

    const data = await response.json();
    return { number: data.number, url: data.html_url };
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          'Authorization': `token ${this.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status !== 201) {
      const error = await response.json();
      throw new Error(`Failed to add comment: ${error.message}`);
    }
  }

  async getIssue(issueNumber: number): Promise<{ title: string; body: string; labels: string[] }> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
      {
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept': 'application/vnd.github.v3+json'
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status !== 200) {
      throw new Error(`Issue not found: ${issueNumber}`);
    }

    const data = await response.json();
    return {
      title: data.title,
      body: data.body || '',
      labels: data.labels.map((l: any) => l.name)
    };
  }

  async deleteIssue(issueNumber: number): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `token ${this.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({ state: 'closed' }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status !== 200) {
      throw new Error(`Failed to close issue: ${response.status}`);
    }
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/github/issue-client.ts
git commit -m "feat(github): add GitHubIssueClient for issue management

- issueExists: check if GitHub issue exists
- createIssue: create new issue with title, body, labels
- addComment: add comment to issue
- getIssue: get issue details
- deleteIssue: close issue

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: 更新 Linear Client - 添加评论同步

**Files:**
- Modify: `src/tracker/linear-client.ts`

**Context:** 需要添加方法来同步信息到 Linear（PR 链接、Review 意见、完成评论）。

- [ ] **Step 1: 添加 postComment 方法**

在 `LinearClient` 类中添加：

```typescript
async postComment(issueId: string, body: string): Promise<{ success: boolean; error?: string }> {
  const mutation = `
    mutation IssueCommentCreate($issueId: String!, $body: String!) {
      issueCommentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `;

  const response = await this.graphqlQuery<{ issueCommentCreate: { success: boolean } }>(
    mutation,
    { issueId, body }
  );

  if (response.error) {
    return { success: false, error: response.errorMessage };
  }

  return { success: response.data?.issueCommentCreate?.success || false };
}
```

- [ ] **Step 2: 提交**

```bash
git add src/tracker/linear-client.ts
git commit -m "feat(linear): add postComment method for syncing to Linear

- Used to sync PR links, review feedback, and completion comments

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: 更新 Config Loader - 添加 dev_policy 和 review_policy

**Files:**
- Modify: `src/config/loader.ts`
- Modify: `WORKFLOW.md`

**Context:** 需要在 WORKFLOW.md 中添加 max_dev_attempts 等配置。

- [ ] **Step 1: 更新 ServiceConfig 类型**

在 `src/types.ts` 中添加：

```typescript
export interface ServiceConfig {
  // ... existing fields
  devPolicy: {
    maxDevAttempts: number;
  };
  reviewPolicy: {
    notifyLinearOnReview: boolean;
  };
}
```

- [ ] **Step 2: 更新 buildServiceConfig**

在 `src/config/loader.ts` 中：

```typescript
// Dev policy
const devPolicy = (config.dev_policy as Record<string, unknown>) || {};
const maxDevAttempts = parseNumber(devPolicy.max_dev_attempts, 3);

// Review policy
const reviewPolicy = (config.review_policy as Record<string, unknown>) || {};
const notifyLinearOnReview = reviewPolicy.notify_linear_on_review !== false; // default true
```

在返回值中添加：

```typescript
return {
  // ... existing fields
  devPolicy: { maxDevAttempts },
  reviewPolicy: { notifyLinearOnReview }
};
```

- [ ] **Step 3: 更新 WORKFLOW.md**

在 WORKFLOW.md 中添加：

```yaml
dev_policy:
  max_dev_attempts: 3

review_policy:
  notify_linear_on_review: true
```

- [ ] **Step 4: 提交**

```bash
git add src/types.ts src/config/loader.ts WORKFLOW.md
git commit -m "feat(config): add dev_policy and review_policy configuration

- max_dev_attempts: max DEV retries before giving up
- notify_linear_on_review: sync review feedback to Linear

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: 更新 before-run.sh - 准备 GitHub Issue 上下文

**Files:**
- Modify: `scripts/before-run.sh`

**Context:** DEV Agent 需要从 GitHub Issue 获取上下文，需要在 before-run.sh 中准备上下文文件。

- [ ] **Step 1: 添加 GitHub Issue 上下文准备**

在 `before-run.sh` 中，获取 GitHub Issue 信息并写入 `ISSUE_CONTEXT.md`：

```bash
# Get GitHub issue info for DEV context
fetchGitHubIssue() {
  local issue_number="$1"
  local github_repo="$2"

  # Fetch issue from GitHub
  local issue_response=$(curl -s -X GET \
    "https://api.github.com/repos/${GITHUB_OWNER}/${github_repo}/issues/${issue_number}" \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/json" \
    --max-time 10 2>/dev/null || echo "{}")

  echo "$issue_response"
}

# Write ISSUE_CONTEXT.md with GitHub Issue info
writeIssueContext() {
  local issue_identifier="$1"
  local github_repo="$2"

  # Extract issue number from identifier (e.g., INT-23 -> 23)
  local issue_number=$(echo "$issue_identifier" | grep -oE '[0-9]+$')

  # Fetch GitHub issue
  local issue_data=$(fetchGitHubIssue "$issue_number" "$github_repo")

  # Parse and write context
  local title=$(echo "$issue_data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('title',''))" 2>/dev/null || echo "")
  local body=$(echo "$issue_data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('body',''))" 2>/dev/null || echo "")

  cat > ISSUE_CONTEXT.md << EOF
# Issue Context

**Source:** GitHub Issue #${issue_number}

## Title
${title}

## Description
${body}

## Development Guidelines
- Complete the task as described above
- Write unit tests for your changes
- Ensure all tests pass before submitting
EOF
}
```

在函数末尾调用 `writeIssueContext`。

- [ ] **Step 2: 提交**

```bash
git add scripts/before-run.sh
git commit -m "feat(hooks): prepare GitHub Issue context in before-run

- Fetch GitHub issue and write to ISSUE_CONTEXT.md
- DEV Agent reads this for task context

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: 更新 after-run.sh - PR 创建和状态同步

**Files:**
- Modify: `scripts/after-run.sh`

**Context:** after-run 需要创建 PR、更新 Linear 状态、同步 Review 意见。

- [ ] **Step 1: 更新 after-run.sh 逻辑**

主要更新：
1. 创建 PR 后，更新 Linear → In Review
2. 同步 PR 链接到 Linear 评论
3. 处理 Review 结果（merge、打回等）

```bash
# After PR is created, update Linear state to In Review
updateLinearInReview() {
  local issue_id="$1"
  local pr_url="$2"

  # Update Linear state to In Review
  updateLinearState "$issue_id" "$LINEAR_IN_REVIEW_STATE_ID"

  # Post PR link as comment
  local comment="## PR Created 🤖

PR: ${pr_url}

Automated PR created by Symphony Agent Platform."
  postLinearComment "$issue_id" "$comment"
}

# Handle merge success
handleMergeSuccess() {
  local issue_id="$1"

  # Update Linear state to Done
  updateLinearState "$issue_id" "$LINEAR_DONE_STATE_ID"

  # Post completion comment
  local comment="## Completed ✅

This issue has been completed and merged successfully.

Automated completion by Symphony Agent Platform."
  postLinearComment "$issue_id" "$comment"

  # Cleanup worktree
  cleanupWorktree
}

# Handle review changes requested
handleReviewChanges() {
  local issue_id="$1"
  local review_comments="$2"

  # Update Linear state to In Progress
  updateLinearState "$issue_id" "$LINEAR_IN_PROGRESS_STATE_ID"

  # Sync review comments to Linear
  local comment="## Review Feedback 🔄

${review_comments}

Please address the feedback and resubmit."
  postLinearComment "$issue_id" "$comment"
}
```

- [ ] **Step 2: 提交**

```bash
git add scripts/after-run.sh
git commit -m "feat(hooks): update after-run for PR and state management

- Create PR and update Linear to In Review
- Handle merge success with Done state
- Handle review changes with In Progress state
- Sync comments to Linear

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: 更新 Review Prompt - Review Agent 指令

**Files:**
- Modify: `src/hooks/review-prompt.ts`

**Context:** Review Agent 需要知道如何审阅 PR，如何写 Review 意见。

- [ ] **Step 1: 更新 review-prompt.ts**

```typescript
export function buildReviewPrompt(issue: Issue): string {
  return `You are reviewing a Pull Request for issue: ${issue.identifier}

## Issue Context
Title: ${issue.title}
Description: ${issue.description || 'No description provided'}

## Your Task
1. Review the PR changes thoroughly
2. Check code quality, tests, and consistency
3. Provide constructive feedback
4. Decide: APPROVE, APPROVE_MINOR, REQUEST_CHANGES, or REJECT

## Output Requirements

Write your review to:
1. **GitHub Issue Comment** - Leave feedback as a comment on the GitHub Issue
2. **REVIEW_REPORT.md** - Generate a structured report in the worktree

### REVIEW_REPORT.md Format

\`\`\`markdown
# Code Review Report - ${issue.identifier}

## Summary
[One sentence overview]

##评审结果
APPROVE | APPROVE_MINOR | REQUEST_CHANGES | REQUEST_TESTS | REJECT

## Detailed Feedback
[Bullet points of specific feedback]

## Recommendations
[Actionable suggestions]

## Files Reviewed
- [List of files reviewed]
\`\`\`

## Decision Criteria

- **APPROVE**: Code is ready, no issues found
- **APPROVE_MINOR**: Minor suggestions, not blocking
- **REQUEST_CHANGES**: Significant issues that need fixing
- **REQUEST_TESTS**: Missing tests that should be added
- **REJECT**: Major problems that cannot be resolved

After your review:
- If APPROVE: The system will merge the PR
- If REQUEST_CHANGES: The DEV agent will fix the issues
- If REJECT: The issue will be flagged for human review

Remember:
- Be constructive and specific
- Reference the actual code in your feedback
- Suggest fixes when possible
`;
}
```

- [ ] **Step 2: 提交**

```bash
git add src/hooks/review-prompt.ts
git commit -m "feat(review): update review prompt for E2E flow

- Guide Review Agent to write GitHub Issue comments
- Generate REVIEW_REPORT.md structure
- Clear decision criteria

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: 创建 cleanup-issue.sh - Issue 清理脚本

**Files:**
- Create: `scripts/cleanup-issue.sh`

**Context:** Issue 完成或取消后需要清理 worktree 和 GitHub Issue/PR。

- [ ] **Step 1: 创建清理脚本**

```bash
#!/usr/bin/env bash
# Cleanup script for cancelled/completed issues

set -euo pipefail

ISSUE_IDENTIFIER="${1:-}"
ACTION="${2:-}"  # "cancel" or "done"

if [ -z "$ISSUE_IDENTIFIER" ]; then
  echo "Usage: cleanup-issue.sh <issue-identifier> <cancel|done>"
  exit 1
fi

# Extract project name and issue number
PROJECT_NAME="$(basename "$(dirname "$(pwd)")")"
ISSUE_NUMBER=$(echo "$ISSUE_IDENTIFIER" | grep -oE '[0-9]+$')

# Remove worktree
removeWorktree() {
  local worktree_path="$(pwd)/$ISSUE_IDENTIFIER"
  if [ -d "$worktree_path" ]; then
    git worktree remove "$worktree_path" --force 2>/dev/null || true
    echo "[cleanup] Removed worktree: $worktree_path"
  fi
}

# Close GitHub PR
closeGitHubPR() {
  # Find PR for this issue
  local pr_response=$(curl -s -X GET \
    "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?state=open&head=${GITHUB_OWNER}:feature/${ISSUE_IDENTIFIER}" \
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
      --max-time 10
    echo "[cleanup] Closed PR #${pr_number}"
  fi
}

# Close GitHub Issue
closeGitHubIssue() {
  if [ -n "$ISSUE_NUMBER" ]; then
    curl -s -X PATCH \
      "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues/${ISSUE_NUMBER}" \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"state":"closed"}' \
      --max-time 10
    echo "[cleanup] Closed GitHub Issue #${ISSUE_NUMBER}"
  fi
}

# Execute cleanup
removeWorktree
if [ "$ACTION" = "cancel" ]; then
  closeGitHubPR
  closeGitHubIssue
fi

echo "[cleanup] Done."
```

- [ ] **Step 2: 提交**

```bash
git add scripts/cleanup-issue.sh
git commit -m "feat(hooks): add cleanup-issue.sh for issue lifecycle management

- Remove worktree on cancel or done
- Close GitHub PR and Issue on cancel
- Used by orchestrator after state transitions

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 9: 更新 Orchestrator - E2E 流程编排

**Files:**
- Modify: `src/orchestrator/index.ts`

**Context:** Orchestrator 需要处理 E2E 流程：
1. 分配时创建 GitHub Issue
2. 检测 Review 结果
3. 处理取消
4. 处理完成

- [ ] **Step 1: 更新 Orchestrator 逻辑**

主要更新：

```typescript
// In the issue dispatch logic
async dispatchIssue(issue: Issue) {
  // 1. Determine GitHub repo from project_name
  const repoName = issue.project_name || issue.project_slug || 'main';

  // 2. Check/create GitHub Issue if not exists
  const githubIssueClient = new GitHubIssueClient({
    token: config.githubToken,
    owner: config.githubOwner,
    repo: repoName
  });

  // Extract issue number from identifier (INT-23 -> 23)
  const issueNumber = parseInt(issue.identifier.replace(/[^0-9]/g, ''));

  const issueExists = await githubIssueClient.issueExists(issueNumber);
  if (!issueExists) {
    // Create GitHub Issue with Linear info
    await githubIssueClient.createIssue({
      title: `[${issue.identifier}] ${issue.title}`,
      body: `## Linear Issue\n\n${issue.description || 'No description'}\n\n---\n*Synced from Linear*`,
      labels: issue.labels
    });
  }

  // 3. Create worktree
  await this.workspaceManager.createForIssue(issue);

  // 4. Update Linear to In Progress
  await this.updateLinearState(issue.id, 'In Progress');
}

// Handle Review completion
async handleReviewComplete(issue: Issue, reviewDecision: string) {
  switch (reviewDecision) {
    case 'APPROVE':
    case 'APPROVE_MINOR':
      // Merge PR
      await this.mergePR(issue);
      // Update Linear to Done
      await this.updateLinearState(issue.id, 'Done');
      // Cleanup worktree
      await this.cleanupIssue(issue, 'done');
      break;
    case 'REQUEST_CHANGES':
      // Update Linear to In Progress
      await this.updateLinearState(issue.id, 'In Progress');
      break;
  }
}

// Detect cancelled issues and cleanup
async reconcileIssues() {
  const cancelledIssues = await this.tracker.fetchIssuesByStates(['Cancelled']);
  for (const issue of cancelledIssues.issues) {
    await this.cleanupIssue(issue, 'cancel');
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/orchestrator/index.ts
git commit -m "feat(orchestrator): implement E2E flow orchestration

- Create GitHub Issue on first assignment
- Handle review decisions (approve, request changes)
- Cleanup on cancel or done
- Detect and handle cancelled issues

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 10: 验证 E2E 流程

**Context:** 验证整个 E2E 流程是否正常工作。

- [ ] **Step 1: 确保所有配置正确**

检查 `.env` 包含：
- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `LINEAR_API_KEY`

检查 `WORKFLOW.md` 包含：
```yaml
dev_policy:
  max_dev_attempts: 3

review_policy:
  notify_linear_on_review: true
```

- [ ] **Step 2: 启动 symphony 测试**

```bash
bun run src/cli/index.ts
```

观察日志，确认：
1. Issue 分配时创建 GitHub Issue
2. DEV Agent 获取 GitHub Issue 上下文
3. PR 创建后 Linear 状态更新为 In Review
4. Review 意见同步到 Linear

- [ ] **Step 3: 提交验证结果**

```bash
git add -A
git commit -m "test: verify E2E flow implementation

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Self-Review 检查清单

1. **Spec coverage:**
   - [x] Workspace 结构：bare repo + worktree
   - [x] GitHub Issue 创建和同步
   - [x] Linear 状态管理
   - [x] DEV Agent 上下文获取
   - [x] Review Agent 反馈机制
   - [x] 取消/完成清理
   - [x] 配置项

2. **Placeholder scan:**
   - [x] 无 TBD/TODO

3. **Type consistency:**
   - [x] GitHubIssueClient 方法签名一致
   - [x] LinearClient.postComment 返回类型一致
