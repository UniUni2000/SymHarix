# symphonyness

symphonyness is a local-first, Telegram-first control plane for supervised coding work. A user sends a request in Telegram, the Supervisor turns it into a clear plan, and the Orchestrator runs the bundled Claude Code-compatible runtime against the routed repository.

symphonyness 是一个本地优先、Telegram 优先的代码执行控制平面。用户在 Telegram 里提出需求，Supervisor 将需求整理成清晰计划，Orchestrator 再把任务交给内置的 Claude Code 兼容 runtime 去执行。

## Quick Start / 快速开始

```bash
bun run setup:local
# edit .env and WORKFLOW.md / 编辑 .env 和 WORKFLOW.md
bun run start:local
```

Open the Runtime Deck:

打开 Runtime Deck：

```text
http://localhost:3000/runtime
```

If port `3000` is busy:

如果 `3000` 端口被占用：

```bash
PORT=4000 bun run start:local
```

Stop local services:

停止本地服务：

```bash
bun run stop
```

## What It Does / 它做什么

- Telegram is the main conversation, clarification, and approval surface.
  Telegram 是主要对话、澄清和审批入口。
- Runtime Deck shows local issue state, timelines, diagnostics, and write actions.
  Runtime Deck 展示本地 issue 状态、时间线、诊断信息和写操作。
- Linear stores tracked work, and GitHub stores code, branches, PRs, and review evidence.
  Linear 记录任务，GitHub 记录代码、分支、PR 和评审证据。
- Claude Code-compatible execution runs through `scripts/claude-adapter.cjs`.
  Claude Code 兼容执行链路通过 `scripts/claude-adapter.cjs` 运行。
- Repository routing is explicit and fail-closed.
  仓库路由必须显式配置，缺失时会 fail closed。

## Runtime Flow / 运行链路

```text
Telegram / Runtime Deck / Linear poll
  -> Supervisor session and job loop
  -> Orchestrator
  -> AgentRunner
  -> scripts/claude-adapter.cjs
  -> claude-code/bin/claude-haha
  -> GitHub / Linear / Runtime history
```

Main modules:

主要模块：

- `src/cli`: startup, stop, repair, and live verification commands / 启动、停止、修复和实时验证命令。
- `src/server`: runtime API, web UI, Telegram webhook, and Mini App routes / Runtime API、网页界面、Telegram webhook 和 Mini App 路由。
- `src/bots`: Telegram/Discord adapters and card delivery state / Telegram/Discord 适配与卡片投递状态。
- `src/supervisor`: Telegram-first assistant sessions, planning, repo understanding, and execution oversight / Telegram-first 助手会话、计划、仓库理解和执行监督。
- `src/orchestrator`: dispatch, retry, governance, dev/review handoff, and cleanup / 派发、重试、治理、开发/评审交接和清理。
- `src/agent`: Claude Code-compatible runner and compact dev context / Claude Code 兼容 runner 与压缩开发上下文。
- `src/runtime`: Runtime Deck, issue views, history, Mini App presentation, and actions / Runtime Deck、issue 视图、历史、Mini App 展示和操作。
- `src/database`: SQLite schema and repositories / SQLite 表结构与仓库层。

## Configuration / 配置

symphonyness reads three layers:

symphonyness 读取三层配置：

1. `.env`: secrets, API keys, Telegram, Runtime, and LLM settings.
   `.env`：密钥、API key、Telegram、Runtime 和 LLM 配置。
2. `WORKFLOW.md`: tracker states, repository routing, agent command, verification scenarios.
   `WORKFLOW.md`：tracker 状态、仓库路由、agent 命令、验证场景。
3. Target repo contracts: `.symphony-repo.yaml` and `.symphony-constitution.md`.
   目标仓库契约：`.symphony-repo.yaml` 与 `.symphony-constitution.md`。

Keep internal compatibility names stable: `SYMPHONY_*`, `.symphony-repo.yaml`, and `.symphony-constitution.md` are still contract names.

请保持内部兼容名称稳定：`SYMPHONY_*`、`.symphony-repo.yaml` 和 `.symphony-constitution.md` 仍是契约名称。

Minimum local `.env` values:

本地运行最小 `.env` 配置：

```dotenv
SYMPHONY_TRACKER_KIND=linear
SYMPHONY_TRACKER_API_KEY=...
SYMPHONY_TRACKER_PROJECT_SLUG=sample-project
GITHUB_TOKEN=...
ANTHROPIC_API_KEY=...
```

Minimum Telegram values:

Telegram 最小配置：

```dotenv
SYMPHONY_TELEGRAM_BOT_TOKEN=...
SYMPHONY_TELEGRAM_WEBHOOK_SECRET=...
SYMPHONY_TELEGRAM_OPERATOR_IDS=123456789
```

Example repository route:

仓库路由示例：

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
```

The route key must match the Linear `project_slug`. Missing routes fail closed before workspace creation or agent dispatch.

路由 key 必须匹配 Linear 的 `project_slug`。缺失路由会在创建 workspace 或派发 agent 前 fail closed。

## Telegram Supervisor / Telegram Supervisor

Typical Telegram flow:

典型 Telegram 流程：

1. User sends a natural-language request.
   用户发送自然语言需求。
2. Supervisor answers, asks a follow-up, or presents a Plan Card.
   Supervisor 直接回答、追问细节，或展示 Plan Card。
3. Risky or broad writes wait for approval.
   高风险或大范围写操作等待审批。
4. After approval, work is materialized and executed through the Orchestrator.
   批准后，任务被物化并交给 Orchestrator 执行。
5. Telegram edits the lifecycle card instead of sending noisy duplicate updates.
   Telegram 会编辑生命周期卡片，而不是发送大量重复消息。

Linear and GitHub are records and delivery surfaces; Telegram is the primary user-facing loop.

Linear 和 GitHub 是记录与交付界面；Telegram 是主要用户交互闭环。

## Health / 健康检查

```bash
bun run health
```

Useful endpoints:

常用端点：

```text
http://localhost:3000/api/v1/runtime/manifest
http://localhost:3000/api/v1/bots/manifest
http://localhost:3000/api/v1/runtime/overview
```

For Telegram, trust `/api/v1/bots/manifest`: check `health`, `webhook_url`, `public_base_url`, `mini_app_base_url`, pending updates, and last webhook error.

验证 Telegram 时以 `/api/v1/bots/manifest` 为准：检查 `health`、`webhook_url`、`public_base_url`、`mini_app_base_url`、pending updates 和最后一次 webhook 错误。

## Verification / 验证

Live Telegram-first verification:

Telegram-first 实时验证：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

Local development checks:

本地开发检查：

```bash
bun run test
bun run build
git diff --check
```

## More Docs / 更多文档

- [QUICKSTART.md](./QUICKSTART.md): step-by-step local setup / 本地配置步骤。
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md): `.env` and `WORKFLOW.md` reference / 配置参考。
- [docs/AI_OPERATOR_GUIDE.md](./docs/AI_OPERATOR_GUIDE.md): live-debugging and operator rules / 实时排障和操作者规则。
