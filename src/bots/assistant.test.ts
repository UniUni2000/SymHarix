import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BotAssistantService } from './assistant';
import { BotCommandService } from './commandService';
import { BotSubscriptionService } from './subscriptions';
import {
  BotConversationPreferenceRepository,
  BotFollowupMessageStateRepository,
  BotPendingActionRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
  initializeSchema,
} from '../database';
import type { RuntimeControlPlane, RuntimeStreamEvent } from '../runtime/types';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { SupervisorSessionService } from '../supervisor/sessionService';

function createRuntimeControlPlane(): RuntimeControlPlane & {
  emit: (event: RuntimeStreamEvent) => void;
  createIssueCalls: Array<Record<string, unknown>>;
  overrideGovernanceCalls: string[];
  rewriteGovernanceCalls: string[];
  splitGovernanceCalls: string[];
  executeGovernanceSuggestionCalls: Array<{ issueId: string; suggestionId: string }>;
  dismissGovernanceSuggestionCalls: Array<{ issueId: string; suggestionId: string }>;
} {
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  const createIssueCalls: Array<Record<string, unknown>> = [];
  const overrideGovernanceCalls: string[] = [];
  const rewriteGovernanceCalls: string[] = [];
  const splitGovernanceCalls: string[] = [];
  const executeGovernanceSuggestionCalls: Array<{ issueId: string; suggestionId: string }> = [];
  const dismissGovernanceSuggestionCalls: Array<{ issueId: string; suggestionId: string }> = [];
  const runtime: RuntimeControlPlane & {
    emit: (event: RuntimeStreamEvent) => void;
    createIssueCalls: Array<Record<string, unknown>>;
    overrideGovernanceCalls: string[];
    rewriteGovernanceCalls: string[];
    splitGovernanceCalls: string[];
    executeGovernanceSuggestionCalls: Array<{ issueId: string; suggestionId: string }>;
    dismissGovernanceSuggestionCalls: Array<{ issueId: string; suggestionId: string }>;
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
          supervisor_session_state: 'executing',
          supervisor_plan_summary: '计划「Hello world」正在推进。',
          governance_pause_reason: '当前先推进 INT-31，源线程仍在等待这一张单。',
          governance_expected_handoff: '完成 INT-31 后，再自动接力 INT-32。',
          governance_queued_child_identifiers: ['INT-32'],
          actions: {
            can_stop: false,
            can_retry: true,
            can_override_governance: false,
            can_rewrite_governance: false,
            can_split_governance: false,
            can_open_pr: false,
          },
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
    overrideGovernance: async (id: string) => {
      overrideGovernanceCalls.push(id);
      return {
        accepted: true,
        status: 'accepted',
        message: `Override approved for ${id}`,
        issue_id: id,
        issue_identifier: 'INT-31',
      };
    },
    rewriteGovernance: async (id: string) => {
      rewriteGovernanceCalls.push(id);
      return {
        accepted: true,
        status: 'accepted',
        message: `Rewrite applied for ${id}`,
        issue_id: id,
        issue_identifier: 'INT-31',
      };
    },
    splitGovernance: async (id: string) => {
      splitGovernanceCalls.push(id);
      return {
        accepted: true,
        status: 'accepted',
        message: `Split applied for ${id}`,
        issue_id: id,
        issue_identifier: 'INT-31',
      };
    },
    executeGovernanceSuggestion: async (issueId: string, suggestionId: string) => {
      executeGovernanceSuggestionCalls.push({ issueId, suggestionId });
      return {
        accepted: true,
        status: 'accepted',
        message: `Executed governance suggestion ${suggestionId} for ${issueId}`,
        issue_id: issueId,
        issue_identifier: 'INT-31',
      };
    },
    dismissGovernanceSuggestion: async (issueId: string, suggestionId: string) => {
      dismissGovernanceSuggestionCalls.push({ issueId, suggestionId });
      return {
        accepted: true,
        status: 'accepted',
        message: `Dismissed governance suggestion ${suggestionId} for ${issueId}`,
        issue_id: issueId,
        issue_identifier: 'INT-31',
      };
    },
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
    overrideGovernanceCalls,
    rewriteGovernanceCalls,
    splitGovernanceCalls,
    executeGovernanceSuggestionCalls,
    dismissGovernanceSuggestionCalls,
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
    expect(confirmed.message).toContain('已创建');
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

  test('routes Telegram create-issue requests through the supervisor session when the supervisor plane is enabled', async () => {
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
      conversation_id: 'chat-supervisor',
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

    const supervisorService = new SupervisorSessionService(
      runtime,
      projectResolver,
      sessions,
      sessionEvents,
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
            title: 'Refactor runtime API and rewrite Telegram copy together',
            description: 'Do both in one issue.',
            project_slug: 'test2',
          },
        }),
      },
      undefined,
      subscriptions,
      null,
      supervisorService,
    );

    const context = {
      transport: 'telegram' as const,
      recipient: { transport: 'telegram' as const, conversation_id: 'chat-supervisor' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };

    const first = await assistant.respondToText(context, '把 runtime API 和 Telegram 文案一起改掉');
    expect(first.message).toContain('计划待你批准');
    expect(first.format).toBe('telegram_html');
    expect(first.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(runtime.createIssueCalls).toHaveLength(0);
    expect(
      pending.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-supervisor',
      }),
    ).toBeNull();

    const second = await assistant.respondToText(context, '按推荐继续');
    expect(second.message).toContain('已创建');
    expect(runtime.createIssueCalls).toHaveLength(3);
    expect(runtime.createIssueCalls[0]?.defer_dispatch).toBe(true);
    expect(runtime.createIssueCalls[1]?.governance_lineage).toMatchObject({
      root_issue_id: 'issue-32',
      parent_issue_id: 'issue-32',
      generation: 1,
    });
    expect(runtime.createIssueCalls[1]?.defer_dispatch).toBe(false);
    expect(runtime.createIssueCalls[2]?.defer_dispatch).toBe(true);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('answers issue-list questions instead of surfacing the active supervisor card', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const sessions = new SupervisorSessionRepository(db);
    const sessionEvents = new SupervisorSessionEventRepository(db);
    const supervisorService = new SupervisorSessionService(
      runtime,
      null,
      sessions,
      sessionEvents,
    );
    sessions.create({
      id: 'session-active-card',
      transport: 'telegram',
      conversation_id: 'chat-supervisor-query',
      user_id: 'user-1',
      state: 'awaiting_user_decision',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-31',
      last_message_id: 'msg-existing',
      last_card_key: 'session|stale',
      active_decision_kind: 'delivery_failure',
      plan_card: {
        title: '清空当前仓库（安全清理计划）',
        user_goal: '清空当前仓库',
        in_scope: ['确认范围', '执行清理'],
        out_of_scope: ['不删除 GitHub 仓库'],
        acceptance: ['结果可验证'],
        known_risks: ['需要确认范围'],
        execution_strategy: '先确认后执行。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续处理交付阻塞。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });
    let modelCalled = false;
    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences),
      preferences,
      pending,
      null,
      {
        decide: async () => {
          modelCalled = true;
          return '{"intent":{"kind":"answer_question","answer":"不应该走到模型"}}';
        },
        getDiagnostics: () => ({
          provider: 'test',
          model: 'heuristic',
          configured: true,
          health: 'healthy',
          fallback_available: true,
          last_error_code: null,
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
        recipient: { transport: 'telegram', conversation_id: 'chat-supervisor-query' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '有哪些 issue',
    );

    expect(response.message).toContain('当前活跃 issue');
    expect(response.message).toContain('INT-31 · Hello world');
    expect(response.message).not.toContain('计划待你批准');
    expect(response.message).not.toContain('执行中需要你决定');
    expect(response.photo).toBeUndefined();
    expect(response.action_rows).toBeUndefined();
    expect(modelCalled).toBe(false);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('passes supervisor session projection into the model runtime context', async () => {
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    let capturedContext: any = null;
    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions),
      null,
      null,
      null,
      {
        decide: async ({ context }) => {
          capturedContext = context;
          return {
            intent: {
              kind: 'answer_question',
              answer: 'ok',
            },
          };
        },
      },
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-ctx' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      'INT-31 当前计划是什么？',
    );

    expect(response.message).toBe('ok');
    expect(capturedContext?.focus_issue?.issue?.supervisor_session_state).toBe('executing');
    expect(capturedContext?.focus_issue?.issue?.supervisor_plan_summary).toContain('Hello world');
    expect(capturedContext?.focus_issue?.issue?.governance_pause_reason).toContain('INT-31');
    expect(capturedContext?.focus_issue?.issue?.governance_expected_handoff).toContain('INT-32');
    expect(capturedContext?.focus_issue?.issue?.governance_queued_child_identifiers).toEqual(['INT-32']);

    subscriptions.dispose();
  });

  test('uses deterministic supervisor intake for repository cleanup requests when the model times out', async () => {
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
      conversation_id: 'chat-cleanup',
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

    const supervisorService = new SupervisorSessionService(
      runtime,
      projectResolver,
      sessions,
      sessionEvents,
    );
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    let modelCalls = 0;
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return null;
        },
        getDiagnostics: () => ({
          provider: 'openai',
          model: 'slow-model',
          configured: true,
          health: 'degraded',
          fallback_available: true,
          last_error_code: 'timeout',
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
        recipient: { transport: 'telegram', conversation_id: 'chat-cleanup' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '这个仓库还有文件残余，把它都清空',
    );

    expect(response.message).toContain('计划待你批准');
    expect(response.message).toContain('这个仓库还有文件残余，把它都清空');
    expect(response.message).not.toContain('当前自然语言模型暂不可用');
    expect(response.format).toBe('telegram_html');
    expect(response.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(runtime.createIssueCalls).toHaveLength(0);
    expect(modelCalls).toBe(0);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('keeps explicit Plan Card requests inside supervisor when the model times out', async () => {
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
      conversation_id: 'chat-plan-card',
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

    const supervisorService = new SupervisorSessionService(
      runtime,
      projectResolver,
      sessions,
      sessionEvents,
    );
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    let modelCalls = 0;
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return null;
        },
        getDiagnostics: () => ({
          provider: 'openai',
          model: 'slow-model',
          configured: true,
          health: 'degraded',
          fallback_available: true,
          last_error_code: 'timeout',
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
        recipient: { transport: 'telegram', conversation_id: 'chat-plan-card' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      'supervisor live E2E UniUni2000/test2 smoke docs/supervisor-telegram-e2e-20260426-1520.md nonce supervisor-telegram-e2e-20260426-1520 Plan Card',
    );

    expect(response.message).toContain('计划待你批准');
    expect(response.message).toContain('smoke docs/supervisor-telegram-e2e-20260426-1520.md');
    expect(response.message).not.toContain('nonce');
    expect(response.message).not.toContain('当前自然语言模型暂不可用');
    expect(response.format).toBe('telegram_html');
    expect(response.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(runtime.createIssueCalls).toHaveLength(0);
    expect(modelCalls).toBe(0);

    subscriptions.dispose();
    supervisorService.dispose();
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

  test('includes governance guidance in the confirmation summary when the intake critic wants a split first', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-bot-intake-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, '.symphony-constitution.md'),
        [
          '# Constitution',
          '',
          '## Main Path',
          '- Keep one control plane.',
        ].join('\n'),
        'utf8',
      );

      const runtime = createRuntimeControlPlane();
      const subscriptions = new BotSubscriptionService(runtime, {});
      const preferences = new BotConversationPreferenceRepository(db);
      const pending = new BotPendingActionRepository(db);
      preferences.upsert({
        transport: 'telegram',
        conversation_id: 'chat-split',
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
            local_path: repoRoot,
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
              title: 'Refactor runtime API and redesign the web dashboard and rewrite Telegram copy',
              description: 'Do all three in one issue and also clean related files.',
              project_slug: 'test2',
            },
          }),
        },
      );

      const response = await assistant.respondToText(
        {
          transport: 'telegram',
          recipient: { transport: 'telegram', conversation_id: 'chat-split' },
          identity: { user_id: 'user-1', display_name: 'Alice' },
        },
        '帮我同时重构 runtime API、重做运行态网页，再改 Telegram 文案',
      );

      expect(response.message).toContain('Action: create issue');
      expect(response.message).toContain('Governance: split_before_implement');
      expect(response.message).toContain('Dispatch: blocked');
      expect(runtime.createIssueCalls).toHaveLength(0);

      subscriptions.dispose();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
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

  test('explains how to rewrite or split a governance-blocked issue from runtime context when the model is unavailable', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const governanceIssue = {
      ...runtime.getOverview().issues[0]!,
      governance_status: 'advisory' as const,
      governance_decision: 'split_before_implement' as const,
      governance_summary: 'This issue spans multiple objectives across different parts of the system. Please split it before dispatch.',
      constitution_hits: [],
      fitness_signals: [],
      active_governance_suggestions: [
        {
          id: 'gov-suggest-1',
          suggestion_type: 'architecture_alignment' as const,
          status: 'pending' as const,
          title: 'Split INT-31 before implementation',
          summary: 'Separate the runtime API change from the Telegram copy change before dispatch.',
        },
      ],
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [governanceIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? governanceIssue : null;
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
        recipient: { transport: 'telegram', conversation_id: 'chat-6' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      'INT-31 这个 issue 该怎么改，怎么拆？',
    );

    expect(response.message).toContain('当前自然语言模型暂不可用');
    expect(response.message).toContain('INT-31');
    expect(response.message).toContain('split_before_implement');
    expect(response.message).toContain('Separate the runtime API change');

    subscriptions.dispose();
  });

  test('uses the single open governance card in the conversation as the focus issue for free-form follow-up text', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const blockedIssue = {
      ...runtime.getOverview().issues[0]!,
      issue_id: 'issue-31',
      work_item_id: 'issue-31',
      identifier: 'INT-31',
      title: 'Runtime and bot cleanup together',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      github_repo: 'UniUni2000/test2',
      governance_status: 'blocked' as const,
      governance_decision: 'split_before_implement' as const,
      governance_summary: 'This issue spans multiple objectives and is blocked until it is split.',
      active_governance_suggestions: [
        {
          id: 'gov-suggest-1',
          suggestion_type: 'architecture_alignment' as const,
          status: 'pending' as const,
          title: 'Split INT-31 before implementation',
          summary: 'Separate runtime cleanup from Telegram UX cleanup.',
          can_execute: true,
          can_dismiss: true,
        },
      ],
      actions: {
        can_stop: false,
        can_retry: true,
        can_override_governance: true,
        can_rewrite_governance: false,
        can_split_governance: true,
        can_open_pr: false,
      },
    };
    const otherIssue = {
      ...blockedIssue,
      issue_id: 'issue-32',
      work_item_id: 'issue-32',
      identifier: 'INT-32',
      title: 'Another active issue',
      orchestrator_state: 'dev_running',
      governance_status: null,
      governance_decision: null,
      governance_summary: null,
      active_governance_suggestions: [],
      actions: {
        can_stop: true,
        can_retry: false,
        can_override_governance: false,
        can_rewrite_governance: false,
        can_split_governance: false,
        can_open_pr: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 1, retrying: 0, total: 2 },
      issues: [blockedIssue, otherIssue],
    });
    runtime.getIssue = (id: string) => {
      if (['INT-31', 'issue-31'].includes(id)) return blockedIssue;
      if (['INT-32', 'issue-32'].includes(id)) return otherIssue;
      return null;
    };

    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const followupMessageStates = new BotFollowupMessageStateRepository(db);
    followupMessageStates.upsert({
      transport: 'telegram',
      conversation_id: 'chat-7',
      issue_id: 'issue-31',
      issue_identifier: 'INT-31',
      message_id: '101',
      card_kind: 'governance_blocked',
      card_key: 'blocked|split_before_implement|gov-suggest-1',
      card_state: 'open',
    });

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
          throw new Error('LLM unavailable');
        },
      },
      undefined,
      subscriptions,
      followupMessageStates,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-7' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '那我想拆成两个任务',
    );

    expect(response.message).toContain('INT-31');
    expect(response.message).toContain('split_before_implement');
    expect(response.message).toContain('Separate runtime cleanup');

    subscriptions.dispose();
  });

  test('explains paused root-thread cause and handoff from structured governance fields when the user asks about a child issue', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const rootIssue = {
      ...runtime.getOverview().issues[0]!,
      issue_id: 'issue-31',
      work_item_id: 'issue-31',
      identifier: 'INT-31',
      title: 'Root governance thread',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      github_repo: 'UniUni2000/test2',
      governance_status: 'advisory' as const,
      governance_decision: 'split_before_implement' as const,
      governance_thread_state: 'waiting_on_child' as const,
      governance_root_issue_identifier: 'INT-31',
      governance_child_issues: [
        {
          issue_id: 'issue-32',
          issue_identifier: 'INT-32',
          title: 'Runtime cleanup child',
          tracker_state: 'In Progress',
          orchestrator_state: 'dev_running',
          governance_decision: null,
          governance_summary: '当前正在收口 runtime cleanup。',
          delivery_code: null,
          delivery_summary: null,
        },
      ],
      next_recommended_action: '先处理治理子任务 INT-32；完成后会自动接力 INT-33。',
      governance_pause_reason: '源单当前暂停在 INT-32；完成这张子任务前不会放行后续 sibling。',
      governance_expected_handoff: '处理完 INT-32 后，会自动接力 INT-33。',
      governance_queued_child_identifiers: ['INT-33'],
      active_governance_suggestions: [],
      actions: {
        can_stop: false,
        can_retry: true,
        can_override_governance: false,
        can_rewrite_governance: false,
        can_split_governance: false,
        can_open_pr: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [rootIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? rootIssue : null;

    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const followupStates = new BotFollowupMessageStateRepository(db);
    followupStates.upsert({
      transport: 'telegram',
      conversation_id: 'chat-structured',
      issue_id: 'issue-31',
      issue_identifier: 'INT-31',
      message_id: '101',
      card_kind: 'governance_blocked',
      card_key: 'card-1',
      card_state: 'waiting_on_child',
    });
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
      () => true,
      subscriptions,
      followupStates,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-structured' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '这个新单是干嘛的，接下来会怎么接力？',
    );

    expect(response.message).toContain('INT-32');
    expect(response.message).toContain('源单当前暂停在 INT-32');
    expect(response.message).toContain('INT-33');

    subscriptions.dispose();
  });

  test('requires confirmation before overriding a governance-blocked issue from natural language', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const governanceIssue = {
      ...runtime.getOverview().issues[0]!,
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      github_repo: 'UniUni2000/test2',
      governance_status: 'blocked' as const,
      governance_decision: 'split_before_implement' as const,
      governance_summary: 'This issue spans multiple objectives and is blocked until it is split or explicitly overridden.',
      active_governance_suggestions: [
        {
          id: 'gov-suggest-1',
          suggestion_type: 'architecture_alignment' as const,
          status: 'pending' as const,
          title: 'Split INT-31 before implementation',
          summary: 'Separate the runtime API change from the Telegram copy change before dispatch.',
        },
      ],
      actions: {
        can_stop: false,
        can_retry: true,
        can_override_governance: true,
        can_rewrite_governance: false,
        can_split_governance: true,
        can_open_pr: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [governanceIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? governanceIssue : null;

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
          throw new Error('Assistant unavailable');
        },
      },
    );

    const context = {
      transport: 'telegram' as const,
      recipient: { transport: 'telegram' as const, conversation_id: 'chat-7' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };

    const first = await assistant.respondToText(context, 'INT-31 忽略治理拦截，继续跑');
    expect(first.message).toContain('当前自然语言模型暂不可用');
    expect(first.message).toContain('Action: override');
    expect(first.message).toContain('Issue: INT-31');
    expect(runtime.overrideGovernanceCalls).toHaveLength(0);

    const confirmed = await assistant.respondToText(context, '确认');
    expect(confirmed.message).toContain('Override approved');
    expect(runtime.overrideGovernanceCalls).toEqual(['INT-31']);

    subscriptions.dispose();
  });

  test('requires confirmation before rewriting a governance-blocked issue from natural language', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const governanceIssue = {
      ...runtime.getOverview().issues[0]!,
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      github_repo: 'UniUni2000/test2',
      governance_status: 'advisory' as const,
      governance_decision: 'accept_with_rewrite' as const,
      governance_summary: 'This issue is too vague to dispatch safely. Rewrite it into one concrete, verifiable task first.',
      active_governance_suggestions: [
        {
          id: 'gov-suggest-2',
          suggestion_type: 'architecture_alignment' as const,
          status: 'pending' as const,
          title: 'Rewrite INT-31 into one concrete task',
          summary: 'Clarify the target area, intended outcome, and verification command before dispatch.',
        },
      ],
      actions: {
        can_stop: false,
        can_retry: true,
        can_override_governance: true,
        can_rewrite_governance: true,
        can_split_governance: false,
        can_open_pr: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [governanceIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? governanceIssue : null;

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
          throw new Error('Assistant unavailable');
        },
      },
    );

    const context = {
      transport: 'telegram' as const,
      recipient: { transport: 'telegram' as const, conversation_id: 'chat-8' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };

    const first = await assistant.respondToText(context, 'INT-31 按建议改写这个 issue');
    expect(first.message).toContain('当前自然语言模型暂不可用');
    expect(first.message).toContain('Action: rewrite');
    expect(first.message).toContain('Issue: INT-31');
    expect(runtime.rewriteGovernanceCalls).toHaveLength(0);

    const confirmed = await assistant.respondToText(context, '确认');
    expect(confirmed.message).toContain('Rewrite applied');
    expect(runtime.rewriteGovernanceCalls).toEqual(['INT-31']);

    subscriptions.dispose();
  });

  test('requires confirmation before splitting a governance-blocked issue from natural language', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const governanceIssue = {
      ...runtime.getOverview().issues[0]!,
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      github_repo: 'UniUni2000/test2',
      governance_status: 'blocked' as const,
      governance_decision: 'split_before_implement' as const,
      governance_summary: 'This issue spans multiple objectives and is blocked until it is split.',
      active_governance_suggestions: [
        {
          id: 'gov-suggest-3',
          suggestion_type: 'architecture_alignment' as const,
          status: 'pending' as const,
          title: 'Split INT-31 before implementation',
          summary: 'Separate runtime work from bot copy and control-plane changes before dispatch.',
        },
      ],
      actions: {
        can_stop: false,
        can_retry: true,
        can_override_governance: true,
        can_rewrite_governance: false,
        can_split_governance: true,
        can_open_pr: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [governanceIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? governanceIssue : null;

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
          throw new Error('Assistant unavailable');
        },
      },
    );

    const context = {
      transport: 'telegram' as const,
      recipient: { transport: 'telegram' as const, conversation_id: 'chat-9' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };

    const first = await assistant.respondToText(context, 'INT-31 把这个 issue 拆分掉');
    expect(first.message).toContain('当前自然语言模型暂不可用');
    expect(first.message).toContain('Action: split');
    expect(first.message).toContain('Issue: INT-31');
    expect(runtime.splitGovernanceCalls).toHaveLength(0);

    const confirmed = await assistant.respondToText(context, '确认');
    expect(confirmed.message).toContain('Split applied');
    expect(runtime.splitGovernanceCalls).toEqual(['INT-31']);

    subscriptions.dispose();
  });

  test('requires confirmation before executing a governance suggestion by ordinal from natural language', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const governanceIssue = {
      ...runtime.getOverview().issues[0]!,
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      github_repo: 'UniUni2000/test2',
      active_governance_suggestions: [
        {
          id: 'gov-suggest-cleanup',
          suggestion_type: 'cleanup' as const,
          status: 'pending' as const,
          title: '[GOVERNANCE] Cleanup runtime hotspot',
          summary: 'Create a focused cleanup issue for the runtime hotspot.',
          can_execute: true,
          can_dismiss: true,
        },
        {
          id: 'gov-suggest-constitution',
          suggestion_type: 'constitution_update' as const,
          status: 'pending' as const,
          title: '[GOVERNANCE] Update constitution',
          summary: 'Patch the constitution with the repeated exception.',
          can_execute: true,
          can_dismiss: true,
        },
      ],
      actions: {
        can_stop: false,
        can_retry: true,
        can_override_governance: false,
        can_rewrite_governance: false,
        can_split_governance: false,
        can_open_pr: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [governanceIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? governanceIssue : null;

    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const projectResolver = new TrackerProjectResolutionService({ listProjects: async () => ({ projects: [] }) } as any, {});
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('Assistant unavailable');
        },
      },
    );

    const context = {
      transport: 'telegram' as const,
      recipient: { transport: 'telegram' as const, conversation_id: 'chat-10' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };

    const first = await assistant.respondToText(context, '执行第一个治理建议');
    expect(first.message).toContain('当前自然语言模型暂不可用');
    expect(first.message).toContain('Action: execute governance suggestion');
    expect(first.message).toContain('Suggestion: [1] cleanup');
    expect(runtime.executeGovernanceSuggestionCalls).toHaveLength(0);

    const confirmed = await assistant.respondToText(context, '确认');
    expect(confirmed.message).toContain('Executed governance suggestion');
    expect(runtime.executeGovernanceSuggestionCalls).toEqual([
      {
        issueId: 'issue-31',
        suggestionId: 'gov-suggest-cleanup',
      },
    ]);

    subscriptions.dispose();
  });

  test('requires confirmation before dismissing a governance suggestion by type from natural language', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const governanceIssue = {
      ...runtime.getOverview().issues[0]!,
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      github_repo: 'UniUni2000/test2',
      active_governance_suggestions: [
        {
          id: 'gov-suggest-cleanup',
          suggestion_type: 'cleanup' as const,
          status: 'pending' as const,
          title: '[GOVERNANCE] Cleanup runtime hotspot',
          summary: 'Create a focused cleanup issue for the runtime hotspot.',
          can_execute: true,
          can_dismiss: true,
        },
      ],
      actions: {
        can_stop: false,
        can_retry: true,
        can_override_governance: false,
        can_rewrite_governance: false,
        can_split_governance: false,
        can_open_pr: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [governanceIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? governanceIssue : null;

    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const projectResolver = new TrackerProjectResolutionService({ listProjects: async () => ({ projects: [] }) } as any, {});
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('Assistant unavailable');
        },
      },
    );

    const context = {
      transport: 'telegram' as const,
      recipient: { transport: 'telegram' as const, conversation_id: 'chat-11' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };

    const first = await assistant.respondToText(context, '忽略 cleanup suggestion');
    expect(first.message).toContain('当前自然语言模型暂不可用');
    expect(first.message).toContain('Action: dismiss governance suggestion');
    expect(first.message).toContain('cleanup');
    expect(runtime.dismissGovernanceSuggestionCalls).toHaveLength(0);

    const confirmed = await assistant.respondToText(context, '确认');
    expect(confirmed.message).toContain('Dismissed governance suggestion');
    expect(runtime.dismissGovernanceSuggestionCalls).toEqual([
      {
        issueId: 'issue-31',
        suggestionId: 'gov-suggest-cleanup',
      },
    ]);

    subscriptions.dispose();
  });

  test('treats a plain ordinal reply as the recommended governance action for the focused issue', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const governanceIssue = {
      ...runtime.getOverview().issues[0]!,
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      github_repo: 'UniUni2000/test2',
      governance_status: 'advisory' as const,
      governance_decision: 'split_before_implement' as const,
      governance_summary: 'Split this issue before dispatch.',
      active_governance_suggestions: [
        {
          id: 'gov-suggest-cleanup',
          suggestion_type: 'cleanup' as const,
          status: 'pending' as const,
          title: '[GOVERNANCE] Cleanup runtime hotspot',
          summary: 'Create a focused cleanup issue for the runtime hotspot.',
          can_execute: true,
          can_dismiss: true,
        },
      ],
      actions: {
        can_stop: false,
        can_retry: true,
        can_override_governance: true,
        can_rewrite_governance: false,
        can_split_governance: true,
        can_open_pr: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [governanceIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? governanceIssue : null;

    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const projectResolver = new TrackerProjectResolutionService({ listProjects: async () => ({ projects: [] }) } as any, {});
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('Assistant unavailable');
        },
      },
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-ordinal' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '1',
    );

    expect(response.message).toContain('Action: split');
    expect(response.message).toContain('Issue: INT-31');
    expect(runtime.executeGovernanceSuggestionCalls).toHaveLength(0);

    subscriptions.dispose();
  });

  test('asks for clarification when multiple governance suggestions exist and the request is ambiguous', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const governanceIssue = {
      ...runtime.getOverview().issues[0]!,
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      github_repo: 'UniUni2000/test2',
      active_governance_suggestions: [
        {
          id: 'gov-suggest-cleanup',
          suggestion_type: 'cleanup' as const,
          status: 'pending' as const,
          title: '[GOVERNANCE] Cleanup runtime hotspot',
          summary: 'Create a focused cleanup issue for the runtime hotspot.',
          can_execute: true,
          can_dismiss: true,
        },
        {
          id: 'gov-suggest-harness',
          suggestion_type: 'harness_adoption' as const,
          status: 'pending' as const,
          title: '[GOVERNANCE] Adopt harness',
          summary: 'Promote the shadow harness into the repository.',
          can_execute: true,
          can_dismiss: true,
        },
      ],
      actions: {
        can_stop: false,
        can_retry: true,
        can_override_governance: false,
        can_rewrite_governance: false,
        can_split_governance: false,
        can_open_pr: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 1 },
      issues: [governanceIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? governanceIssue : null;

    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const projectResolver = new TrackerProjectResolutionService({ listProjects: async () => ({ projects: [] }) } as any, {});
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('Assistant unavailable');
        },
      },
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-12' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '执行治理建议',
    );

    expect(response.message).toContain('请明确指定要操作的治理建议');
    expect(response.message).toContain('[1] cleanup');
    expect(response.message).toContain('[2] harness_adoption');
    expect(runtime.executeGovernanceSuggestionCalls).toHaveLength(0);
    expect(
      pending.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-12',
      }),
    ).toBeNull();

    subscriptions.dispose();
  });

});
