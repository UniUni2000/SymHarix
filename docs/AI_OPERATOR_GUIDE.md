# AI Operator Guide

This guide is for AI agents or maintainers working inside the symphonyness repository. It states the operating rules that are easy to forget when debugging live Supervisor/Telegram flows.

## Prime Directive

Respect the operator's configured target. symphonyness can create issues, branches, PRs, comments, and tracker state transitions in the routed repository, so verify `.env` and `WORKFLOW.md` before any live test.

The examples in this guide use placeholder values:

```text
Linear project slug: sample-project
GitHub repo: acme/demo-app
```

Before any live test, check:

```bash
rg -n "SYMPHONY_TRACKER_PROJECT_SLUG|repositories:|routing:|github_owner|github_repo" .env WORKFLOW.md
```

Expected:

- `.env` default project is `sample-project`.
- `WORKFLOW.md -> repositories.routing` maps `sample-project` to `acme/demo-app`.
- The route points to the repository the operator intends to use for this run.

## What The System Is

symphonyness is a local control plane with a Telegram-first Supervisor.

The Supervisor is not simply a model call and not a Claude Code instance. It is a durable state machine plus an optional LLM brain:

- Session state and approvals live in SQLite.
- Telegram is the clarification and approval surface.
- Linear/GitHub are records and delivery surfaces.
- Orchestrator still owns dispatch, retry, dev/review post-processing, delivery cleanup.
- Claude Code does code edits through `scripts/claude-adapter.cjs`.

## Safe Startup

Use:

```bash
bun run start -- --port 3000
```

Stop:

```bash
bun run start -- --kill
```

If startup behaves strangely, inspect before changing code:

```bash
curl http://localhost:3000/api/v1/runtime/manifest
curl http://localhost:3000/api/v1/bots/manifest
curl http://localhost:3000/api/v1/runtime/overview
```

## Live E2E Rules

For Telegram-first Supervisor behavior, use attach mode:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

The verifier must enter through Telegram webhook/session logic. If a verifier creates issues directly through the runtime API, it is not validating Telegram-first Supervisor behavior.

Expected live flow:

1. Telegram request arrives.
2. Bot quickly ACKs.
3. Supervisor creates or updates one root session for the chat.
4. Plan Card appears.
5. Approval materializes work.
6. Root issue remains the user-facing thread.
7. Child issues run sequentially.
8. Supervisor writes directives after dev/review milestones.
9. Telegram receives high-signal updates only.

## Do Not Reintroduce These Bugs

Do not:

- Send ordinary lifecycle digests while a Supervisor root card is active.
- Create descendant Telegram cards that steal focus from the root session.
- Treat proof/evidence success as delivery success.
- Let a stale active session block new work without offering clear `continue / cancel / new thread` choices.
- Let `message is not modified` trigger Telegram fallback sends.
- Let old retry/failed notifications replay after restart because only in-memory dedupe was used.
- Create live verifier issues outside the dedicated test repo.

## Common Failure Modes

### Telegram button appears dead

Check:

- `/api/v1/bots/manifest`
- webhook diagnostics
- tunnel/public URL reachability
- callback audit logs
- `bot_transport_events`

Classify the failure:

- webhook did not arrive
- callback parsed but ACK failed
- ACK succeeded but async execution failed
- execution succeeded but card edit failed

### Duplicate Telegram messages

Inspect:

```bash
sqlite3 symphony.db "select source, action, result, message_id, material_key, created_at from bot_transport_events order by id desc limit 30;"
sqlite3 symphony.db "select * from bot_followup_delivery_states order by updated_at desc limit 20;"
sqlite3 symphony.db "select * from bot_followup_message_states order by updated_at desc limit 20;"
```

Prefer fixing persistent material-key/delivery-state logic over adding another in-memory guard.

### Supervisor session blocks new work

Inspect:

```bash
sqlite3 symphony.db "select id, state, transport, conversation_id, repo_ref, root_issue_id, updated_at from supervisor_sessions order by updated_at desc limit 20;"
```

For user-facing UX, the bot should offer clear options:

- continue current thread
- cancel current thread
- new thread

### Dev agent fails immediately

Check the true runner path:

```text
Orchestrator -> AgentRunner -> scripts/claude-adapter.cjs -> claude-code/bin/claude-haha
```

Look for:

- `codex.command` in `WORKFLOW.md`
- `ANTHROPIC_API_KEY`
- local workspace path
- branch/source-of-truth mismatch
- compact dev context size
- Claude process startup stderr

### PR or issue does not close

Do not assume code evidence means delivery completed. Check:

- `delivery_code`
- `delivery_summary`
- active PR number
- PR head branch
- GitHub issue mapping
- tracker state conflict recovery
- orphan repair logs

## Repair Commands

Stop everything first if the run is confused:

```bash
bun run start -- --kill
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
- cancel or archive local Supervisor sessions and jobs for that repo

Never run destructive cleanup against the wrong repository.

## Context Budget Rules

The dev agent first turn must stay compact.

Avoid injecting:

- full child queue histories
- full GitHub issue/PR histories
- repeated timeline noise
- stale governance boilerplate
- broad repo scans

Prefer:

- root goal
- current child goal
- acceptance summary
- latest supervisor directive
- compact branch/PR facts
- missing evidence summary
- recent high-signal events

## Before Claiming Success

Run:

```bash
bun run test
bun run build
git diff --check
```

For Telegram/Supervisor changes, also run or schedule:

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

If live verification fails, summarize by evidence, not guesswork:

1. exact issue/session/message ids
2. first failing transition
3. observed logs/DB rows
4. delivery code and summary
5. whether failure is Telegram ingress, Supervisor session, orchestrator dispatch, dev agent, review, GitHub delivery, or cleanup
