# symphonyness

symphonyness is a harness-based, Telegram-first control plane for end-to-end code development. It combines repo-local contracts, planning, supervised Claude Code-style execution, review, delivery, and cleanup into one recoverable flow.

The repo is intentionally local-first. Secrets live in `.env`, orchestration policy lives in local `WORKFLOW.md`, and target repositories can declare their own `.symphony-repo.yaml` and `.symphony-constitution.md` contracts.

## Quick Start

```bash
bun install
cp .env.example .env
cp WORKFLOW.md.example WORKFLOW.md
```

Edit `.env` and `WORKFLOW.md`, then start:

```bash
bun run start -- --port 3000
```

Open the runtime deck:

```text
http://localhost:3000/runtime
```

Stop every local symphonyness service and companion process:

```bash
bun run start -- --kill
```

More detail:

- [QUICKSTART.md](./QUICKSTART.md) for a step-by-step local setup.
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) for every important `.env` and `WORKFLOW.md` setting.
- [docs/AI_OPERATOR_GUIDE.md](./docs/AI_OPERATOR_GUIDE.md) for AI agents or maintainers operating this repo.

## What Runs

The main execution chain is:

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

Important modules:

- `src/cli`: startup, stop, repair, and live verifier commands.
- `src/server`: runtime API, web UI, bot webhook routes.
- `src/runtime`: user-facing issue projections, timeline, history, actions.
- `src/bots`: Telegram/Discord adapters over the shared runtime control plane.
- `src/supervisor`: Telegram-first sessions, planning, job loop, memory, execution oversight.
- `src/orchestrator`: dispatch, retry, governance, dev/review handoff, delivery cleanup.
- `src/agent`: Claude Code runner and compact dev context.
- `src/database`: SQLite schema and repositories.
- `scripts/claude-adapter.cjs`: bridge to the bundled Claude Code runtime.
- `scripts/hooks`: dev/review post-processing and delivery classification.

## Telegram-First Supervisor Flow

Telegram is the primary product surface for new user requests.

Typical flow:

1. User sends a natural-language request in Telegram.
2. Bot routes it into a Supervisor session.
3. Supervisor decides whether it is a small direct-run task or a plan that needs clarification/approval.
4. Telegram shows a Plan Card with goal, scope, non-goals, acceptance criteria, risks, and recommended action.
5. After approval, Supervisor creates a root issue and, for larger plans, a sequential child queue.
6. Orchestrator runs only the current child while later children stay queued.
7. Supervisor watches dev/review milestones, writes directives for the next dev turn, and asks the user only for high-risk decisions.
8. Telegram gets high-signal updates, not raw retry/status noise.

Linear and GitHub are records and delivery surfaces. They are not the main place for clarification or approval.

## Configuration Model

There are three layers:

1. `.env`: secrets, API keys, local runtime switches, Telegram tunnel/bootstrap, LLM providers.
2. `WORKFLOW.md`: local orchestration policy, tracker states, repository routing, agent command.
3. Target repo contracts:
   - `.symphony-repo.yaml` defines setup/test/build/review checks and required artifacts.
   - `.symphony-constitution.md` defines architectural boundaries, preferred directions, and cleanup triggers.

`WORKFLOW.md` is not committed because it is environment-specific. Start from `WORKFLOW.md.example`.

Repository routing is explicit. The key under `repositories.routing` must match the Linear `project_slug`:

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
```

Replace the sample values with the Linear project and GitHub repository you want symphonyness to operate.

## Telegram Setup

Minimum Telegram settings:

```dotenv
SYMPHONY_TELEGRAM_BOT_TOKEN=...
SYMPHONY_TELEGRAM_WEBHOOK_SECRET=...
SYMPHONY_TELEGRAM_OPERATOR_IDS=123456789
```

If you have a public URL:

```dotenv
SYMPHONY_PUBLIC_BASE_URL=https://your-public-host
```

If you do not have one, symphonyness tries to start `cloudflared tunnel --url <local-server> --protocol http2` automatically. To disable this:

```dotenv
SYMPHONY_TELEGRAM_BOOTSTRAP=off
```

Check bot health:

```bash
curl http://localhost:3000/api/v1/bots/manifest
```

## LLM Configuration

Bot natural-language parsing, Supervisor planning, and Supervisor execution oversight all read from `.env`.

Common local setup:

```dotenv
ANTHROPIC_API_KEY=...
SYMPHONY_BOT_LLM_PROVIDER=anthropic
SYMPHONY_BOT_LLM_MODEL=claude-3-5-sonnet-latest
SYMPHONY_BOT_LLM_API_KEY=...
SYMPHONY_BOT_LLM_TIMEOUT_MS=15000
SYMPHONY_BOT_LLM_HTTP_TRANSPORT=fetch
```

Supervisor planning defaults to `SYMPHONY_BOT_LLM_*`, with a separate timeout:

```dotenv
SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS=45000
```

Execution oversight defaults to supervisor LLM settings, then bot LLM settings:

```dotenv
SYMPHONY_SUPERVISOR_OVERSEER_TIMEOUT_MS=30000
```

If a model call times out or returns unusable JSON, symphonyness falls back to deterministic routing/planning. It should not block Telegram webhook ACKs.

## Live Verification

For live verification, choose a repository/project where it is acceptable for symphonyness to create issues, branches, PRs, and comments. The examples below use placeholder values:

```text
Linear project slug: sample-project
GitHub repo: acme/demo-app
```

Lifecycle verifier:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-lifecycle --project-slug sample-project
```

Telegram-first Supervisor verifier against a running server:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

The attach-mode supervisor verifier must enter through Telegram webhook/session behavior. It should not create issues directly through the runtime API.

## Repair And Cleanup

Repair stale bot state and orphan GitHub delivery artifacts:

```bash
bun src/cli/index.ts repair all
```

Stop all local processes:

```bash
bun run start -- --kill
```

If a previous run left active sessions, the startup repair path cancels stale pre-materialization sessions and folds old follow-up state back into the current root thread. Startup cleanup is intentionally delayed by default so `bun run start` becomes responsive before heavier orphan repair runs.

## Development

```bash
bun run test
bun run build
```

Useful targeted suites:

```bash
bun test src/bots/gateway.test.ts src/bots/followups.test.ts
bun test src/supervisor/sessionService.test.ts src/supervisor/jobLoop.test.ts
bun test src/orchestrator/index.test.ts
bun test src/verification/attachedLiveSupervisorVerifier.test.ts
```

## Safety Notes

- Do not commit `.env`.
- Do not commit local `WORKFLOW.md` unless the team intentionally changes policy for this checkout.
- For live verification, use a target repository/project that is safe for automated issues, branches, PRs, and cleanup.
- Do not bypass Telegram when validating Telegram-first Supervisor behavior.
- Do not interpret proof/evidence success as delivery success. Delivery may still fail on PR, branch, tracker, or merge state.
