# Supervisor-First Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram freeform chat flow through the repo-aware supervisor first, while keeping slash commands as the explicit mechanical path and requiring user assent before conversational issue creation materializes.

**Architecture:** The implementation keeps the existing bot command plane and supervisor session plane, but changes the intake boundary. `src/bots/assistant.ts` becomes responsible for separating slash-command traffic from ordinary Telegram chat, and `src/supervisor/sessionService.ts` becomes responsible for conversational answers, proactive issue recommendation, and suggestion-first approval gating before materialization.

**Tech Stack:** Bun, TypeScript, Telegram bot pipeline, `src/bots/assistant.ts`, `src/bots/commandService.ts`, `src/bots/types.ts`, `src/supervisor/sessionService.ts`, Bun test.

---

## File Structure

- Modify: `src/bots/assistant.ts`
  - Owns Telegram text entry, model/heuristic orchestration, and the routing boundary between slash commands, supervisor-first chat, and fallback intent handling.
- Modify: `src/bots/types.ts`
  - Owns shared bot/supervisor request types; add the minimal intake-source field needed to let the supervisor distinguish conversational chat from machine-mode command entry.
- Modify: `src/supervisor/sessionService.ts`
  - Owns session creation, clarification, recommendation rendering, approval gating, and materialization; extend it to support conversation-first intake without forcing a mechanical form flow.
- Modify: `src/bots/assistant.test.ts`
  - Lock in routing behavior for slash commands, conversational chat, and suggestion-first issue creation.
- Modify: `src/supervisor/sessionService.test.ts`
  - Lock in suggestion-first approval gating, conversational answer handling, and conservative clarification defaults.
- Modify: `src/bots/commandService.test.ts`
  - Preserve slash-command parsing behavior as the explicit machine-mode path.

### Task 1: Lock In The Intake Boundary With Tests

**Files:**
- Modify: `src/bots/assistant.test.ts`
- Modify: `src/bots/commandService.test.ts`

- [ ] **Step 1: Add a failing assistant test proving that Telegram freeform chat routes to the supervisor before mechanical issue creation**

```ts
test('routes ordinary Telegram freeform chat to the supervisor before falling back to command-style issue handling', async () => {
  db = new Database(':memory:');
  initializeSchema(db);

  const runtime = createRuntimeControlPlane();
  const subscriptions = new BotSubscriptionService(runtime, {});
  const preferences = new BotConversationPreferenceRepository(db);
  const pending = new BotPendingActionRepository(db);

  let supervisorCalls = 0;
  const supervisorService = {
    hasActiveSession: () => false,
    respond: async ({ text }: { text: string }) => {
      supervisorCalls += 1;
      return {
        format: 'telegram_html' as const,
        message: `💡 我建议先把这个整理成 issue：${text}`,
      };
    },
  } as unknown as SupervisorSessionService;

  const assistant = new BotAssistantService(
    runtime,
    new BotCommandService(runtime, subscriptions),
    preferences,
    pending,
    null,
    {
      decide: async () => ({
        intent: {
          kind: 'help',
        },
      }),
    },
    undefined,
    subscriptions,
    null,
    supervisorService,
  );

  const response = await assistant.respondToText(
    {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-freeform' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    },
    '这个 supervisor 的建单体验太机械了，帮我想个更自然的方案',
  );

  expect(supervisorCalls).toBe(1);
  expect(response.message).toContain('我建议先把这个整理成 issue');
  expect(runtime.createIssueCalls).toHaveLength(0);
});
```

- [ ] **Step 2: Add a failing assistant test proving that slash commands still bypass supervisor-first chat**

```ts
test('keeps slash commands on the deterministic command path even when the supervisor plane is enabled', async () => {
  db = new Database(':memory:');
  initializeSchema(db);

  const runtime = createRuntimeControlPlane();
  const subscriptions = new BotSubscriptionService(runtime, {});
  const preferences = new BotConversationPreferenceRepository(db);
  const pending = new BotPendingActionRepository(db);

  let supervisorCalls = 0;
  const supervisorService = {
    hasActiveSession: () => false,
    respond: async () => {
      supervisorCalls += 1;
      return {
        message: 'should not be used',
      };
    },
  } as unknown as SupervisorSessionService;

  const assistant = new BotAssistantService(
    runtime,
    new BotCommandService(runtime, subscriptions),
    preferences,
    pending,
    null,
    undefined,
    undefined,
    subscriptions,
    null,
    supervisorService,
  );

  const response = await assistant.respondToText(
    {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-slash' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    },
    '/status INT-31',
  );

  expect(supervisorCalls).toBe(0);
  expect(response.message).toContain('INT-31');
});
```

