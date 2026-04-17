# Symphony E2E Flow Design - DEV/REVIEW/MERGE

> **Goal:** 设计从 Linear Issue 分配到 GitHub PR Merge 的完整 E2E 流程

---

## 1. Workspace 架构

```
workspaces/
├── repos/                        # bare repos (共享仓库)
│   └── {project}.git/           # bare repository
└── {project}/                   # 主工作目录 (main 分支)
    ├── INT-23/                 # issue worktree
    ├── INT-24/                 # another worktree
    └── INT-25/                 # yet another
```

**设计要点：**
- 所有 issue 共用同一个 bare git repo
- 每个 active issue 单独一个 worktree（通过 git worktree 实现）
- 互不干扰，节省空间
- 主工作目录用于 bare repo 的本地克隆

---

## 2. GitHub Repo 与 Issue 映射

### 2.1 GitHub Repo
- 名称由 Linear Project name 决定（已在之前的设计中实现）
- 存储在 `workspaces/repos/{project}.git`

### 2.2 GitHub Issue
- **创建时机**：Issue 第一次被分配时
- **创建规则**：检查 GitHub Issue 是否存在，不存在则创建
- **信息同步**：完整同步 Linear Issue 信息
  - Title、description、labels
  - Priority、assignee 等
- **后续管理**：以 GitHub Issue 为准，Linear 仅作为备份

---

## 3. Linear 状态管理

**只在关键节点更新 Linear 状态：**

| 触发事件 | Linear 状态变化 | 说明 |
|---------|----------------|------|
| DEV 开始开发 | Todo → In Progress | |
| DEV 提交 PR | In Progress → In Review | |
| Review 通过 + Merge 成功 | In Review → Done | 添加完成评论 |
| Review 打回 / Merge 冲突 | In Review → In Progress | |
| 用户取消 | (已由用户操作) | 立即清理 |

---

## 4. E2E 流程详解

### 4.1 Issue 分配 (Todo → In Progress)

```
1. Orchestrator 从 Linear 获取 Todo/In Progress 状态的 issues
2. 对每个 issue：
   a. 确定对应的 project_name → GitHub repo
   b. 检查 GitHub Repo 是否存在，不存在则创建
   c. 检查 GitHub Issue 是否存在，不存在则创建（完整同步 Linear 信息）
   d. 创建 worktree + feature 分支
   e. 更新 Linear → In Progress
3. DEV Agent 开始工作
```

### 4.2 DEV 开发阶段

**上下文获取（优先级）：**
1. GitHub Issue（主要）
2. Linear Issue（备用，如 priority 等字段）

**DEV Agent 工作：**
- 在 worktree 中开发
- 生成 DEVELOPMENT_LOG.md（不提交，单独管理）
- 完成后提交 PR

### 4.3 PR 提交 (In Progress → In Review)

```
1. DEV Agent 提交 PR
2. after-run hook 执行：
   a. git commit & push 分支
   b. 创建 GitHub PR
   c. 更新 Linear → In Review
   d. 同步 PR 链接到 Linear Issue 评论
3. Review Agent 开始工作
```

### 4.4 Review 审阅阶段

**Review Agent 上下文：**
- GitHub PR（diff、files changed）
- GitHub Issue（描述、历史评论）

**Review Agent 工作：**
1. 读取 PR diff 和 GitHub Issue
2. 生成 REVIEW_REPORT.md（不提交，单独管理）
3. 写 GitHub Issue 评论（评审意见）
4. 同步 Review 意见到 Linear Issue 评论

### 4.5 Review 结果处理

**通过 (APPROVE/APPROVE_MINOR)：**
```
1. Review Agent 触发 merge
2. merge 成功：
   a. 更新 Linear → Done
   b. 添加完成评论到 Linear
   c. 清理 worktree
   d. 拉取最新 main
3. merge 失败（冲突）：
   a. 更新 Linear → In Progress
   b. DEV Agent 读取冲突信息
   c. 解决冲突，重新提交 PR
```

**打回 (REQUEST_CHANGES)：**
```
1. Review Agent 写评审意见到 GitHub Issue 评论
2. 同步评审意见到 Linear Issue 评论
3. 更新 Linear → In Progress
4. DEV Agent 下次工作时：
   a. 读取 GitHub Issue 评论中的评审意见
   b. 读取 REVIEW_REPORT.md
   c. 在 worktree 中继续修改
   d. 重新提交 PR
5. 重复直到通过或达到 max_dev_attempts
```

**达到最大重试次数：**
- 停止 DEV Agent
- 通知用户（如通过 Telegram）
- 用户手动处理

### 4.6 用户取消 Issue

**触发条件：** 用户在 Linear 取消 issue

**处理流程：**
```
1. Orchestrator 检测到 Linear Issue 状态为 Cancelled
2. 立即清理：
   a. 删除 issue 的 worktree
   b. 删除 GitHub Issue
   c. 删除相关的 PR（如有）
3. 不再分配给任何 Agent
```

### 4.7 Done 后清理

**触发条件：** PR merge 成功，Linear Issue 标记为 Done

**处理流程：**
```
1. 删除 issue 的 worktree
2. 拉取最新 main 到主工作目录
3. 在 Linear Issue 下添加完成评论
4. 代码已在 main 分支，保留在仓库中
```

---

## 5. 文件管理

### 5.1 不提交的文件

以下文件由 Agent 生成，但**不提交到 git**：
- `DEVELOPMENT_LOG.md` - 开发日志
- `REVIEW_REPORT.md` - 审阅报告
- `.mcp.json` - MCP 配置
- `ISSUE_CONTEXT.md` - Issue 上下文

### 5.2 提交的文件

只有代码文件、配置文件等需要提交的才会上传到 GitHub。

---

## 6. 配置项

在 WORKFLOW.md 中新增配置：

```yaml
dev_policy:
  max_dev_attempts: 3          # DEV Agent 最大重试次数

review_policy:
  notify_linear_on_review: true  # Review 意见同步到 Linear
```

---

## 7. 关键问题回顾

| 问题 | 决策 |
|------|------|
| Workspace 架构 | workspaces/{project}/{issue}/ 每个 issue 单独 worktree |
| GitHub Issue 创建 | 第一次分配时创建，完整同步 Linear 信息 |
| DEV Agent 上下文 | GitHub Issue 为主，Linear Issue 备用 |
| Linear 状态管理 | 只在关键节点更新 |
| Review 意见传达 | GitHub Issue 评论 + REVIEW_REPORT.md |
| 最大重试次数 | 可配置，默认 3 |
| 用户取消处理 | 清理 worktree + 删除 GitHub Issue/PR |
| Done 后处理 | 清理 worktree + Linear 完成评论 |

---

## 8. Out of Scope (v1)

- Linear Issue 创建（只同步已有的 Issue）
- GitHub Issue 删除后的恢复
- 并发冲突检测（多个 worktree 同时修改同一文件）
