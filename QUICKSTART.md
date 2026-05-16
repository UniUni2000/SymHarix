# SymHarix Quick Start

**Language:** English | [Chinese](./QUICKSTART.zh-CN.md)

This guide takes a fresh checkout to a working Runtime Deck and Telegram-first Supervisor flow.

## 0. Fast Path

```bash
bun run setup
# edit .env and WORKFLOW.md
bun run start
```

`setup` installs dependencies and creates `.env` / `WORKFLOW.md` only when they do not already exist.

`start` reruns the safe setup guard, stops an older local listener on the same port when possible, prepares Telegram proxy settings, creates a temporary `cloudflared` tunnel when needed, starts the service, and keeps the temporary tunnel URL in process memory instead of writing it back to `.env`.

If an existing `trycloudflare.com` URL is stale, the startup watchdog can recover with a fresh tunnel when the public URL or Telegram webhook degrades.

## 1. Install Tools

Required:

- Bun.
- Git and access to the target GitHub repository.
- A Linear API key.
- An Anthropic API key for the bundled Claude-compatible runtime.

Optional:

- `cloudflared`, when Telegram webhooks need to reach a local machine without your own public HTTPS URL.
- `sqlite3`, when you want to inspect local diagnostics directly.

Initialize:

```bash
bun run setup
```

Check the bundled runtime when preparing a fresh server or public demo:

```bash
bash scripts/check-runtime.sh
```

## 2. Route Repositories

SymHarix routes Linear projects to GitHub repositories through `WORKFLOW.md`.

Example:

```text
Linear project slug: sample-project
GitHub repo: acme/web-app

Linear project slug: sample-api
GitHub repo: acme/api-service
```

`WORKFLOW.md`:

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: web-app
      # optional:
      # local_path: ./repos/web-app
    sample-api:
      github_owner: acme
      github_repo: api-service
```

Rules:

- The route key must match the Linear `project_slug`.
- `github_owner` and `github_repo` are required.
- `local_path` is optional. Relative paths resolve from this SymHarix repository.
- Missing routes fail closed before workspace creation or agent dispatch.
- `SYMHARIX_TRACKER_PROJECT_SLUG` selects the default route for new Telegram/Runtime-created work.

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

Why these values are needed:

| Setting | How to choose it | Why it exists |
| --- | --- | --- |
| `SYMHARIX_TRACKER_KIND` | Use `linear`. | Selects the tracker backend. SymHarix currently ships with Linear as the supported tracker. |
| `SYMHARIX_TRACKER_API_KEY` | Create a Linear API key with access to the workspace/project you want SymHarix to manage. | Lets the control plane read and update work items, states, and project metadata. |
| `SYMHARIX_TRACKER_PROJECT_SLUG` | Use the Linear project slug that should receive Telegram/Runtime-created work. | Provides the default project for new issues and must match `WORKFLOW.md -> repositories.routing`. |
| `GITHUB_TOKEN` | Use a GitHub token with access to every target repository listed in `WORKFLOW.md`. | Lets SymHarix fetch repository metadata, prepare workspaces, and drive delivery against the right repo. |
| `ANTHROPIC_API_KEY` | Use the API key for the bundled Claude-compatible runtime. | Powers agent execution and read-only repo understanding unless you intentionally override the runtime command. |

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

Why these values are needed:

| Setting | How to choose it | Why it exists |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_BOT_TOKEN` | Create a bot with BotFather and paste its token. Leave blank to disable Telegram. | Enables the Telegram transport and webhook bootstrap. |
| `SYMHARIX_TELEGRAM_WEBHOOK_SECRET` | Use a random secret string. | Lets SymHarix reject webhook calls that do not carry Telegram's secret header. |
| `SYMHARIX_TELEGRAM_OPERATOR_IDS` | Put your Telegram user id, or a comma-separated allowlist. | Restricts write-capable Telegram actions to known operators. |
| `SYMHARIX_PUBLIC_BASE_URL` | For production, use your stable HTTPS domain or named tunnel URL. Leave blank for local temporary tunnel mode. | Gives Telegram a webhook target and gives Mini App buttons an openable HTTPS URL. |
| `SYMHARIX_TELEGRAM_BOOTSTRAP` | Leave blank for automatic webhook registration; set `off` only if you register webhooks yourself. | Controls whether startup calls Telegram `setWebhook`. |

Webhook choices:

- With your own public HTTPS URL, set `SYMHARIX_PUBLIC_BASE_URL=https://...`.
- Without one, leave it empty and install `cloudflared`; `start` will try a temporary tunnel.
- If you manage Telegram webhook registration yourself, set `SYMHARIX_TELEGRAM_BOOTSTRAP=off`.

SymHarix does not require a public IP, but Telegram webhook and Mini App features require a stable publicly reachable HTTPS URL. For production, use a domain with HTTPS reverse proxy or a named Cloudflare Tunnel. Quick trycloudflare.com tunnels are intended for local development and demos, not 24/7 production.

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
bun run start
```

Open:

```text
http://localhost:3000/runtime
```

Use a different port only when needed:

```bash
PORT=4000 bun run start
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

### Linux Server Service

For a real server, do not keep SymHarix running in an SSH foreground shell. Install it as a systemd service:

```bash
bash scripts/install-systemd-service.sh
```

The installer renders `/etc/systemd/system/symharix.service` from the current checkout, starts it immediately, and enables it for reboot. The service keeps running after SSH disconnects.

Useful service commands:

```bash
sudo systemctl status ${SYMHARIX_SERVICE_NAME:-symharix} --no-pager
sudo journalctl -u ${SYMHARIX_SERVICE_NAME:-symharix} -f
sudo systemctl restart ${SYMHARIX_SERVICE_NAME:-symharix}
sudo systemctl stop ${SYMHARIX_SERVICE_NAME:-symharix}
```

Configure `.env` and `WORKFLOW.md` before installing the service. In production, set `SYMHARIX_PUBLIC_BASE_URL` to a stable HTTPS domain or named Cloudflare Tunnel. You can customize install-time values with `SYMHARIX_SERVICE_NAME`, `SYMHARIX_SERVICE_USER`, `SYMHARIX_SERVICE_PORT`, and `SYMHARIX_BUN_BIN`.

## 7. Use Telegram

Send a normal request to the bot:

```text
Find places where this repository's docs and code disagree.
```

Expected behavior:

1. Telegram receives a lightweight acknowledgement.
2. Supervisor creates or resumes one active session for the chat.
3. Supervisor answers, asks a follow-up, or shows a Plan Card.
4. Risky or broad tasks wait for approval.
5. Approved work is created and run through the Orchestrator.
6. Normal lifecycle updates edit the existing card instead of sending duplicate messages.

Useful text actions:

- `What is the current issue?`
- `What repositories are configured?`
- `Switch to the test2 repo`
- `What does the test2 repo do?`
- `Approve and start`
- `Revise the plan: ...`
- `Cancel the current thread`
- `Start a new thread: ...`
- `Retry this issue`

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
- Confirm `agent_runner.command` is `node ./scripts/claude-adapter.cjs`.
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
