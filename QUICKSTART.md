# SymHarix Quick Start / 快速开始

This guide takes a fresh checkout to a working Runtime Deck and Telegram-first Supervisor flow.

这份指南会把一个全新 checkout 配到可运行的 Runtime Deck 和 Telegram-first Supervisor 流程。

## 0. Fast Path / 最短路径

```bash
bun run setup:local
# edit .env and WORKFLOW.md / 编辑 .env 和 WORKFLOW.md
bun run start:local
```

`setup:local` installs dependencies and creates `.env` / `WORKFLOW.md` only when they do not already exist.

`setup:local` 会安装依赖，并且只在 `.env` / `WORKFLOW.md` 不存在时才创建它们。

`start:local` reruns the safe setup guard, stops an older local listener on the same port when possible, prepares Telegram proxy settings, creates a temporary `cloudflared` tunnel when needed, starts the service, and keeps the tunnel URL in process memory rather than writing it back to `.env`.

`start:local` 会重新执行安全初始化检查，在可能时停止同端口旧实例，准备 Telegram 代理配置，在需要时创建临时 `cloudflared` 隧道，启动服务，并且只在当前进程中使用临时隧道地址，不写回 `.env`。

If you already have a stale temporary `trycloudflare.com` URL, `start:local` will probe it and recover with a fresh tunnel when the watchdog sees the public URL or Telegram webhook degrade.

如果当前已有过期的临时 `trycloudflare.com` 地址，`start:local` 会探测它，并在 watchdog 发现公网 URL 或 Telegram webhook 退化时自动换新隧道。

## 1. Install Tools / 安装工具

Required:

必需：

- Bun.
  Bun。
- Git and access to the target GitHub repository.
  Git，以及目标 GitHub 仓库权限。
- A Linear API key.
  Linear API key。
- An Anthropic API key for the bundled Claude Code-compatible runtime.
  用于内置 Claude Code 兼容 runtime 的 Anthropic API key。

Optional:

可选：

- `cloudflared`, if you want Telegram webhooks to reach a local machine without your own public HTTPS URL.
  如果没有自己的公网 HTTPS 地址，但想让 Telegram webhook 进入本机，需要安装 `cloudflared`。
- `sqlite3`, if you want to inspect local diagnostics directly.
  如果想直接检查本地诊断数据，可以安装 `sqlite3`。

Initialize:

初始化：

```bash
bun run setup:local
```

## 2. Route A Repository / 配置仓库路由

SymHarix routes Linear projects to GitHub repositories through `WORKFLOW.md`.

SymHarix 通过 `WORKFLOW.md` 把 Linear 项目路由到 GitHub 仓库。

Example:

示例：

```text
Linear project slug: sample-project
GitHub repo: acme/demo-app
```

`WORKFLOW.md`:

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
      # optional / 可选:
      # local_path: ./repos/demo-app
```

Rules:

规则：

- The route key must match the Linear `project_slug`.
  路由 key 必须匹配 Linear 的 `project_slug`。
- `github_owner` and `github_repo` are required.
  `github_owner` 和 `github_repo` 必填。
- `local_path` is optional. Relative paths resolve from this SymHarix repository.
  `local_path` 可选。相对路径从当前 SymHarix 仓库解析。
- Missing routes fail closed before workspace creation or agent dispatch.
  缺失路由会在创建 workspace 或派发 agent 前 fail closed。

You can add more route entries for a multi-repo workspace. Telegram can list configured repositories, switch the chat default project, and answer repo-reading questions against a named route.

多仓库 workspace 可以继续添加更多 route。Telegram 可以列出已配置仓库、切换当前 chat 的默认项目，并针对指定 route 回答仓库读取问题。

## 3. Fill `.env` / 填写 `.env`

Minimum local execution:

本地执行最小配置：

```dotenv
SYMHARIX_TRACKER_KIND=linear
SYMHARIX_TRACKER_API_KEY=...
SYMHARIX_TRACKER_PROJECT_SLUG=sample-project
GITHUB_TOKEN=...
ANTHROPIC_API_KEY=...
```

Recommended runtime defaults:

推荐 runtime 默认值：

```dotenv
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1
```

Use `SYMHARIX_*` for new environment variables. Legacy `SYMPHONY_*` names, `.symphony-*` repository contracts, and the local `symphony.db` file remain supported for compatibility.

新环境变量请使用 `SYMHARIX_*`。旧的 `SYMPHONY_*` 名称、`.symphony-*` 仓库契约和本地 `symphony.db` 文件仍会为了兼容继续支持。

## 4. Configure Telegram / 配置 Telegram

Minimum Telegram settings:

Telegram 最小配置：

```dotenv
SYMHARIX_TELEGRAM_BOT_TOKEN=...
SYMHARIX_TELEGRAM_WEBHOOK_SECRET=...
SYMHARIX_TELEGRAM_OPERATOR_IDS=<your-telegram-user-id>
```

Webhook choices:

Webhook 选择：

- With your own public HTTPS URL, set `SYMHARIX_PUBLIC_BASE_URL=https://...`.
  如果有自己的公网 HTTPS 地址，设置 `SYMHARIX_PUBLIC_BASE_URL=https://...`。
