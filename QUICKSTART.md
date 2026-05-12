# symphonyness Quick Start / 快速开始

This guide takes a fresh checkout to a working Runtime Deck and Telegram-first Supervisor flow.

这份指南会把一个全新 checkout 配到可运行的 Runtime Deck 和 Telegram-first Supervisor 流程。

## 0. Fast Path / 最短路径

```bash
bun run setup:local
# edit .env and WORKFLOW.md
bun run start:local
```

`setup:local` installs dependencies and creates `.env` / `WORKFLOW.md` only when they do not already exist.

`setup:local` 会安装依赖，并且只在 `.env` / `WORKFLOW.md` 不存在时才创建它们。

`start:local` reruns the safe setup guard, stops an older local listener on the same port when possible, prepares Telegram proxy settings, pre-provisions a temporary `cloudflared` tunnel when needed, and starts the server.

`start:local` 会重新执行安全初始化检查，在可能时停止同端口的旧本地实例，准备 Telegram 代理配置，在需要时预先创建临时 `cloudflared` 隧道，然后启动服务。

## 1. Install / 安装

```bash
bun run setup:local
```

Required tools:

需要的工具：

- Bun.
- Git and access to the target GitHub repository.
- `cloudflared` only if you want local Telegram webhooks without your own public HTTPS URL.
  如果你没有自己的公网 HTTPS 地址，但想本地接 Telegram webhook，需要安装 `cloudflared`。

## 2. Choose A Target Repository / 选择目标仓库

symphonyness routes Linear projects to GitHub repositories through `WORKFLOW.md`.

symphonyness 通过 `WORKFLOW.md` 把 Linear 项目路由到 GitHub 仓库。

The examples use:

本文示例使用：

```text
Linear project slug: sample-project
GitHub repo: acme/demo-app
```

Configure `WORKFLOW.md`:

配置 `WORKFLOW.md`：

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
```

Rules:

规则：

- The key must match the Linear `project_slug`.
  key 必须匹配 Linear 的 `project_slug`。
- `github_owner` and `github_repo` are required.
  `github_owner` 和 `github_repo` 必填。
- `local_path` is optional. Relative paths resolve from this symphonyness repo.
  `local_path` 可选。相对路径从当前 symphonyness 仓库解析。
- Missing routes fail closed before workspace creation.
  缺失路由会 fail closed，不会创建 workspace。

## 3. Fill `.env` / 填写 `.env`

Minimum local execution:

本地执行最小配置：

```dotenv
SYMPHONY_TRACKER_KIND=linear
SYMPHONY_TRACKER_API_KEY=...
SYMPHONY_TRACKER_PROJECT_SLUG=sample-project
GITHUB_TOKEN=...
ANTHROPIC_API_KEY=...
```

Recommended Claude Code runtime settings:

推荐的 Claude Code runtime 设置：

```dotenv
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1
```

The adapter also defaults the embedded runtime to simple, no background tasks, no auto memory, and read-only when Supervisor launches a read-only session. You normally do not need to set those manually.

adapter 会默认让内置 runtime 使用 simple 模式、关闭后台任务、关闭自动记忆；当 Supervisor 启动只读会话时，会自动进入 read-only。通常不需要手动配置这些值。

## 4. Configure Telegram / 配置 Telegram

Minimum Telegram settings:

Telegram 最小配置：

```dotenv
SYMPHONY_TELEGRAM_BOT_TOKEN=...
SYMPHONY_TELEGRAM_WEBHOOK_SECRET=...
SYMPHONY_TELEGRAM_OPERATOR_IDS=<your-telegram-user-id>
```

Optional operations chat:

可选 operations chat：

```dotenv
SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID=<chat-id>
```

Webhook choices:

Webhook 选项：

- If you have a public HTTPS URL, set `SYMPHONY_PUBLIC_BASE_URL=https://...`.
  如果你有公网 HTTPS 地址，设置 `SYMPHONY_PUBLIC_BASE_URL=https://...`。
- If you do not, leave it empty and install `cloudflared`; `start:local` will try a temporary tunnel.
  如果没有，留空并安装 `cloudflared`；`start:local` 会尝试临时隧道。
