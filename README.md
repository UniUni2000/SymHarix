# Symphony

这是一个收敛到 `V1` 控制面主链的编码 agent 编排器。

当前仓库只保留这些核心模块：

- `src/cli`：启动入口
- `src/orchestrator`：调度、状态机、重试、清理
- `src/workspace`：`repo source + issue worktree`
- `src/github`：GitHub issue / PR / review 上下文与同步
- `src/database`：`work_items` 为中心的控制面数据层
- `src/server`：最小只读 API，提供 `health` 和 `work-items`
- `scripts/claude-adapter.cjs` + `claude-code/`：当前 agent runtime 链路
- `scripts/hooks/*.py`：dev / review 业务后处理

已经移除的旧模块包括：

- Telegram Bot
- React Web Dashboard
- 旧 `tasks / events / reviews` 数据模型
- 旧 `task` API、`stats` API、WebSocket runtime
- 重复的 `main.ts` 全量启动入口

## 运行

```bash
bun install
bun run start
```

开发模式：

```bash
bun run dev
```

测试：

```bash
bun run test
```

## Agent 执行链

当前 agent 的真实执行路径是：

```text
Orchestrator
  -> AgentRunner
  -> codex.command
  -> scripts/claude-adapter.cjs
  -> claude-code/bin/claude-haha
```

默认 `WORKFLOW.md` 里 `codex.command` 指向 `node ./scripts/claude-adapter.cjs`。

## 控制面数据模型

当前数据库只围绕这些表：

- `work_items`
- `repo_caches`
- `agent_runs`
- `review_events`
- `sync_events`

## 文档

- [Quick Start](/Users/example/projects/symharix/QUICKSTART.md)
- [V1 设计稿](/Users/example/projects/symharix/docs/2026-04-20-symphony-cloud-e2e-design.md)
- [V1 实施计划](/Users/example/projects/symharix/docs/2026-04-20-symphony-cloud-e2e-v1-plan.md)