- Without one, leave it empty and install `cloudflared`; `start:local` will try a temporary tunnel.
  如果没有，留空并安装 `cloudflared`；`start:local` 会尝试临时隧道。
- If you manage Telegram webhook registration yourself, set `SYMHARIX_TELEGRAM_BOOTSTRAP=off`.
  如果你自己管理 Telegram webhook 注册，设置 `SYMHARIX_TELEGRAM_BOOTSTRAP=off`。

Useful local knobs:

常用本地参数：

```dotenv
SYMHARIX_PROXY_MODE=auto
SYMHARIX_TELEGRAM_TUNNEL_PROTOCOL=http2
SYMHARIX_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS=6
SYMHARIX_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS=60
```

## 5. Configure LLMs / 配置 LLM

For richer Telegram natural-language behavior:

为了获得更好的 Telegram 自然语言体验：

```dotenv
SYMHARIX_BOT_LLM_PROVIDER=anthropic
SYMHARIX_BOT_LLM_MODEL=claude-3-5-sonnet-latest
SYMHARIX_BOT_LLM_API_KEY=...
SYMHARIX_BOT_LLM_HTTP_TRANSPORT=fetch
```

Supervisor planning defaults to the bot LLM. Override only when you need a separate model:

Supervisor 计划默认复用 Bot LLM。只有需要单独模型时才覆盖：

```dotenv
SYMHARIX_SUPERVISOR_LLM_PROVIDER=
SYMHARIX_SUPERVISOR_LLM_MODEL=
SYMHARIX_SUPERVISOR_LLM_API_KEY=
SYMHARIX_SUPERVISOR_LLM_TIMEOUT_MS=45000
```

Read-only repo understanding defaults to the bundled adapter:

只读仓库理解默认使用内置 adapter：

```dotenv
SYMHARIX_SUPERVISOR_TOOL_ROUTER_TIMEOUT_MS=12000
SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND=
SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND=
```

Blank command values use `node scripts/claude-adapter.cjs`. The tool-router timeout is capped at 60000 ms.

命令留空时使用 `node scripts/claude-adapter.cjs`。tool-router timeout 上限为 60000 ms。

## 6. Start / 启动

```bash
bun run start:local
```

Open:

打开：

```text
http://localhost:3000/runtime
```

Use a different local port only when needed:

只在需要时更换本地端口：

```bash
PORT=4000 bun run start:local
PORT=4000 bun run health
```

If you set `SYMHARIX_RUNTIME_WRITE_TOKEN`, enter the same token in the Runtime Deck token field before using write actions.

如果设置了 `SYMHARIX_RUNTIME_WRITE_TOKEN`，使用 Runtime Deck 写操作前需要在 token 输入框填写同一个 token。

Health checks:

健康检查：

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/manifest
curl http://localhost:3000/api/v1/bots/manifest
```

Telegram is ready only when `/api/v1/bots/manifest` shows a healthy Telegram transport and a non-empty `webhook_url` pointing at the current public base URL.

只有当 `/api/v1/bots/manifest` 显示 Telegram transport healthy，并且 `webhook_url` 非空且指向当前 public base URL 时，Telegram 才真正接到本地服务。

The local service being up is not enough for Telegram: confirm the public tunnel, webhook URL, pending update count, and last webhook error in that manifest.

本地服务启动不等于 Telegram 可用：还需要在该 manifest 里确认公网隧道、webhook URL、pending update count 和最后一次 webhook error。

## 7. Use Telegram / 使用 Telegram

Send a normal request to the bot, for example:

给 Bot 发普通请求，例如：

```text
帮我看一下这个仓库还有哪些文档和代码不一致
```

Expected behavior:

预期行为：

1. Telegram receives a lightweight acknowledgement.
   Telegram 收到轻量确认。
2. Supervisor creates or resumes one active session for the chat.
   Supervisor 为这个 chat 创建或恢复一个 active session。
3. Supervisor answers, asks a follow-up, or shows a Plan Card.
   Supervisor 直接回答、追问细节，或展示 Plan Card。
4. Risky or broad tasks wait for approval.
   高风险或范围较大的任务会等待批准。
5. After approval, SymHarix creates work and runs it through the Orchestrator.
   批准后，SymHarix 创建任务，并通过 Orchestrator 执行。
6. Normal lifecycle updates edit the existing card instead of sending duplicates.
   正常生命周期更新会编辑已有卡片，而不是重复发送新卡片。

Useful text actions:

常用文本操作：

- `现在是什么单子？`
- `有哪些仓库？`
- `切到 test2 仓库`
- `test2 仓库主要做什么？`
- `批准并开始`
- `改一下计划：...`
- `取消当前线程`
- `新开线程：...`
- `重新把这个单子启动下`

## 8. Verify / 验证

Start the service first, then run Telegram attach-mode verification:

先启动服务，再运行 Telegram attach-mode 验证：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

The matrix covers simple, governed split, and destructive-cleanup approval flows.

矩阵会覆盖 simple、governed split 和 destructive-cleanup 审批流程。

Use the runtime/orchestrator verifier only when you intentionally bypass Telegram:

只有明确要绕过 Telegram 验证 runtime/orchestrator 路径时，才使用：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-lifecycle --project-slug sample-project
```

