# SymHarix Configuration Guide

**Language:** English | [Chinese](./CONFIGURATION.zh-CN.md)

This is the reference for startup configuration, `.env`, `WORKFLOW.md`, and target-repository contracts.

## Configuration Layers

SymHarix reads configuration from three places:

1. `.env`: secrets, tokens, Telegram, Runtime Deck, and LLM settings.
2. `WORKFLOW.md`: tracker state names, repository routing, agent command, and verification scenarios.
3. Target repository contracts: `.symphony-repo.yaml` and `.symphony-constitution.md`.

Use `SYMHARIX_*` for new operator-facing environment variables. Legacy `SYMPHONY_*` names, `.symphony-*` repository contracts, and the local `symphony.db` file remain supported for compatibility.

## Local Commands

```bash
bun run setup:local
bun run start:local
bun run stop
bun run health
```

`start:local` is the preferred local entrypoint. It keeps existing files, prepares Telegram proxy/tunnel behavior, starts the service, and prints a Telegram startup summary when possible.

Use another port with:

```bash
PORT=4000 bun run start:local
PORT=4000 bun run health
```

## Startup Minimums

The fastest way to reason about startup is by responsibility:

| Area | Configure | Why |
| --- | --- | --- |
| Tracker | `SYMHARIX_TRACKER_KIND=linear`, `SYMHARIX_TRACKER_API_KEY`, `SYMHARIX_TRACKER_PROJECT_SLUG` | Linear supplies the work-item state machine and the default project for Telegram/Runtime-created issues. |
| GitHub access | `GITHUB_TOKEN` | The token must reach every repository declared in `WORKFLOW.md -> repositories.routing`. |
| Agent runtime | `ANTHROPIC_API_KEY` | The bundled Claude Code-compatible runtime uses it for execution and repo understanding unless the runner is replaced. |
| Repository routing | `WORKFLOW.md -> repositories.routing` | The route key must match the Linear `project_slug`; missing routes fail closed before workspace creation. |
| Telegram transport | `SYMHARIX_TELEGRAM_BOT_TOKEN`, `SYMHARIX_TELEGRAM_WEBHOOK_SECRET`, `SYMHARIX_TELEGRAM_OPERATOR_IDS` | The token enables Telegram, the secret protects webhook ingress, and operator ids restrict write-capable actions. |
| Public ingress | `SYMHARIX_PUBLIC_BASE_URL` or temporary tunnel mode | Webhook and Mini App features need a stable publicly reachable HTTPS URL in production. |
| Runtime writes | `SYMHARIX_RUNTIME_WRITE_TOKEN` | Optional locally, but recommended before exposing Runtime Deck/API write actions publicly. |

## `.env` Reference

### Tracker

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMHARIX_TRACKER_KIND` | yes | Currently `linear` only. |
| `SYMHARIX_TRACKER_API_KEY` | yes | Linear API key. |
| `SYMHARIX_TRACKER_PROJECT_SLUG` | recommended | Default project slug for Telegram/Runtime issue creation. Must match `WORKFLOW.md -> repositories.routing`. |
| `LINEAR_API_KEY` | legacy | Python hook compatibility; prefer `SYMHARIX_TRACKER_API_KEY`. |

### GitHub

| Variable | Required | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Token with access to target repositories in `WORKFLOW.md`. |
| `GITHUB_OWNER` | optional | Older fallback path only. Prefer `WORKFLOW.md -> repositories.routing`. |
| `GITHUB_REPO` | optional | Older fallback path only. Prefer `WORKFLOW.md -> repositories.routing`. |

### Claude Code-Compatible Runtime

| Variable | Required | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Used by the bundled runtime. |
| `ANTHROPIC_MODEL` | optional | Older fallback path. |
| `ANTHROPIC_BASE_URL` | optional | Older fallback path. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | recommended | Keeps the local runtime quieter. |
| `CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH` | recommended | Avoids broad startup prefetch. |
| `SYMHARIX_ADAPTER_DEBUG` | debugging | Agent I/O diagnostics. |

The adapter supplies runtime defaults such as simple mode, disabled background tasks, disabled auto memory, and read-only mode for read-only Supervisor sessions.

### Runtime Deck

| Variable | Required | Meaning |
| --- | --- | --- |
| `PORT` | optional | One-off local HTTP port override. |
| `SYMHARIX_RUNTIME_WRITE_TOKEN` | optional | Protects Runtime Deck/API write actions. |

Leaving `SYMHARIX_RUNTIME_WRITE_TOKEN` blank is convenient for local development. Set it before exposing `/runtime` publicly.

Runtime issue detail restores token usage from persisted agent runs, so completed issues can still show usage after the live orchestrator snapshot is gone. Mini App history also tries workspace diffs, merge commits, and active PR heads before falling back to compact history text.

### Telegram

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_BOT_TOKEN` | for Telegram | BotFather token. Leave blank to disable Telegram. |
| `SYMHARIX_TELEGRAM_WEBHOOK_SECRET` | recommended | Webhook path/header secret. |
| `SYMHARIX_TELEGRAM_OPERATOR_IDS` | recommended | Comma-separated user ids allowed to run write actions. |
| `SYMHARIX_TELEGRAM_OPERATIONS_CHAT_ID` | optional | Fixed operations chat. |
| `SYMHARIX_PUBLIC_BASE_URL` | optional | Public HTTPS base for webhook and Mini App links. |
| `SYMHARIX_TELEGRAM_BOOTSTRAP` | optional | Set `off` to disable automatic webhook bootstrap. |

