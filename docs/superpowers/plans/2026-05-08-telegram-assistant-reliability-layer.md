# Telegram Assistant Reliability Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Telegram natural-language message land in a calm, useful, recoverable assistant outcome instead of parser leakage, backend jargon, stale confirmations, or dead-end fallback text.

**Architecture:** Add a small reliability layer around `SupervisorAgentRuntimeService`: transcript-level contract tests define forbidden user-visible outputs and required outcome categories; a focused formatter module turns no-action, invalid-turn, unsupported-tool, and tool-failure states into secretary-style replies; the runtime records raw diagnostics internally while exposing only concise next steps to Telegram users. The plan keeps Claude Code read-only and keeps business/control tools behind the supervisor runtime.

**Tech Stack:** TypeScript, Bun test, SQLite-backed in-memory repositories, existing `SupervisorAgentRuntimeService`, existing Telegram `BotAssistantService` and gateway tests.

---

## File Structure

- Create `src/supervisor/assistantReliability.ts`
  - Owns user-facing reliability copy.
  - Exports `buildNoActionAssistantReply`, `formatToolArgumentRejection`, `formatUnsupportedToolRecovery`, `formatToolFailureRecovery`, `formatDuplicateToolRecovery`, `formatStepLimitRecovery`, `formatPendingActionReminder`, and `isAcknowledgementOnlyText`.
- Modify `src/supervisor/agentRuntime.ts`
  - Imports the reliability helpers.
  - Replaces internal fallback strings and raw tool/model failures with reliability envelopes.
  - Keeps raw error strings in `summary` and persisted events.
  - Adds one model repair turn for invalid model outputs when a model loop is configured.
- Modify `src/supervisor/agentRuntime.test.ts`
  - Adds transcript contract tests for vague acknowledgements, unsupported tools, invalid args, tool exceptions, duplicate-loop summaries, and step-limit summaries.
  - Uses a shared forbidden-output assertion so future regressions fail at the transcript level.
- Modify `src/bots/assistant.test.ts`
  - Verifies Telegram natural language reaches the runtime and receives reliability-layer replies without falling back to old generic model text.
- Modify `src/bots/gateway.test.ts`
  - Verifies asynchronous Telegram delivery sends a reliability-layer answer when the assistant runtime recovers from a malformed turn.

## Outcome Contract

Every Telegram natural-language response from the supervisor runtime must fit one of these user-visible outcomes:

- `direct_answer`: concise answer, evidence, next step.
- `repo_recommendation`: repo-aware issue or artifact recommendation.
- `clarification`: exactly one clear question.
- `confirmation`: explicit action summary plus confirm/cancel actions.
- `progress`: short stage update for long-running work.
- `safe_recovery`: no write executed, what went wrong in user language, next useful phrase.

These strings must not appear in Telegram-facing text:

```ts
export const FORBIDDEN_USER_OUTPUT_PATTERNS = [
  /我还不能确定要做什么/,
  /仓库分析已完成，但需要进一步确认下一步/,
  /Invalid args/i,
  /Unsupported supervisor tool/i,
  /ECONNRESET/i,
  /stack trace/i,
  /undefined|null object/i,
];
```

### Task 1: Add Transcript-Level Reliability Contract Tests

**Files:**
- Modify: `src/supervisor/agentRuntime.test.ts`

- [ ] **Step 1: Write the failing forbidden-output helper inside `agentRuntime.test.ts`**

Add this helper after `createHarness()`:

```ts
const FORBIDDEN_USER_OUTPUT_PATTERNS = [
  /我还不能确定要做什么/,
  /仓库分析已完成，但需要进一步确认下一步/,
  /Invalid args/i,
  /Unsupported supervisor tool/i,
  /ECONNRESET/i,
  /stack trace/i,
  /undefined|null object/i,
];

function expectAssistantSafeMessage(message: string): void {
  expect(message.trim().length).toBeGreaterThan(0);
  for (const pattern of FORBIDDEN_USER_OUTPUT_PATTERNS) {
    expect(message).not.toMatch(pattern);
  }
}
```

