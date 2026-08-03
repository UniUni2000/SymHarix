# SymHarix Configuration Guide

**Language:** English | [Chinese](./CONFIGURATION.zh-CN.md)

This is the reference for startup configuration, `.env`, `WORKFLOW.md`, and target-repository contracts.

## Configuration Layers

SymHarix reads configuration from three places:

1. `.env`: secrets, tokens, Telegram, Runtime Deck, and LLM settings.
2. `WORKFLOW.md`: tracker state names, repository routing, agent command, and verification scenarios.
3. Target repository contracts: `.symphony-repo.yaml` and `.symphony-constitution.md`.

Use `SYMHARIX_*` for new operator-facing environment variables. New installations use `symharix.db`; an existing `symphony.db` is detected and reused automatically. Legacy `SYMPHONY_*` names and `.symphony-*` repository contracts remain supported during migration.

## Local Commands

```bash
bun run setup
bun run configure:guide
bun run configure:secure
bun run configure
bun run configure:check
bun run configure:doctor
bun run runtime:smoke
bun run start
bun run stop
bun run health
bash scripts/install-systemd-service.sh
```

`configure:guide` explains where each credential comes from and its minimum permissions. `configure:check` performs offline format validation. `configure:doctor` calls authentication/read-only endpoints only; it does not create issues, pull requests, messages, or model requests. `runtime:smoke` is the explicit, low-cost end-to-end model call.

`start` is the default Telegram local entrypoint. Use `bun run start:telegram` explicitly for Telegram, or `bun run start:feishu` for a Feishu-only local run. Each start command isolates the opposite chat surface in the child process environment, so Feishu does not require Telegram variables and Telegram does not require Feishu variables.

Use another port with:

```bash
PORT=4000 bun run start
PORT=4000 bun run health
```

On Linux servers, `bash scripts/install-systemd-service.sh` installs and starts a systemd service. Use this when the process must survive SSH disconnects and machine reboots.

Service controls:

```bash
sudo systemctl status ${SYMHARIX_SERVICE_NAME:-symharix} --no-pager
sudo journalctl -u ${SYMHARIX_SERVICE_NAME:-symharix} -f
sudo systemctl restart ${SYMHARIX_SERVICE_NAME:-symharix}
sudo systemctl stop ${SYMHARIX_SERVICE_NAME:-symharix}
```

Install-time overrides:

| Variable | Meaning |
| --- | --- |
| `SYMHARIX_SERVICE_NAME` | systemd unit name, default `symharix`. |
| `SYMHARIX_SERVICE_USER` | Linux user that runs the service, default current user. |
| `SYMHARIX_SERVICE_PORT` | HTTP port rendered into the unit, default `3000`. |
| `SYMHARIX_BUN_BIN` | Explicit Bun binary path. |

## Startup Minimums

The fastest way to reason about startup is by responsibility:

| Area | Configure | Why |
| --- | --- | --- |
| Tracker | `SYMHARIX_TRACKER_KIND=linear`, `SYMHARIX_TRACKER_API_KEY`, `SYMHARIX_TRACKER_PROJECT_SLUG` | Linear supplies the work-item state machine and the default project for Telegram/Feishu/Runtime-created issues. |
| GitHub access | `GITHUB_TOKEN` | The token must reach every repository declared in `WORKFLOW.md -> repositories.routing`. |
| Agent runtime | `SYMHARIX_OPENCODE_MODEL` plus a provider key or `opencode auth` | OpenCode uses `provider/model` IDs for execution and repo understanding. |
| Repository routing | `WORKFLOW.md -> repositories.routing` | The route key must match the Linear `project_slug`; missing routes fail closed before workspace creation. |
| Telegram transport | `SYMHARIX_TELEGRAM_BOT_TOKEN`, `SYMHARIX_TELEGRAM_WEBHOOK_SECRET`, `SYMHARIX_TELEGRAM_OPERATOR_IDS` | Required only for `start:telegram`. The token enables Telegram, the secret protects webhook ingress, and operator ids restrict write-capable actions. |
| Feishu transport | `SYMHARIX_FEISHU_APP_ID`, `SYMHARIX_FEISHU_APP_SECRET`, `SYMHARIX_FEISHU_OPERATOR_IDS` | Required only for `start:feishu`. App id/secret enable Feishu long connection mode, and operator ids restrict write-capable actions. |
| Public ingress | `SYMHARIX_PUBLIC_BASE_URL` or temporary tunnel mode | Webhook and Mini App features need a stable publicly reachable HTTPS URL in production. |
| Runtime access | `SYMHARIX_RUNTIME_VIEWER_TOKEN`, `SYMHARIX_RUNTIME_WRITE_TOKEN`, `SYMHARIX_RUNTIME_SESSION_SECRET` | Viewer access is read-only and operator access can mutate; the wizard generates both credentials and the server-side session signing secret. |

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