- [ ] **Step 3: Add a failing assistant/session test proving that conversational issue-worthy requests yield a recommendation before materialization**

```ts
test('shows a supervisor recommendation first for conversational issue-worthy Telegram requests', async () => {
  db = new Database(':memory:');
  initializeSchema(db);

  const runtime = createRuntimeControlPlane();
  const subscriptions = new BotSubscriptionService(runtime, {});
  const preferences = new BotConversationPreferenceRepository(db);
  const pending = new BotPendingActionRepository(db);
  const sessions = new SupervisorSessionRepository(db);
  const sessionEvents = new SupervisorSessionEventRepository(db);

  preferences.upsert({
    transport: 'telegram',
    conversation_id: 'chat-suggest',
    default_project_slug: 'test2',
  });

  const supervisorService = new SupervisorSessionService(
    runtime,
    createProjectResolver(),
    sessions,
    sessionEvents,
  );

  const assistant = new BotAssistantService(
    runtime,
    new BotCommandService(runtime, subscriptions, () => true, preferences, createProjectResolver()),
    preferences,
    pending,
    createProjectResolver(),
    {
      decide: async () => ({
        intent: {
          kind: 'create_issue',
          title: '让 supervisor 自然语言建单',
          description: '从普通聊天里识别清晰需求，并先发推荐 issue 卡',
          project_slug: 'test2',
        },
      }),
    },
    undefined,
    subscriptions,
    null,
    supervisorService,
  );

  const response = await assistant.respondToText(
    {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-suggest' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    },
    '我希望 supervisor 能像人一样理解需求，然后帮我建一个更像样的 issue',
  );

  expect(response.format).toBe('telegram_html');
  expect(response.message).toContain('💡');
  expect(response.message).toContain('我建议把这件事收成一张 issue');
  expect(runtime.createIssueCalls).toHaveLength(0);
});
```

- [ ] **Step 4: Run the targeted tests and confirm they fail for the right reasons**

Run:

```bash
bun test src/bots/assistant.test.ts src/bots/commandService.test.ts
```

Expected:

```text
fail
- routes ordinary Telegram freeform chat to the supervisor before falling back to command-style issue handling
- keeps slash commands on the deterministic command path even when the supervisor plane is enabled
- shows a supervisor recommendation first for conversational issue-worthy Telegram requests
```

- [ ] **Step 5: Commit the red test baseline**

```bash
git add src/bots/assistant.test.ts src/bots/commandService.test.ts
git commit -m "test: lock supervisor-first intake boundary"
```

### Task 2: Implement Telegram Supervisor-First Routing In The Assistant

**Files:**
- Modify: `src/bots/assistant.ts`
- Modify: `src/bots/types.ts`
- Test: `src/bots/assistant.test.ts`

- [ ] **Step 1: Add the minimal intake-source type used to tell the supervisor whether a message came from conversational chat or command mode**

```ts
export type SupervisorIntakeSource =
  | 'telegram_chat'
  | 'slash_command'
  | 'inline_action';
```

```ts
export interface SupervisorServiceResponseParams {
  context: BotCommandContext;
  text: string;
  intent: BotAssistantIntent | null;
  runtimeContext: BotRuntimeCopilotContext;
  canWrite: boolean;
  source: SupervisorIntakeSource;
}
```

- [ ] **Step 2: Add a slash-command detector and short-circuit slash traffic back to the deterministic command service**

```ts
function isSlashCommandText(text: string): boolean {
  const trimmed = text.trim();
  return /^\/[a-z0-9_]+(?:@[\w_]+)?(?:\s|$)/i.test(trimmed);
}
```

```ts
if (isSlashCommandText(text)) {
  return this.commandService.execute(context, parseTextCommand(text));
}
```

- [ ] **Step 3: Route all non-slash Telegram chat through the supervisor before the old create-issue-only gate**