- [ ] **Step 2: Write failing tests for vague no-action text**

Add this test near the advisory/repo tests:

```ts
test('turns vague acknowledgements into calm assistant guidance instead of useless fallback', async () => {
  for (const text of ['好的', '嗯', '随便你看看']) {
    const h = createHarness();

    const response = await h.service.respond({
      context: h.context,
      text,
    });

    expect(response.message).toContain('当前没有等待确认的动作');
    expect(response.message).toContain('查 active issues');
    expect(response.message).toContain('建议下一个 issue');
    expect(response.message).not.toContain('Action:');
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })).toBeNull();
    expectAssistantSafeMessage(response.message);
  }
});
```

- [ ] **Step 3: Write failing tests for invalid model tool args**

Replace the current invalid-args expectation with this stricter behavior:

```ts
test('rejects invalid tool args with a recoverable assistant reply before policy or tool execution', async () => {
  const h = createHarness(async () => ({
    type: 'tool_call',
    tool: 'retry_issue',
    args: {},
    reason: 'Malformed model output.',
  }));

  const response = await h.service.respond({
    context: h.context,
    text: 'retry something',
  });

  expect(response.message).toContain('这个动作还缺少 issue id');
  expect(response.message).toContain('我没有执行任何写入');
  expect(response.message).toContain('重试 INT-158');
  expectAssistantSafeMessage(response.message);
  expect(h.runtime.retryCalls).toEqual([]);
  const run = h.runs.findLatestByConversation({
    transport: 'telegram',
    conversation_id: 'chat-1',
  });
  expect(h.toolCalls.findByRun(run!.id)).toHaveLength(0);
  expect(h.events.listByRun(run!.id).map((event) => event.event_kind)).toContain('tool_call_rejected');
});
```

- [ ] **Step 4: Write failing tests for unsupported model tools**

Add this test after the invalid-args test:

```ts
test('hides unsupported model tools behind a safe assistant recovery reply', async () => {
  const h = createHarness(async () => ({
    type: 'tool_call',
    tool: 'delete_everything',
    args: {},
    reason: 'Malformed model output.',
  }));

  const response = await h.service.respond({
    context: h.context,
    text: '帮我处理一下',
  });

  expect(response.message).toContain('这个请求没有执行');
  expect(response.message).toContain('没有改动任何东西');
  expect(response.message).toContain('查状态、读仓库、建议 issue');
  expectAssistantSafeMessage(response.message);
  const run = h.runs.findLatestByConversation({
    transport: 'telegram',
    conversation_id: 'chat-1',
  });
  expect(h.toolCalls.findByRun(run!.id)).toHaveLength(0);
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run:

```bash
bun test src/supervisor/agentRuntime.test.ts --grep "vague acknowledgements|invalid tool args|unsupported model tools"
```

Expected: the new tests fail because the runtime currently exposes the old fallback, `Invalid args`, or `Unsupported supervisor tool`.

### Task 2: Extract Reliability Copy Into a Focused Module

**Files:**
- Create: `src/supervisor/assistantReliability.ts`
- Modify: `src/supervisor/agentRuntime.ts`
- Test: `src/supervisor/agentRuntime.test.ts`

- [ ] **Step 1: Create `src/supervisor/assistantReliability.ts`**

```ts
export function isAcknowledgementOnlyText(text: string): boolean {
  return /^(?:好的?|好吧|嗯+|行|可以|收到|ok|okay|sure|随便你看看|你看着办)[!！,.，。?？\s]*$/i.test(text.trim());
}

export function buildNoActionAssistantReply(text: string): string {
  if (/^(你好|您好|hello|hi|hey|在吗|在么)/i.test(text.trim())) {
    return '你好，我在。你可以直接问我 issue 状态、仓库内容，或者让我起草下一步计划。';
  }

  const lead = /^(?:确认|是的|是|对|对的|没错|yes|y|ok|okay|好|执行|继续|confirm|取消|cancel|no|n|停止)$/i.test(text.trim()) ||
    isAcknowledgementOnlyText(text)
    ? '当前没有等待确认的动作。'
    : '当前没有等待确认的动作，我可以继续帮你往前推进。';

  return [
    lead,
    '你可以直接说：查 active issues、读仓库、建议下一个 issue，或者重试/停止/取消某个 INT-xxx。',
  ].join('\n');
}

