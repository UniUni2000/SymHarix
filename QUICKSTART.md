# SymHarix Quick Start

**Language:** English | [中文](./QUICKSTART.zh-CN.md)

This guide takes a fresh checkout to a working Runtime Deck and Telegram-first Supervisor flow.

## 0. Fast Path

```bash
bun run setup:local
# edit .env and WORKFLOW.md
bun run start:local
```

`setup:local` installs dependencies and creates `.env` / `WORKFLOW.md` only when they do not already exist.

`start:local` reruns the safe setup guard, stops an older local listener on the same port when possible, prepares Telegram proxy settings, creates a temporary `cloudflared` tunnel when needed, starts the service, and keeps the temporary tunnel URL in process memory instead of writing it back to `.env`.

If an existing `trycloudflare.com` URL is stale, the startup watchdog can recover with a fresh tunnel when the public URL or Telegram webhook degrades.

## 1. Install Tools

Required:

- Bun.
- Git and access to the target GitHub repository.
- A Linear API key.
- An Anthropic API key for the bundled Claude Code-compatible runtime.

Optional:

- `cloudflared`, when Telegram webhooks need to reach a local machine without your own public HTTPS URL.
- `sqlite3`, when you want to inspect local diagnostics directly.

Initialize:

```bash
bun run setup:local
```

## 2. Route A Repository

SymHarix routes Linear projects to GitHub repositories through `WORKFLOW.md`.

Example:

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
      # optional:
      # local_path: ./repos/demo-app
```

Rules:

- The route key must match the Linear `project_slug`.
- `github_owner` and `github_repo` are required.
- `local_path` is optional. Relative paths resolve from this SymHarix repository.
- Missing routes fail closed before workspace creation or agent dispatch.

You can add more route entries for a multi-repo workspace. Telegram can list configured repositories, switch the chat default project, and answer repo-reading questions against a named route.

## 3. Fill `.env`

Minimum local execution:

```dotenv
SYMHARIX_TRACKER_KIND=linear
SYMHARIX_TRACKER_API_KEY=...
SYMHARIX_TRACKER_PROJECT_SLUG=sample-project
GITHUB_TOKEN=...
ANTHROPIC_API_KEY=...
```

Recommended runtime defaults:

```dotenv
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1
```

Use `SYMHARIX_*` for new environment variables. Legacy `SYMPHONY_*` names, `.symphony-*` repository contracts, and the local `symphony.db` file remain supported for compatibility.

## 4. Configure Telegram

Minimum Telegram settings:

```dotenv
SYMHARIX_TELEGRAM_BOT_TOKEN=...
SYMHARIX_TELEGRAM_WEBHOOK_SECRET=...
SYMHARIX_TELEGRAM_OPERATOR_IDS=<your-telegram-user-id>
```

Webhook choices:

- With your own public HTTPS URL, set `SYMHARIX_PUBLIC_BASE_URL=https://...`.
- Without one, leave it empty and install `cloudflared`; `start:local` will try a temporary tunnel.
- If you manage Telegram webhook registration yourself, set `SYMHARIX_TELEGRAM_BOOTSTRAP=off`.

Useful local knobs:

```dotenv
SYMHARIX_PROXY_MODE=auto
SYMHARIX_TELEGRAM_TUNNEL_PROTOCOL=http2
SYMHARIX_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS=6
SYMHARIX_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS=60
```

## 5. Configure LLMs

For richer Telegram natural-language behavior:

```dotenv
SYMHARIX_BOT_LLM_PROVIDER=anthropic
SYMHARIX_BOT_LLM_MODEL=claude-3-5-sonnet-latest
SYMHARIX_BOT_LLM_API_KEY=...
SYMHARIX_BOT_LLM_HTTP_TRANSPORT=fetch
```

Supervisor planning defaults to the bot LLM. Override only when you need a separate model:

```dotenv
SYMHARIX_SUPERVISOR_LLM_PROVIDER=
SYMHARIX_SUPERVISOR_LLM_MODEL=
SYMHARIX_SUPERVISOR_LLM_API_KEY=
SYMHARIX_SUPERVISOR_LLM_TIMEOUT_MS=45000
```