- If you manage the webhook yourself, set `SYMPHONY_TELEGRAM_BOOTSTRAP=off`.
  如果你自己管理 webhook，设置 `SYMPHONY_TELEGRAM_BOOTSTRAP=off`。

Useful local tunnel knobs:

常用本地隧道参数：

```dotenv
SYMPHONY_TELEGRAM_TUNNEL_PROTOCOL=http2
SYMPHONY_TELEGRAM_TUNNEL_RETRY_ATTEMPTS=3
SYMPHONY_TELEGRAM_TUNNEL_RETRY_DELAY_MS=1500
SYMPHONY_TELEGRAM_TUNNEL_WATCHDOG_INTERVAL_MS=10000
SYMPHONY_TELEGRAM_TUNNEL_WATCHDOG_DEGRADED_POLLS=2
```

## 5. Configure LLMs / 配置 LLM

Bot natural-language model:

Bot 自然语言模型：

```dotenv
SYMPHONY_BOT_LLM_PROVIDER=anthropic
SYMPHONY_BOT_LLM_MODEL=claude-3-5-sonnet-latest
SYMPHONY_BOT_LLM_API_KEY=...
SYMPHONY_BOT_LLM_TIMEOUT_MS=15000
SYMPHONY_BOT_LLM_HTTP_TRANSPORT=fetch
```

Supervisor planning defaults to bot LLM settings. Override only when needed:

Supervisor 计划默认复用 Bot LLM。只有需要单独模型时才覆盖：

```dotenv
SYMPHONY_SUPERVISOR_LLM_PROVIDER=
SYMPHONY_SUPERVISOR_LLM_MODEL=
SYMPHONY_SUPERVISOR_LLM_API_KEY=
SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS=45000
```

Supervisor agent settings are the newer high-level assistant model knobs. They fall back through `SYMPHONY_SUPERVISOR_CC_*`, `SYMPHONY_SUPERVISOR_LLM_*`, then `SYMPHONY_BOT_LLM_*`.

Supervisor agent 是较新的顶层助手模型配置。它会依次回退到 `SYMPHONY_SUPERVISOR_CC_*`、`SYMPHONY_SUPERVISOR_LLM_*`、再到 `SYMPHONY_BOT_LLM_*`。

```dotenv
SYMPHONY_SUPERVISOR_AGENT_PROVIDER=
SYMPHONY_SUPERVISOR_AGENT_MODEL=
SYMPHONY_SUPERVISOR_AGENT_API_KEY=
SYMPHONY_SUPERVISOR_AGENT_BASE_URL=
SYMPHONY_SUPERVISOR_AGENT_TIMEOUT_MS=45000
```

Read-only repo understanding defaults to the bundled adapter:

只读仓库理解默认使用内置 adapter：

```dotenv
SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND=
SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS=120000
SYMPHONY_SUPERVISOR_READONLY_ADVISOR_COMMAND=
SYMPHONY_SUPERVISOR_READONLY_ADVISOR_TIMEOUT_MS=120000
```

## 6. Start / 启动

```bash
bun run start:local
```

Open:

打开：

```text
http://localhost:3000/runtime
```

Health checks:

健康检查：

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/manifest
curl http://localhost:3000/api/v1/bots/manifest
```

Telegram is ready only when `/api/v1/bots/manifest` shows a non-empty `webhook_url` pointing at the current public base URL.

只有当 `/api/v1/bots/manifest` 显示非空 `webhook_url`，并且它指向当前 public base URL 时，Telegram 才真的接到本地服务。

## 7. Use Telegram / 使用 Telegram

Send a normal request to the bot, for example:

给 Bot 发普通请求，例如：

```text
这个仓库还有文件残余，把它都清空
```

Expected behavior:

预期行为：

1. Telegram receives a lightweight acknowledgement.
   Telegram 收到轻量确认。
2. Supervisor creates or updates one active session for the chat.
   Supervisor 为这个 chat 创建或更新一个 active session。
3. Telegram shows one lifecycle card with native buttons.
   Telegram 展示一张带原生按钮的生命周期卡片。
4. Risky or broad tasks wait for approval before materializing work.
   高风险或范围较大的任务会先等待批准。
5. After approval, symphonyness creates the root issue and runs work through the Orchestrator.
   批准后，symphonyness 创建 root issue，并通过 Orchestrator 执行。
6. Normal lifecycle updates edit the existing card instead of sending duplicates.
   正常生命周期更新会编辑已有卡片，而不是重复发送新卡片。

Useful text actions:

常用文本操作：

- `现在是什么单子？`
- `批准并开始`
- `改一下计划：...`
- `取消当前线程`
- `新开线程：...`
- `重新把这个单子启动下`

## 8. Verify The Full Flow / 验证完整链路

Start the service first, then run attach-mode verification:

先启动服务，再运行 attach-mode 验证：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

The matrix covers:

矩阵覆盖：

- `simple`: Telegram request -> plan/card -> issue -> dev/review/delivery.
- `governed-split`: root plan -> approval -> child queue -> sequential execution.
- `destructive-cleanup`: approval-gated cleanup wording and delivery safety.

Run the lifecycle verifier only when you want the runtime/orchestrator path directly:

只有当你想直接验证 runtime/orchestrator 路径时，才运行 lifecycle verifier：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-lifecycle --project-slug sample-project
```