export function formatToolArgumentRejection(toolName: string, validationError: string): string {
  if (/issue_id is required/i.test(validationError)) {
    const example = toolName === 'retry_issue'
      ? '重试 INT-158'
      : toolName === 'stop_issue'
        ? '停止 INT-158'
        : '处理 INT-158';
    return [
      '这个动作还缺少 issue id，所以我没有执行任何写入。',
      `请直接说清楚目标，例如：${example}。`,
    ].join('\n');
  }
  if (/project_slug is required/i.test(validationError)) {
    return [
      '这个动作还缺少项目名，所以我没有切换默认项目。',
      '请直接说：set project to test2。',
    ].join('\n');
  }
  if (/title is required/i.test(validationError)) {
    return [
      '这个 issue 还缺少标题，所以我没有创建任何东西。',
      '请用一句话说明要做什么，我会先整理成可确认的 issue。',
    ].join('\n');
  }
  return [
    '这个动作还缺少必要信息，所以我没有执行任何写入。',
    '请补充目标或换一句自然语言描述，我会重新判断。',
  ].join('\n');
}

export function formatUnsupportedToolRecovery(): string {
  return [
    '这个请求没有执行，因为我没有找到一个稳定可用的动作入口。',
    '我没有改动任何东西。你可以换成：查状态、读仓库、建议 issue，或者明确说重试/停止/取消某个 INT-xxx。',
  ].join('\n');
}
```

- [ ] **Step 2: Import the module from `agentRuntime.ts`**

Add this import near the existing supervisor imports:

```ts
import {
  buildNoActionAssistantReply,
  formatToolArgumentRejection,
  formatUnsupportedToolRecovery,
} from './assistantReliability';
```

- [ ] **Step 3: Remove local reliability helpers from `agentRuntime.ts`**

Delete local copies of:

```ts
function isAcknowledgementOnlyText(text: string): boolean
function buildNoActionAssistantReply(text: string): string
function formatToolArgumentRejection(toolName: string, validationError: string): string
function formatUnsupportedToolRecovery(): string
```

- [ ] **Step 4: Wire the helpers into the runtime**

In `finalResponseFromToolResults`, replace the no-result branch with:

```ts
if (!last) {
  return { message: buildNoActionAssistantReply(text) };
}
```

In `executeTool`, replace the unsupported-tool user message with:

```ts
if (!definition) {
  return {
    tool: params.turn.tool,
    ok: false,
    summary: `Unsupported supervisor tool: ${params.turn.tool}`,
    message: formatUnsupportedToolRecovery(),
  };
}
```

In the validation error branch, keep the raw summary and replace only the user message:

```ts
return {
  tool: definition.name,
  ok: false,
  summary: validationError,
  message: formatToolArgumentRejection(definition.name, validationError),
};
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test src/supervisor/agentRuntime.test.ts --grep "vague acknowledgements|invalid tool args|unsupported model tools"
```

Expected: all three tests pass.

### Task 3: Add Safe Recovery for Tool Exceptions and Repo Read Failures

**Files:**
- Modify: `src/supervisor/assistantReliability.ts`
- Modify: `src/supervisor/agentRuntime.ts`
- Test: `src/supervisor/agentRuntime.test.ts`

- [ ] **Step 1: Write failing tests for thrown tool errors**

Add this test after the unsupported-tool test:

```ts
test('turns thrown read-only repo failures into safe recovery copy without leaking internals', async () => {
  const h = createHarness(undefined, {
    supervisorAgentService: {
      respond: async () => {
        throw new Error('ECONNRESET read-only backend stack trace');
      },
      getRepoConversationDiagnostics: () => [],
    },
  });

  const response = await h.service.respond({
    context: h.context,
    text: 'README 有啥',
  });

  expect(response.message).toContain('仓库只读分析暂时失败');
  expect(response.message).toContain('我没有改动任何东西');
  expect(response.message).toContain('可以先查 active issues');
  expectAssistantSafeMessage(response.message);
  const run = h.runs.findLatestByConversation({
    transport: 'telegram',
    conversation_id: 'chat-1',
  });
  const readCall = h.toolCalls.findByRun(run!.id).find((call) => call.tool_name === 'read_repo_with_claude');
  expect(readCall?.status).toBe('failed');
  expect(readCall?.result_summary).toContain('ECONNRESET');
});
```

- [ ] **Step 2: Add `formatToolFailureRecovery`**

Append this to `assistantReliability.ts`:

```ts
export function formatToolFailureRecovery(toolName: string): string {
  if (toolName === 'read_repo_with_claude') {
    return [
      '仓库只读分析暂时失败，但我没有改动任何东西。',
      '你可以先查 active issues、问某个 INT-xxx 的状态，或者稍后再让我读仓库。',
    ].join('\n');
  }
  if (toolName === 'create_issue' || toolName === 'close_issue' || toolName === 'supersede_issue') {
    return [
      '这个写入动作暂时没有完成，我已经停在安全状态。',
      '我没有继续执行后续步骤。请让我先查这个 issue 的当前状态，再决定是否重试。',
    ].join('\n');
  }
  return [
    '这一步暂时失败了，我已经停在安全状态。',
    '我没有改动任何东西。你可以换一句话重试，或者先让我查当前状态。',
  ].join('\n');
}
```

- [ ] **Step 3: Use the formatter in `executeTool` catch block**

Import `formatToolFailureRecovery` and change the catch block return to:

```ts
return {
  tool: definition.name,
  ok: false,
  summary: message,
  message: formatToolFailureRecovery(definition.name),
};
```

Keep this existing persisted diagnostic behavior:

```ts
this.options.toolCalls.update({
  id: call.id,
  status: 'failed',
  duration_ms: Date.now() - started,
  result_summary: message,
});
this.options.events.create({
  run_id: params.runId,
  event_kind: 'tool_call_failed',
  message,
});
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
bun test src/supervisor/agentRuntime.test.ts --grep "thrown read-only repo failures"
```

Expected: the test passes, the user message hides `ECONNRESET`, and the persisted tool call keeps `ECONNRESET` in `result_summary`.

### Task 4: Repair Malformed Model Turns Before Giving Up

**Files:**
- Modify: `src/supervisor/agentRuntime.ts`
- Test: `src/supervisor/agentRuntime.test.ts`

- [ ] **Step 1: Write a failing repair-loop test**

Add this test before the invalid-args test:

```ts
test('asks the model for one repair turn after invalid tool args before falling back to recovery copy', async () => {
  let callCount = 0;
  const h = createHarness(async ({ toolResults }) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        type: 'tool_call',
        tool: 'retry_issue',
        args: {},
        reason: 'Missing issue id.',
      };
    }
    expect(toolResults[0]?.ok).toBe(false);
    expect(toolResults[0]?.summary).toContain('issue_id is required');
    return {
      type: 'clarify',
      question: '你想重试哪一个 issue？例如：重试 INT-158。',
    };
  });

  const response = await h.service.respond({
    context: h.context,
    text: '帮我重试一下',
  });

  expect(callCount).toBe(2);
  expect(response.message).toBe('你想重试哪一个 issue？例如：重试 INT-158。');
  expectAssistantSafeMessage(response.message);
  expect(h.runtime.retryCalls).toEqual([]);
});
```

- [ ] **Step 2: Modify `executeRun` to continue once after validation failures**

In `executeRun`, after the `executeTool` call resolves into `result`, replace the current failed-result branch with:

```ts
toolResults.push(result);
if (!result.ok) {
  const canAskModelForRepair = Boolean(this.options.model) && step + 1 < this.maxSteps;
  if (canAskModelForRepair) {
    this.options.events.create({
      run_id: run.id,
      event_kind: 'model_repair_requested',
      message: result.summary,
      payload: {
        failed_tool: result.tool,
      },
    });
    continue;
  }
  return this.completeRun(run.id, {
    message: result.message ?? result.summary,
  }, 'failed');
}
```

Keep the existing `if (result.response?.actions) return result.response;` before this block so confirmation cards still short-circuit.

- [ ] **Step 3: Add a regression for deterministic mode**

Add this test to prove deterministic mode still returns recovery copy without looping forever:

```ts
test('deterministic invalid args use recovery copy without model repair loop', async () => {
  const h = createHarness(async () => ({
    type: 'tool_call',
    tool: 'retry_issue',
    args: {},
    reason: 'Malformed model output.',
  }), { supervisorAgentService: null });

  const response = await h.service.respond({
    context: h.context,
    text: 'retry something',
  });

  expect(response.message).toContain('这个动作还缺少 issue id');
  expectAssistantSafeMessage(response.message);
});
```

- [ ] **Step 4: Run repair-loop tests**

Run:

```bash
bun test src/supervisor/agentRuntime.test.ts --grep "repair turn|deterministic invalid args|invalid tool args"
```

Expected: all repair and invalid-args tests pass.

### Task 5: Make Pending Confirmation Behavior Secretary-Like

**Files:**
- Modify: `src/supervisor/assistantReliability.ts`
- Modify: `src/supervisor/agentRuntime.ts`
- Test: `src/supervisor/agentRuntime.test.ts`

- [ ] **Step 1: Write failing tests for ambiguous replies while pending exists**

Add this test after the pending-action bypass test:

```ts
test('handles ambiguous acknowledgement while a pending action exists without executing accidentally', async () => {
  const h = createHarness();

  await h.service.respond({
    context: h.context,
    text: '把 157 给我关了吧',
  });

  const response = await h.service.respond({
    context: h.context,
    text: '好的',
  });

  expect(response.message).toContain('我这里还有一个等待确认的动作');
  expect(response.message).toContain('close issue');
  expect(response.message).toContain('请回复“确认”执行，或回复“取消”放弃');
  expect(response.actions?.map((action) => action.label)).toEqual(['确认', '取消']);
  expect(h.runtime.closeCalls).toEqual([]);
  expectAssistantSafeMessage(response.message);
});
```

- [ ] **Step 2: Add pending clarification formatter**

Append this function to `assistantReliability.ts`:

```ts
export function formatPendingActionReminder(summary: string): string {
  const firstLine = summary.split('\n').find((line) => line.trim()) ?? '待确认动作';
  return [
    `我这里还有一个等待确认的动作：${firstLine}`,
    '请回复“确认”执行，或回复“取消”放弃。你也可以直接问状态或仓库内容，我会先回答你的问题。',
  ].join('\n');
}
```

- [ ] **Step 3: Use the pending formatter in `respond`**

In the `existingPending` branch of `SupervisorAgentRuntimeService.respond`, replace:

```ts
return {
  message: `${existingPending.summary_message}\nReply with 确认 / 取消.`,
  actions: buildConfirmActions(),
};
```

with:

```ts
return {
  message: formatPendingActionReminder(existingPending.summary_message),
  actions: buildConfirmActions(),
};
```

Import `formatPendingActionReminder`.

- [ ] **Step 4: Run focused pending tests**

Run:

```bash
bun test src/supervisor/agentRuntime.test.ts --grep "pending action|ambiguous acknowledgement|read questions bypass"
```

Expected: pending reminders are useful, read questions still bypass pending actions, and confirm/cancel behavior is unchanged.

### Task 6: Add Loop Guard and Step-Limit Recovery Copy

**Files:**
- Modify: `src/supervisor/assistantReliability.ts`
- Modify: `src/supervisor/agentRuntime.ts`
- Test: `src/supervisor/agentRuntime.test.ts`

- [ ] **Step 1: Write failing tests for loop guard and step-limit copy**

Add these tests after the progress/duplicate tool-call test:

```ts
test('summarizes duplicate tool-call guard in user-facing language', async () => {
  let turn = 0;
  const h = createHarness(async () => {
    turn += 1;
    return {
      type: 'tool_call',
      tool: 'list_issues',
      args: { active_only: true },
      reason: `Duplicate check ${turn}`,
    };
  });

  const response = await h.service.respond({
    context: h.context,
    text: '一直查 active issues',
  });

  expect(response.message).toContain('我已经用同样条件查过一次');
  expect(response.message).toContain('不会重复空转');
  expect(response.message).toContain('当前有 1 个活跃 issue');
  expectAssistantSafeMessage(response.message);
});

