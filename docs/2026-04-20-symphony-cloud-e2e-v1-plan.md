# Symphony + Claude Code 云端 E2E V1 实施计划

**日期**: 2026-04-20
**状态**: Draft
**关联设计**: [2026-04-20-symphony-cloud-e2e-design.md](/Users/example/projects/symharix/docs/2026-04-20-symphony-cloud-e2e-design.md)

## 1. V1 目标

V1 的目标不是一次性做成最终云平台，而是先把最关键的主链路做对：

1. 一个 GitHub repo 只保留一个共享源码 cache。
2. 每个 Linear issue 使用独立 worktree，返工复用同一个 worktree。
3. `Linear issue -> GitHub issue -> PR -> workspace` 映射成为系统主线。
4. Dev Agent 只消费 GitHub 工程上下文，不直接参与 Linear 调度。
5. Review Agent 基于 PR 做结构化决策，merge 成功后才把 Linear 更新为 `Done`。
6. 支持返工、冲突、取消、最大尝试次数、完成清理。

## 2. V1 范围与非目标

### 2.1 V1 范围

- 单机单实例 orchestrator
- 轮询驱动，不强依赖 webhook
- SQLite 继续使用，但表结构按未来迁移到 Postgres 的方式设计
- 一个 Linear issue 对应一个 GitHub issue 和一个 active PR
- 一个 repo 下支持多个 issue 并行 worktree
- Dev / Review agent 形成完整闭环

### 2.2 V1 非目标

- 多机分布式调度
- GitHub App 权限体系
- 完整 webhook 事件驱动
- 自动横向扩容 worker pool
- 完整前端控制台重构
- Telegram 流程深度集成

## 3. V1 目标架构

```text
Linear -> Orchestrator -> WorkItem DB
                    -> RepoCache + Worktrees
                    -> GitHub Sync Layer
                    -> Dev Agent
                    -> Review Agent
                    -> HTTP/WS Observability
```

V1 中保留当前几个核心入口：

- [src/orchestrator/index.ts](/Users/example/projects/symharix/src/orchestrator/index.ts)
- [src/workspace/manager.ts](/Users/example/projects/symharix/src/workspace/manager.ts)
- [src/database/schema.ts](/Users/example/projects/symharix/src/database/schema.ts)
- [src/server/index.ts](/Users/example/projects/symharix/src/server/index.ts)

但需要把它们重构成更清晰的模块边界。

## 4. 数据模型变更

### 4.1 保留现有表

V1 先保留现有表以减少回归范围：

- `tasks`
- `workspaces`
- `execution_events`

它们继续服务现有 API 和可视化能力。

### 4.2 新增主表

#### `work_items`

用途：成为控制面的主记录表。

字段：

- `id`
- `linear_issue_id`
- `linear_identifier`
- `linear_title`
- `linear_state`
- `github_repo`
- `github_issue_number`
- `active_pr_number`
- `branch_name`
- `workspace_path`
- `workspace_key`
- `orchestrator_state`
- `dev_attempt_count`
- `review_round`
- `last_review_decision`
- `last_review_summary`
- `cancelled_at`
- `merged_at`
- `created_at`
- `updated_at`

约束：

- `linear_issue_id` 唯一
- `linear_identifier` 唯一
- 同一条记录最多只有一个 `active_pr_number`

#### `repo_caches`

用途：管理 repo 级别共享源码 cache。

字段：

- `id`
- `github_repo`
- `local_source_path`
- `default_branch`
- `last_fetched_at`
- `last_fetch_commit`
- `created_at`
- `updated_at`

约束：

- `github_repo` 唯一

#### `agent_runs`

用途：记录每次 dev/review 执行。

字段：

- `id`
- `work_item_id`
- `agent_type`
- `phase`
- `run_status`
- `input_summary`
- `output_summary`
- `decision`
- `error`
- `started_at`
- `finished_at`

#### `review_events`

用途：结构化保存 review 结论。

字段：

