import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  BotConversationPreferenceRepository,
  initializeSchema,
  SupervisorPendingActionRepository,
  SupervisorRunEventRepository,
  SupervisorRunRepository,
  SupervisorToolCallRepository,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeStreamEvent } from '../runtime/types';
import { BotCommandService } from '../bots/commandService';
import { BotSubscriptionService } from '../bots/subscriptions';
import type { BotCommandContext } from '../bots/types';
import { SupervisorOrchestratorBroker } from './orchestratorBroker';

function issue(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-163',
    work_item_id: 'issue-163',
    identifier: 'INT-163',
    title: '重构测试导入方式',
    phase: 'DEV',
    tracker_state: 'Todo',
    orchestrator_state: 'failed',
    workspace_path: null,
    branch_name: null,
    github_repo: 'UniUni2000/test2',
    github_issue_number: null,
    active_pr_number: null,
    session: null,
    actions: {
      can_stop: false,
      can_retry: true,
      can_open_pr: false,
    },
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    ...overrides,
  };
}

function createRuntimeControlPlane(): RuntimeControlPlane & {
  createIssueCalls: Array<Record<string, unknown>>;
  retryIssueCalls: string[];
} {
  const issues = [issue()];
  const createIssueCalls: Array<Record<string, unknown>> = [];
  const retryIssueCalls: string[] = [];
  const runtime: RuntimeControlPlane & {
    createIssueCalls: Array<Record<string, unknown>>;
    retryIssueCalls: string[];
  } = {
    getOverview: () => ({
      generated_at: '2026-05-10T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: issues.length },
      issues,
    }),
    getIssue: (id: string) => issues.find((item) => item.issue_id === id || item.identifier === id) ?? null,
    getTimeline: () => [],
    getHistoryView: () => ({
      issue_id: 'issue-163',
      issue_identifier: 'INT-163',
      digest: {
        headline: 'INT-163 · DEV · Todo',
        detail: 'Review stalled after repeated attempts.',
        history_blurb: null,
        updated_at: '2026-05-10T00:00:00.000Z',
      },
      entries: [],
    }),
    createIssue: async (input) => {
      createIssueCalls.push(input as Record<string, unknown>);
      return {
        accepted: true,
        status: 'accepted',
        message: '已创建 INT-164',
        issue_id: 'issue-164',
        issue_identifier: 'INT-164',
        issue: null,
      };
    },
    stopIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    retryIssue: async (id: string) => {
      retryIssueCalls.push(id);
      return { accepted: true, status: 'accepted', message: `Retrying ${id}`, issue_id: id, issue_identifier: 'INT-163' };
    },
    closeIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    overrideGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    rewriteGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    splitGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    executeGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    dismissGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: (_listener: (event: RuntimeStreamEvent) => void) => () => undefined,
    createIssueCalls,
    retryIssueCalls,
  };
  return runtime;
}

describe('SupervisorOrchestratorBroker', () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  function createHarness() {
    db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const preferences = new BotConversationPreferenceRepository(db);
    const subscriptions = new BotSubscriptionService(runtime, {
      telegram: {
        sendMessage: async () => ({ provider_message_id: 'watch-message' }),
        editMessage: async () => ({ provider_message_id: 'watch-message' }),
      },
    });
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences);
    const broker = new SupervisorOrchestratorBroker({
      runtime,
      commandService,
      preferences,
      projectResolver: null,
      runs: new SupervisorRunRepository(db),
      events: new SupervisorRunEventRepository(db),
      toolCalls: new SupervisorToolCallRepository(db),
      pendingActions: new SupervisorPendingActionRepository(db),
    });
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-1' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    return { broker, runtime, context, subscriptions };
  }

  test('lists the orchestrator business tool surface with schemas for Claude to inspect', async () => {
    const { broker, context } = createHarness();

    const result = await broker.callTool('list_orchestrator_capabilities', {}, { context });
    const capabilities = result.data?.capabilities as Array<Record<string, unknown>>;

    expect(capabilities.map((capability) => capability.name)).toContain('watch_issue');
    expect(capabilities.map((capability) => capability.name)).toContain('unwatch_issue');
    expect(capabilities.map((capability) => capability.name)).toContain('switch_repository');
    expect(capabilities.map((capability) => capability.name)).toContain('create_issue');
    const watchCapability = capabilities.find((capability) => capability.name === 'watch_issue');
    expect(watchCapability?.risk).toBe('low_write');
    expect(watchCapability?.input_schema).toBeTruthy();
  });

  test('captures issue card responses for the active Claude turn', async () => {
    const { broker, context } = createHarness();
    broker.beginTurn({ context, text: '卡片发我', repoRef: 'UniUni2000/test2', canWrite: true, activeIssueId: 'INT-163' });

    const result = await broker.callTool('show_issue_card', {}, { context });
    const captured = broker.consumeTurnResponse({ context, repoRef: 'UniUni2000/test2' });

    expect(result.summary).toContain('Issue Card · INT-163');
    expect(captured?.message).toContain('Issue Card · INT-163');
    expect(captured?.media_key).toContain('issue-card|INT-163');
  });

  test('creates pending confirmations for high-risk issue creation without executing immediately', async () => {
    const { broker, runtime, context } = createHarness();
    broker.beginTurn({ context, text: '让你提一个 issue', repoRef: 'UniUni2000/test2', canWrite: true });

    const result = await broker.callTool('create_issue', {
      title: '添加 pre-commit hooks 自动化代码质量检查',
      description: 'black + isort + flake8 + mypy',
      project_slug: 'test2',
    }, { context });
    const captured = broker.consumeTurnResponse({ context, repoRef: 'UniUni2000/test2' });

    expect(result.response?.actions?.[0]?.callback_data).toBe('pending|confirm');
    expect(captured?.message).toContain('Action: create issue');
    expect(captured?.message).toContain('添加 pre-commit hooks');
    expect(runtime.createIssueCalls).toHaveLength(0);
  });

  test('executes retry directly only when the runtime says the issue is retryable', async () => {
    const { broker, runtime, context } = createHarness();
    broker.beginTurn({ context, text: '重试一下', repoRef: 'UniUni2000/test2', canWrite: true, activeIssueId: 'INT-163' });

    const result = await broker.callTool('retry_issue', { issue_id: 'INT-163' }, { context });

    expect(result.ok).toBe(true);
    expect(runtime.retryIssueCalls).toEqual(['INT-163']);
  });

  test('lets Claude call watch and unwatch through orchestrator tools', async () => {
    const { broker, context, subscriptions } = createHarness();
    broker.beginTurn({ context, text: '关注这个 issue 的失败更新', repoRef: 'UniUni2000/test2', canWrite: true, activeIssueId: 'INT-163' });

    const watched = await broker.callTool('watch_issue', {
      issue_id: 'INT-163',
      watch_preset: 'failures',
    }, { context });

    expect(watched.ok).toBe(true);
    expect(watched.response?.watch_registered).toBe(true);
    expect(subscriptions.listByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })).toHaveLength(1);

    const unwatched = await broker.callTool('unwatch_issue', { issue_id: 'INT-163' }, { context });

    expect(unwatched.ok).toBe(true);
    expect(unwatched.response?.watch_registered).toBe(false);
    expect(subscriptions.listByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })).toHaveLength(0);
  });
});