test('summarizes step-limit stop without exposing runtime internals', async () => {
  const h = createHarness(async () => ({
    type: 'progress_update',
    message: 'I am still checking.',
  }), { supervisorAgentService: null });

  const response = await h.service.respond({
    context: h.context,
    text: '慢慢查',
  });

  expect(response.message).toContain('我先停在安全位置');
  expect(response.message).toContain('没有执行新的写入');
  expect(response.message).toContain('可以让我给结论');
  expectAssistantSafeMessage(response.message);
});
```

- [ ] **Step 2: Add loop and step-limit formatters**

Append these functions to `assistantReliability.ts`:

```ts
export function formatDuplicateToolRecovery(lastMessage: string | null): string {
  return [
    '我已经用同样条件查过一次，不会重复空转。',
    lastMessage ? `目前能确认的是：${lastMessage}` : '目前没有新的事实变化。',
    '你可以让我给结论，或者换一个更具体的问题继续查。',
  ].join('\n');
}

export function formatStepLimitRecovery(): string {
  return [
    '我先停在安全位置，避免继续空转。',
    '没有执行新的写入。你可以让我给结论、缩小问题，或者指定一个 INT-xxx 继续查。',
  ].join('\n');
}
```

- [ ] **Step 3: Use duplicate recovery copy in `executeRun`**

In the duplicate-tool branch of `executeRun`, replace the existing English message with:

```ts
const previousResult = toolResults.find((item) => item.tool === turn.tool)?.message ??
  toolResults.find((item) => item.tool === turn.tool)?.summary ??
  null;