Read-only repo understanding defaults to the bundled adapter:

```dotenv
SYMHARIX_SUPERVISOR_TOOL_ROUTER_TIMEOUT_MS=12000
SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND=
SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND=
```

Blank command values use `node scripts/claude-adapter.cjs`. The tool-router timeout is capped at `60000` ms.

## 6. Start

```bash
bun run start:local
```

Open:

```text
http://localhost:3000/runtime
```

Use a different port only when needed:

```bash
PORT=4000 bun run start:local
PORT=4000 bun run health
```

If you set `SYMHARIX_RUNTIME_WRITE_TOKEN`, enter the same token in the Runtime Deck token field before using write actions.

Health checks:

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/manifest
curl http://localhost:3000/api/v1/bots/manifest
```

Telegram is ready only when `/api/v1/bots/manifest` shows a healthy Telegram transport and a non-empty `webhook_url` pointing at the current public base URL.

## 7. Use Telegram

Send a normal request to the bot:

```text
帮我看一下这个仓库还有哪些文档和代码不一致
```

Expected behavior:

1. Telegram receives a lightweight acknowledgement.
2. Supervisor creates or resumes one active session for the chat.
3. Supervisor answers, asks a follow-up, or shows a Plan Card.
4. Risky or broad tasks wait for approval.
5. Approved work is created and run through the Orchestrator.
6. Normal lifecycle updates edit the existing card instead of sending duplicate messages.

Useful text actions:

- `现在是什么单子？`
- `有哪些仓库？`
- `切到 test2 仓库`
- `test2 仓库主要做什么？`
- `批准并开始`
- `改一下计划：...`
- `取消当前线程`
- `新开线程：...`
- `重新把这个单子启动下`

## 8. Verify

Start the service first, then run Telegram attach-mode verification:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

The matrix covers simple, governed split, and destructive-cleanup approval flows.

Use the runtime/orchestrator verifier only when you intentionally bypass Telegram:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-lifecycle --project-slug sample-project
```

## 9. Stop And Repair

```bash
bun run stop
```

Repair persisted bot/GitHub state:

```bash
bun src/cli/index.ts repair all
```

Startup repair defaults:

```dotenv
SYMHARIX_BOT_FOLLOWUP_REPAIR_DELAY_MS=5000
SYMHARIX_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS=86400000
SYMHARIX_STARTUP_CLEANUP_DELAY_MS=900000
SYMHARIX_FIRST_TICK_DELAY_MS=10000
```

## 10. Troubleshooting

Telegram messages do not reach local service:

- Check `bun run health`.
- Inspect `/api/v1/bots/manifest`.
- Confirm `webhook_url` points at the current tunnel or public URL.
- If Telegram replies but the local manifest has no webhook, another deployment may be answering with the same bot token.

Bot says the model is unavailable:

- Confirm `SYMHARIX_BOT_LLM_*` and `SYMHARIX_SUPERVISOR_*`.
- Keep `SYMHARIX_BOT_LLM_HTTP_TRANSPORT=fetch` unless debugging transport.

Issue created but agent does not run:

- Confirm `WORKFLOW.md -> repositories.routing` contains the Linear project slug.
- Confirm `codex.command` is `node ./scripts/claude-adapter.cjs`.
- Confirm `ANTHROPIC_API_KEY` is available to the service process.
- Check Runtime issue detail for `delivery_code`, `delivery_summary`, and supervisor directives.

Review passed but delivery is blocked:

- Check Runtime issue detail for `delivery_code=merge_blocked`.
- Open the active PR from Runtime Deck or Mini App and resolve the merge blocker there.
- After the blocker is fixed, retry the issue or let the operator decide whether to close/supersede it.

Too many Telegram messages:

- Confirm the issue has one active Supervisor root session.
- Run `bun src/cli/index.ts repair all`.
- Inspect `bot_transport_events`, `bot_followup_delivery_states`, and `bot_followup_message_states` in SQLite.

## 11. Development Checks

```bash
bun run test
bun run build
git diff --check
```
