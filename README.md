# symphonyness

symphonyness is a local-first, Telegram-first control plane for supervised coding work. It turns a user request into a plan, routes it to the right repository, runs the bundled Claude Code runtime under orchestration, and keeps the operator informed through Telegram and the Runtime Deck.

symphonyness 是一个本地优先、Telegram 优先的代码执行控制平面。它会把用户请求变成计划，路由到正确仓库，通过编排层调用内置 Claude Code runtime，并在 Telegram 和 Runtime Deck 中同步关键状态。

## Quick Start / 快速开始

Run setup once:

先执行一次本地初始化：

```bash
bun run setup:local
```

Then fill `.env` and `WORKFLOW.md`.

然后填写 `.env` 和 `WORKFLOW.md`。

Normal local startup is one command:

日常本地启动只需要一个命令：

```bash
bun run start:local
```

`start:local` keeps existing config files, starts the service, prepares Telegram proxy settings, and, when Telegram is configured without a public URL, tries to create a temporary `cloudflared` HTTPS tunnel for this run. It does not write the temporary tunnel URL back into `.env`.

`start:local` 会保留已有配置文件，启动服务，准备 Telegram 代理配置；如果已经配置 Telegram 但没有公网 URL，它会尝试为本次运行创建临时 `cloudflared` HTTPS 隧道。临时隧道地址不会写回 `.env`。

Open the local Runtime Deck:

打开本地 Runtime Deck：

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

More detail:

更多说明：

- [QUICKSTART.md](./QUICKSTART.md): step-by-step local setup / 本地配置步骤。
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md): `.env` and `WORKFLOW.md` reference / 配置参考。
- [docs/AI_OPERATOR_GUIDE.md](./docs/AI_OPERATOR_GUIDE.md): operator guide for maintainers and agents / 维护者与 AI 操作者指南。

## What Runs / 运行链路

```text
Telegram / Runtime / Linear poll
  -> Supervisor session and job loop
  -> Orchestrator
  -> AgentRunner
  -> scripts/claude-adapter.cjs
  -> claude-code/bin/claude-haha
  -> scripts/hooks/dev.py or scripts/hooks/review.py
  -> GitHub / Linear / runtime history
```

Main modules:

主要模块：

- `src/cli`: startup, stop, repair, and live verifier commands / 启停、修复、实时验证命令。
- `src/server`: runtime API, web UI, and bot webhook routes / Runtime API、网页界面、Bot webhook。
- `src/runtime`: issue views, timeline, history, and actions / 工单视图、时间线、历史、操作。
- `src/bots`: Telegram and Discord adapters over the shared control plane / Telegram 与 Discord 适配层。
- `src/supervisor`: Telegram-first assistant sessions, planning, repo understanding, and execution oversight / Telegram 优先的助手会话、计划、仓库理解、执行监督。
- `src/orchestrator`: dispatch, retry, governance, dev/review handoff, and cleanup / 派发、重试、治理、开发/评审交接、清理。
- `src/agent`: Claude Code runner and compact dev context / Claude Code 运行器与压缩开发上下文。
- `src/database`: SQLite schema and repositories / SQLite 表结构与仓库层。
- `scripts/claude-adapter.cjs`: bridge to the bundled Claude Code runtime / 到内置 Claude Code runtime 的桥接。

## Configuration / 配置模型

symphonyness reads three layers:

symphonyness 读取三层配置：

1. `.env`: secrets, API keys, local runtime switches, Telegram tunnel/bootstrap, LLM providers.
   `.env`：密钥、API key、本地运行开关、Telegram 隧道/启动、LLM provider。
2. `WORKFLOW.md`: local orchestration policy, tracker states, repository routing, agent command.
   `WORKFLOW.md`：本地编排策略、Tracker 状态、仓库路由、Agent 命令。
3. Target repo contracts: `.symphony-repo.yaml` and `.symphony-constitution.md`.
   目标仓库契约：`.symphony-repo.yaml` 与 `.symphony-constitution.md`。

The `SYMPHONY_*` prefix and `.symphony-*` filenames are internal contracts. Keep them stable even though the product name is `symphonyness`.

`SYMPHONY_*` 前缀和 `.symphony-*` 文件名是内部兼容契约。即使产品名是 `symphonyness`，这些名字也应保持稳定。

Repository routing is explicit. The key under `repositories.routing` must match the Linear `project_slug`:

仓库路由必须显式配置。`repositories.routing` 下的 key 必须匹配 Linear 的 `project_slug`：

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
```

If a project is not routed, symphonyness fails closed and will not create a workspace or dispatch an agent.

如果项目没有配置路由，symphonyness 会 fail closed，不会创建 workspace，也不会派发 agent。

## Telegram Supervisor / Telegram Supervisor

Telegram is the primary conversational surface. A normal request flows like this:

Telegram 是主要对话入口。一次正常请求大致这样流转：

1. The user sends a natural-language request in Telegram.
   用户在 Telegram 发送自然语言请求。
2. The bot routes the message into the Supervisor.
   Bot 将消息交给 Supervisor。
3. Supervisor inspects runtime, conversation, tracker, and repo context.
   Supervisor 查看 runtime、会话、tracker、仓库上下文。
4. It answers directly, asks for clarification, shows a Plan Card, or requests confirmation for risky writes.
   它会直接回答、追问细节、展示 Plan Card，或对高风险写操作请求确认。
5. After approval, it creates or updates work and lets the Orchestrator execute.
   批准后，它创建或更新工作，并交由 Orchestrator 执行。
6. Telegram edits the lifecycle card instead of posting noisy duplicate messages.
   Telegram 会编辑同一张生命周期卡片，而不是刷出大量重复消息。

Linear and GitHub are records and delivery surfaces. They are not the main clarification or approval surfaces.

Linear 和 GitHub 是记录与交付界面，不是主要澄清或审批界面。

## Required Local Values / 本地必填项

Minimum `.env` values for a real local run:

一次真实本地运行通常至少需要：

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

Recommended bot and supervisor LLM values:

推荐的 Bot 与 Supervisor LLM 配置：

```dotenv
SYMPHONY_BOT_LLM_PROVIDER=anthropic
SYMPHONY_BOT_LLM_MODEL=claude-3-5-sonnet-latest
SYMPHONY_BOT_LLM_API_KEY=...
SYMPHONY_BOT_LLM_HTTP_TRANSPORT=fetch
SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS=45000
```

The Supervisor has two repo-understanding paths:

Supervisor 有两条仓库理解路径：

- LLM planning settings: `SYMPHONY_SUPERVISOR_LLM_*`, with fallback to `SYMPHONY_BOT_LLM_*`.
  计划模型：`SYMPHONY_SUPERVISOR_LLM_*`，未配置时回退到 `SYMPHONY_BOT_LLM_*`。
- Read-only Claude Code advisor: `SYMPHONY_SUPERVISOR_READONLY_ADVISOR_COMMAND` and `SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND`, both defaulting to `node scripts/claude-adapter.cjs`.
  只读 Claude Code 顾问：`SYMPHONY_SUPERVISOR_READONLY_ADVISOR_COMMAND` 与 `SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND`，默认都是 `node scripts/claude-adapter.cjs`。

## Health And Verification / 健康检查与验证

Health check:

健康检查：

```bash
bun run health
```

Key endpoints:

关键端点：

```text
http://localhost:3000/api/v1/runtime/manifest
http://localhost:3000/api/v1/bots/manifest
```

For live Telegram verification, start the service first, then run:

实时 Telegram 验证需要先启动服务，然后运行：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

Use a project/repository where automated issues, branches, PRs, comments, and cleanup are safe.

请使用允许自动创建 issue、branch、PR、comment 和清理动作的项目/仓库。

## Development / 开发检查

```bash
bun run test
bun run build
git diff --check
```

Useful focused suites:

常用定向测试：

```bash
bun test src/bots/gateway.test.ts src/bots/followups.test.ts
bun test src/supervisor/sessionService.test.ts src/supervisor/jobLoop.test.ts
bun test src/orchestrator/index.test.ts
bun test src/verification/attachedLiveSupervisorVerifier.test.ts
```

## Safety Notes / 安全说明

- Do not commit `.env`.
  不要提交 `.env`。
- Do not commit local `WORKFLOW.md` unless the team intentionally changes policy for this checkout.
  除非团队明确要改变本 checkout 的策略，否则不要提交本地 `WORKFLOW.md`。
- Do not bypass Telegram when validating Telegram-first Supervisor behavior.
  验证 Telegram-first Supervisor 时，不要绕过 Telegram 入口。
- Treat runtime proof/evidence success and delivery success separately.
  Runtime 证据成功不等于 PR、branch、tracker 或 merge 交付成功。