const message = formatDuplicateToolRecovery(previousResult);
```

Import `formatDuplicateToolRecovery`.

- [ ] **Step 4: Use step-limit recovery copy in `executeRun`**

Replace the final step-limit response with:

```ts
return this.completeRun(run.id, {
  message: formatStepLimitRecovery(),
}, 'failed');
```

Import `formatStepLimitRecovery`.

- [ ] **Step 5: Run focused loop tests**

Run:

```bash
bun test src/supervisor/agentRuntime.test.ts --grep "duplicate tool-call guard|step-limit stop|progress updates"
```

Expected: loop guards and step-limit stops return safe, concise, Chinese user-facing copy.

### Task 7: Add Gateway-Level Telegram Delivery Regression

**Files:**
- Modify: `src/bots/gateway.test.ts`

- [ ] **Step 1: Locate the asynchronous Telegram text test**

Run:

```bash
rg -n "routes non-command Telegram text|Telegram text outbound sent|assistant path" src/bots/gateway.test.ts
```

Expected: find the existing non-command webhook test that injects a bot assistant response.

- [ ] **Step 2: Add a test for reliability-layer output through the webhook path**

Add a new gateway test beside the non-command Telegram text test. Use the existing gateway harness in that file and configure the assistant or runtime stub to return:

```ts
{
  message: [
    '这个请求没有执行，因为我没有找到一个稳定可用的动作入口。',
    '我没有改动任何东西。你可以换成：查状态、读仓库、建议 issue，或者明确说重试/停止/取消某个 INT-xxx。',
  ].join('\n'),
}
```

Assert the outbound Telegram send receives that exact message:

```ts
expect(sentMessages.at(-1)?.text).toContain('这个请求没有执行');
expect(sentMessages.at(-1)?.text).toContain('没有改动任何东西');
expect(sentMessages.at(-1)?.text).not.toMatch(/Unsupported supervisor tool|Invalid args|ECONNRESET/i);
```

- [ ] **Step 3: Run the gateway focused tests**

Run:

```bash
bun test src/bots/gateway.test.ts --grep "non-command Telegram text|reliability-layer"
```

Expected: webhook handling stays async, outbound text is user-safe, and no backend jargon leaks.

### Task 8: Verification Gate and Local Telegram Bring-Up

**Files:**
- No source changes in this task unless tests expose a regression.

- [ ] **Step 1: Run supervisor runtime tests**

Run:

```bash
bun test src/supervisor/agentRuntime.test.ts
```

Expected: all `SupervisorAgentRuntimeService` tests pass.

- [ ] **Step 2: Run assistant and gateway focused tests**

Run:

```bash
bun test src/bots/assistant.test.ts src/bots/gateway.test.ts --grep "supervisor agent runtime|non-command Telegram text|pending|fallback|reliability"
```

Expected: Telegram routing, pending behavior, and webhook delivery tests pass.

- [ ] **Step 3: Run build and diff hygiene**

Run:

```bash
bun run build
git diff --check
```

Expected: build succeeds and `git diff --check` prints nothing.

- [ ] **Step 4: Run the full suite**

Run:

```bash
bun test
```

Expected: full test suite passes with no failures.

- [ ] **Step 5: Restart local Telegram service without leaving stale processes**

Run:

```bash
source /Users/liupenghui/miniconda3/bin/activate
bun run start:local
```

If the primary lease is held by a stale local instance, run:

```bash
bun --env-file=.env run src/cli/index.ts --kill
source /Users/liupenghui/miniconda3/bin/activate
bun run start:local
```

Expected: startup prints a public `trycloudflare.com` URL and keeps the service running.

- [ ] **Step 6: Check Telegram manifest health**

Run in a separate terminal:

```bash
curl -fsS http://127.0.0.1:8080/api/v1/bots/manifest | jq '{
  telegram_health: .telegram.health,
  webhook_url: .telegram.webhook_url,
  pending_update_count: .telegram.webhook_pending_update_count,
  active_runs: .supervisor.active_runs,
  pending_actions: .supervisor.pending_actions
}'
```

Expected: `telegram_health` is `healthy`, `pending_update_count` is `0`, both supervisor arrays are empty, and `webhook_url` contains `trycloudflare.com/api/v1/bots/telegram/webhook`.

```json
{
  "telegram_health": "healthy",
  "webhook_url": "contains trycloudflare.com/api/v1/bots/telegram/webhook",
  "pending_update_count": 0,
  "active_runs": [],
  "pending_actions": []
}
```

- [ ] **Step 7: Live Telegram smoke phrases**

Send these from the real Telegram chat:

```text
好的
open issues
如果让你来提个issue，你觉得当前最应该提的是什么
README 有啥
帮我重试一下
清理 INT-157 的 GitHub 和 Linear 残留垃圾
```

Expected user-visible behavior:

- `好的` says there is no pending action and suggests useful next entrances.
- `open issues` lists active/open issues, not issue creation.
- The issue-advice sentence returns a concrete recommendation, not a confirmation.
- `README 有啥` returns repo-aware read-only analysis or safe repo-read recovery.
- `帮我重试一下` asks which issue or suggests `重试 INT-158`; it does not fail.
- Cleanup text creates a confirmation card unless the user explicitly asks direct execution.

## Self-Review

- Spec coverage:
  - One Telegram natural-language front door: covered by runtime and gateway tests.
  - Structured tool loop safety: covered by invalid args, unsupported tools, repair turn, and tool exception tests.
  - Pending confirmations: covered by pending bypass and pending reminder tests.
  - Loop guard and step-limit exits: covered by duplicate and safe-stop transcript tests.
  - Read-only Claude boundary: covered by repo read failure and existing repo recommendation tests.
  - User-facing calm UX: covered by forbidden-output contract and live Telegram smoke phrases.
- Placeholder scan:
  - No placeholder tokens or undefined future functions remain in this plan.
  - All new helpers are named with exact TypeScript signatures.
- Type consistency:
  - New helper names match imports and usage in `agentRuntime.ts`.
  - Tests use existing harness names: `createHarness`, `h.service.respond`, `h.pendingActions`, `h.toolCalls`, and `h.events`.