SymHarix does not require a public IP, but Telegram webhook and Mini App features require a stable publicly reachable HTTPS URL. For production, use a domain with HTTPS reverse proxy or a named Cloudflare Tunnel. Quick trycloudflare.com tunnels are intended for local development and demos, not 24/7 production.

Common deployment shapes:

| Setup | Result |
| --- | --- |
| Server with public IP, domain, TLS, and reverse proxy to SymHarix | Set `SYMHARIX_PUBLIC_BASE_URL=https://your-domain.example`; no temporary Cloudflare tunnel is needed. |
| Server without public IP but with a stable public tunnel or load balancer | Works if the HTTPS URL is reachable by Telegram and users. |
| Server with outbound-only access to Telegram | Not enough for the current webhook mode; it would need a polling/getUpdates transport. |
| Local development without a stable public URL | Leave `SYMHARIX_PUBLIC_BASE_URL` empty and let `start:local` try a temporary `cloudflared` tunnel. |

If `SYMHARIX_PUBLIC_BASE_URL` is empty and Telegram is enabled, `start:local` tries to create a temporary `cloudflared` tunnel before starting the app. For temporary `trycloudflare.com` URLs, `start:local` also runs a watchdog that checks the public URL and Telegram manifest. If the tunnel becomes stale or unreachable, it provisions a fresh tunnel and restarts the local service process.

Tunnel and webhook knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_TUNNEL_COMMAND` | auto | Override tunnel command. |
| `SYMHARIX_TELEGRAM_TUNNEL_PROTOCOL` | `http2` | Tunnel protocol. |
| `SYMHARIX_TELEGRAM_TUNNEL_RETRY_ATTEMPTS` | `3` | Tunnel attempts. |
| `SYMHARIX_TELEGRAM_TUNNEL_RETRY_DELAY_MS` | `1500` | Delay between tunnel attempts. |
| `SYMHARIX_TELEGRAM_TUNNEL_WATCHDOG_INTERVAL_MS` | `10000` | Watchdog poll interval. |
| `SYMHARIX_TELEGRAM_TUNNEL_WATCHDOG_DEGRADED_POLLS` | `2` | Degraded polls before recovery. |
| `SYMHARIX_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS` | `6` | Webhook registration attempts. |
| `SYMHARIX_TELEGRAM_WEBHOOK_RETRY_DELAY_MS` | `2000` | Webhook retry delay. |
| `SYMHARIX_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS` | `60` | Startup summary polling attempts. |

Message and network knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_TEXT_ACK_DELAY_MS` | `3000` | Delay before lightweight text ACK. |
| `SYMHARIX_TELEGRAM_TEXT_COALESCE_DELAY_MS` | blank | Optional text coalescing delay. |
| `SYMHARIX_PROXY_MODE` | `auto` | Auto-detect common local proxies; `off` disables Telegram proxy use. |
| `SYMHARIX_PROXY_URL` | blank | Explicit proxy URL. |
| `SYMHARIX_TELEGRAM_DISABLE_PROXY` | blank | Low-level disable flag. |
| `SYMHARIX_TELEGRAM_CURL_TIMEOUT_SECONDS` | blank | Curl transport timeout. |