```ts
if (context.transport === 'telegram' && this.supervisorSessionService) {
  const supervisorResponse = await this.supervisorSessionService.respond({
    context,
    text,
    intent: fastHeuristic.intent.kind === 'help' ? null : fastHeuristic.intent,
    runtimeContext,
    canWrite: this.canWrite(context),
    source: 'telegram_chat',
  });
  if (supervisorResponse) {
    return supervisorResponse;
  }
}
```

```ts
if (context.transport === 'telegram' && this.supervisorSessionService) {
  const supervisorResponse = await this.supervisorSessionService.respond({
    context,
    text,
    intent: decision.intent,
    runtimeContext,
    canWrite: this.canWrite(context),
    source: 'telegram_chat',
  });
  if (supervisorResponse) {
    return supervisorResponse;
  }
}
```

- [ ] **Step 4: Preserve the old non-Telegram and post-supervisor fallback behavior**

```ts
if (decision.intent.kind === 'help') {
  return {
    message: prefixFallbackNotice(
      buildScopedHelp(runtimeContext, text),
      modelDiagnostics,
      usedFallback,
    ),
  };
}

const response = await this.handleIntent(
  context,
  decision.intent,
  text,
  runtimeContext,
);
```

- [ ] **Step 5: Run the routing tests and confirm the assistant boundary is now correct**

Run:

```bash
bun test src/bots/assistant.test.ts src/bots/commandService.test.ts
```

Expected:

```text
pass
- routes ordinary Telegram freeform chat to the supervisor before falling back to command-style issue handling
- keeps slash commands on the deterministic command path even when the supervisor plane is enabled
```

- [ ] **Step 6: Commit the assistant-side routing change**

```bash
git add src/bots/assistant.ts src/bots/types.ts src/bots/assistant.test.ts src/bots/commandService.test.ts
git commit -m "feat: route Telegram freeform chat through supervisor first"
```

### Task 3: Turn Supervisor Intake From Mechanical Plan-Filling Into Suggestion-First Conversation

**Files:**
- Modify: `src/supervisor/sessionService.ts`
- Test: `src/supervisor/sessionService.test.ts`

- [ ] **Step 1: Add failing session-service tests for conversational answer handling and recommendation-first issue suggestion**

```ts
test('answers ordinary supervisor-facing Telegram questions without forcing a new issue session', async () => {
  db = new Database(':memory:');
  initializeSchema(db);

  const runtime = createRuntime();
  const sessions = new SupervisorSessionRepository(db);
  const events = new SupervisorSessionEventRepository(db);
  const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

  const response = await service.respond({
    context: createContext(),
    text: '这个仓库现在有哪些活跃 issue？',
    intent: {
      kind: 'answer_question',
      answer: '当前活跃 issue：INT-31 · Hello world',
    },
    runtimeContext: createRuntimeContext(),
    canWrite: true,
    source: 'telegram_chat',
  });

  expect(response?.message).toContain('当前活跃 issue');
  expect(sessions.findAll()).toHaveLength(0);
});
```

```ts
test('keeps conversational create-issue requests in recommendation mode until the user approves', async () => {
  db = new Database(':memory:');
  initializeSchema(db);

  const runtime = createRuntime();
  const sessions = new SupervisorSessionRepository(db);
  const events = new SupervisorSessionEventRepository(db);
  const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

  const first = await service.respond({
    context: createContext(),
    text: '我想把 supervisor 做成自然语言建单，不要再像补表单',
    intent: {
      kind: 'create_issue',
      title: '让 supervisor 自然语言建单',
      description: '用户普通聊天时，先给推荐 issue 卡，再等用户点头',
      project_slug: 'test2',
    },
    runtimeContext: createRuntimeContext(),
    canWrite: true,
    source: 'telegram_chat',
  });

  expect(first?.message).toContain('💡');
  expect(first?.message).toContain('我建议把这件事收成一张 issue');
  expect(runtime.createIssueCalls).toHaveLength(0);

  const second = await service.respond({
    context: createContext(),
    text: '可以，就按这个来',
    intent: null,
    runtimeContext: createRuntimeContext(),
    canWrite: true,
    source: 'telegram_chat',
  });

  expect(second?.message).toContain('已创建');
  expect(runtime.createIssueCalls).toHaveLength(1);
});
```

