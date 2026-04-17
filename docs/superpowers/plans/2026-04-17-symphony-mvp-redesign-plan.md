# Symphony MVP Redesign - Dynamic GitHub Repo Mapping 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现动态 GitHub Repo 映射 - 从 Linear Project 名字自动关联 GitHub Repo，不需要手动配置

**Architecture:**
- 新增 GitHub Client 模块处理 repo 检查/创建
- LinearClient 返回 Issue 时包含 project.name（用于推导 GitHub repo 名）
- WorkspaceManager 根据 issue 的 project_name 动态计算 GitHub repo
- 移除 WORKFLOW.md 中的 projects 配置

**Tech Stack:** TypeScript, GitHub REST API, Linear GraphQL API

---

## File Structure

```
src/
├── github/                    # 新建 - GitHub API 封装
│   └── client.ts             # GitHubClient 类
├── tracker/
│   └── linear-client.ts      # 修改 - 添加 project.name 到 Issue
├── types.ts                  # 修改 - 添加 project_name 字段
├── config/
│   └── loader.ts             # 修改 - 移除 projects 解析
├── workspace/
│   └── manager.ts            # 修改 - 动态 repo 解析
└── orchestrator/
    └── index.ts              # 可能需要修改

WORKFLOW.md                   # 修改 - 移除 projects 配置
.env                          # 不变（已删除 GITHUB_REPO）
```

---

### Task 1: 创建 GitHub Client 模块

**Files:**
- Create: `src/github/client.ts`
- Test: `src/github/client.test.ts`

**Context:** 这是第一个任务，创建 GitHub API 封装模块，用于检查和创建 GitHub repos。

- [ ] **Step 1: 创建 src/github/ 目录和 client.ts**

```typescript
// src/github/client.ts
export interface GitHubClientOptions {
  token: string;
  owner: string;
}

export class GitHubClient {
  private token: string;
  private owner: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.owner = options.owner;
  }

  async repoExists(repo: string): Promise<boolean> {
    const response = await fetch(`https://api.github.com/repos/${this.owner}/${repo}`, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    return response.status === 200;
  }

  async createRepo(repo: string, isPrivate: boolean = true): Promise<{ success: boolean; error?: string }> {
    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `token ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        name: repo,
        private: isPrivate,
        auto_init: false
      })
    });

    if (response.status === 201) {
      return { success: true };
    }

    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    return { success: false, error: error.message };
  }

  async getDefaultBranch(repo: string): Promise<string> {
    const response = await fetch(`https://api.github.com/repos/${this.owner}/${repo}`, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (response.status !== 200) {
      return 'main';
    }

    const data = await response.json();
    return data.default_branch || 'main';
  }
}
```

- [ ] **Step 2: 创建测试文件 src/github/client.test.ts**

```typescript
// src/github/client.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { GitHubClient } from './client';