After startup, Telegram is actually ready only when:

```bash
curl http://localhost:3000/api/v1/bots/manifest
```

Check `health`, `webhook_url`, `public_base_url`, `mini_app_base_url`, pending update count, and last webhook error.

### Bot LLM

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMHARIX_BOT_LLM_PROVIDER` | for richer NL | `anthropic` or `openai`. |
| `SYMHARIX_BOT_LLM_MODEL` | for richer NL | Model name. |
| `SYMHARIX_BOT_LLM_API_KEY` | for richer NL | Provider key. |
| `SYMHARIX_BOT_LLM_BASE_URL` | optional | Custom endpoint. |
| `SYMHARIX_BOT_LLM_TIMEOUT_MS` | optional | Default `15000`. |
| `SYMHARIX_BOT_LLM_HTTP_TRANSPORT` | optional | `fetch`, `curl`, or `auto`. Use `fetch` for normal operation. |

### Supervisor LLMs

Planning defaults to bot LLM settings.

Top-level assistant fallback order:

```text
SYMHARIX_SUPERVISOR_AGENT_*
  -> SYMHARIX_SUPERVISOR_CC_*
  -> SYMHARIX_SUPERVISOR_LLM_*
  -> SYMHARIX_BOT_LLM_*
```

| Variable | Meaning |
| --- | --- |
| `SYMHARIX_SUPERVISOR_LLM_PROVIDER` | Supervisor planning provider. |
| `SYMHARIX_SUPERVISOR_LLM_MODEL` | Supervisor planning model. |
| `SYMHARIX_SUPERVISOR_LLM_API_KEY` | Supervisor planning key. |
| `SYMHARIX_SUPERVISOR_LLM_BASE_URL` | Supervisor planning endpoint. |
| `SYMHARIX_SUPERVISOR_LLM_TIMEOUT_MS` | Default `45000`. |
| `SYMHARIX_SUPERVISOR_AGENT_PROVIDER` | Top-level Supervisor assistant provider. |
| `SYMHARIX_SUPERVISOR_AGENT_MODEL` | Top-level Supervisor assistant model. |
| `SYMHARIX_SUPERVISOR_AGENT_API_KEY` | Top-level Supervisor assistant key. |
| `SYMHARIX_SUPERVISOR_AGENT_BASE_URL` | Top-level Supervisor assistant endpoint. |
| `SYMHARIX_SUPERVISOR_AGENT_TIMEOUT_MS` | Default `45000`. |
| `SYMHARIX_SUPERVISOR_CC_*` | Compatibility layer for the older CC advisor. |

### Supervisor Claude Runtime And Repo Understanding

The Telegram Supervisor can use a top-level Claude Code-compatible runtime as the assistant brain. Repository access in repo-understanding paths is read-only. Business actions still go through supervisor/orchestrator tools and confirmation policy.

| Variable | Meaning |
| --- | --- |
| `SYMHARIX_SUPERVISOR_CLAUDE_RUNTIME` | Set `off` only when intentionally disabling the Claude runtime front door. |
| `SYMHARIX_SUPERVISOR_CLAUDE_COMMAND` | Runtime command, default `node scripts/claude-adapter.cjs`. |
| `SYMHARIX_SUPERVISOR_TOOL_ROUTER_TIMEOUT_MS` | Supervisor tool-router model timeout, default `12000`, max `60000`. |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND` | Read-only repo understanding command. |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS` | Default `120000`. |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND` | Per-turn read-only repo advisor command. |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_TIMEOUT_MS` | Default `120000`. |

Blank command values use `node scripts/claude-adapter.cjs`, which invokes `claude-code/bin/claude-haha`.

Internal Supervisor MCP bridge variables such as `SYMHARIX_SUPERVISOR_CONTEXT_*` and `SYMHARIX_SUPERVISOR_ORCHESTRATOR_*` are generated by the runtime. Do not set them in `.env` unless debugging the bridge directly; legacy `SYMPHONY_*` bridge names are still accepted internally.

### Supervisor Overseer

| Variable | Meaning |
| --- | --- |
| `SYMHARIX_SUPERVISOR_OVERSEER_PROVIDER` | Dedicated overseer provider. |
| `SYMHARIX_SUPERVISOR_OVERSEER_MODEL` | Dedicated overseer model. |
| `SYMHARIX_SUPERVISOR_OVERSEER_API_KEY` | Dedicated overseer key. |
| `SYMHARIX_SUPERVISOR_OVERSEER_BASE_URL` | Dedicated overseer endpoint. |
| `SYMHARIX_SUPERVISOR_OVERSEER_TIMEOUT_MS` | Default `30000`. |

If the overseer LLM fails, deterministic supervision still classifies delivery failures, missing evidence, branch drift, and approval gates.

### Startup Repair And Cleanup

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYMHARIX_SUPERVISOR_JOB_INTERVAL_MS` | `30000` | Supervisor job-loop tick interval. |
| `SYMHARIX_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS` | `86400000` | Stale pre-materialization session threshold. |
| `SYMHARIX_BOT_FOLLOWUP_REPAIR_DELAY_MS` | `5000` | Delay before bot follow-up repair. |
| `SYMHARIX_STARTUP_CLEANUP_DELAY_MS` | `900000` | Delay before heavier orphan cleanup. |
| `SYMHARIX_FIRST_TICK_DELAY_MS` | `10000` | Delay before first orchestrator poll. |

