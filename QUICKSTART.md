# symphonyness Quick Start

This guide gets a local operator from a fresh checkout to a working Runtime Deck and Telegram-first Supervisor flow.

## 1. Install

```bash
bun install
cp .env.example .env
cp WORKFLOW.md.example WORKFLOW.md
```

## 2. Choose The Target Repository

symphonyness routes Linear projects to GitHub repositories through `WORKFLOW.md`.

The examples in this guide use placeholder values:

```text
Linear project slug: sample-project
GitHub repo: acme/demo-app
```

In `WORKFLOW.md`, configure:

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
```

If an issue's Linear `project_slug` is not listed in `repositories.routing`, symphonyness fails closed: it will not create a workspace or dispatch an agent.

## 3. Fill `.env`

Minimum local execution:

```dotenv
SYMPHONY_TRACKER_KIND=linear
SYMPHONY_TRACKER_API_KEY=...
SYMPHONY_TRACKER_PROJECT_SLUG=sample-project
ANTHROPIC_API_KEY=...
```

If your GitHub integration uses the GitHub CLI or a token-backed app, make sure it is available in the same shell environment that starts symphonyness.

Recommended Claude Code runtime settings:

```dotenv
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1
```

## 4. Configure Telegram

Minimum Telegram settings:

```dotenv
SYMPHONY_TELEGRAM_BOT_TOKEN=...
SYMPHONY_TELEGRAM_WEBHOOK_SECRET=...
SYMPHONY_TELEGRAM_OPERATOR_IDS=<your-telegram-user-id>
```

Optional operations chat:

```dotenv
SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID=<chat-id>
```

Webhook options:

- If you have a public HTTPS URL, set `SYMPHONY_PUBLIC_BASE_URL=https://...`.
- If you do not, leave it empty and install `cloudflared`; symphonyness will try to create a temporary tunnel.
- If you want to manage Telegram webhook yourself, set `SYMPHONY_TELEGRAM_BOOTSTRAP=off`.

Default tunnel protocol:

```dotenv
SYMPHONY_TELEGRAM_TUNNEL_PROTOCOL=http2
```

## 5. Configure LLMs

Bot natural-language parsing:

```dotenv
SYMPHONY_BOT_LLM_PROVIDER=anthropic
SYMPHONY_BOT_LLM_MODEL=claude-3-5-sonnet-latest
SYMPHONY_BOT_LLM_API_KEY=...
SYMPHONY_BOT_LLM_TIMEOUT_MS=15000
SYMPHONY_BOT_LLM_HTTP_TRANSPORT=fetch
```

Supervisor planning defaults to bot LLM settings. Override only if needed:

```dotenv
SYMPHONY_SUPERVISOR_LLM_PROVIDER=
SYMPHONY_SUPERVISOR_LLM_MODEL=
SYMPHONY_SUPERVISOR_LLM_API_KEY=
SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS=45000
```

Supervisor execution overseer defaults to supervisor LLM settings, then bot LLM settings:

```dotenv
SYMPHONY_SUPERVISOR_OVERSEER_PROVIDER=
SYMPHONY_SUPERVISOR_OVERSEER_MODEL=
SYMPHONY_SUPERVISOR_OVERSEER_API_KEY=
SYMPHONY_SUPERVISOR_OVERSEER_TIMEOUT_MS=30000
```

Use `SYMPHONY_BOT_LLM_HTTP_TRANSPORT=fetch` for normal use. `auto` is useful for HTTP-client compatibility debugging but can double worst-case latency.

## 6. Start

```bash
bun run start -- --port 3000
```

Open:

```text
http://localhost:3000/runtime
```

Health endpoints:

```bash
curl http://localhost:3000/api/v1/runtime/manifest
curl http://localhost:3000/api/v1/bots/manifest
```

## 7. Use Telegram

Send a normal request to the bot, for example:

```text
这个仓库还有文件残余，把它都清空
```

Expected behavior:

1. Telegram receives a lightweight acknowledgement.
2. Supervisor creates or updates one active session for the chat.
3. Simple tasks get a compact plan and may auto-run.
4. Larger or risky tasks show a Plan Card and wait for approval.
5. After approval, symphonyness creates a root issue and, if needed, a sequential child queue.
6. Only the current child runs; queued children wait.
7. Telegram reports high-signal milestones, not every internal retry/status tick.

Useful text actions:

- `现在是什么单子？`
- `批准并开始`
- `改一下计划：...`
- `取消当前线程`
- `新开线程：...`
- `重新把这个单子启动下`

## 8. Verify The Full Flow

Start the service first, then run attach-mode live verification:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

The matrix covers:

- `simple`: Telegram request -> Plan Card/auto plan -> issue -> dev/review/delivery.
- `governed-split`: root plan -> approval -> child queue -> sequential execution.
- `destructive-cleanup`: approval-gated cleanup wording and delivery safety.

Run the legacy lifecycle verifier only when you want to test the runtime/orchestrator path directly:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-lifecycle --project-slug sample-project
```

## 9. Stop And Repair

Stop all local symphonyness processes:

```bash
bun run start -- --kill
```

Repair stale bot/GitHub state:

```bash
bun src/cli/index.ts repair all
```

Startup repair defaults:

```dotenv
SYMPHONY_BOT_FOLLOWUP_REPAIR_DELAY_MS=5000
SYMPHONY_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS=86400000
SYMPHONY_STARTUP_CLEANUP_DELAY_MS=900000
```

The delays keep cold start responsive and avoid cleanup competing with active live verification.

## 10. Troubleshooting

Telegram messages send but buttons do nothing:

- Check `/api/v1/bots/manifest`.
- Check Telegram webhook diagnostics in logs.
- Confirm public URL/tunnel is reachable by Telegram.
- Confirm `SYMPHONY_TELEGRAM_WEBHOOK_SECRET` matches the registered webhook path.

Bot says the model is unavailable:

- Confirm `SYMPHONY_BOT_LLM_*` values.
- Keep transport as `fetch` unless debugging.
- Check provider latency and timeout logs.
- The deterministic fallback should still route clear create/status/retry requests.

Issue created but agent does not run:

- Confirm `WORKFLOW.md -> repositories.routing` contains the issue's Linear project slug.
- Confirm the route points to the intended GitHub repo.
- Confirm `codex.command` points to `node ./scripts/claude-adapter.cjs`.
- Check runtime issue detail for `delivery_code`, `delivery_summary`, and latest supervisor directive.

Too many Telegram messages:

- Confirm the issue has one active Supervisor root session.
- Run `bun src/cli/index.ts repair all`.
- Check `bot_transport_events` and `bot_followup_delivery_states` in SQLite to see whether sends are new, edits, or fallback sends.

## 11. Development Checks

```bash
bun run test
bun run build
git diff --check
```