## 9. Stop And Repair / 停止与修复

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
SYMHARIX_BOT_FOLLOWUP_REPAIR_DELAY_MS=5000
SYMHARIX_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS=86400000
SYMHARIX_STARTUP_CLEANUP_DELAY_MS=900000
SYMHARIX_FIRST_TICK_DELAY_MS=10000
```

## 10. Troubleshooting / 排障

Telegram messages do not reach local service:

Telegram 消息没有进入本地服务：

- Check `bun run health`.
  检查 `bun run health`。
- Inspect `/api/v1/bots/manifest`.
  查看 `/api/v1/bots/manifest`。
- Confirm `webhook_url` points at the current tunnel or public URL.
  确认 `webhook_url` 指向当前隧道或公网 URL。
- If Telegram replies but local manifest has no webhook, another deployment may be answering with the same bot token.
  如果 Telegram 有回复但本地 manifest 没有 webhook，可能是另一个部署正在使用同一个 bot token。

Bot says the model is unavailable:

Bot 提示模型不可用：

- Confirm `SYMHARIX_BOT_LLM_*` and `SYMHARIX_SUPERVISOR_*`.
  检查 `SYMHARIX_BOT_LLM_*` 和 `SYMHARIX_SUPERVISOR_*`。
- Keep `SYMHARIX_BOT_LLM_HTTP_TRANSPORT=fetch` unless debugging transport.
  除非在调试网络传输，否则保持 `SYMHARIX_BOT_LLM_HTTP_TRANSPORT=fetch`。

Issue created but agent does not run:

Issue 已创建但 agent 没跑：

- Confirm `WORKFLOW.md -> repositories.routing` contains the Linear project slug.
  确认 `WORKFLOW.md -> repositories.routing` 包含 Linear project slug。
- Confirm `codex.command` is `node ./scripts/claude-adapter.cjs`.
  确认 `codex.command` 是 `node ./scripts/claude-adapter.cjs`。
- Confirm `ANTHROPIC_API_KEY` is available to the service process.
  确认 service process 能读取 `ANTHROPIC_API_KEY`。
- Check Runtime issue detail for `delivery_code`, `delivery_summary`, and supervisor directives.
  在 Runtime issue detail 中检查 `delivery_code`、`delivery_summary` 和 supervisor directive。

Review passed but delivery is blocked:

Review 通过但交付阻塞：

- Check Runtime issue detail for `delivery_code=merge_blocked`.
  在 Runtime issue detail 中检查 `delivery_code=merge_blocked`。
- Open the active PR from the Runtime Deck or Mini App and resolve the merge blocker there.
  从 Runtime Deck 或 Mini App 打开 active PR，并在 PR 里处理 merge blocker。
- After the blocker is fixed, retry the issue or let the operator decide whether to close/supersede it.
  blocker 修复后，重试该 issue，或由操作者决定关闭/替换。

Too many Telegram messages:

Telegram 消息过多：

- Confirm the issue has one active Supervisor root session.
  确认该 issue 只有一个 active Supervisor root session。
- Run `bun src/cli/index.ts repair all`.
  运行 `bun src/cli/index.ts repair all`。
- Inspect `bot_transport_events`, `bot_followup_delivery_states`, and `bot_followup_message_states` in SQLite.
  查看 SQLite 中的 `bot_transport_events`、`bot_followup_delivery_states` 和 `bot_followup_message_states`。

## 11. Development Checks / 开发检查

```bash
bun run test
bun run build
git diff --check
```
