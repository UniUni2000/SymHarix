# AI Operator Guide

**Language:** English | [Chinese](./AI_OPERATOR_GUIDE.zh-CN.md)

This guide is for maintainers and AI agents working inside this repository. It focuses on live Supervisor, Telegram, Runtime Deck, and delivery debugging.

## Prime Directive

Respect the operator's configured target. SymHarix can create issues, branches, PRs, comments, and tracker state transitions in the routed repository.

Before any live test, check:

```bash
rg -n "SYMHARIX_TRACKER_PROJECT_SLUG|repositories:|routing:|github_owner|github_repo" .env WORKFLOW.md
```

Expected shape:

```text
Linear project slug: sample-project
GitHub repo: acme/demo-app
```

Only run live verification against a repository where automated issues, branches, PRs, comments, and cleanup are allowed.

## What The System Is

SymHarix is a self-hostable control plane with a Telegram-first Supervisor.

- Telegram is the main clarification and approval surface.
- Runtime Deck is the diagnostics and control surface.
- Linear and GitHub are records and delivery surfaces.
- Runtime issue detail and Mini App history are the best place to inspect persisted agent-run usage, replay summaries, active PR context, and file diffs.
- Multi-repo context is explicit: Telegram can list configured routes, switch the chat default project, and read a named repo through the read-only advisor.
- Orchestrator owns dispatch, retry, dev/review handoff, delivery cleanup, and repair.
- Claude-compatible execution runs through `scripts/claude-adapter.cjs`.

The Supervisor is not just a model call and not just a Claude Code process. It is durable session state plus optional LLM and read-only repo-understanding paths.

## Safe Startup

Preferred local path:

```bash
bun run setup
bun run start
```

Stop:

```bash
bun run stop
```

Use another port only when `3000` is busy:

```bash
PORT=4000 bun run start
PORT=4000 bun run health
```