## 9. Stop And Repair / 停止与修复

Stop local services:

停止本地服务：

```bash
bun run stop
```

Repair persisted bot/GitHub state:

修复持久化的 Bot/GitHub 状态：

```bash
bun src/cli/index.ts repair all
```

Startup repair defaults:

启动修复默认值：

```dotenv
SYMPHONY_BOT_FOLLOWUP_REPAIR_DELAY_MS=5000
SYMPHONY_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS=86400000
SYMPHONY_STARTUP_CLEANUP_DELAY_MS=900000
```

The delays keep cold start responsive and avoid cleanup competing with live verification.

这些延迟能让冷启动更快响应，也避免清理任务和实时验证互相抢资源。

## 10. Troubleshooting / 排障

Telegram messages do not reach local service:

Telegram 消息没有进入本地服务：

- Check `bun run health`.
  检查 `bun run health`。
- Inspect `/api/v1/bots/manifest`.
  查看 `/api/v1/bots/manifest`。
- Confirm `webhook_url` points at the current tunnel or public URL.
  确认 `webhook_url` 指向当前隧道或公网 URL。
- Confirm `SYMPHONY_TELEGRAM_WEBHOOK_SECRET` matches the webhook registration.
  确认 `SYMPHONY_TELEGRAM_WEBHOOK_SECRET` 和 webhook 注册一致。

Bot says the model is unavailable:

Bot 提示模型不可用：

- Confirm `SYMPHONY_BOT_LLM_*` and `SYMPHONY_SUPERVISOR_*` values.
  检查 `SYMPHONY_BOT_LLM_*` 和 `SYMPHONY_SUPERVISOR_*`。
- Keep `SYMPHONY_BOT_LLM_HTTP_TRANSPORT=fetch` unless debugging transport.
  除非在调试网络传输，否则保持 `SYMPHONY_BOT_LLM_HTTP_TRANSPORT=fetch`。
- If Telegram replies but local manifest has no webhook, another deployment may be answering with the same bot token.
  如果 Telegram 有回复但本地 manifest 没有 webhook，可能是另一个部署正在使用同一个 bot token。

Issue created but agent does not run:

Issue 已创建但 agent 没跑：

- Confirm `WORKFLOW.md -> repositories.routing` contains the Linear project slug.
  确认 `WORKFLOW.md -> repositories.routing` 包含 Linear project slug。
- Confirm `codex.command` is `node ./scripts/claude-adapter.cjs`.
  确认 `codex.command` 是 `node ./scripts/claude-adapter.cjs`。
- Check Runtime issue detail for `delivery_code`, `delivery_summary`, and supervisor directives.
  在 Runtime issue detail 中检查 `delivery_code`、`delivery_summary` 和 supervisor directive。

Too many Telegram messages:

Telegram 消息过多：

- Confirm the issue has one active Supervisor root session.
  确认该 issue 只有一个 active Supervisor root session。
- Run `bun src/cli/index.ts repair all`.
  运行 `bun src/cli/index.ts repair all`。
- Inspect `bot_transport_events` and `bot_followup_delivery_states` in SQLite.
  查看 SQLite 中的 `bot_transport_events` 和 `bot_followup_delivery_states`。

## 11. Development Checks / 开发检查

```bash
bun run test
bun run build
git diff --check
```