- [ ] **Step 2: Teach `respond(...)` to handle conversational traffic even when there is no active session**

```ts
if (!activeSession) {
  if (params.source === 'telegram_chat') {
    return this.respondToFreshConversation(params);
  }
  if (params.intent?.kind !== 'create_issue') {
    return null;
  }
  return this.startSession(params);
}
```

```ts
private async respondToFreshConversation(
  params: SupervisorServiceResponseParams,
): Promise<BotCommandResponse | null> {
  if (!params.intent || params.intent.kind === 'help') {
    return null;
  }

  if (params.intent.kind === 'answer_question') {
    return { message: params.intent.answer };
  }

  if (params.intent.kind === 'clarify') {
    return { message: params.intent.question };
  }

  if (params.intent.kind === 'create_issue') {
    return this.startSession(params);
  }

  return null;
}
```

- [ ] **Step 3: Force conversational issue-worthy intake into recommendation mode instead of auto-materializing low-risk work immediately**

```ts
const isConversationalSuggestion =
  params.source === 'telegram_chat'
  && session.plan_version === 1
  && !isApprovalText(params.text);

if (isConversationalSuggestion && updated.state !== 'clarifying') {
  const suggestion = this.sessions.update({
    id: updated.id,
    state: 'awaiting_user_approval',
    approval_mode: 'explicit_user_approval',
    active_decision_kind: 'plan_approval',
  })!;
  return this.renderRecommendationMessage(suggestion);
}
```

- [ ] **Step 4: Add a prominent advisor-style recommendation renderer instead of reusing the old mechanical clarification copy**

```ts
private renderRecommendationMessage(session: SupervisorSessionRecord): BotCommandResponse {
  const planCard = session.plan_card;
  return {
    format: 'telegram_html',
    message: joinHtmlLines([
      '<b>💡 我建议把这件事收成一张 issue</b>',
      escapeHtml(planCard?.title || '未命名计划'),
      null,
      escapeHtml(planCard?.recommended_option?.summary || '我已经按当前上下文帮你补齐了一个推荐草案。'),
      null,
      '<b>如果你点头，我会：</b>',
      `1. 建单到 <code>${escapeHtml(planCard?.project_slug || 'unknown')}</code>`,
      `2. 用更像样的标题和验收方式起草计划`,
      '3. 再进入正常的 supervisor 执行/监管流程',
    ]),
    action_rows: [
      [{ label: '批准并开始', style: 'success', callback_data: `sup|${session.id}|approve` }],
      [{ label: '改一下计划', callback_data: `sup|${session.id}|edit` }],
    ],
  };
}
```

- [ ] **Step 5: Run the focused session-service tests and confirm recommendation-first behavior is in place**

Run:

```bash
bun test src/supervisor/sessionService.test.ts
```

Expected:

```text
pass
- answers ordinary supervisor-facing Telegram questions without forcing a new issue session
- keeps conversational create-issue requests in recommendation mode until the user approves
```

- [ ] **Step 6: Commit the session-service conversation change**

```bash
git add src/supervisor/sessionService.ts src/supervisor/sessionService.test.ts
git commit -m "feat: make supervisor intake recommendation-first"
```

### Task 4: Make The Drafted Issue Smarter And Less Form-Like

**Files:**
- Modify: `src/supervisor/sessionService.ts`
- Modify: `src/bots/assistant.test.ts`
- Modify: `src/supervisor/sessionService.test.ts`

- [ ] **Step 1: Add failing tests for “fill sensible defaults” behavior so the supervisor stops mechanically looping on clarifications**