If startup behaves strangely, inspect before changing code:

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/overview
curl http://localhost:3000/api/v1/bots/manifest
```

For Telegram, verify:

- `data.transports.telegram.health`
- `data.transports.telegram.webhook_url`
- `data.transports.telegram.public_base_url`
- `data.transports.telegram.mini_app_base_url`
- `data.transports.telegram.webhook_pending_update_count`
- `data.transports.telegram.webhook_last_error_message`

If Telegram replies but the local manifest has an empty webhook URL, another bot process or deployment may be answering with the same token.

If the public base URL is a temporary `trycloudflare.com` address, treat HTTP 530, stale webhook URLs, DNS errors, and repeated pending updates as tunnel-layer failures first. Let `start` recover the tunnel before changing application code.

## Live E2E Rules

For Telegram-first Supervisor behavior, use attach mode:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

The verifier must enter through Telegram webhook/session logic. Creating issues directly through Runtime API does not validate Telegram-first behavior.

Expected live flow:

1. Telegram request arrives.
2. Bot quickly ACKs.
3. Supervisor creates or resumes one root session for the chat.
4. Plan Card or direct answer appears.
5. Approval materializes work when needed.
6. Root issue remains the user-facing thread.
7. Child issues run sequentially when a split plan is approved.
8. Telegram receives high-signal updates only.

## Failure Classification

When something breaks, classify the layer before patching:

- Process/lease: stale local service, occupied port, primary lease conflict.
- Webhook ingress: Telegram did not reach local service.
- Telegram transport: callback ACK, card edit, sendPhoto/sendMessage, Mini App URL.
- Supervisor session: stale active session, missing approval, wrong repo context.
- Orchestrator: issue materialization, dispatch, retry, governance.
- Dev agent: adapter startup, workspace path, Anthropic key, branch drift.
- Delivery: PR, tracker transition, issue close, cleanup.
- Delivery blocker: proof is satisfied, but merge or final delivery failed, commonly `delivery_code=merge_blocked`.

## Common Checks

### Telegram Button Appears Dead

Check:

- `/api/v1/bots/manifest`
- webhook diagnostics
- tunnel/public URL reachability
- stale `trycloudflare.com` public base URL
- callback audit logs
- `bot_transport_events`

Classify:

- webhook did not arrive
- callback parsed but ACK failed
- ACK succeeded but async execution failed
- execution succeeded but card edit failed

### Duplicate Telegram Messages

Inspect:

```bash
sqlite3 symphony.db "select source, action, result, message_id, material_key, created_at from bot_transport_events order by id desc limit 30;"
sqlite3 symphony.db "select * from bot_followup_delivery_states order by updated_at desc limit 20;"
sqlite3 symphony.db "select * from bot_followup_message_states order by updated_at desc limit 20;"
```

Prefer fixing persisted material-key or delivery-state logic over adding another in-memory guard.

### Supervisor Session Blocks New Work

Inspect:

```bash
sqlite3 symphony.db "select id, state, transport, conversation_id, repo_ref, root_issue_id, updated_at from supervisor_sessions order by updated_at desc limit 20;"
```

The user-facing UX should offer clear choices:

- continue current thread
- cancel current thread
- new thread

### Supervisor Answers Feel Shallow

Check repo understanding:

```bash
sqlite3 symphony.db "select repo_ref, local_path, commit_sha, status, summary, error, updated_at from supervisor_repo_understandings order by id desc limit 20;"
```

If missing or failed, verify:

- chat default project
- `WORKFLOW.md -> repositories.routing`
- route local path or source cache
- `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND`
- `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND`
- `claude-code/bin/claude-symharix --help` from this checkout
- readable repository path and valid Git `HEAD`

Repo understanding is read-only. It should improve conversation and recommendations, but must not create issues or edit code before a Plan Card is approved.

### Wrong Repository In Telegram

Check configured routes and chat preference before changing code:

```bash
rg -n "repositories:|routing:|github_owner|github_repo|SYMHARIX_TRACKER_PROJECT_SLUG" WORKFLOW.md .env
```

In Telegram, ask for available repositories or switch explicitly:

- `What repositories are configured?`
- `Switch to sample-project`
- `Switch to acme/demo-app`
- `What does the test2 repo do?`

The resolver accepts project slug, full `owner/repo`, or repo name. If a route is missing, the system should fail closed instead of guessing.

### Dev Agent Fails Immediately

True runner path:

```text
Orchestrator -> AgentRunner -> scripts/claude-adapter.cjs -> bundled Claude-compatible runtime
```

Check:

- `agent_runner.command` in `WORKFLOW.md`, or legacy `codex.command`
- `ANTHROPIC_API_KEY`
- local workspace path
- branch/source-of-truth mismatch
- compact dev context size
- Claude process startup stderr

### PR Or Issue Does Not Close

Do not assume code evidence means delivery completed.

Check:

- `delivery_code`
- `delivery_summary`
- active PR number
- PR head branch
- GitHub issue mapping
- tracker state conflict recovery
- orphan repair logs

If `delivery_code=merge_blocked`, treat it as a delivery blocker, not as failed review proof. Open the active PR, inspect the merge failure, then retry or supersede after the blocker is resolved.

## Repair Commands

Stop first when a run is confused:

```bash
bun run stop
```

Repair local bot/GitHub residue:

```bash
bun src/cli/index.ts repair all
```

If a test repo was polluted by live verification, clean it deliberately:

- close open PRs and issues
- delete non-main branches
- remove local workspaces for that repo
- cancel corresponding Linear test issues
- cancel or archive local Supervisor sessions/jobs for that repo

Never run destructive cleanup against the wrong repository.

## Before Claiming Success

Run:

```bash
bun run test
bun run build
git diff --check
```

For Telegram/Supervisor behavior, also run or schedule:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

If live verification fails, summarize by evidence:

- exact issue/session/message ids
- first failing transition
- observed logs or DB rows
- delivery code and summary
- failing layer
