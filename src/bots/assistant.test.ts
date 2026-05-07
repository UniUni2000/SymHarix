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
import type { SupervisorCcAdvisor } from '../supervisor/ccAdvisor';
import type { SupervisorAgentService } from '../supervisor/supervisorAgent';
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
      new BotCommandService(runtime, subscriptions, () => true, preferences),
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

    subscriptions.dispose();
  });

  test('keeps slash commands on the deterministic command path even when the supervisor plane is enabled', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);

    let supervisorCalls = 0;
    let modelCalls = 0;
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
      new BotCommandService(runtime, subscriptions, () => true, preferences),
      preferences,
      pending,
      null,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'create_issue',
              title: 'model path should be bypassed for slash commands',
              description: 'If this appears, slash command routing regressed.',
              project_slug: null,
            },
          };
        },
      },
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

    expect(modelCalls).toBe(0);
    expect(supervisorCalls).toBe(0);
    expect(response.message).toContain('INT-31');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
  });

  test('keeps pending confirmation flow ahead of slash-command routing', async () => {
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

    pending.upsert({
      transport: 'telegram',
      conversation_id: 'chat-pending-slash',
      user_id: 'user-1',
      intent_kind: 'create_issue',
      normalized_payload: {
        command: 'new',
        project_slug: 'test2',
        create_issue: {
          title: 'Keep pending confirmation',
          description: 'Slash commands should not bypass this pending action.',
          project_slug: 'test2',
        },
      },
      summary_message: 'Action: create issue\nReply with: 确认 / 取消',
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
    });

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences),
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
        recipient: { transport: 'telegram', conversation_id: 'chat-pending-slash' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '/status INT-31',
    );

    expect(supervisorCalls).toBe(0);
    expect(response.message).toContain('Action: create issue');
    expect(response.message).toContain('Reply with 确认 / 取消.');
    expect(runtime.createIssueCalls).toHaveLength(0);
    expect(
      pending.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-pending-slash',
      }),
    ).not.toBeNull();

    subscriptions.dispose();
  });

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

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
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

    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-suggest',
    });
    const callbacks = response.action_rows?.flat().map((action) => action.callback_data ?? null) ?? [];

    expect(response.format).toBe('telegram_html');
    expect(response.message).not.toContain('一起补计划');
    expect(response.action_rows?.length).toBeGreaterThan(0);
    expect(callbacks).toEqual(expect.arrayContaining([
      expect.stringContaining('|approve'),
    ]));
    expect(session?.state).toBe('awaiting_user_approval');
    expect(session?.active_decision_kind).toBe('plan_approval');
    expect(session?.plan_card?.clarification_question).toBeNull();
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('treats a plain greeting as conversation instead of resurfacing an active issue card when the model misclassifies it', async () => {
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
      conversation_id: 'chat-greeting',
      default_project_slug: 'test2',
    });

    sessions.create({
      id: 'session-greeting-active',
      transport: 'telegram',
      conversation_id: 'chat-greeting',
      user_id: 'user-1',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      plan_card: {
        title: '创建 Issue',
        user_goal: '创建 Issue',
        in_scope: ['创建 Issue'],
        out_of_scope: [],
        acceptance: ['结果可验证。'],
        known_risks: [],
        execution_strategy: '批准后执行。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '批准并开始',
          summary: '执行旧计划。',
        },
        alternate_option: null,
        governance_preview: null,
      },
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

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => ({
          intent: {
            kind: 'create_issue',
            title: '创建 Issue',
            description: null,
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
        recipient: { transport: 'telegram', conversation_id: 'chat-greeting' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '你好',
    );

    expect(response.message).toContain('你好');
    expect(response.message).not.toContain('计划待你批准');
    expect(response.message).not.toContain('创建 Issue');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('answers repo content questions via the advisor instead of resurfacing an active supervisor card', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-profile-active-session-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, 'README.md'),
        '# Test Two\n\nTelegram-first supervisor workspace.\n',
      );
      fs.mkdirSync(path.join(repoRoot, 'src'));
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({
          name: 'test2',
          scripts: {
            start: 'bun run src/cli/index.ts',
          },
          dependencies: {
            typescript: '^5.0.0',
          },
        }),
      );

      const runtime = createRuntimeControlPlane();
      const subscriptions = new BotSubscriptionService(runtime, {});
      const preferences = new BotConversationPreferenceRepository(db);
      const pending = new BotPendingActionRepository(db);
      const sessions = new SupervisorSessionRepository(db);
      const sessionEvents = new SupervisorSessionEventRepository(db);

      preferences.upsert({
        transport: 'telegram',
        conversation_id: 'chat-repo-active-session',
        default_project_slug: 'test2',
      });

      sessions.create({
        id: 'session-repo-active',
        transport: 'telegram',
        conversation_id: 'chat-repo-active-session',
        user_id: 'user-1',
        state: 'awaiting_user_approval',
        repo_ref: 'test2',
        intake_mode: 'plan_then_approve',
        approval_mode: 'explicit_user_approval',
        plan_version: 1,
        plan_card: {
          title: '创建 Issue',
          user_goal: '创建 Issue',
          in_scope: ['创建 Issue'],
          out_of_scope: [],
          acceptance: ['结果可验证。'],
          known_risks: [],
          execution_strategy: '批准后执行。',
          needs_user_approval: true,
          repo_ref: 'UniUni2000/test2',
          project_slug: 'test2',
          clarification_question: null,
          materialization_mode: 'root_only',
          recommended_option: {
            label: '批准并开始',
            summary: '执行旧计划。',
          },
          alternate_option: null,
          governance_preview: null,
        },
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

      const supervisorService = new SupervisorSessionService(
        runtime,
        projectResolver,
        sessions,
        sessionEvents,
      );

      let advisorCalls = 0;
      const advisor: SupervisorCcAdvisor = {
        advise: async () => {
          advisorCalls += 1;
          return {
            mode: 'repo_answer',
            answer: '这个仓库当前是一个 Telegram-first supervisor workspace，主要代码在 src/。',
          };
        },
      };

      const assistant = new BotAssistantService(
        runtime,
        new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
        preferences,
        pending,
        projectResolver,
        {
          decide: async () => ({
            intent: {
              kind: 'create_issue',
              title: '创建 Issue',
              description: null,
              project_slug: 'test2',
            },
          }),
        },
        undefined,
        subscriptions,
        null,
        supervisorService,
        advisor,
      );

      const response = await assistant.respondToText(
        {
          transport: 'telegram',
          recipient: { transport: 'telegram', conversation_id: 'chat-repo-active-session' },
          identity: { user_id: 'user-1', display_name: 'Alice' },
        },
        '这个默认项目里面有啥代码',
      );

      expect(advisorCalls).toBe(1);
      expect(response.message).toContain('Telegram-first supervisor workspace');
      expect(response.message).toContain('src/');
      expect(response.message).not.toContain('计划待你批准');
      expect(response.message).not.toContain('创建 Issue');
      expect(runtime.createIssueCalls).toHaveLength(0);

      subscriptions.dispose();
      supervisorService.dispose();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('answers default-project repo content questions from repo profile when the model misclassifies them', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-profile-default-project-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, 'README.md'),
        '# Test Two\n\nTelegram-first supervisor workspace.\n',
      );
      fs.mkdirSync(path.join(repoRoot, 'src'));
      fs.mkdirSync(path.join(repoRoot, 'docs'));
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({
          name: 'test2',
          scripts: {
            start: 'bun run src/cli/index.ts',
          },
          dependencies: {
            typescript: '^5.0.0',
          },
        }),
      );

      const runtime = createRuntimeControlPlane();
      const subscriptions = new BotSubscriptionService(runtime, {});
      const preferences = new BotConversationPreferenceRepository(db);
      const pending = new BotPendingActionRepository(db);
      const sessions = new SupervisorSessionRepository(db);
      const sessionEvents = new SupervisorSessionEventRepository(db);

      preferences.upsert({
        transport: 'telegram',
        conversation_id: 'chat-default-project-repo',
        default_project_slug: 'test2',
      });

      sessions.create({
        id: 'session-default-project-repo',
        transport: 'telegram',
        conversation_id: 'chat-default-project-repo',
        user_id: 'user-1',
        state: 'awaiting_user_approval',
        repo_ref: 'test2',
        intake_mode: 'plan_then_approve',
        approval_mode: 'explicit_user_approval',
        plan_version: 1,
        plan_card: {
          title: '创建 Issue',
          user_goal: '创建 Issue',
          in_scope: ['创建 Issue'],
          out_of_scope: [],
          acceptance: ['结果可验证。'],
          known_risks: [],
          execution_strategy: '批准后执行。',
          needs_user_approval: true,
          repo_ref: 'UniUni2000/test2',
          project_slug: 'test2',
          clarification_question: null,
          materialization_mode: 'root_only',
          recommended_option: {
            label: '批准并开始',
            summary: '执行旧计划。',
          },
          alternate_option: null,
          governance_preview: null,
        },
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

      const supervisorService = new SupervisorSessionService(
        runtime,
        projectResolver,
        sessions,
        sessionEvents,
      );

      const assistant = new BotAssistantService(
        runtime,
        new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
        preferences,
        pending,
        projectResolver,
        {
          decide: async () => ({
            intent: {
              kind: 'create_issue',
              title: '创建 Issue',
              description: null,
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
          recipient: { transport: 'telegram', conversation_id: 'chat-default-project-repo' },
          identity: { user_id: 'user-1', display_name: 'Alice' },
        },
        '这个默认项目里面有啥',
      );

      expect(response.message).toContain('UniUni2000/test2');
      expect(response.message).toContain('Telegram-first supervisor workspace');
      expect(response.message).toContain('src');
      expect(response.message).not.toContain('计划待你批准');
      expect(response.message).not.toContain('创建 Issue');
      expect(runtime.createIssueCalls).toHaveLength(0);

      subscriptions.dispose();
      supervisorService.dispose();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
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

  test('uses the read-only advisor for Telegram repo questions before generic model fallback', async () => {
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
          local_path: '/tmp/test2',
        },
      },
    );
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-advisor-repo',
      default_project_slug: 'test2',
    });

    let modelCalls = 0;
    let advisorCalls = 0;
    let advisorInput: any = null;
    const advisor: SupervisorCcAdvisor = {
      advise: async (input) => {
        advisorCalls += 1;
        advisorInput = input;
        return {
          mode: 'repo_answer',
          answer: '这是一个 Telegram-first supervisor workspace.',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'answer_question',
              answer: 'should not use model',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      advisor,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-advisor-repo' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '这个项目是做什么的？',
    );

    expect(advisorCalls).toBe(1);
    expect(advisorInput).toMatchObject({
      repoRef: 'UniUni2000/test2',
      localPath: '/tmp/test2',
      userText: '这个项目是做什么的？',
    });
    expect(advisorInput).toHaveProperty('repoProfile');
    expect(modelCalls).toBe(0);
    expect(response.message).toContain('Telegram-first supervisor workspace');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
  });

  test('uses the advisor for ordinary Telegram natural chat before generic model fallback', async () => {
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
          local_path: '/tmp/test2',
        },
      },
    );
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-advisor-natural',
      default_project_slug: 'test2',
    });

    let modelCalls = 0;
    let advisorCalls = 0;
    const advisor: SupervisorCcAdvisor = {
      advise: async () => {
        advisorCalls += 1;
        return {
          mode: 'repo_answer',
          answer: '当然可以，我们先一起想清楚你最想把这个 supervisor 变成什么样。',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'answer_question',
              answer: 'should not use model first',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      advisor,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-advisor-natural' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '我有点迷糊，想聊聊怎么把这个 supervisor 做得更自然',
    );

    expect(advisorCalls).toBe(1);
    expect(modelCalls).toBe(0);
    expect(response.message).toContain('当然可以');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
  });

  test('uses the supervisor agent for ordinary Telegram natural chat before advisor and generic model fallback', async () => {
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
          local_path: '/tmp/test2',
        },
      },
    );
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-agent-natural',
      default_project_slug: 'test2',
    });

    let modelCalls = 0;
    let advisorCalls = 0;
    let agentCalls = 0;
    const agent: SupervisorAgentService = {
      respond: async () => {
        agentCalls += 1;
        return {
          mode: 'chat_reply',
          message: '当然可以，我们先把你想要的 supervisor 体验聊顺，再决定要不要进 issue 流。',
        };
      },
    };
    const advisor: SupervisorCcAdvisor = {
      advise: async () => {
        advisorCalls += 1;
        return {
          mode: 'repo_answer',
          answer: 'should not call advisor first',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'answer_question',
              answer: 'should not use model first',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      advisor,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-natural' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '我有点迷糊，想聊聊怎么把这个 supervisor 做得更自然',
    );

    expect(agentCalls).toBe(1);
    expect(advisorCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(response.message).toContain('先把你想要的 supervisor 体验聊顺');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
  });

  test('passes a configured route without local_path to the supervisor agent for repo questions', async () => {
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
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-agent-route-no-local',
      default_project_slug: 'test2',
    });

    let modelCalls = 0;
    let agentInput: any = null;
    const agent: SupervisorAgentService = {
      respond: async (input) => {
        agentInput = input;
        return {
          mode: 'repo_answer',
          repoRef: 'UniUni2000/test2',
          answer: '这个仓库当前可以通过共享 source cache 读取。',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return null;
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      null,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-route-no-local' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '这个仓库有哪些文件？',
    );

    expect(agentInput).toMatchObject({
      localPath: null,
      defaultRepoRef: 'UniUni2000/test2',
      route: {
        project_slug: 'test2',
        github_repo_full: 'UniUni2000/test2',
        local_path: null,
      },
    });
    expect(response.message).toContain('共享 source cache');
    expect(modelCalls).toBe(0);
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
  });

  test('continues the active repo Claude conversation for repo follow-up issue advice', async () => {
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
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-agent-follow-up',
      default_project_slug: 'test2',
    });

    let modelCalls = 0;
    let agentInput: any = null;
    const agent: SupervisorAgentService & {
      hasActiveRepoConversation: (params: {
        transport: string;
        conversationId: string;
        repoRef: string | null;
      }) => boolean;
    } = {
      hasActiveRepoConversation: (params) => {
        expect(params).toEqual({
          transport: 'telegram',
          conversationId: 'chat-agent-follow-up',
          repoRef: 'UniUni2000/test2',
        });
        return true;
      },
      respond: async (input) => {
        agentInput = input;
        return {
          mode: 'repo_answer',
          repoRef: 'UniUni2000/test2',
          answer: '我会基于当前仓库连续上下文建议先补 README。',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return null;
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      null,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-follow-up' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '如果让你提一个 issue，你会提什么',
    );

    expect(agentInput).toMatchObject({
      forceReadOnlyClaude: true,
      runtimeContext: {
        transport: 'telegram',
        conversationId: 'chat-agent-follow-up',
      },
      route: {
        github_repo_full: 'UniUni2000/test2',
        local_path: null,
      },
    });
    expect(response.message).toContain('连续上下文');
    expect(modelCalls).toBe(0);

    subscriptions.dispose();
  });

  test('answers issue-list questions from runtime context even when a repo Claude conversation is active', async () => {
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
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-agent-issue-list',
      default_project_slug: 'test2',
    });

    let modelCalls = 0;
    let agentRespondCalls = 0;
    const agent: SupervisorAgentService & {
      hasActiveRepoConversation: (params: {
        transport: string;
        conversationId: string;
        repoRef: string | null;
      }) => boolean;
    } = {
      hasActiveRepoConversation: () => true,
      respond: async () => {
        agentRespondCalls += 1;
        return {
          mode: 'repo_answer',
          repoRef: 'UniUni2000/test2',
          answer: 'wrong repo advisor path',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return null;
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      null,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-issue-list' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '现在运行中的 issue 有哪些呢？',
    );

    expect(response.message).toContain('当前活跃 issue');
    expect(response.message).toContain('INT-31');
    expect(response.message).not.toContain('wrong repo advisor path');
    expect(agentRespondCalls).toBe(0);
    expect(modelCalls).toBe(0);

    subscriptions.dispose();
  });

  test('passes detailed issue runtime context to repo Claude for stuck and ETA diagnosis', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const runningIssue = {
      ...runtime.getOverview().issues[0]!,
      tracker_state: 'In Progress',
      orchestrator_state: 'dev_running',
      github_repo: 'UniUni2000/test2',
      session: {
        session_id: 'thread-31',
        turn_count: 2,
        stage: 'coding',
        last_event: 'timeline',
        last_message: 'Read completed',
        started_at: '2026-01-01T00:00:00.000Z',
        last_event_at: '2026-01-01T00:02:00.000Z',
        tokens: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
        recent_tools: [
          {
            tool_name: 'Read',
            status: 'completed',
            message: 'Read completed',
            summary: 'Read completed',
            path: 'README.md',
            timestamp: '2026-01-01T00:02:00.000Z',
          },
        ],
        recent_files: [
          {
            path: 'README.md',
            operation: 'read',
            status: 'completed',
            timestamp: '2026-01-01T00:02:00.000Z',
          },
        ],
      },
    } as any;
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:02:00.000Z',
      counts: { running: 1, retrying: 0, total: 1 },
      issues: [runningIssue],
    });
    runtime.getIssue = (id: string) => ['INT-31', 'issue-31'].includes(id) ? runningIssue : null;
    runtime.getTimeline = () => [
      {
        id: 'event-1',
        issue_id: 'issue-31',
        issue_identifier: 'INT-31',
        timestamp: '2026-01-01T00:02:00.000Z',
        message: 'Read completed',
        code: 'tool.completed',
        tool_name: 'Read',
        level: 'info',
        category: 'tool',
        detail: { path: 'README.md' },
      },
    ] as any;
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
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
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-agent-runtime-diagnosis',
      default_project_slug: 'test2',
    });

    let agentInput: any = null;
    const agent: SupervisorAgentService & {
      hasActiveRepoConversation: (params: {
        transport: string;
        conversationId: string;
        repoRef: string | null;
      }) => boolean;
    } = {
      hasActiveRepoConversation: () => true,
      respond: async (input) => {
        agentInput = input;
        return {
          mode: 'repo_answer',
          repoRef: 'UniUni2000/test2',
          answer: 'INT-31 仍在 dev_running，最近在处理 Read completed，ETA 只能给启发式判断。',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('diagnosis should use supervisor agent');
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      null,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-runtime-diagnosis' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      'INT-31 卡在哪里了，正在开发什么，预计啥时候能完成？',
    );

    expect(agentInput).toMatchObject({
      forceReadOnlyClaude: true,
      controlPlaneSnapshot: {
        overview: {
          active_issues: [
            {
              identifier: 'INT-31',
              tracker_state: 'In Progress',
              orchestrator_state: 'dev_running',
            },
          ],
        },
        focus_issue: {
          issue: {
            identifier: 'INT-31',
            session: {
              stage: 'coding',
              turn_count: 2,
            },
          },
          recent_timeline: [
            {
              message: 'Read completed',
            },
          ],
        },
      },
    });
    expect(agentInput.controlPlaneSnapshot.focus_issue.issue.runtime_diagnosis).toMatchObject({
      current_activity: expect.stringContaining('Read completed'),
      completion_estimate: expect.stringContaining('启发式'),
    });
    expect(response.message).toContain('ETA');

    subscriptions.dispose();
  });

  test('uses focused issue repository route instead of default project route for issue diagnosis', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const baseIssue = runtime.getOverview().issues[0]!;
    const focusedIssue = {
      ...baseIssue,
      issue_id: 'issue-99',
      work_item_id: 'issue-99',
      identifier: 'INT-99',
      title: 'Cross repo issue',
      tracker_state: 'In Progress',
      orchestrator_state: 'dev_running',
      github_repo: 'UniUni2000/other',
      actions: {
        ...baseIssue.actions,
        can_stop: true,
        can_retry: false,
      },
    };
    runtime.getOverview = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 1, retrying: 0, total: 1 },
      issues: [focusedIssue],
    });
    runtime.getIssue = (id: string) =>
      ['INT-99', 'issue-99'].includes(id) ? focusedIssue : null;

    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const projectResolver = new TrackerProjectResolutionService(
      {
        listProjects: async () => ({
          projects: [
            { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' },
            { project_id: 'project-2', project_slug: 'other', project_name: 'Other Repo' },
          ],
        }),
        findProjectBySlug: async (projectSlug: string) => ({
          project: projectSlug === 'test2'
            ? { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' }
            : projectSlug === 'other'
              ? { project_id: 'project-2', project_slug: 'other', project_name: 'Other Repo' }
              : null,
        }),
      } as any,
      {
        test2: {
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          local_path: '/tmp/test2',
        },
        other: {
          github_owner: 'UniUni2000',
          github_repo: 'other',
          local_path: '/tmp/other',
        },
      },
    );
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-agent-cross-repo',
      default_project_slug: 'test2',
    });

    let agentInput: any = null;
    const agent: SupervisorAgentService = {
      hasActiveRepoConversation: () => false,
      respond: async (input) => {
        agentInput = input;
        return {
          mode: 'repo_answer',
          repoRef: 'UniUni2000/other',
          answer: 'INT-99 正在 other 仓库开发。',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('cross-repo diagnosis should use supervisor agent');
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      null,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-cross-repo' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      'INT-99 卡在哪里，预计什么时候完成？',
    );

    expect(agentInput).toMatchObject({
      repoRef: 'UniUni2000/other',
      defaultRepoRef: 'UniUni2000/test2',
      localPath: '/tmp/other',
      route: {
        project_slug: 'other',
        github_repo_full: 'UniUni2000/other',
      },
    });
    expect(response.message).toContain('other 仓库');

    subscriptions.dispose();
  });

  test('clears the active repo Claude conversation with /clear', async () => {
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
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-agent-clear',
      default_project_slug: 'test2',
    });

    let clearInput: any = null;
    const agent: SupervisorAgentService & {
      clearRepoConversation: (params: {
        transport: string;
        conversationId: string;
        repoRef: string | null;
      }) => Promise<number>;
    } = {
      clearRepoConversation: async (params) => {
        clearInput = params;
        return 1;
      },
      respond: async () => {
        throw new Error('clear should not call respond');
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('clear should not call model');
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      null,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-clear' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '/clear',
    );

    expect(clearInput).toEqual({
      transport: 'telegram',
      conversationId: 'chat-agent-clear',
      repoRef: 'UniUni2000/test2',
    });
    expect(response.message).toContain('已清空');
    expect(response.message).toContain('UniUni2000/test2');

    subscriptions.dispose();
  });

  test('uses the advisor for ordinary Telegram natural chat even when an active supervisor session exists', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const sessions = new SupervisorSessionRepository(db);
    const sessionEvents = new SupervisorSessionEventRepository(db);
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
          local_path: '/tmp/test2',
        },
      },
    );
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-advisor-natural-active',
      default_project_slug: 'test2',
    });

    sessions.create({
      id: 'session-natural-active',
      transport: 'telegram',
      conversation_id: 'chat-advisor-natural-active',
      user_id: 'user-1',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      plan_card: {
        title: '创建 Issue',
        user_goal: '创建 Issue',
        in_scope: ['创建 Issue'],
        out_of_scope: [],
        acceptance: ['结果可验证。'],
        known_risks: [],
        execution_strategy: '批准后执行。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '批准并开始',
          summary: '执行旧计划。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const supervisorService = new SupervisorSessionService(
      runtime,
      projectResolver,
      sessions,
      sessionEvents,
    );

    let modelCalls = 0;
    let advisorCalls = 0;
    const advisor: SupervisorCcAdvisor = {
      advise: async () => {
        advisorCalls += 1;
        return {
          mode: 'repo_answer',
          answer: '我们可以先别急着建单，先把你想要的体验说顺，我来帮你收。🙂',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'answer_question',
              answer: 'should not use model first',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      supervisorService,
      advisor,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-advisor-natural-active' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '我有点迷糊，想聊聊怎么把这个 supervisor 做得更自然',
    );

    expect(advisorCalls).toBe(1);
    expect(modelCalls).toBe(0);
    expect(response.message).toContain('先别急着建单');
    expect(response.message).not.toContain('计划待你批准');
    expect(response.message).not.toContain('创建 Issue');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('routes active supervisor approval text to the session before asking the supervisor agent', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const sessions = new SupervisorSessionRepository(db);
    const sessionEvents = new SupervisorSessionEventRepository(db);
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
          local_path: '/tmp/test2',
        },
      },
    );
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-agent-active-approve',
      default_project_slug: 'test2',
    });

    sessions.create({
      id: 'session-agent-active-approve',
      transport: 'telegram',
      conversation_id: 'chat-agent-active-approve',
      user_id: 'user-1',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      plan_card: {
        title: 'Build the supervisor Plan Card artifact',
        user_goal: 'Build the supervisor Plan Card artifact',
        in_scope: ['Create the artifact after approval.'],
        out_of_scope: [],
        acceptance: ['The artifact exists and is reviewable.'],
        known_risks: [],
        execution_strategy: '批准后建单并推进。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '批准并开始',
          summary: '执行当前计划。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const supervisorService = new SupervisorSessionService(
      runtime,
      projectResolver,
      sessions,
      sessionEvents,
    );
    let agentCalls = 0;
    const agent: SupervisorAgentService = {
      respond: async () => {
        agentCalls += 1;
        return {
          mode: 'chat_reply',
          repoRef: 'UniUni2000/test2',
          message: 'This would incorrectly swallow approval.',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
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
      null,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-active-approve' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '批准并开始',
    );

    expect(agentCalls).toBe(0);
    expect(runtime.createIssueCalls).toHaveLength(1);
    expect(String(runtime.createIssueCalls[0]?.title)).toContain('supervisor Plan Card artifact');
    expect(response.message).not.toContain('incorrectly swallow approval');

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('routes advisor issue drafts back through the existing supervisor session flow', async () => {
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
      conversation_id: 'chat-advisor-draft',
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
          local_path: '/tmp/test2',
        },
      },
    );

    const supervisorService = new SupervisorSessionService(
      runtime,
      projectResolver,
      sessions,
      sessionEvents,
    );
    let modelCalls = 0;
    let advisorCalls = 0;
    const advisor: SupervisorCcAdvisor = {
      advise: async () => {
        advisorCalls += 1;
        return {
          mode: 'issue_draft',
          title: '让 supervisor 更自然地起草 issue',
          body: '从普通 Telegram 对话中先理解需求，再给出推荐计划卡。',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'help',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      supervisorService,
      advisor,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-advisor-draft' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '我想把这个 repo 的建单体验变自然一点，你先帮我理解并起草',
    );

    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-advisor-draft',
    });

    expect(advisorCalls).toBe(1);
    expect(modelCalls).toBe(0);
    expect(response.message).toContain('计划待你批准');
    expect(response.message).not.toContain('一起补计划');
    expect(session?.plan_card?.title).toContain('让 supervisor 更自然地起草 issue');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('routes supervisor agent handoff results through the existing supervisor session flow', async () => {
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
      conversation_id: 'chat-agent-handoff',
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
          local_path: '/tmp/test2',
        },
      },
    );

    const supervisorService = new SupervisorSessionService(
      runtime,
      projectResolver,
      sessions,
      sessionEvents,
    );
    let modelCalls = 0;
    let advisorCalls = 0;
    let agentCalls = 0;
    const agent: SupervisorAgentService = {
      respond: async () => {
        agentCalls += 1;
        return {
          mode: 'handoff_to_session',
          repoRef: 'UniUni2000/test2',
          suggestedTitle: '计算不同质量恒星的光度等参数随 M 的变化',
          suggestedBody: '整理理论公式、标度律，并附一个可运行的 Python 计算/绘图脚本。',
          projectSlug: 'test2',
          handoffMessage: '我先帮你把这个需求收成一张推荐 issue 卡。',
        };
      },
    };
    const advisor: SupervisorCcAdvisor = {
      advise: async () => {
        advisorCalls += 1;
        return null;
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'help',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      supervisorService,
      advisor,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-handoff' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '创建个 issue，计算不同质量恒星的光度等参数随 M 的变化',
    );

    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-agent-handoff',
    });

    expect(agentCalls).toBe(1);
    expect(advisorCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(response.message).toContain('计划待你批准');
    expect(session?.plan_card?.title).toContain('恒星');
    expect(session?.plan_card?.title).toContain('光度');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('routes supervisor agent artifact ideation through the existing supervisor session flow', async () => {
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
      conversation_id: 'chat-agent-artifact',
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
          local_path: '/tmp/test2',
        },
      },
    );

    const supervisorService = new SupervisorSessionService(
      runtime,
      projectResolver,
      sessions,
      sessionEvents,
    );
    let modelCalls = 0;
    let advisorCalls = 0;
    let agentCalls = 0;
    const agent: SupervisorAgentService = {
      respond: async () => {
        agentCalls += 1;
        return {
          mode: 'artifact_ideation',
          repoRef: 'UniUni2000/test2',
          title: 'Release readiness artifact map',
          recommendation: 'Create a single artifact map that links release checks, ownership, and proof outputs.',
          rationale: 'The team needs one reviewable object before execution starts.',
          nextStep: 'Draft the artifact map shape and acceptance checks in the Plan Card.',
        };
      },
    };
    const advisor: SupervisorCcAdvisor = {
      advise: async () => {
        advisorCalls += 1;
        return null;
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'help',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      supervisorService,
      advisor,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-artifact' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '帮我想一个 release readiness artifact',
    );

    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-agent-artifact',
    });

    expect(agentCalls).toBe(1);
    expect(advisorCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(response.message).toContain('计划待你批准');
    expect(response.message).not.toContain('一起补计划');
    expect(session?.state).toBe('awaiting_user_approval');
    expect(session?.active_decision_kind).toBe('plan_approval');
    expect(session?.plan_card?.title).toContain('Release readiness artifact map');
    const planAcceptance = session?.plan_card?.acceptance.join('\n') ?? '';
    expect(planAcceptance).toContain('Artifact recommendation: Create a single artifact map that links release checks, ownership, and proof outputs.');
    expect(planAcceptance).toContain('Rationale: The team needs one reviewable object before execution starts.');
    expect(planAcceptance).toContain('Next step: Draft the artifact map shape and acceptance checks in the Plan Card');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('returns supervisor agent artifact ideation as a helpful reply when session service is unavailable', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-agent-artifact-no-session',
      default_project_slug: 'test2',
    });
    const noSessionProjectResolver = new TrackerProjectResolutionService(
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
          local_path: '/tmp/test2',
        },
      },
    );

    let modelCalls = 0;
    let agentCalls = 0;
    const agent: SupervisorAgentService = {
      respond: async () => {
        agentCalls += 1;
        return {
          mode: 'artifact_ideation',
          repoRef: 'UniUni2000/test2',
          title: 'Runtime proof artifact',
          recommendation: 'Show one compact proof card with command, result, and owner.',
          rationale: 'The artifact should make review possible without opening a separate tracker.',
          nextStep: 'Turn this into a Plan Card once the supervisor session service is available.',
        };
      },
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions, () => true, preferences, noSessionProjectResolver),
      preferences,
      pending,
      noSessionProjectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'answer_question',
              answer: 'generic fallback should not be used',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      null,
      null,
      agent,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-agent-artifact-no-session' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '先给我一个 artifact 建议',
    );

    expect(agentCalls).toBe(1);
    expect(modelCalls).toBe(0);
    expect(response.message).toContain('Runtime proof artifact');
    expect(response.message).toContain('Recommendation: Show one compact proof card with command, result, and owner.');
    expect(response.message).toContain('Rationale: The artifact should make review possible without opening a separate tracker.');
    expect(response.message).toContain('Next step: Turn this into a Plan Card once the supervisor session service is available.');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
  });

  test('returns advisor clarification as a normal conversational reply without creating a session', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-advisor-clarify',
      default_project_slug: 'test2',
    });
    const sessions = new SupervisorSessionRepository(db);
    const sessionEvents = new SupervisorSessionEventRepository(db);
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
          local_path: '/tmp/test2',
        },
      },
    );
    const supervisorService = new SupervisorSessionService(
      runtime,
      projectResolver,
      sessions,
      sessionEvents,
    );

    let modelCalls = 0;
    const advisor: SupervisorCcAdvisor = {
      advise: async () => ({
        mode: 'clarify',
        question: '你更想优化 repo 理解、还是 issue 起草这一步？',
      }),
    };

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions),
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'help',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      supervisorService,
      advisor,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-advisor-clarify' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '帮我先想清楚这个需求',
    );

    expect(response.message).toBe('你更想优化 repo 理解、还是 issue 起草这一步？');
    expect(modelCalls).toBe(0);
    expect(sessions.findAll()).toHaveLength(0);
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
    supervisorService.dispose();
  });

  test('falls back to existing behavior when the advisor cannot help', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);

    let modelCalls = 0;
    let supervisorCalls = 0;
    const advisor: SupervisorCcAdvisor = {
      advise: async () => null,
    };
    const supervisorService = {
      hasActiveSession: () => false,
      respond: async () => {
        supervisorCalls += 1;
        return null;
      },
    } as unknown as SupervisorSessionService;

    const assistant = new BotAssistantService(
      runtime,
      new BotCommandService(runtime, subscriptions),
      preferences,
      pending,
      null,
      {
        decide: async () => {
          modelCalls += 1;
          return {
            intent: {
              kind: 'answer_question',
              answer: 'generic fallback still works',
            },
          };
        },
      },
      undefined,
      subscriptions,
      null,
      supervisorService,
      advisor,
    );

    const response = await assistant.respondToText(
      {
        transport: 'telegram',
        recipient: { transport: 'telegram', conversation_id: 'chat-advisor-fallback' },
        identity: { user_id: 'user-1', display_name: 'Alice' },
      },
      '随便聊聊这个系统',
    );

    expect(supervisorCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(response.message).toBe('generic fallback still works');
    expect(runtime.createIssueCalls).toHaveLength(0);

    subscriptions.dispose();
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

  test('answers repo-purpose questions from repo profile when the model is unavailable', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-assistant-repo-profile-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, 'README.md'),
        [
          '# Test Two',
          '',
          'Test Two is a Telegram-first supervisor workspace for planning repository work and tracking runtime execution.',
          'It helps users discuss requirements naturally, draft better issues, and manage execution state in one place.',
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({
          name: 'test-two',
          dependencies: {
            hono: '^4.0.0',
          },
          devDependencies: {
            typescript: '^5.0.0',
          },
        }, null, 2),
        'utf8',
      );
      fs.mkdirSync(path.join(repoRoot, 'src'));

      const runtime = createRuntimeControlPlane();
      const subscriptions = new BotSubscriptionService(runtime, {});
      const preferences = new BotConversationPreferenceRepository(db);
      const pending = new BotPendingActionRepository(db);
      preferences.upsert({
        transport: 'telegram',
        conversation_id: 'chat-repo-purpose',
        default_project_slug: 'test2',
      });
      const projectResolver = new TrackerProjectResolutionService(
        {
          listProjects: async () => ({ projects: [] }),
          findProjectBySlug: async () => ({ project: null }),
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
          decide: async () => {
            throw new Error('Anthropic unavailable');
          },
        },
      );

      const response = await assistant.respondToText(
        {
          transport: 'telegram',
          recipient: { transport: 'telegram', conversation_id: 'chat-repo-purpose' },
          identity: { user_id: 'user-1', display_name: 'Alice' },
        },
        '这个项目主要干啥？',
      );

      expect(response.message).toContain('Telegram-first supervisor workspace');
      expect(response.message).toContain('UniUni2000/test2');
      expect(response.message).toContain('TypeScript');
      expect(response.message).not.toContain('当前自然语言模型暂不可用');

      subscriptions.dispose();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('answers repo downside questions from repo profile instead of runtime governance noise', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-assistant-repo-downsides-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, 'README.md'),
        [
          '# Test Two',
          '',
          'Test Two is a Telegram-first supervisor workspace for planning repository work and tracking runtime execution.',
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({
          name: 'test-two',
          dependencies: {
            hono: '^4.0.0',
          },
          devDependencies: {
            typescript: '^5.0.0',
          },
        }, null, 2),
        'utf8',
      );
      fs.mkdirSync(path.join(repoRoot, 'src'));

      const runtime = createRuntimeControlPlane();
      const subscriptions = new BotSubscriptionService(runtime, {});
      const preferences = new BotConversationPreferenceRepository(db);
      const pending = new BotPendingActionRepository(db);
      preferences.upsert({
        transport: 'telegram',
        conversation_id: 'chat-repo-downsides',
        default_project_slug: 'test2',
      });
      const projectResolver = new TrackerProjectResolutionService(
        {
          listProjects: async () => ({ projects: [] }),
          findProjectBySlug: async () => ({ project: null }),
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
              kind: 'answer_question',
              answer: '根据当前运行时上下文，该项目存在治理降级、Harness 缺失、INT-150 清理中等问题。',
            },
          }),
        },
      );

      const response = await assistant.respondToText(
        {
          transport: 'telegram',
          recipient: { transport: 'telegram', conversation_id: 'chat-repo-downsides' },
          identity: { user_id: 'user-1', display_name: 'Alice' },
        },
        '这个项目有哪些弊端？',
      );

      expect(response.message).toContain('Test Two');
      expect(response.message).toContain('README');
      expect(response.message).not.toContain('治理降级');
      expect(response.message).not.toContain('Harness');
      expect(response.message).not.toContain('INT-150');

      subscriptions.dispose();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
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