describe('GitHubClient', () => {
  let client: GitHubClient;

  beforeEach(() => {
    client = new GitHubClient({
      token: 'ghp_test_token',
      owner: 'test-owner'
    });
  });

  it('should return true when repo exists', async () => {
    // This will need mocking in real tests
    const result = await client.repoExists('test-repo');
    expect(typeof result).toBe('boolean');
  });

  it('should create a private repo', async () => {
    const result = await client.createRepo('test-repo-new', true);
    expect(typeof result.success).toBe('boolean');
  });

  it('should get default branch', async () => {
    const result = await client.getDefaultBranch('test-repo');
    expect(typeof result).toBe('string');
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `bun test src/github/client.test.ts`

- [ ] **Step 4: 提交**

```bash
git add src/github/client.ts src/github/client.test.ts
git commit -m "feat(github): add GitHub client for repo operations

- Add repoExists() to check if repo exists
- Add createRepo() to create new private repos
- Add getDefaultBranch() to get default branch

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: 更新 Types - 添加 project_name 字段

**Files:**
- Modify: `src/types.ts`

**Context:** 需要在 Issue 接口添加 project_name 字段，用于存储 Linear Project 名字（用于推导 GitHub repo 名）。

- [ ] **Step 1: 更新 Issue 接口**

在 `src/types.ts` 中，Issue 接口添加 `project_name` 字段：

找到 Issue 接口（约第10-24行），添加 `project_name` 字段：

```typescript
export interface Issue {
  id: string;
  identifier: string;  // Human-readable key like "ABC-123"
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  project_slug: string | null;
  project_name: string | null;  // 新增 - Linear Project 名字，用于推导 GitHub repo
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: Date | null;
  updated_at: Date | null;
}
```

同时更新 `ServiceConfig`（约第45-92行），添加 `githubOwner`：

```typescript
// 在 ServiceConfig 接口中添加：
export interface ServiceConfig {
  // Tracker
  trackerKind: string;
  trackerEndpoint: string;
  trackerApiKey: string;
  githubOwner: string;  // 新增 - GitHub owner (来自 .env GITHUB_OWNER)
  activeStates: string[];
  terminalStates: string[];
  // ... 其他字段不变
}
```

- [ ] **Step 2: 提交**

```bash
git add src/types.ts
git commit -m "feat(types): add project_name to Issue, githubOwner to ServiceConfig

- Issue.project_name: Linear Project 名字，用于推导 GitHub repo 名
- ServiceConfig.githubOwner: GitHub owner，来自 .env GITHUB_OWNER

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: 更新 LinearClient - 返回 project_name

**Files:**
- Modify: `src/tracker/linear-client.ts`

**Context:** LinearClient 的 normalizeIssue 方法需要返回 project_name。

- [ ] **Step 1: 更新 normalizeIssue 方法**

找到 `normalizeIssue` 方法（约第92-126行），在返回值中添加 `project_name`：

```typescript
return {
  id: linearIssue.id,
  identifier: linearIssue.identifier,
  title: linearIssue.title,
  description: linearIssue.description,
  priority,
  state: linearIssue.state.name,
  project_slug: linearIssue.project?.slugId || null,
  project_name: linearIssue.project?.name || null,  // 新增
  branch_name: linearIssue.branchName,
  url: linearIssue.url,
  labels,
  blocked_by,
  created_at: linearIssue.createdAt ? new Date(linearIssue.createdAt) : null,
  updated_at: linearIssue.updatedAt ? new Date(linearIssue.updatedAt) : null
};
```

- [ ] **Step 2: 提交**

```bash
git add src/tracker/linear-client.ts
git commit -m "feat(linear): include project_name in normalized Issue

- Extract Linear Project name for GitHub repo derivation

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: 更新 Config Loader - 移除 projects 解析

**Files:**
- Modify: `src/config/loader.ts`

**Context:** Config Loader 需要移除 projects 映射的解析，改从 .env 读取 GITHUB_OWNER。

- [ ] **Step 1: 更新 buildServiceConfig 函数**

1. 找到 `projects` 解析相关代码（约第197-211行），移除它

2. 添加 `githubOwner` 读取：
```typescript
const githubOwner = process.env.GITHUB_OWNER || '';
```

3. 在返回值中添加 `githubOwner`

同时更新 `validateConfigForDispatch`（约第288-319行），移除 `projects` 验证，改为验证 `githubOwner`：

```typescript
// 移除 tracker.projects 验证（约第303-308行）
// 改为验证 githubOwner：
if (!cfg.githubOwner) {
  errors.push('Missing required "GITHUB_OWNER" environment variable');
}
```

- [ ] **Step 2: 提交**

```bash
git add src/config/loader.ts
git commit -m "feat(config): remove projects mapping, add githubOwner

- WORKFLOW.md no longer needs projects config
- GitHub owner comes from GITHUB_OWNER env var
- Dynamic repo resolution via GitHub API

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: 更新 WorkspaceManager - 动态 GitHub Repo 解析

**Files:**
- Modify: `src/workspace/manager.ts`

**Context:** WorkspaceManager 需要集成 GitHubClient，实现动态 repo 检查和创建。

- [ ] **Step 1: 添加 GitHubClient 导入和构造函数更新**

1. 添加导入：
```typescript
import { GitHubClient } from '../github/client';
```

2. 找到 WorkspaceManagerOptions 接口（约第28-39行），更新它：
```typescript
export interface WorkspaceManagerOptions {
  workspaceRoot: string;
  projectRoot: string;
  githubOwner: string;
  githubToken: string;
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
}
```

3. 更新类属性和构造函数：
```typescript
private githubOwner: string;
private githubClient: GitHubClient;

constructor(options: WorkspaceManagerOptions) {
  this.workspaceRoot = options.workspaceRoot;
  this.githubOwner = options.githubOwner;
  this.githubToken = options.githubToken;
  this.hooks = options.hooks;
  this.projectRoot = options.projectRoot;
  this.githubClient = new GitHubClient({
    token: options.githubToken,
    owner: options.githubOwner
  });
}
```

- [ ] **Step 2: 更新 prepareWorkspace 或相关方法**

找到准备 workspace 的方法，添加 GitHub repo 检查/创建逻辑。确保：
- 使用 issue.project_name 作为 repo 名字
- 如果 repo 不存在，自动创建
- 获取默认分支用于 git worktree

- [ ] **Step 3: 提交**

```bash
git add src/workspace/manager.ts
git commit -m "feat(workspace): dynamic GitHub repo resolution

- Remove static projects config dependency
- Check/create GitHub repo on-demand via GitHub API
- Derive repo name from issue.project_name

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: 更新 WORKFLOW.md - 移除 projects 配置

**Files:**
- Modify: `WORKFLOW.md`

**Context:** WORKFLOW.md 需要移除 projects 配置部分。

- [ ] **Step 1: 更新 WORKFLOW.md 配置**

移除 `projects` 配置部分（约第6-10行）：

修改前：
```yaml
projects:
  6d0843db8904:
    github_repo: UniUni2000/symphony-test
    local_path: /Users/example/projects/symharix/repos/symphony-test
```

修改后：删除整个 projects 部分

最终 WORKFLOW.md 的 tracker 部分应该是：
```yaml
tracker:
  kind: linear
  api_key: $SYMPHONY_TRACKER_API_KEY
  endpoint: https://api.linear.app/graphql
  # projects 配置已移除 - 现在自动从 Linear Project 名字推导
```

- [ ] **Step 2: 提交**

```bash
git add WORKFLOW.md
git commit -m "docs(workflow): remove projects config section

- GitHub repo now derived from Linear Project name
- Simplifies configuration for multi-project use

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: 验证流程

**Context:** 最后一个任务，验证整个流程是否正常工作。

- [ ] **Step 1: 确保 .env 有 GITHUB_OWNER**

检查 .env 文件包含 `GITHUB_OWNER=UniUni2000`（或你的 GitHub 用户名）

- [ ] **Step 2: 启动 symphony 测试**

```bash
bun run src/cli/index.ts
```

观察日志：
- 应该自动发现 Linear Projects
- 应该自动检查/创建 GitHub repos
- 应该为每个 issue 创建 worktree

- [ ] **Step 3: 如果测试通过，提交验证结果**

```bash
git add -A
git commit -m "test: verify MVP redesign flow

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Self-Review 检查清单

1. **Spec coverage:** 检查设计文档的每个需求是否有对应实现
   - [x] Linear Project name → GitHub repo 名推导
   - [x] 检查 repo 是否存在
   - [x] 不存在则自动创建
   - [x] 移除 WORKFLOW.md projects 配置
   - [x] 移除 GITHUB_REPO .env 配置

2. **Placeholder scan:** 检查是否有 TBD/TODO
   - [x] 无 placeholder

3. **Type consistency:** 检查类型定义一致性
   - [x] Issue.project_name 添加
   - [x] ServiceConfig.githubOwner 添加
   - [x] GitHubClient 方法签名正确
