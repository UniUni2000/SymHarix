# Supervisor Control Intents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Telegram supervisor understand natural-language close/supersede requests and execute them through audited runtime/orchestrator commands.

**Architecture:** Supervisor remains the intent layer: it parses "close INT-157, continue INT-158" into a typed command and asks for confirmation. Runtime/orchestrator remains the execution layer: it stops local work, updates durable work-item state, moves Linear to a cancellation state, closes the mapped GitHub issue, records sync events, and refreshes runtime views.

**Tech Stack:** Bun, TypeScript, SQLite repositories, Telegram bot assistant, RuntimeHub, Orchestrator, Linear/GitHub clients.

---

### Task 1: Add Runtime Close/Supersede Command Contract

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/hub.ts`
- Test: `src/orchestrator/index.test.ts`

- [ ] Add a `CloseIssueRequest` type with `successor_issue_id` and `reason`.
- [ ] Add `closeIssue(id, request?)` to `RuntimeControlPlane` and controller interfaces.
- [ ] Add `RuntimeDeliveryCode` values for `manual_stop`, `manual_close`, and `superseded`.

### Task 2: Implement Orchestrator External Close

**Files:**
- Modify: `src/orchestrator/index.ts`
- Test: `src/orchestrator/index.test.ts`

- [ ] Write a failing test proving an idle active work item can be closed as superseded.
- [ ] Implement `closeIssue` so it cancels retry/running state, sets local state to `cancelled`, updates Linear to the configured cancellation state, posts a Linear comment, closes the mapped GitHub issue, and writes sync events.
- [ ] Keep ordinary `stopIssue` local-only so "pause execution" and "close tracker issue" remain distinct commands.

### Task 3: Wire Bot Command and Natural Language Intent

**Files:**
- Modify: `src/bots/types.ts`
- Modify: `src/bots/commandService.ts`
- Modify: `src/bots/assistant.ts`
- Modify: `src/bots/model.ts`
- Test: `src/bots/assistant.test.ts`
- Test: `src/bots/commandService.test.ts`

- [ ] Add `close_issue` and `supersede_issue` command/request shapes.
- [ ] Parse slash commands `/close INT-157` and `/supersede INT-157 INT-158`.
- [ ] Add heuristic parsing for Chinese natural language like `关闭 157 这个 issue，就开发 158`.
- [ ] Put destructive close/supersede actions behind the existing confirmation flow.

### Task 4: Verify

**Files:**
- Test: focused Bun tests and build.

- [ ] Run `bun test src/orchestrator/index.test.ts src/bots/commandService.test.ts src/bots/assistant.test.ts`.
- [ ] Run focused existing bot/runtime regression tests.
- [ ] Run `bun run build`.
- [ ] Run `git diff --check`.
