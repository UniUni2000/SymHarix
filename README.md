# ✨ SymHarix — Telegram-First AI Supervisor

<p align="center">
  <img src="./assets/readme/logo.gif" alt="SymHarix logo animation" width="920">
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/Quick_Start-Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Quick Start"></a>
  <a href="#telegram-and-feishu-supervisor"><img src="https://img.shields.io/badge/Telegram_%2F_Feishu-bot-229ED9?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram and Feishu bot"></a>
  <a href="#core-flow"><img src="https://img.shields.io/badge/Runtime-Deck-6D5DFC?style=for-the-badge" alt="Runtime Deck"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <strong>Language:</strong> English | <a href="./README.zh-CN.md">Chinese</a>
</p>

<p align="center">
  <img src="./assets/readme/concept-flow.png" alt="SymHarix Telegram-first supervised coding control plane conceptual flow" width="920">
</p>

<p align="center">
  <em>Conceptual flow illustration; actual Telegram, Runtime Deck, and Mini App screens may differ.</em>
</p>

## Demo Video

Watch the walkthrough: [SymHarix demo video](https://youtu.be/1dCix6hFUY0).

The video shows the full loop from Telegram intake to Plan Card approval, runtime progress, Mini App inspection, Harness review evidence, and a verified GitHub pull request.

## What SymHarix Is

SymHarix is a self-hostable control plane for supervised coding work. The user talks to a Telegram or Feishu bot, the Supervisor clarifies or prepares a Plan Card, and approved work is routed to the configured GitHub repository through a pinned open-source OpenCode runtime.

Telegram is the default local entrypoint, while Feishu can run as an independent long-connection entrypoint for teams that cannot conveniently use Telegram. Runtime Deck is the diagnostics and control surface. Linear and GitHub remain the durable records for work items, branches, PRs, review evidence, and delivery state.

## Guided Tour

SymHarix is intentionally beginner-friendly: it guides users from a Telegram or Feishu request into a tracked issue, keeps overall progress visible in preview cards, and lets the operator ask about status or blockers at any time.

<p align="center">
  <img src="./assets/readme/guided-tour-telegram.gif" alt="Telegram-guided SymHarix conversation and issue context" width="820">
</p>

When an issue is too large, SymHarix helps split it into focused child issues. After the user confirms the split, it runs the child issues by priority until the project is complete.

<p align="center">
  <img src="./assets/readme/guided-tour-supervision.gif" alt="SymHarix issue splitting and supervised child issue execution" width="820">
</p>

For deeper visibility, the Mini App shows the live Status Overview, code diffs, stage details, and real-time token usage for the current issue.

<p align="center">
  <img src="./assets/readme/guided-tour-miniapp.gif" alt="SymHarix Mini App status overview, diffs, and token usage" width="820">
</p>

The SymHarix reviewer checks code from the dev agent before delivery can continue. The branch detail view makes review status and reviewer evidence visible before merge.

<p align="center">
  <img src="./assets/readme/guided-tour-review.gif" alt="SymHarix GitHub review proof and delivery state walkthrough" width="820">
</p>

## Install

macOS / Linux one-line install (downloads a GitHub Release, verifies SHA-256, creates an isolated Python environment, then opens setup):

```bash
curl -fsSL https://raw.githubusercontent.com/UniUni2000/SymHarix/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/UniUni2000/SymHarix/main/install.ps1 | iex
```

Git and Python 3 are required system tools; the installer checks them before downloading and exits with a precise message when either is missing. Bun is bundled in each release package. Application versions are separate from mutable configuration, database, Python environment, and workspaces under the per-user SymHarix home, so upgrades do not overwrite operator data.

For a script-free install, download the matching `tar.gz` / `.zip` and `checksums.txt` from [GitHub Releases](https://github.com/UniUni2000/SymHarix/releases), verify it, extract it, and run `SymHarix/bin/symharix` (`SymHarix\bin\symharix.cmd` on Windows).

## Quick Start

Downloaded package:

```bash
symharix guide
symharix configure
symharix check
symharix doctor
symharix smoke
symharix start telegram # or symharix start feishu
```

After first-time setup, `symharix config` opens selective configuration management instead of replaying the entire wizard. Direct shortcuts are also available:

```bash
symharix config models
symharix config telegram
symharix config feishu
symharix config connections
symharix config budget
symharix config security
symharix config status
symharix configure all       # explicitly replay the full wizard
```

Only the selected category is written. Existing secrets remain masked and can be kept unchanged or explicitly replaced.

Equivalent source-checkout commands:

```bash
bun run configure:guide
bun run configure:secure
bun run configure
bun run configure:check
bun run configure:doctor
bun run runtime:smoke
bun run runtime:access -- copy viewer # Copy the read-only Runtime token without printing it
bun run start:telegram # or bun run start:feishu
```

The terminal guide explains where every key/token comes from and the minimum permissions. `configure:check` performs offline format checks, while `configure:doctor` performs read-only connectivity checks. Only `runtime:smoke` sends a small real model request.

Downloaded packages also provide `symharix open`, `symharix stop`, and `symharix runtime install`. See the [distribution design](./docs/DISTRIBUTION.zh-CN.md) for the release model and comparisons with other open-source installers.

The first OpenCode download reports percent, size, speed, and elapsed time. A 30-second data stall or five-minute total timeout stops the current request and offers an explicit retry-or-skip choice without discarding completed configuration or partial download bytes; the next attempt resumes with HTTP Range.

When a key/token already exists, the wizard shows only a masked prefix/suffix and explicitly asks whether to keep it unchanged or replace it. Replacement input is never echoed.

`bun run start` is an alias for the Telegram surface. To run only Feishu, use:

```bash
bun run start:feishu
```

Open Runtime Deck:

```text
http://localhost:3000/runtime
```

Use another port only when needed:

```bash
PORT=4000 bun run start
```

Stop local services:

```bash
bun run stop
```

Install and check the checksum-verified OpenCode runtime:

```bash
bun run runtime:install
bun run runtime:check
```

On a Linux server, install a systemd service so SymHarix keeps running after SSH disconnects:

```bash
bash scripts/install-systemd-service.sh
sudo journalctl -u symharix -f
```

## Core Flow

```text
Telegram or Feishu / Runtime Deck / Linear issue
  -> Supervisor session, repo routing, Plan Card, approval
  -> Issue-scoped run in Runtime history
  -> Workspace checkout + feature branch
  -> AgentRunner -> scripts/opencode-adapter.cjs
  -> pinned anomalyco/opencode runtime
  -> Code changes + tests + evidence
  -> GitHub branch -> pull request -> review
  -> Merge or delivery blocker
  -> Linear state + Runtime Deck + Mini App updated
```

The main behavior:

- Telegram or Feishu handles conversation, clarification, repo switching, Plan Cards, approval, and concise lifecycle updates.
- Runtime Deck shows issue state, timelines, token usage, recent agent progress, delivery blockers, and safe write actions.
- Mini App issue views expose active stage, active PR context, replay history, and file diffs when a workspace or PR head is available.
- Approved work becomes an issue-scoped coding run: SymHarix prepares the workspace, creates or tracks a feature branch, captures verification evidence, opens or follows a GitHub PR, and keeps review and merge state visible.
- Repository routing is explicit and fail-closed. A Linear `project_slug` must map to a GitHub repository in `WORKFLOW.md`.
- Agent execution runs through `scripts/opencode-adapter.cjs`, which launches the pinned open-source OpenCode runtime. Read-only planning/review and writable development use separate permission policies.

See [docs/OPENCODE_RUNTIME.zh-CN.md](docs/OPENCODE_RUNTIME.zh-CN.md) for the
version lock, role permissions, model routing, and gated upgrade workflow.

## Configuration

SymHarix reads three layers:

1. `.env`: secrets, API keys, chat-surface, Runtime Deck, and LLM settings.
2. `WORKFLOW.md`: tracker states, repository routing, agent command, verification scenarios.
3. Target repo contracts: `.symphony-repo.yaml` and `.symphony-constitution.md`.

Use `SYMHARIX_*` for new environment variables. New installations use `symharix.db`; if an existing `symphony.db` is present, SymHarix automatically keeps using it in place. Legacy `SYMPHONY_*` variables and `.symphony-*` repository contracts remain supported during migration.

Minimum local `.env`:

```dotenv
SYMHARIX_TRACKER_KIND=linear
SYMHARIX_TRACKER_API_KEY=...
SYMHARIX_TRACKER_PROJECT_SLUG=sample-project
GITHUB_TOKEN=...
ANTHROPIC_API_KEY=...
```

Choose at least one chat surface:

- Telegram: configure the Telegram variables and run `bun run start:telegram` or `bun run start`.
- Feishu: configure the Feishu variables and run `bun run start:feishu`.
- Both can exist in `.env`, but each local start command isolates its own surface. `start:feishu` does not require Telegram variables, and `start:telegram` does not require Feishu variables.

Minimum Telegram `.env`:

```dotenv
SYMHARIX_TELEGRAM_BOT_TOKEN=...
SYMHARIX_TELEGRAM_WEBHOOK_SECRET=...
SYMHARIX_TELEGRAM_OPERATOR_IDS=123456789
```

Minimum Feishu `.env`:

```dotenv
SYMHARIX_FEISHU_APP_ID=cli_xxx
SYMHARIX_FEISHU_APP_SECRET=...
SYMHARIX_FEISHU_OPERATOR_IDS=ou_xxx
```

How to get these values:

1. Open [Feishu Open Platform](https://open.feishu.cn/) and create a **self-built app** for your organization.
2. In **Add App Capability**, enable **Bot**. This is the Feishu robot users will chat with.
3. In **Credentials and Basic Info**, copy **App ID** into `SYMHARIX_FEISHU_APP_ID` and **App Secret** into `SYMHARIX_FEISHU_APP_SECRET`.
4. In **Events and Callbacks**, set the subscription mode to **persistent connection**, then add `im.message.receive_v1` and `card.action.trigger`.
5. For `SYMHARIX_FEISHU_OPERATOR_IDS`, first leave it blank for a read-only run, start with `bun run start:feishu`, and send a write command to the bot. Copy the detected `ou_...` user id from its reply into `.env`, then restart. Put multiple ids in the variable separated by commas.

Required Feishu app permissions for the full SymHarix bot flow:

| Scope | Purpose |
| --- | --- |
| `im:message.group_at_msg.include_bot:readonly` | Receive group messages that mention the current bot and include other bots/users. |
| `im:message.group_at_msg:readonly` | Receive group messages where users mention the bot. |
| `im:message.p2p_msg:readonly` | Receive direct messages sent to the bot. |
| `im:message:send_as_bot` | Reply as the bot. |
| `im:message:update` | Edit sent messages/cards for Plan Card and runtime-card updates. |
| `im:resource` | Upload and display card image/file resources. |

Run Feishu locally with long connection mode:

```bash
bun run start:feishu
```

Feishu long connection message intake does not require a public IP or webhook URL. Runtime buttons default to `SYMHARIX_FEISHU_RUNTIME_OPEN_MODE=applink_web_url`; if mobile Feishu clients need to open the runtime view, use a stable public ingress with `SYMHARIX_PUBLIC_BASE_URL=https://your-domain.example`, or let `start:feishu` create a temporary `trycloudflare.com` tunnel only for Mini App/runtime links during local development. Telegram webhook and Mini App features still require a stable publicly reachable HTTPS URL in production. Use a domain with HTTPS reverse proxy or a named Cloudflare Tunnel; quick `trycloudflare.com` tunnels are intended for local development and demos, not 24/7 production.

Example repository route:

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
```

The route key must match the Linear `project_slug`. Missing routes block dispatch before workspace creation.

## Telegram And Feishu Supervisor

Telegram and Feishu now share the same Supervisor logic. Feishu uses Open Platform long connection mode; after enabling bot capability, set both Events and Callbacks to persistent connection and add `im.message.receive_v1` plus `card.action.trigger` to mirror the Telegram conversation, Plan Card, approval buttons, runtime cards, and follow-ups.

The two transports are intentionally isolated. Feishu-origin issues send follow-ups to the Feishu origin conversation and Feishu operations chat only; Telegram-origin issues do the same on Telegram. This keeps Feishu usable even when Telegram is unconfigured or unreachable.

A typical Telegram/Feishu interaction:

1. The user sends a natural-language request.
2. Supervisor answers, asks a follow-up, switches repo context, reads a routed repo, or shows a Plan Card.
3. Risky or broad writes wait for approval.
4. Approved work is materialized and executed through the Orchestrator.
5. Telegram/Feishu edits the active lifecycle card instead of sending duplicate updates.

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