- `id`
- `work_item_id`
- `pr_number`
- `review_round`
- `decision`
- `summary_md`
- `requested_changes_md`
- `merge_block_reason`
- `created_at`

#### `sync_events`

用途：记录写回 GitHub / Linear 的动作和结果。

字段：

- `id`
- `work_item_id`
- `target_system`
- `action`
- `payload_json`
- `result`
- `error`
- `created_at`

### 4.3 V1 数据兼容策略

- `tasks` 暂不删除，继续作为 API 层兼容数据源。
- `work_items` 作为 orchestrator 的新主视图。
- 在 V1 中通过 adapter 保持 `tasks <-> work_items` 同步，避免一次性替换全站读取逻辑。

## 5. 模块拆分方案

### 5.1 数据层

新增：

- `src/database/repositories/workItemRepository.ts`
- `src/database/repositories/repoCacheRepository.ts`
- `src/database/repositories/agentRunRepository.ts`
- `src/database/repositories/reviewEventRepository.ts`
- `src/database/repositories/syncEventRepository.ts`

调整：

- [src/database/repositories/index.ts](/Users/example/projects/symharix/src/database/repositories/index.ts)
  统一导出新仓储

### 5.2 Workspace 层

将当前 [src/workspace/manager.ts](/Users/example/projects/symharix/src/workspace/manager.ts) 拆分为：

- `src/workspace/repoCacheManager.ts`
  负责 repo clone、fetch、reset、main 同步
- `src/workspace/issueWorktreeManager.ts`
  负责 worktree create/reuse/prune/remove
- `src/workspace/manager.ts`
  作为兼容 facade，逐步转为组合式调用

### 5.3 GitHub 集成层

新增：

- `src/github/mappingService.ts`
  管理 GitHub issue / PR / branch 映射
- `src/github/contextService.ts`
  聚合 GitHub issue、PR、reviews、checks 形成 agent 输入上下文
- `src/github/syncService.ts`
  负责结构化写回 GitHub issue / PR

保留并增强：

- [src/github/issue-client.ts](/Users/example/projects/symharix/src/github/issue-client.ts)
- [scripts/lib/github_client.py](/Users/example/projects/symharix/scripts/lib/github_client.py)

### 5.4 Orchestrator 层

将当前 orchestrator 拆出这些职责：

- `IssueDiscoveryService`
  从 Linear 获取候选 issue
- `WorkItemLifecycleService`
  推进 `mapping -> dev -> review -> done/cancelled`
- `LinearSyncService`
  只负责 Linear 状态和 comment 同步
- `AgentDispatchService`
  启动 dev/review agent 并解析结构化结果

V1 不要求物理拆成很多文件，但逻辑上必须按上述边界重构。

### 5.5 Agent 上下文层

新增：

- `src/agent/devContextBuilder.ts`
- `src/agent/reviewContextBuilder.ts`

用途：

- 统一构造 Dev Agent / Review Agent 输入
- 防止未来上下文注入继续散落在 orchestrator 里

## 6. 接口契约

### 6.1 Dev Agent 输入契约

V1 中 Dev Agent 只能接收：

- `github_issue`
- `active_pr`
- `unresolved_review_threads`
- `review_summary`
- `workspace_path`
- `branch_name`

明确不传：

- Linear 自定义字段细节
- Linear 调度状态机内部信息

### 6.2 Dev Agent 输出契约

Dev Agent 运行完成后返回结构化结果：

```json
{
  "ok": true,
  "branch_name": "feature/int-123",
  "pr_number": 42,
  "pr_url": "https://github.com/org/repo/pull/42",
  "summary": "implemented feature X",
  "tests": {
    "status": "passed",
    "summary": "bun test: 18 passed"
  },
  "handover": "markdown summary"
}
```

### 6.3 Review Agent 输入契约

Review Agent 输入：

- `github_issue`
- `pr`
- `checks`
- `review_threads`
- `latest_dev_summary`
- `workspace_path`

### 6.4 Review Agent 输出契约

