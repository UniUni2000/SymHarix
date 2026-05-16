# ✨ SymHarix — Telegram-First AI Supervisor

<p align="center">
  <img src="./assets/logo_dark.svg" alt="SymHarix" width="220">
</p>

<p align="center">
  <strong>PLAN. APPROVE. SHIP.</strong>
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/Quick_Start-Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Quick Start"></a>
  <a href="#telegram-supervisor"><img src="https://img.shields.io/badge/Telegram-first-229ED9?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram first"></a>
  <a href="#core-flow"><img src="https://img.shields.io/badge/Runtime-Deck-6D5DFC?style=for-the-badge" alt="Runtime Deck"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <strong>Language:</strong> English | <a href="./README.zh-CN.md">Chinese</a>
</p>

## What SymHarix Is

SymHarix is a self-hostable control plane for supervised coding work. The user talks to a Telegram bot, the Supervisor clarifies or prepares a Plan Card, and approved work is routed to the configured GitHub repository through the bundled Claude Code-compatible runtime.

Telegram is the primary user loop. Runtime Deck is the diagnostics and control surface. Linear and GitHub remain the durable records for work items, branches, PRs, review evidence, and delivery state.

## Quick Start

```bash
bun run setup:local
# edit .env and WORKFLOW.md
bun run start:local
```

Open Runtime Deck:

```text
http://localhost:3000/runtime
```

Use another port only when needed:

```bash
PORT=4000 bun run start:local
```

Stop local services:

```bash
bun run stop
```

## Core Flow

```text
Telegram / Runtime Deck / Linear poll
  -> Supervisor session and tool router
  -> Orchestrator and approval policy
  -> AgentRunner
  -> scripts/claude-adapter.cjs
  -> claude-code/bin/claude-haha
  -> GitHub / Linear / Runtime history
```

The main behavior:

- Telegram handles conversation, clarification, repo switching, Plan Cards, approval, and concise lifecycle updates.
- Runtime Deck shows issue state, timelines, token usage, recent agent progress, delivery blockers, and safe write actions.
- Mini App issue views expose active stage, active PR context, replay history, and file diffs when a workspace or PR head is available.
- Repository routing is explicit and fail-closed. A Linear `project_slug` must map to a GitHub repository in `WORKFLOW.md`.
- Claude Code-compatible execution runs through `scripts/claude-adapter.cjs`; read-only repo understanding uses the same adapter unless overridden.

## Configuration

SymHarix reads three layers:

1. `.env`: secrets, API keys, Telegram, Runtime Deck, and LLM settings.
2. `WORKFLOW.md`: tracker states, repository routing, agent command, verification scenarios.
3. Target repo contracts: `.symphony-repo.yaml` and `.symphony-constitution.md`.

Use `SYMHARIX_*` for new environment variables. Legacy `SYMPHONY_*` variables, `.symphony-*` contracts, and the local `symphony.db` file remain supported for compatibility.

Minimum local `.env`:

```dotenv
SYMHARIX_TRACKER_KIND=linear
SYMHARIX_TRACKER_API_KEY=...
SYMHARIX_TRACKER_PROJECT_SLUG=sample-project
GITHUB_TOKEN=...
ANTHROPIC_API_KEY=...
```

Minimum Telegram `.env`:

```dotenv
SYMHARIX_TELEGRAM_BOT_TOKEN=...
SYMHARIX_TELEGRAM_WEBHOOK_SECRET=...
SYMHARIX_TELEGRAM_OPERATOR_IDS=123456789
```

SymHarix does not require a public IP, but Telegram webhook and Mini App features require a stable publicly reachable HTTPS URL. For production, use a domain with HTTPS reverse proxy or a named Cloudflare Tunnel. Quick trycloudflare.com tunnels are intended for local development and demos, not 24/7 production.

Example repository route:

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
```

The route key must match the Linear `project_slug`. Missing routes block dispatch before workspace creation.

## Telegram Supervisor

A typical Telegram interaction:

1. The user sends a natural-language request.
2. Supervisor answers, asks a follow-up, switches repo context, reads a routed repo, or shows a Plan Card.
3. Risky or broad writes wait for approval.
4. Approved work is materialized and executed through the Orchestrator.
5. Telegram edits the active lifecycle card instead of sending duplicate updates.

Low-risk control actions such as listing repositories, showing cards, watching issues, stopping, retrying, or setting the default project go through Supervisor tools. Higher-risk actions such as create, close, supersede, split, rewrite, or override are governed by the confirmation policy.

## Health And Verification

```bash
bun run health
```

Useful local endpoints:

```text
http://localhost:3000/api/v1/runtime/manifest
http://localhost:3000/api/v1/bots/manifest
http://localhost:3000/api/v1/runtime/overview
```

For Telegram, trust `/api/v1/bots/manifest`: check `health`, `webhook_url`, `public_base_url`, `mini_app_base_url`, pending updates, and the last webhook error.

For delivery, trust Runtime issue detail. For example, `delivery_code=merge_blocked` means review proof passed, but the final merge or delivery action still needs attention.

Live Telegram-first verification:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

Local development checks:

```bash
bun run test
bun run build
git diff --check
```

## Documentation

- [QUICKSTART.md](./QUICKSTART.md): local setup and first Telegram test.
- [docs/CONFIGURATION.md](./docs/CONFIGURATION.md): `.env`, `WORKFLOW.md`, and target-repo contract reference.
- [docs/AI_OPERATOR_GUIDE.md](./docs/AI_OPERATOR_GUIDE.md): live-debugging rules for maintainers and AI agents.
