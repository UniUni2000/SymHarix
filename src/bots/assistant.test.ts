import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BotAssistantService } from './assistant';
import { BotCommandService } from './commandService';
import { BotSubscriptionService } from './subscriptions';
import {
  BotConversationPreferenceRepository,
  BotPendingActionRepository,
  initializeSchema,
} from '../database';
import type { RuntimeControlPlane, RuntimeStreamEvent } from '../runtime/types';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';

function createRuntimeControlPlane(): RuntimeControlPlane & {
  emit: (event: RuntimeStreamEvent) => void;
  createIssueCalls: Array<Record<string, unknown>>;
} {
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  const createIssueCalls: Array<Record<string, unknown>> = [];
  const runtime: RuntimeControlPlane & {
    emit: (event: RuntimeStreamEvent) => void;
    createIssueCalls: Array<Record<string, unknown>>;
  } = {
    getOverview: () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [
        {
          issue_id: 'issue-31',
          work_item_id: 'issue-31',
          identifier: 'INT-31',
          title: 'Hello world',
          phase: 'DEV',
          tracker_state: 'Backlog',
          orchestrator_state: 'failed',
          workspace_path: null,
          branch_name: 'feature/int-31',
          github_repo: null,
          github_issue_number: null,
          active_pr_number: null,
          session: null,
          actions: { can_stop: false, can_retry: true, can_open_pr: false },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    getIssue: (id: string) =>
      ['INT-31', 'issue-31'].includes(id) ? runtime.getOverview().issues[0] ?? null : null,
    getTimeline: () => [],
    getHistoryView: () => ({
      issue_id: 'issue-31',
      issue_identifier: 'INT-31',
      digest: {
        headline: 'INT-31 · DEV · Backlog',
        detail: 'Dispatch is blocked waiting for a repository route.',
        history_blurb: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      entries: [],
    }),
    createIssue: async (input) => {
      createIssueCalls.push(input as Record<string, unknown>);
      return {
        accepted: true,
        status: 'accepted',
        message: 'Created INT-32',
        issue_id: 'issue-32',
        issue_identifier: 'INT-32',
        issue: null,
      };
    },
    stopIssue: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Stopping ${id}`,
      issue_id: id,
      issue_identifier: 'INT-31',
    }),
    retryIssue: async (id: string) => ({
      accepted: true,
      status: 'queued',
      message: `Queued ${id}`,
      issue_id: id,
      issue_identifier: 'INT-31',
    }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    createIssueCalls,
  };
  return runtime;
}

describe('BotAssistantService', () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  test('requires confirmation before creating an issue from natural language and uses the default project', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      default_project_slug: 'test2',
    });

    const projectResolver = new TrackerProjectResolutionService(
      {
        listProjects: async () => ({
          projects: [
            { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' },
          ],
        }),
        findProjectBySlug: async (projectSlug: string) => ({
          project: projectSlug === 'test2'
            ? { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' }
            : null,
        }),
      } as any,
      {
        test2: {
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          local_path: null,
        },
      },
    );

    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => ({
          intent: {
            kind: 'create_issue',
            title: '写一个 hello world 的 Python 脚本',
            description: '要求输出到终端，并补一个简单测试',
            project_slug: null,
          },
        }),
      },
    );

    const context = {
      transport: 'telegram' as const,
      recipient: { transport: 'telegram' as const, conversation_id: 'chat-1' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };

    const first = await assistant.respondToText(context, '写一个 hello world 的 Python 脚本');
    expect(first.message).toContain('Action: create issue');
    expect(first.message).toContain('Project: test2');
    expect(runtime.createIssueCalls).toHaveLength(0);

    const confirmed = await assistant.respondToText(context, '确认');
    expect(confirmed.message).toContain('Created');
    expect(runtime.createIssueCalls).toHaveLength(1);
    expect(runtime.createIssueCalls[0]?.project_slug).toBe('test2');
    expect(
      pending.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toBeNull();

    subscriptions.dispose();
  });

  test('answers natural-language status questions without creating a pending action', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const projectResolver = new TrackerProjectResolutionService(
      {
        listProjects: async () => ({ projects: [] }),
      } as any,
      {},
    );
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => ({
          intent: {
            kind: 'status',
            issue_id: 'INT-31',
          },
        }),
      },
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-1' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      'INT-31 现在怎么样了',
    );

    expect(response.message).toContain('INT-31');
    expect(response.message).toContain('summary');
    expect(runtime.createIssueCalls).toHaveLength(0);
    expect(
      pending.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toBeNull();

    subscriptions.dispose();
  });

  test('falls back to heuristic parsing when the Anthropic assistant model fails', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-2',
      default_project_slug: 'test2',
    });

    const projectResolver = new TrackerProjectResolutionService(
      {
        listProjects: async () => ({
          projects: [
            { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' },
          ],
        }),
        findProjectBySlug: async (projectSlug: string) => ({
          project: projectSlug === 'test2'
            ? { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' }
            : null,
        }),
      } as any,
      {
        test2: {
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          local_path: null,
        },
      },
    );

    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('Anthropic unavailable');
        },
      },
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-2' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '创建一个 issue，搜集俄乌最近一周的重要事件吧，存到一个 markdown 里面，仓库 test2',
    );

    expect(response.message).toContain('当前自然语言模型暂不可用');
    expect(response.message).toContain('Action: create issue');
    expect(response.message).toContain('Project: test2');
    expect(response.message).toContain('Reply with: 确认 / 取消');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
  });

  test('matches repository aliases like test2 when heuristic parsing creates an issue without a default project', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);

    const projectResolver = new TrackerProjectResolutionService(
      {
        listProjects: async () => ({
          projects: [
            { project_id: 'project-1', project_slug: '1d3a3f95809d', project_name: 'Test Two' },
          ],
        }),
        findProjectBySlug: async (projectSlug: string) => ({
          project: projectSlug === '1d3a3f95809d'
            ? { project_id: 'project-1', project_slug: '1d3a3f95809d', project_name: 'Test Two' }
            : null,
        }),
      } as any,
      {
        '1d3a3f95809d': {
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          local_path: null,
        },
      },
    );

    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('Anthropic unavailable');
        },
      },
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-3' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '创建一个 issue，搜集俄乌最近一周的重要事件吧，存到一个 markdown 里面，仓库 test2',
    );

    expect(response.message).toContain('Action: create issue');
    expect(response.message).toContain('Project: 1d3a3f95809d');
    expect(response.message).toContain('Repo: UniUni2000/test2');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
  });

  test('answers active issue questions from runtime context when the model is unavailable', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const projectResolver = new TrackerProjectResolutionService(
      {
        listProjects: async () => ({ projects: [] }),
      } as any,
      {},
    );
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('Anthropic unavailable');
        },
      },
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-4' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '当前有哪些活跃 issue？',
    );

    expect(response.message).toContain('当前自然语言模型暂不可用');
    expect(response.message).toContain('INT-31');
    expect(response.message).toContain('failed');

    subscriptions.dispose();
  });

  test('explains why an issue is blocked from runtime context when the model is unavailable', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const projectResolver = new TrackerProjectResolutionService(
      {
        listProjects: async () => ({ projects: [] }),
      } as any,
      {},
    );
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('Anthropic unavailable');
        },
      },
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-5' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      'INT-31 为什么没跑起来，卡在哪了？',
    );

    expect(response.message).toContain('当前自然语言模型暂不可用');
    expect(response.message).toContain('INT-31');
    expect(response.message).toContain('repository route');

    subscriptions.dispose();
  });

});
