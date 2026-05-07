# Supervisor-First Intake Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Telegram supervisor feel like a smart repo-aware conversational agent that can chat naturally, spot clear issue-worthy opportunities, suggest them proactively, and only fall back to mechanical issue creation when the user explicitly uses slash commands.

**Architecture:** Telegram freeform chat should first reach the supervisor intelligence path, not the old issue-form path. The supervisor may answer, ask a clarifying question, or recommend an issue draft, but it must wait for explicit user assent before materializing a new issue thread. Slash commands remain the deterministic machine-mode escape hatch. The implementation should preserve the current session model and approval mechanics, but change the intake boundary and prompt/response shape so the first impression is recommendation-led instead of form-led.

**Tech Stack:** Bun, TypeScript, existing Telegram bot pipeline, `src/bots/assistant.ts`, `src/bots/commandService.ts`, `src/supervisor/sessionService.ts`, existing supervisor session/event repositories.

---

## Background

Today, Telegram natural language is mostly filtered by `fastHeuristic`, and the supervisor only receives messages when the heuristic says `create_issue` or when an active session already exists. That makes the experience feel like a form parser with a few smart exceptions.

This redesign makes the supervisor the default conversational front door for Telegram. The user can still issue slash commands for direct machine actions, but ordinary chat should feel like talking to a knowledgeable teammate who understands the repo, asks good follow-up questions, and occasionally says, "this looks like a real issue worth filing" before asking for a yes/no.

## Goals

- Make Telegram chat feel natural, not like a command form.
- Let the supervisor understand ordinary repo questions, planning talk, and issue-worthy requests in one flow.
- Keep slash commands available as the explicit mechanical path.
- When the supervisor sees a clear opportunity, show a prominent suggestion first, then wait for approval.
- Preserve the current approval and session materialization model after the user agrees.
- Keep the behavior stable enough to test with deterministic boundaries.

## Non-Goals

- Replacing the supervisor with a pure chat assistant.
- Removing slash commands.
- Changing the runtime/orchestrator execution model beyond intake and session initiation.
- Auto-creating issues from vague user text without a visible approval step.

## Proposed User Experience

1. User sends a normal Telegram message.
2. Supervisor answers directly if it is just a question or conversation.
3. If the supervisor thinks the message is likely an issue request or a useful repo task, it sends a clearly visible recommendation card/message first.
4. The recommendation includes a short summary, why it matters, and the proposed next step.
5. Only after the user approves does the system create or materialize the issue/session.
6. If the user uses slash commands, the system takes the direct deterministic path.

## Behavior Model

### Telegram freeform chat
- Default route: supervisor conversation.
- The supervisor may ask one clarifying question at a time.
- The supervisor may answer questions directly when no issue should be created.
- The supervisor may propose an issue only when confidence and usefulness are both high.
- The supervisor should not turn every message into a form-filling workflow.

### Slash commands
- `/new`, `/status`, `/project`, `/watch`, `/stop`, `/retry`, `/override`, `/rewrite`, `/split`, and similar commands remain explicit machine actions.
- Slash commands bypass the conversational recommendation flow unless the command itself already implies a supervisor session.

### Proactive issue suggestion
- Trigger threshold is conservative.
- Only clear pain points or clear improvement opportunities should trigger a proactive suggestion.
- The suggestion must be phrased as a recommendation, not a completion state.
- The system must wait for user assent before creating the issue thread.

### Approval rhythm
- One suggestion, one user decision, then continue.
- If the user declines, the supervisor should stay conversational and keep helping.
- If the user edits the idea, the supervisor should revise the recommendation instead of restarting from scratch.

## Architecture Changes

### 1. Intake routing
- Make Telegram freeform messages route to supervisor first.
- Keep slash commands on the existing deterministic command path.
- Keep the old issue-form heuristic only as a fallback inside the supervisor flow, not as the front door.

### 2. Supervisor intake brain
- Add a supervisor intake decision layer that can classify a message as:
  - direct answer
  - clarification needed
  - recommendation candidate
  - explicit issue creation request
  - machine command fallback
- The brain should be repo-aware and use project context when forming the recommendation.

### 3. Recommendation surface
- When a recommendation is warranted, emit a high-visibility chat message with:
  - a short proposed issue title
  - the reason this is worth doing
  - a concise repo-aware summary
  - the next action the user can approve
- The message should feel like an advisor speaking, not a parser echoing fields.

### 4. Session materialization
- A supervisor recommendation becomes a session only after user approval.
- Existing session lifecycle and repositories remain the storage boundary.
- Once approved, the current plan/issue creation flow can proceed with minimal change.

## File Impact

- `src/bots/assistant.ts`: change the Telegram routing priority so freeform chat reaches supervisor first.
- `src/bots/commandService.ts`: keep the command parser as the explicit machine path.
- `src/supervisor/sessionService.ts`: extend the supervisor intake behavior so it can chat, recommend, and wait for assent before materializing.
- `src/supervisor/sessionService.test.ts`: add coverage for conversational intake, proactive suggestion, and approval gating.
- `src/bots/assistant.test.ts` and `src/bots/gateway.test.ts`: verify routing no longer feels command-only for normal Telegram chat.

## Decision Rules

- If the text starts with a slash command, treat it as command mode.
- If the user is already in an active supervisor session, continue that session.
- Otherwise, let the supervisor evaluate the message first.
- Only surface a proactive issue suggestion when the message is clearly issue-worthy.
- Never auto-create a new issue thread from a suggestion without approval.

## Error Handling

- If the supervisor cannot classify the message confidently, it should ask a clarifying question instead of forcing issue creation.
- If repo context is missing, the supervisor should say so and keep the conversation open.
- If the user rejects a suggestion, the system should return to normal chat without creating state churn.

## Testing

- Normal Telegram chat reaches the supervisor path even when it is not a clear issue request.
- Slash commands still behave exactly as mechanical commands.
- A clear issue opportunity produces a recommendation first, not an immediate materialization.
- Approval creates the issue/session only after the user assents.
- Ambiguous requests result in clarification rather than forced issue creation.
- Existing active sessions still continue correctly after the routing change.

## Acceptance Criteria

- Telegram chat feels like talking to a knowledgeable supervisor.
- Users can keep chatting casually without being forced through forms.
- Clear issue opportunities are surfaced proactively and politely.
- The system still respects explicit slash commands.
- The approval boundary remains visible and deterministic.

## Open Questions Resolved

- The user wants the supervisor to be the intelligent conversational layer.
- The user wants slash commands to remain the mechanical escape hatch.
- The user wants proactive suggestions to happen only after a clear opportunity is detected.
- The user wants the system to wait for a yes/no before creating the issue thread.
