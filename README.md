# Symphony

这是一个收敛到 `V1` 控制面主链的编码 agent 编排器。

当前仓库只保留这些核心模块：

- `src/cli`：启动入口
- `src/orchestrator`：调度、状态机、重试、清理
- `src/workspace`：`repo source + issue worktree`
- `src/github`：GitHub issue / PR / review 上下文与同步
- `src/database`：`work_items` 为中心的控制面数据层
- `src/server`：runtime API、SSE、最小运行态网页和 bot webhook 入口
- `src/runtime`：用户态运行视图、timeline 聚合、SSE/control plane
- `src/bots`：Telegram / Discord 薄适配层，复用同一套 runtime control plane
- `scripts/claude-adapter.cjs` + `claude-code/`：当前 agent runtime 链路
- `scripts/hooks/*.py`：dev / review 业务后处理

已经移除的旧模块包括：

- 旧 Telegram 专用业务栈
- 旧 React Web Dashboard
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

## 多仓路由

仓库路由现在以 `WORKFLOW.md` 为唯一真相源，不再按 Linear project 名字隐式猜 repo。

示例：

```yaml
repositories:
  routing:
    repo-a:
      github_owner: acme
      github_repo: repo-a
      local_path: ./repos/repo-a
    backend-core:
      github_owner: acme-platform
      github_repo: backend
```

规则：

- `routing` 的 key 必须等于 Linear `project_slug`
- `github_owner` / `github_repo` 必填
- `local_path` 可选；相对路径按当前项目根目录解析
- 未命中路由时会直接阻止 dispatch，不会再回退到 `project_name == repo name` 的旧约定
- 同一个 GitHub repo 被多个 Linear project 复用时，会共享同一个 `source` cache

## Runtime 与聊天端入口

启动 `bun run start -- --port 3000` 后，默认可以直接使用：

- 运行态网页：`/runtime`
- Runtime manifest：`/api/v1/runtime/manifest`
- Runtime overview：`/api/v1/runtime/overview`
- Runtime history replay：`/api/v1/runtime/issues/:id/history`
- Runtime SSE：`/api/v1/runtime/stream`
- Bot manifest：`/api/v1/bots/manifest`
- Telegram webhook：`/api/v1/bots/telegram/webhook`
- Discord interactions：`/api/v1/bots/discord/interactions`

bot 适配层是薄壳，所有 `new/status/watch/unwatch/stop/retry` 命令都复用同一个 runtime control plane，不单独维护第二套业务状态。
Phase 4 之后，runtime/bot 入口还补了这几层产品化能力：

- 权限：可选 `SYMPHONY_RUNTIME_WRITE_TOKEN`，让网页/API 的 `create/stop/retry` 进入读写分离
- 订阅偏好：bot `watch` 支持 `default` / `verbose` / `failures` / `status`，并会持久化到本地 DB，重启后继续生效
- 消息摘要：`status`、watch 通知和网页详情都复用 runtime digest
- 历史回放：基于 `agent_runs` / `review_events` / `sync_events` / `work_items` 提供 replay view
- Operator Copilot：Telegram / Discord 的非命令文本会优先走专用 bot LLM；若后端未配置或不可用，会透明降级到本地 heuristic，并明确提示当前在“简化理解模式”

## 内部 Live Lifecycle 验证

仓库内现在提供了一条内部 CLI，用来拿一张新的 `Todo` issue 真实验证整条主链：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-lifecycle --project-slug 1d3a3f95809d
```

它会自动：

- 按 `WORKFLOW.md -> verification.lifecycle.projects` 创建验证 issue
- 真实跑 `dev -> PR -> review -> merge -> Done`
- 校验 worktree / branch / runtime session / worker cleanup

常用参数：

- `--timeout-ms <n>`
- `--json`
- `--title-suffix <text>`

若验证失败，CLI 会保留现场，并输出 issue、PR、最后 timeline 摘要和 cleanup 状态，便于排查。

可选环境变量：

- `SYMPHONY_RUNTIME_WRITE_TOKEN`
- `SYMPHONY_TELEGRAM_BOT_TOKEN`
- `SYMPHONY_TELEGRAM_WEBHOOK_SECRET`
- `SYMPHONY_TELEGRAM_OPERATOR_IDS`
- `SYMPHONY_BOT_LLM_PROVIDER`
- `SYMPHONY_BOT_LLM_MODEL`
- `SYMPHONY_BOT_LLM_API_KEY`
- `SYMPHONY_BOT_LLM_BASE_URL`
- `SYMPHONY_DISCORD_BOT_TOKEN`
- `SYMPHONY_DISCORD_PUBLIC_KEY`
- `SYMPHONY_DISCORD_OPERATOR_IDS`

`/api/v1/runtime/manifest` 会返回当前 viewer 的 access mode、viewer role 和 Phase 4 feature flags。

`/api/v1/bots/manifest` 会返回每个 transport 的 `inbound_enabled`、`outbound_enabled`、`watch_supported`、`write_requires_operator`、可用 `watch_presets`，以及 bot assistant 的 `configured/healthy/degraded` 诊断，方便 CLI / Web / Telegram / Discord 统一接线。

bot `watch` 的几个常用例子：

- `watch INT-1`
- `watch verbose INT-1`
- `watch failures INT-1`
- `watch status INT-1`

## 控制面数据模型

当前数据库只围绕这些表：

- `work_items`
- `repo_caches`
- `agent_runs`
- `review_events`
- `sync_events`

## 文档

- [Quick Start](/Users/liupenghui/Documents/code/agent/test-cc/QUICKSTART.md)
- [V1 设计稿](/Users/liupenghui/Documents/code/agent/test-cc/docs/2026-04-20-symphony-cloud-e2e-design.md)
- [V1 实施计划](/Users/liupenghui/Documents/code/agent/test-cc/docs/2026-04-20-symphony-cloud-e2e-v1-plan.md)