These delays keep startup responsive and reduce contention with live verification.

### Standalone Hook Compatibility

| Variable | Meaning |
| --- | --- |
| `WORKSPACE_ROOT` | Manual `scripts/cli.py` runs only. |
| `SYMHARIX_WORKSPACE_ROOT` | Manual `scripts/cli.py` runs only. |
| `SYMHARIX_AUTO_MERGE_NO_REVIEWS` | Auto-merge PR even without review; default false. |
| `SYMPHONY_EFFECTIVE_HARNESS_JSON` | Internal legacy hook protocol; isolated review-hook debugging only. |

### Discord

| Variable | Meaning |
| --- | --- |
| `SYMHARIX_DISCORD_BOT_TOKEN` | Discord token; blank disables Discord. |
| `SYMHARIX_DISCORD_PUBLIC_KEY` | Discord public key. |
| `SYMHARIX_DISCORD_OPERATOR_IDS` | Comma-separated operator ids. |

## `WORKFLOW.md` Reference

Start from:

```bash
bun run setup:local
```

### Repository Routing

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: web-app
      # local_path: ./repos/web-app
    sample-api:
      github_owner: acme
      github_repo: api-service
    sample-docs:
      github_owner: acme
      github_repo: docs-site
```

Rules:

- The key must match the Linear `project_slug`.
- `github_owner` and `github_repo` are required.
- `local_path` is optional. When omitted, execution and supervisor analysis use a shared source cache cloned from GitHub.
- Missing routes fail closed before workspace creation.
- Telegram can resolve a route by project slug, full `owner/repo`, or repo name for repository switching and read-only repo questions.
- `SYMHARIX_TRACKER_PROJECT_SLUG` selects the default route for new Telegram/Runtime-created work.

### Agent Command

```yaml
agent_runner:
  command: node ./scripts/claude-adapter.cjs
```

Change this only when intentionally replacing the Claude Code-compatible runner. Older workflows may still use `codex.command`; it remains accepted as a legacy alias.

### Verification Scenarios

```yaml
verification:
  lifecycle:
    projects:
      sample-project:
        title: "Live lifecycle smoke test"
        description: "Make a tiny repository-safe change..."
```

Live verifiers use these templates to create controlled test issues.

## Target Repo Contracts

Target repositories can add:

```text
.symphony-repo.yaml
.symphony-constitution.md
```

`.symphony-repo.yaml` defines setup, dev, test, build, review checks, artifacts, and evidence rules.

`.symphony-constitution.md` defines architecture preferences, forbidden directions, stable boundaries, and cleanup triggers.

If a repo has no formal harness, SymHarix uses shadow harness inference. Shadow or missing harness status appears in runtime diagnostics, but should not dominate Telegram user-facing messages.

## Diagnostics Checklist

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/overview
curl http://localhost:3000/api/v1/bots/manifest
bun src/cli/index.ts repair all
```

When using a non-default port, pass the same `PORT` to health checks:

```bash
PORT=4000 bun run health
curl http://localhost:4000/api/v1/bots/manifest
```

Delivery blockers:

- `delivery_code=merge_blocked` means review proof passed, but the PR merge or final delivery action failed.
- Runtime Deck and Mini App issue previews surface the active stage, active PR, delivery summary, and blocker code.

Telegram-first live verification:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```