### OpenCode Runtime

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMHARIX_OPENCODE_MODEL` | yes | Default `provider/model` used by all roles. |
| `SYMHARIX_OPENCODE_PLAN_MODEL` | optional | Plan-only model override. |
| `SYMHARIX_OPENCODE_DEV_MODEL` | optional | Dev-only model override. |
| `SYMHARIX_OPENCODE_REVIEW_MODEL` | optional | Review-only model override. |
| `SYMHARIX_OPENCODE_USE_AUTH` | optional | Set `1` to reuse credentials from `opencode auth login`. |
| `SYMHARIX_ADAPTER_DEBUG` | debugging | Agent I/O diagnostics. |

The adapter supplies role-scoped permissions and disables runtime auto-update and external plugins for reproducibility.

Before publishing or deploying a fresh checkout, verify the pinned runtime:

```bash
bash scripts/check-runtime.sh
```

### Runtime Deck

| Variable | Required | Meaning |
| --- | --- | --- |
| `PORT` | optional | One-off local HTTP port override. |
| `SYMHARIX_RUNTIME_VIEWER_TOKEN` | recommended | Read-only access to Runtime API, SSE, detailed health, Deck, and Mini App. Generated by the wizard. |
| `SYMHARIX_RUNTIME_WRITE_TOKEN` | required for writes | Operator credential with read access plus create, stop, retry, and approval actions. Generated by the wizard. |
| `SYMHARIX_RUNTIME_SESSION_SECRET` | required | Signs short browser sessions. Generated by the wizard and must not be reused as an access token. |
| `SYMHARIX_RUNTIME_SESSION_TTL_MINUTES` | optional | Browser session lifetime; defaults to `15` minutes. |
| `SYMHARIX_MAX_TURN_OUTPUT_TOKENS` | optional | Per-call output ceiling passed to OpenCode/provider; defaults to `16000`. |
| `SYMHARIX_MAX_TURN_STEPS` | optional | Maximum OpenCode agentic iterations per turn; defaults to `12`. |
| `SYMHARIX_TURN_RESERVE_TOKENS` | optional | Aggregate per-turn token ceiling and the amount atomically reserved before each model call; defaults to `200000`. Cache reads are included. Reaching it pauses the issue without automatic retry. |
| `SYMHARIX_MAX_TASK_TOKENS` | optional | Hard per-task token budget; defaults to `500000`. |
| `SYMHARIX_MAX_REPO_DAILY_TOKENS` | optional | Per-repository UTC daily token limit; defaults to `2000000`. |
| `SYMHARIX_MAX_DAILY_TOKENS` | optional | Global UTC daily token limit; defaults to `5000000`. |
| `SYMHARIX_MAX_TASK_USD` | optional | Per-task USD limit; defaults to `$25` and is enforced when rates are configured. |
| `SYMHARIX_MAX_REPO_DAILY_USD` | optional | Per-repository UTC daily USD limit; defaults to `$100` when rates are configured. |
| `SYMHARIX_MAX_DAILY_USD` | optional | Global UTC daily USD limit; defaults to `$250` when rates are configured. |
| `SYMHARIX_COST_OVERRIDE_MINUTES` | optional | Operator approval lifetime; defaults to `60` minutes. |
| `SYMHARIX_COST_INPUT_USD_PER_MILLION` | optional | Conservative input ceiling rate. Use the highest active rate when roles use different models. |
| `SYMHARIX_COST_OUTPUT_USD_PER_MILLION` | optional | Conservative output ceiling rate. Use the highest active rate when roles use different models. |
| `SYMHARIX_COST_CACHE_READ_USD_PER_MILLION` | optional | Cache-read input rate; falls back to the input rate when omitted. |

Runtime API, SSE, detailed health/readiness, Deck, Mini App, work-items, and the Bot manifest all require read authentication by default. A browser submits a viewer/operator token once and receives a short `HttpOnly + SameSite=Lax` session cookie; the token is never stored in `localStorage`. Cookie-backed mutations additionally require the same origin and a CSRF marker. `/api/v1/health/live` stays public for process and container liveness probes. With no viewer or operator credential, access fails closed and SymHarix refuses non-loopback exposure.

You do not need to open `.env` or print a credential into terminal history. From a source checkout, run `bun run runtime:access -- copy viewer`; from an installed package, run `symharix access copy viewer`. Replace `viewer` with `operator` for stop/retry/approval access. The command writes only to the system clipboard and never prints the token.

Scripts and external monitors can use a header directly without creating a cookie:

```bash
curl -H "Authorization: Bearer $SYMHARIX_RUNTIME_VIEWER_TOKEN" \
  http://127.0.0.1:3000/api/v1/runtime/overview