```json
{
  "decision": "APPROVE | REQUEST_CHANGES | MERGE_BLOCKED",
  "summary": "string",
  "requested_changes": "string | null",
  "merge_block_reason": "string | null",
  "next_action": "merge | retry_dev | wait"
}
```

### 6.5 Orchestrator 内部决策输出

Orchestrator 只认三种 review 结果：

- `APPROVE`
- `REQUEST_CHANGES`
- `MERGE_BLOCKED`

对应动作：

- `APPROVE` -> 尝试 merge -> 成功后 `Linear=Done`
- `REQUEST_CHANGES` -> `Linear=In Progress` -> 复用原 worktree/PR
- `MERGE_BLOCKED` -> `Linear=In Progress` -> Dev 修复阻塞问题

## 7. 迭代顺序

### 迭代 1：控制面数据底座

目标：

- 建好 `work_items / repo_caches / agent_runs / review_events / sync_events`
- 给 orchestrator 提供稳定读写接口

改动：

- 更新 [src/database/schema.ts](/Users/example/projects/symharix/src/database/schema.ts)
- 新增 repository 文件
- 补 repository 单测
- 在 orchestrator 启动时初始化新 schema

验收：

- 可以创建、更新、查询 work item
- 可以记录一次 agent run 和 sync event
- 现有 `tasks` API 不受影响

### 迭代 2：Workspace 重构

目标：

- 正式落地 `repo source + issue worktrees`

改动：

- 拆分当前 workspace manager
- 规范目录结构为：

```text
/workspace/<repo>/source
/workspace/<repo>/worktrees/<linear-key>
```

- 所有 worktree 创建都从 `source` 派生
- 删除分支/复用 worktree 逻辑收口到单一实现

验收：

- 同一个 repo 处理 3 个 issue 时只有一个 `source`
- 3 个 issue 各有独立 worktree
- 返工时 worktree 被复用

### 迭代 3：映射和 GitHub 同步层

目标：

- 建立 `Linear issue -> GitHub issue -> PR` 主映射

改动：

- 实现 `mappingService`
- issue 首次发现时创建 GitHub issue
- PR create/update 后更新 `work_items.active_pr_number`
- 将 PR 摘要写回 GitHub issue

验收：

- 同一 issue 不重复创建 GitHub issue
- 同一 issue 不重复创建多条 active PR
- 映射可从 DB 恢复

### 迭代 4：Dev 流程闭环

目标：

- Dev Agent 基于 GitHub 工程上下文工作

改动：

- 引入 `devContextBuilder`
- Orchestrator 不再把 Linear 直接作为 dev 上下文主来源
- Dev 完成后必须产出 PR 和结构化结果
- Orchestrator 成功写回 `Linear=In Review`

验收：

- issue 从 `Todo/In Progress` 能推进到 `In Review`
- DB 中记录 PR 号、branch、workspace
- Dev 失败会记录 run 和 retry

### 迭代 5：Review 流程闭环

目标：

- Review Agent 驱动 approve / changes requested / merge blocked

改动：

- 引入 `reviewContextBuilder`
- Review 输出结构化决策
- `APPROVE` 时执行 merge
- merge 成功后再更新 `Linear=Done`
- `REQUEST_CHANGES` / `MERGE_BLOCKED` 时回到 `In Progress`

验收：

- review 通过后 merge 成功才 `Done`
- review 打回后复用原 PR 和原 worktree
- merge 冲突会回流 dev，而不是误标 `Done`

### 迭代 6：取消、清理、恢复

目标：

- 完成取消、重试、启动恢复和清理链路

改动：

- 用户取消优先级最高
- 启动时扫描未完成 work item 并恢复
- `Done / Cancelled` 后清理 worktree
- 清理后更新 workspace / work_items 状态

验收：

- 用户将 issue 设为 `Cancelled` 后，运行和重试都停止
- 重启 orchestrator 后能恢复未完成 issue
- `Done` 后对应 worktree 被清理，repo source 保留

## 8. 代码落点建议

### 8.1 第一批文件

