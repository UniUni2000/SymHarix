# symphonyness Configuration Guide

This guide explains what to put in `.env` and `WORKFLOW.md`.

## Configuration Layers

symphonyness reads configuration from three places:

1. `.env`
   - Secrets and local runtime switches.
   - Never commit this file.
2. `WORKFLOW.md`
   - Local orchestration policy.
   - Repository routing.
   - Agent command.
   - Usually local/private because it can be environment-specific.
3. Target repository contracts
   - `.symphony-repo.yaml`
   - `.symphony-constitution.md`
   - These belong to the target repo, not the symphonyness global config.

Environment variables currently keep the `SYMPHONY_` prefix for compatibility with existing deployments.

## `.env`

Start from:

```bash
bun run setup:local
```

`setup:local` installs dependencies if needed and creates `.env` and `WORKFLOW.md` from their examples when they do not exist. Existing local files are left untouched.

After `.env` and `WORKFLOW.md` are filled once, use the one-command local loop:

```bash
bun run start:local
```

That command reruns the setup guard and starts the server. It does not overwrite existing local config.

### Tracker

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMPHONY_TRACKER_KIND` | yes | Currently `linear`. |
| `SYMPHONY_TRACKER_API_KEY` | yes | Linear API key. |
| `SYMPHONY_TRACKER_PROJECT_SLUG` | recommended | Default Linear project slug for bot/runtime creation. |

Example:

```dotenv
SYMPHONY_TRACKER_PROJECT_SLUG=sample-project
```

### Claude Code Runtime

| Variable | Required | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Used by the bundled Claude Code runtime. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | recommended | Keeps startup/context lighter. |
| `CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH` | recommended | Avoids broad startup prefetch. |

Recommended:

```dotenv
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1
```

The runtime command normally comes from `WORKFLOW.md`:

```yaml
codex:
  command: node ./scripts/claude-adapter.cjs
```

That adapter invokes the bundled Claude Code path, including `claude-code/bin/claude-haha`.

### Runtime Write Token

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMPHONY_RUNTIME_WRITE_TOKEN` | optional | Protects runtime write actions. Without it, local development can run in a simpler operator mode. |

When configured, pass it as the runtime access token in the web UI or API calls.

### Telegram

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMPHONY_TELEGRAM_BOT_TOKEN` | for Telegram | Bot token from BotFather. |
| `SYMPHONY_TELEGRAM_WEBHOOK_SECRET` | recommended | Shared secret in Telegram webhook path/header checks. |
| `SYMPHONY_TELEGRAM_OPERATOR_IDS` | recommended | Comma-separated Telegram user ids allowed to perform write actions. |
| `SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID` | optional | Chat that receives operations summaries when distinct from origin chats. |
| `SYMPHONY_PUBLIC_BASE_URL` | optional | Public HTTPS base URL for webhook registration. |
| `SYMPHONY_TELEGRAM_BOOTSTRAP` | optional | Set to `off` to disable automatic webhook/tunnel bootstrap. |
| `SYMPHONY_TELEGRAM_TUNNEL_COMMAND` | optional | Override tunnel command. Default expects `cloudflared`. |
| `SYMPHONY_TELEGRAM_TUNNEL_PROTOCOL` | optional | Default `http2`. |

Recommended local setup:

```dotenv
SYMPHONY_TELEGRAM_BOT_TOKEN=...
SYMPHONY_TELEGRAM_WEBHOOK_SECRET=...
SYMPHONY_TELEGRAM_OPERATOR_IDS=123456789
SYMPHONY_TELEGRAM_TUNNEL_PROTOCOL=http2
```

Use an existing public URL when possible:

```dotenv
SYMPHONY_PUBLIC_BASE_URL=https://your-host.example.com
```

If `SYMPHONY_PUBLIC_BASE_URL` is empty and bootstrap is not off, symphonyness can start a temporary tunnel in two ways:

- `bun run start:local`: pre-provisions a temporary `cloudflared` URL before the app starts and injects it for that run.
- Other startup paths: fall back to in-process webhook/tunnel bootstrap.

If no tunnel is available, the service still starts, but Telegram inbound will not work.

After startup, confirm Telegram really points at this process:

```bash
curl http://localhost:3000/api/v1/bots/manifest
```

Healthy Telegram ingress should show a non-empty `webhook_url` ending in `/api/v1/bots/telegram/webhook`. If `webhook_url` is empty, messages in the Telegram app are not reaching this local server. In that case either set `SYMPHONY_PUBLIC_BASE_URL=https://...` to a reachable HTTPS host, or install `cloudflared` and leave `SYMPHONY_PUBLIC_BASE_URL` empty so local auto-tunnel bootstrap can run.