```
Token limits remain active without pricing. Until both input and output rates are supplied, USD budgets are shown as “not configured” and are not used to block calls. Every task-associated coding or supervisor call atomically reserves capacity in SQLite, so concurrent tasks cannot independently spend the same remaining daily budget. An over-budget task is halted with `cost_budget_exceeded`; a Runtime operator can grant a time-limited override in Runtime Deck or from the Telegram/Feishu issue card (or `/budget ISSUE-ID`). Standalone chat-classification traffic is not assigned to a repository budget, so keep the provider account spending cap enabled as an independent final safeguard.

Runtime issue detail restores token usage from persisted agent runs, so completed issues can still show usage after the live orchestrator snapshot is gone. Mini App history also tries workspace diffs, merge commits, and active PR heads before falling back to compact history text.

### Chat Surface Selection

Telegram and Feishu are optional product surfaces over the same Supervisor runtime. Configure at least one:

| Goal | Required chat config | Start command |
| --- | --- | --- |
| Telegram only | Telegram variables; leave Feishu blank | `bun run start:telegram` or `bun run start` |
| Feishu only | Feishu variables; leave Telegram blank | `bun run start:feishu` |
| Both configured in `.env` | Both variable groups | Use the surface-specific start command for the process you want |

`start:feishu` clears Telegram token, webhook, operator, operations-chat, and bootstrap values only inside the launched child process. It does not rewrite `.env`. Follow-up delivery is also origin-scoped: Feishu-origin issues notify Feishu recipients, and Telegram-origin issues notify Telegram recipients.

### Telegram

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_BOT_TOKEN` | for Telegram | BotFather token. Leave blank to disable Telegram. |
| `SYMHARIX_TELEGRAM_WEBHOOK_SECRET` | recommended | Webhook path/header secret. |
| `SYMHARIX_TELEGRAM_OPERATOR_IDS` | required for writes | Comma-separated user ids allowed to run write actions. Blank is read-only. |
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
| Local development without a stable public URL | Leave `SYMHARIX_PUBLIC_BASE_URL` empty and let `start` try a temporary `cloudflared` tunnel. |

If `SYMHARIX_PUBLIC_BASE_URL` is empty and Telegram is enabled, `start` tries to create a temporary `cloudflared` tunnel before starting the app. For temporary `trycloudflare.com` URLs, `start` also runs a watchdog that checks the public URL and Telegram manifest. If the tunnel becomes stale or unreachable, it provisions a fresh tunnel and restarts the local service process.

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

### Feishu

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYMHARIX_FEISHU_APP_ID` | for Feishu | Feishu custom app ID. Leave blank to disable Feishu. |
| `SYMHARIX_FEISHU_APP_SECRET` | for Feishu | Feishu custom app secret used to obtain `tenant_access_token`. |
| `SYMHARIX_FEISHU_OPERATOR_IDS` | required for writes | Comma-separated `open_id`, `user_id`, or `union_id` values allowed to run write actions. Blank is read-only. |
| `SYMHARIX_FEISHU_OPERATIONS_CHAT_ID` | optional | Fixed operations chat. You can read the `chat_id` from a Feishu message event. |
| `SYMHARIX_FEISHU_API_BASE_URL` | optional | OpenAPI base, defaulting to `https://open.feishu.cn/open-apis`. |
| `SYMHARIX_PUBLIC_BASE_URL` | optional | Only needed if you want Feishu cards to open local Mini App/runtime web URLs through a public HTTPS base. Not required for long connection events. |
| `SYMHARIX_FEISHU_RUNTIME_OPEN_MODE` | optional | Runtime button open mode. Keep the default `applink_web_url` so Feishu opens runtime views inside the client. |
| `SYMHARIX_FEISHU_RUNTIME_TUNNEL` | optional | `auto` creates a temporary runtime tunnel for `applink_web_url` when no public base is configured, so mobile Feishu can open the runtime view. Use `off` to disable or `on` to force it. |
| `SYMHARIX_FEISHU_TUNNEL_PROTOCOL` | optional | Runtime tunnel protocol. Defaults to `auto` for Feishu so it does not inherit Telegram's `http2` setting. Try `http2` or `quic` if your network is picky. |
| `SYMHARIX_FEISHU_TUNNEL_TIMEOUT_MS` / `SYMHARIX_FEISHU_TUNNEL_RETRY_ATTEMPTS` / `SYMHARIX_FEISHU_TUNNEL_RETRY_DELAY_MS` | optional | Timeout and retry controls for creating the temporary Feishu runtime tunnel. Defaults to `45000ms`, `3`, and `1500ms`. |
| `SYMHARIX_FEISHU_TUNNEL_READY_ATTEMPTS` / `SYMHARIX_FEISHU_TUNNEL_READY_DELAY_MS` | optional | Attempts and delay for waiting until the temporary Cloudflare tunnel stops returning 530 before publishing it to cards. Defaults to `60` attempts at `1000ms`. |
| `SYMHARIX_FEISHU_RUNTIME_APPLINK_MODE` | optional | AppLink open mode, defaulting to `window`; try `sidebar` if you prefer a side panel. |
| `SYMHARIX_FEISHU_RUNTIME_APPLINK_WIDTH` / `SYMHARIX_FEISHU_RUNTIME_APPLINK_HEIGHT` | optional | Desktop Feishu AppLink window size. |
| `SYMHARIX_FEISHU_RUNTIME_APPLINK_TEMPLATE` | optional | Custom AppLink template. Supports `{appId}`, `{url}`, `{path}`, `{encodedUrl}`, and `{encodedPath}`. |