- [src/database/schema.ts](/Users/example/projects/symharix/src/database/schema.ts)
- [src/database/repositories/index.ts](/Users/example/projects/symharix/src/database/repositories/index.ts)
- [src/orchestrator/index.ts](/Users/example/projects/symharix/src/orchestrator/index.ts)
- [src/workspace/manager.ts](/Users/example/projects/symharix/src/workspace/manager.ts)

### 8.2 第二批新增文件

- `src/database/repositories/workItemRepository.ts`
- `src/database/repositories/agentRunRepository.ts`
- `src/database/repositories/reviewEventRepository.ts`
- `src/database/repositories/syncEventRepository.ts`
- `src/database/repositories/repoCacheRepository.ts`
- `src/workspace/repoCacheManager.ts`
- `src/workspace/issueWorktreeManager.ts`
- `src/github/mappingService.ts`
- `src/github/contextService.ts`
- `src/github/syncService.ts`
- `src/agent/devContextBuilder.ts`
- `src/agent/reviewContextBuilder.ts`

## 9. 测试计划

### 9.1 单测

- repository CRUD 和唯一约束
- repo cache 和 worktree 目录选择逻辑
- GitHub 映射逻辑
- dev/review context builder 输出
- orchestrator 状态推进

### 9.2 集成测试

覆盖以下场景：

1. `Linear issue -> GitHub issue -> worktree -> PR -> In Review`
2. `Review approve -> merge success -> Done -> cleanup`
3. `Review request changes -> In Progress -> same PR same worktree`
4. `Merge blocked -> In Progress -> retry dev`
5. `User cancel -> stop + cleanup`

### 9.3 回归保护

保留并扩展当前 orchestrator 稳定性测试：

- 不重复派发
- retry 不漂移
- halt 不误触发后处理
- running/claimed 生命周期一致

## 10. API / 可观测性最小改动

V1 不强制重做 server，但建议加最小查询能力：

- `GET /api/v1/work-items`
- `GET /api/v1/work-items/:id`
- `GET /api/v1/work-items/:id/runs`
- `GET /api/v1/work-items/:id/reviews`

现有 [src/server/index.ts](/Users/example/projects/symharix/src/server/index.ts) 可以继续保留 `tasks` 路由，新增 `work-items` 路由作为新控制面视图。

## 11. 风险与缓解

### 风险 1：现有 `tasks` 与 `work_items` 双写造成不一致

缓解：

- 统一通过 adapter 写入
- 只允许 orchestrator 主流程更新 `work_items`
- `tasks` 作为兼容投影，不作为控制面主记录

### 风险 2：Workspace 逻辑重构影响当前开发流程

缓解：

- 先做兼容 facade
- 逐步迁移调用方
- 为 worktree create/reuse/remove 写集成测试

### 风险 3：GitHub issue / PR 映射不稳定

缓解：

- 以 DB 为主映射
- GitHub 查询只做恢复校验，不做唯一真相源

### 风险 4：Review 通过但 merge 失败

缓解：

- 将 `APPROVE` 和 `merge success` 分成两个阶段
- 只有 merge success 才允许写 `Done`

## 12. V1 完成标准

V1 结束时，系统应满足：

1. 一个 repo 同时处理多个 issue 时只保留一个共享源码 cache。
2. 每个 issue 有唯一 worktree，返工复用。
3. GitHub issue 和 PR 映射可查询、可恢复。
4. Dev Agent 基于 GitHub 上下文开发，不直接依赖 Linear 细节。
5. Review Agent 驱动 approve / request changes / merge blocked。
6. merge 成功是 `Done` 的唯一入口。
7. 取消、失败、返工、完成清理都可闭环。

## 13. 实施建议

建议按以下节奏推进：

1. 先做数据库和 workspace 重构。
2. 再做 GitHub 映射和上下文装配。
3. 然后打通 dev 流程。
4. 最后打通 review / merge / cleanup。

这样可以先把最难回滚的底层模型打稳，再逐步替换流程层。