### Bot LLM

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMPHONY_BOT_LLM_PROVIDER` | for natural language | `anthropic` or `openai`. |
| `SYMPHONY_BOT_LLM_MODEL` | for natural language | Model name. |
| `SYMPHONY_BOT_LLM_API_KEY` | for natural language | Provider key. |
| `SYMPHONY_BOT_LLM_BASE_URL` | optional | OpenAI-compatible/self-hosted endpoint. |
| `SYMPHONY_BOT_LLM_TIMEOUT_MS` | optional | Default `15000`. |
| `SYMPHONY_BOT_LLM_HTTP_TRANSPORT` | optional | `fetch`, `curl`, or `auto`. |

Recommended:

```dotenv
SYMPHONY_BOT_LLM_PROVIDER=anthropic
SYMPHONY_BOT_LLM_MODEL=claude-3-5-sonnet-latest
SYMPHONY_BOT_LLM_API_KEY=...
SYMPHONY_BOT_LLM_TIMEOUT_MS=15000
SYMPHONY_BOT_LLM_HTTP_TRANSPORT=fetch
```

Use `auto` only for transport debugging. It can increase worst-case latency because it tries multiple clients.

If Telegram replies with a provider error such as `HTTP 401: invalid access token or token expired`, first check which process is answering. A healthy local manifest should show:

```bash
curl http://localhost:3000/api/v1/bots/manifest
```

Expected:

- `data.transports.telegram.health` is `healthy`.
- `data.transports.telegram.webhook_url` points at this local server's public URL.
- `data.assistant.health` becomes `healthy` after a natural-language message is processed.

If `webhook_url` is empty but Telegram still replies, another deployment or polling process is using the same bot token. Stop that process or reset the webhook to the current server. If the webhook is correct and `data.assistant.last_error_code` is `auth_error`, rotate or correct `SYMPHONY_BOT_LLM_API_KEY`, `SYMPHONY_BOT_LLM_BASE_URL`, and `SYMPHONY_BOT_LLM_MODEL` as a set.

### Supervisor Planning LLM

Supervisor planning defaults to bot LLM settings. Override only when you need a separate model, endpoint, or timeout.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMPHONY_SUPERVISOR_LLM_PROVIDER` | optional | Overrides bot provider. |
| `SYMPHONY_SUPERVISOR_LLM_MODEL` | optional | Overrides bot model. |
| `SYMPHONY_SUPERVISOR_LLM_API_KEY` | optional | Overrides bot key. |
| `SYMPHONY_SUPERVISOR_LLM_BASE_URL` | optional | Overrides bot base URL. |
| `SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS` | optional | Default `45000`. |

### Supervisor Overseer LLM

The execution overseer reads dev/review milestones and generates the next directive. It defaults to supervisor LLM settings, then bot LLM settings.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMPHONY_SUPERVISOR_OVERSEER_PROVIDER` | optional | Dedicated overseer provider. |
| `SYMPHONY_SUPERVISOR_OVERSEER_MODEL` | optional | Dedicated overseer model. |
| `SYMPHONY_SUPERVISOR_OVERSEER_API_KEY` | optional | Dedicated overseer key. |
| `SYMPHONY_SUPERVISOR_OVERSEER_BASE_URL` | optional | Dedicated overseer endpoint. |
| `SYMPHONY_SUPERVISOR_OVERSEER_TIMEOUT_MS` | optional | Default `30000`. |

If overseer LLM fails, deterministic supervision still classifies delivery failures, missing evidence, branch drift, and user-approval gates.

### Startup Repair And Cleanup

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYMPHONY_SUPERVISOR_JOB_INTERVAL_MS` | `30000` | Supervisor job-loop tick interval. |
| `SYMPHONY_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS` | `86400000` | Age threshold for stale pre-materialization session cancellation. |
| `SYMPHONY_BOT_FOLLOWUP_REPAIR_DELAY_MS` | `5000` | Delay before repairing bot follow-up state. |
| `SYMPHONY_STARTUP_CLEANUP_DELAY_MS` | `900000` | Delay before heavier terminal workspace/GitHub orphan cleanup. |

The delays are intentional. They make `bun run start` responsive before cleanup competes with live E2E or dev/review work.

## `WORKFLOW.md`

Start from:

```bash
bun run setup:local
```

Important sections:

### Tracker States

```yaml
tracker:
  active_states:
    - Todo
    - In Progress
    - In Review
    - Cancelled
  terminal_states:
    - Done
    - Canceled
    - Duplicate
```

`active_states` are eligible for polling/dispatch. `terminal_states` are cleanup states.

### Repository Routing

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
```

Rules:

- The key must match the Linear `project_slug`.
- `github_owner` and `github_repo` are required.
- `local_path` is optional; relative paths resolve from the symphonyness repo root.
- Missing routes fail closed before workspace creation.

### Verification Scenarios

```yaml
verification:
  lifecycle:
    projects:
      sample-project:
        title: "Live lifecycle smoke test"
        description: "Make a tiny repository-safe change..."
```

The live verifier uses these templates to create controlled issues.

### Agent Command

```yaml
codex:
  command: node ./scripts/claude-adapter.cjs
```

Only change this if you know which Claude Code-compatible runner you want symphonyness to invoke.

## Target Repo Contracts

Target repositories can add:

```text
.symphony-repo.yaml
.symphony-constitution.md
```

`.symphony-repo.yaml` defines formal harness behavior: setup, dev, test, build, review checks, artifacts, and what counts as evidence.

`.symphony-constitution.md` defines architecture preferences, forbidden directions, stable boundaries, and cleanup triggers.

If a repo does not have a formal harness, symphonyness uses shadow harness inference. Shadow/missing harness status is visible in runtime diagnostics, but should not dominate Telegram user-facing messages.

## Diagnostics Checklist

Use these endpoints after startup:

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/overview
```

Use these commands for repairs:

```bash
bun src/cli/index.ts repair all
bun run stop
```

Use these commands for the normal local loop:

```bash
bun run setup:local
bun run start:local
PORT=4000 bun run start
bun run stop
```

Use this to validate Telegram-first behavior:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```