For local Feishu testing, use `bun run start:feishu`. Feishu long connection message intake does not require a public webhook URL, Verification Token, or Encrypt Key. Runtime buttons default to `applink_web_url`; when `SYMHARIX_PUBLIC_BASE_URL` is blank, the launcher attempts to create a temporary `trycloudflare.com` runtime tunnel and uses it only for Mini App links such as "Open Runtime View"; Feishu events still use persistent connection mode.

If mobile Feishu clients need to open the runtime view remotely, use one of these:

| Mode | Config |
| --- | --- |
| Stable public ingress | `SYMHARIX_PUBLIC_BASE_URL=https://your-domain.example` |
| Local development tunnel | `SYMHARIX_FEISHU_RUNTIME_OPEN_MODE=applink_web_url` and `SYMHARIX_FEISHU_RUNTIME_TUNNEL=auto` or `on` |

To discover your operator id, leave `SYMHARIX_FEISHU_OPERATOR_IDS` blank for the first read-only run and send `/whoami` (aliases: `/id`, `/me`) to the bot. The response prints the detected user id; copy it into the env var and restart. The received value is normally the sender `open_id` (`ou_...`).

Minimum Feishu app permissions:

| Scope | Purpose |
| --- | --- |
| `im:message.group_at_msg.include_bot:readonly` | Receive group messages that mention the current bot and include other bots/users. |
| `im:message.group_at_msg:readonly` | Receive group messages where users mention the bot. |
| `im:message.p2p_msg:readonly` | Receive direct messages sent to the bot. |
| `im:message:send_as_bot` | Reply as the bot. |
| `im:message:update` | Edit sent messages/cards for Plan Card and runtime-card updates. |
| `im:resource` | Upload and display card image/file resources. |

After changing permissions, publish the app again and restart SymHarix so the tenant access token is refreshed.

The Feishu adapter mirrors the core Telegram supervisor loop: natural-language intake, slash commands, repo switching, Plan Cards/runtime cards, approval/retry/stop buttons, proactive follow-ups, and a fixed operations chat. Enable bot capability in the Feishu app, set Events and Callbacks to persistent connection mode, then add `im.message.receive_v1` and `card.action.trigger`.

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

### Supervisor OpenCode Runtime And Repo Understanding

The Telegram Supervisor can use the open-source OpenCode runtime as the assistant brain. Repository access in repo-understanding paths is read-only. Business actions still go through supervisor/orchestrator tools and confirmation policy.

| Variable | Meaning |
| --- | --- |
| `SYMHARIX_SUPERVISOR_OPENCODE_RUNTIME` | Set `off` only when intentionally disabling the OpenCode runtime front door. |
| `SYMHARIX_SUPERVISOR_OPENCODE_COMMAND` | Runtime command, default `node scripts/opencode-adapter.cjs`. |
| `SYMHARIX_SUPERVISOR_TOOL_ROUTER_TIMEOUT_MS` | Supervisor tool-router model timeout, default `12000`, max `60000`. |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND` | Read-only repo understanding command. |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS` | Default `120000`. |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND` | Per-turn read-only repo advisor command. |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_TIMEOUT_MS` | Default `120000`. |

Blank command values use `node scripts/opencode-adapter.cjs`, which invokes the checksum-verified version in `runtime/opencode.lock.json`. The older `SYMHARIX_SUPERVISOR_CLAUDE_*` names remain temporary configuration aliases.

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
bun run setup
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
  command: node ./scripts/opencode-adapter.cjs
```

Change this only when intentionally replacing the OpenCode adapter. Older workflows may still use `codex.command`; it remains accepted as a legacy alias.

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