```ts
test('uses repo-aware defaults when the user delegates the remaining drafting details', async () => {
  db = new Database(':memory:');
  initializeSchema(db);

  const runtime = createRuntime();
  const sessions = new SupervisorSessionRepository(db);
  const events = new SupervisorSessionEventRepository(db);
  const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

  const session = sessions.create({
    id: 'session-defaults',
    transport: 'telegram',
    conversation_id: 'chat-1',
    user_id: 'user-1',
    state: 'clarifying',
    repo_ref: 'test2',
    intake_mode: 'clarify_then_plan',
    approval_mode: 'explicit_user_approval',
    plan_version: 1,
    plan_card: {
      title: '让 supervisor 自然语言建单',
      user_goal: '让 supervisor 自然语言建单',
      in_scope: ['让 supervisor 自然语言建单'],
      out_of_scope: [],
      acceptance: ['结果可验证。'],
      known_risks: ['当前验收条件还不够稳，需要先补清楚。'],
      execution_strategy: '保持单目标推进，避免顺手扩大范围。',
      needs_user_approval: true,
      repo_ref: 'UniUni2000/test2',
      project_slug: 'test2',
      clarification_question: '这条需求完成以后，你最想看到的可验证结果是什么？',
      materialization_mode: 'root_only',
      recommended_option: { label: '按推荐继续', summary: '按这张精简计划继续。' },
      alternate_option: null,
      governance_preview: null,
    },
  });

  const response = await service.respond({
    context: createContext(),
    text: '你自己决定吧',
    intent: null,
    runtimeContext: createRuntimeContext(),
    canWrite: true,
    source: 'telegram_chat',
  });

  expect(response?.message).toContain('计划待你批准');
  expect(response?.message).not.toContain('一起补计划');
  expect(sessions.findById(session.id)?.plan_card?.acceptance.join('\n')).toContain('用户能直接在 Telegram 里看到建议 issue 卡');
});
```

- [ ] **Step 2: Normalize conversational issue drafts into cleaner titles, acceptance criteria, and suggestion copy**

```ts
function normalizeConversationalIssueTitle(title: string): string {
  return title
    .replace(/^创建\s*issue[:：]?\s*/i, '')
    .replace(/^帮我(?:把|做|创建)?/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
```

```ts
function inferConversationalAcceptance(planCard: SupervisorPlanCard): string[] {
  const existing = planCard.acceptance.filter(Boolean);
  if (existing.length > 0 && existing[0] !== '结果可验证。') {
    return existing;
  }
  return [
    '用户能直接在 Telegram 中看到显眼的推荐 issue 卡并可一键批准',
    '普通聊天不会再掉回机械补表单',
    'slash 命令仍能走原来的确定性命令路径',
  ];
}
```

- [ ] **Step 3: Make clarification conservative: only ask when ambiguity blocks a good recommendation, otherwise auto-fill defaults and stay natural**

```ts
const needsClarify = !inferredAcceptance
  && shouldClarifyAcceptance(draft.title, draft.description)
  && !multiObjective
  && !explicitApprovalRequested
  && governance?.decision !== 'accept_with_rewrite'
  && params.source !== 'telegram_chat';
```

```ts
const acceptance = params.source === 'telegram_chat'
  ? inferConversationalAcceptance(base.planCard)
  : inferredAcceptance ?? inferAcceptance(requestTitle, requestDescription);
```

- [ ] **Step 4: Run the focused behavior tests plus a build**

Run:

```bash
bun test src/bots/assistant.test.ts src/supervisor/sessionService.test.ts
bun run build
git diff --check
```

Expected:

```text
pass
- shows a supervisor recommendation first for conversational issue-worthy Telegram requests
- uses repo-aware defaults when the user delegates the remaining drafting details

build succeeds
git diff --check returns no output
```

- [ ] **Step 5: Commit the smarter drafting/defaults pass**

```bash
git add src/bots/assistant.test.ts src/supervisor/sessionService.ts src/supervisor/sessionService.test.ts
git commit -m "feat: make supervisor issue drafting feel conversational"
```

## Self-Review

### Spec coverage
- Telegram freeform chat reaches supervisor first: Task 1 and Task 2.
- Slash commands remain the explicit machine path: Task 1 and Task 2.
- Clear issue-worthy requests show a visible recommendation before materialization: Task 1 and Task 3.
- The supervisor answers ordinary repo questions naturally: Task 3.
- The system fills reasonable defaults instead of looping mechanically: Task 4.

### Placeholder scan
- No `TBD`, `TODO`, “similar to”, or empty “add validation” steps remain.
- Each task includes concrete file targets, code blocks, commands, and expected outcomes.

### Type consistency
- The plan uses one shared intake-source concept: `telegram_chat`, `slash_command`, `inline_action`.
- The assistant remains the routing boundary; the supervisor remains the recommendation/materialization boundary.
