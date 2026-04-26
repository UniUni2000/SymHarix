import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema, SupervisorSessionEventRepository, SupervisorSessionRepository } from '../database';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeStreamEvent } from '../runtime/types';
import type { BotAssistantIntent, BotCommandContext, BotRuntimeCopilotContext } from '../bots/types';
import { SupervisorSessionService, type SupervisorPlanBrain } from './sessionService';

function createIssueView(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-1',
    work_item_id: 'work-item-1',
    identifier: 'INT-1',
    title: 'Default title',
    phase: 'DEV',
    tracker_state: 'Todo',
    orchestrator_state: 'halted',
    workspace_path: null,
    branch_name: null,
    github_repo: 'UniUni2000/test2',
    github_issue_number: null,
    active_pr_number: null,
    session: null,
    governance_status: null,
    governance_decision: null,
    governance_summary: null,
    governance_root_issue_id: 'issue-1',
    governance_root_issue_identifier: 'INT-1',
    governance_thread_state: null,
    governance_child_issues: [],
    governance_current_child: null,
    governance_child_queue: [],
    next_recommended_action: null,
    delivery_state: null,
    delivery_code: null,
    delivery_summary: null,
    active_governance_suggestions: [],
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
    ...overrides,
  };
}

function createRuntime(): RuntimeControlPlane & {
  createIssueCalls: Array<Record<string, unknown>>;
  splitGovernanceCalls: string[];
  issues: Map<string, RuntimeIssueView>;
  emit: (event: RuntimeStreamEvent) => void;
} {
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  const createIssueCalls: Array<Record<string, unknown>> = [];
  const splitGovernanceCalls: string[] = [];
  const issues = new Map<string, RuntimeIssueView>();

  const runtime: RuntimeControlPlane & {
    createIssueCalls: Array<Record<string, unknown>>;
    splitGovernanceCalls: string[];
    issues: Map<string, RuntimeIssueView>;
    emit: (event: RuntimeStreamEvent) => void;
  } = {
    getOverview: () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: issues.size },
      issues: [...issues.values()],
    }),
    getIssue: (id: string) => issues.get(id) ?? [...issues.values()].find((issue) => issue.identifier === id) ?? null,
    getTimeline: () => [],
    getHistoryView: () => null,
    createIssue: async (input) => {
      createIssueCalls.push(input as Record<string, unknown>);
      const issue = createIssueView({
        issue_id: 'issue-1',
        work_item_id: 'work-item-1',
        identifier: 'INT-1',
        title: input.title,
        governance_status: 'blocked',
        governance_decision: 'split_before_implement',
        governance_summary: 'This issue spans multiple objectives and should be split before implementation.',
        governance_thread_state: 'blocked',
        actions: {
          can_stop: false,
          can_retry: true,
          can_override_governance: true,
          can_rewrite_governance: true,
          can_split_governance: true,
          can_open_pr: false,
        },
      });
      issues.set(issue.issue_id, issue);
      return {
        accepted: true,
        status: 'accepted',
        message: 'Created INT-1',
        issue_id: issue.issue_id,
        issue_identifier: issue.identifier,
        issue,
      };
    },
    stopIssue: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    retryIssue: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    overrideGovernance: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    rewriteGovernance: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    splitGovernance: async (id: string) => {
      splitGovernanceCalls.push(id);
      const root = issues.get(id);
      if (root) {
        issues.set(id, {
          ...root,
          governance_thread_state: 'waiting_on_child',
          governance_current_child: {
            issue_id: 'issue-2',
            issue_identifier: 'INT-2',
            title: '拆分后的当前子任务',
            tracker_state: 'Todo',
            orchestrator_state: 'discovering',
            governance_decision: null,
            governance_summary: null,
            queue_state: 'current',
            delivery_state: null,
            delivery_code: null,
            delivery_summary: null,
          },
          governance_child_queue: [
            {
              issue_id: 'issue-2',
              issue_identifier: 'INT-2',
              title: '拆分后的当前子任务',
              tracker_state: 'Todo',
              orchestrator_state: 'discovering',
              governance_decision: null,
              governance_summary: null,
              queue_state: 'current',
              delivery_state: null,
              delivery_code: null,
              delivery_summary: null,
            },
            {
              issue_id: 'issue-3',
              issue_identifier: 'INT-3',
              title: '后续排队子任务',
              tracker_state: 'Todo',
              orchestrator_state: 'halted',
              governance_decision: null,
              governance_summary: null,
              queue_state: 'queued',
              delivery_state: null,
              delivery_code: null,
              delivery_summary: null,
            },
          ],
          next_recommended_action: '先处理治理子任务 INT-2；其余子任务会按顺序自动接力。',
        });
      }
      return {
        accepted: true,
        status: 'accepted',
        message: 'Split applied for INT-1',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        governance_action: {
          outcome_kind: 'waiting_on_child',
          root_issue_identifier: 'INT-1',
          created_issue_identifiers: ['INT-2', 'INT-3'],
          next_recommended_action: '先处理治理子任务 INT-2；其余子任务会按顺序自动接力。',
          user_summary: '已为 INT-1 创建治理子任务 INT-2、INT-3，当前先处理 INT-2。',
        },
      };
    },
    executeGovernanceSuggestion: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    dismissGovernanceSuggestion: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
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
    splitGovernanceCalls,
    issues,
  };

  return runtime;
}

function createProjectResolver() {
  return new TrackerProjectResolutionService(
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
}

function createContext(): BotCommandContext {
  return {
    transport: 'telegram',
    recipient: {
      transport: 'telegram',
      conversation_id: 'chat-1',
    },
    identity: {
      user_id: 'user-1',
      display_name: 'Alice',
    },
  };
}

function createRuntimeContext(overrides: Partial<BotRuntimeCopilotContext> = {}): BotRuntimeCopilotContext {
  return {
    default_project_slug: 'test2',
    available_projects: [
      {
        project_slug: 'test2',
        github_repo_full: 'UniUni2000/test2',
      },
    ],
    watch_subscriptions: [],
    overview: {
      running: 0,
      retrying: 0,
      total: 0,
      active_issues: [],
    },
    focus_issue: null,
    assistant: {
      provider: null,
      model: null,
      configured: false,
      health: 'unconfigured',
      fallback_available: true,
      last_error_code: 'unconfigured',
    },
    ...overrides,
  };
}

describe('SupervisorSessionService', () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  test('creates an approval-gated plan card for a multi-objective request and materializes it into a split queue after approval', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const context = createContext();
    const runtimeContext = createRuntimeContext();
    const createIntent: BotAssistantIntent = {
      kind: 'create_issue',
      title: 'Refactor runtime API and redesign the runtime web dashboard and rewrite Telegram copy',
      description: 'Do all three together and clean related files.',
      project_slug: 'test2',
    };

    const first = await service.respond({
      context,
      text: '帮我同时改 runtime API、运行态网页和 Telegram 文案',
      intent: createIntent,
      runtimeContext,
      canWrite: true,
    });

    expect(first).not.toBeNull();
    expect(first?.message).toContain('计划待你批准');
    expect(first?.format).toBe('telegram_html');
    expect(first?.session_id).toBeTruthy();
    expect(first?.material_key).toContain('session');
    expect(first?.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('awaiting_user_approval');
    expect(session?.approval_mode).toBe('explicit_user_approval');

    const approved = await service.respond({
      context,
      text: '按推荐继续',
      intent: null,
      runtimeContext,
      canWrite: true,
    });

    expect(approved).not.toBeNull();
    expect(approved?.format).toBe('telegram_html');
    expect(approved?.message).toContain('INT-1');
    expect(approved?.message).toContain('当前子任务');
    expect(runtime.createIssueCalls).toHaveLength(1);
    expect(runtime.createIssueCalls[0]?.supervisor_execution_intent).toEqual(expect.objectContaining({
      root_session_id: session!.id,
      repo_ref: 'test2',
      approved_execution_mode: 'root_with_split_queue',
      plan_summary: expect.stringContaining('Refactor runtime API'),
      acceptance_summary: expect.stringContaining('Do all three together'),
    }));
    expect(runtime.splitGovernanceCalls).toEqual(['issue-1']);
    const updated = sessions.findById(session!.id);
    expect(updated?.state).toBe('executing');
    expect(updated?.root_issue_id).toBe('issue-1');
    expect(updated?.current_child_issue_id).toBe('issue-2');
    const eventKinds = events.listBySession(session!.id).map((event) => event.event_kind);
    expect(eventKinds).toContain('execution_intent_approved');
    expect(eventKinds).toContain('materialized_plan_created');
  });

  test('folds repo intelligence into the plan card before approval', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(
      runtime,
      createProjectResolver(),
      sessions,
      events,
      {
        resolve: async () => ({
          repo_ref: 'UniUni2000/test2',
          harness_status: 'shadow',
          constitution_status: 'missing',
          decision_memory_count: 2,
          related_conflict_count: 3,
          related_debt_signal_count: 2,
          top_conflict_summary: '最近几次相关需求都在 runtime ↔ bots 边界上反复冲突。',
          top_debt_summary: 'runtime 控制面已经积累了待清理债务。',
        }),
      },
    );

    const response = await service.respond({
      context: createContext(),
      text: '把 runtime API、bot copy 和控制面清理一起做掉',
      intent: {
        kind: 'create_issue',
        title: '把 runtime API、bot copy 和控制面清理一起做掉',
        description: '希望这轮一起收口',
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response).not.toBeNull();
    expect(response?.message).toContain('shadow harness');
    expect(response?.message).toContain('.symphony-constitution.md');
    expect(response?.message).toContain('runtime 控制面已经积累了待清理债务');
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('awaiting_user_approval');
    expect(session?.plan_card?.known_risks).toEqual(expect.arrayContaining([
      expect.stringContaining('shadow harness'),
      expect.stringContaining('.symphony-constitution.md'),
      expect.stringContaining('3 条相关冲突记忆'),
      expect.stringContaining('2 条相关 debt signal'),
    ]));
    expect(session?.plan_card?.execution_strategy).toContain('先把源目标收成 root thread');
  });

  test('lets the memoryful planning brain refine the plan card using session events and repo intelligence', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const seenInputs: Array<Parameters<SupervisorPlanBrain['refinePlan']>[0]> = [];
    const planBrain: SupervisorPlanBrain = {
      refinePlan: async (input) => {
        seenInputs.push(input);
        return {
          state: 'awaiting_user_approval',
          approvalMode: 'explicit_user_approval',
          rationale: 'cleanup request needs bounded acceptance and explicit approval',
          planCard: {
            title: '受控清理仓库残余文件',
            user_goal: '清理仓库残余文件，同时保留有效源码和配置',
            in_scope: ['识别未跟踪/流程残余文件', '删除确认无用的临时产物'],
            out_of_scope: ['不删除业务源码', '不改动真实用户数据'],
            acceptance: ['git status 只剩预期变更', '清理清单写入交付说明'],
            known_risks: ['清理类操作需要避免误删有效文件'],
            execution_strategy: '先让 dev agent 列出候选残余，再按最小安全范围清理和验证。',
            materialization_mode: 'root_only',
            recommended_option: {
              label: '批准受控清理',
              summary: '按安全清理计划建单并执行。',
            },
          },
        };
      },
    };
    const service = new SupervisorSessionService(
      runtime,
      createProjectResolver(),
      sessions,
      events,
      {
        resolve: async () => ({
          repo_ref: 'UniUni2000/test2',
          harness_status: 'formal',
          constitution_status: 'present',
          decision_memory_count: 4,
          related_conflict_count: 1,
          related_debt_signal_count: 0,
          top_conflict_summary: '历史清理任务曾误碰 workflow artifacts。',
          top_debt_summary: null,
        }),
      },
      planBrain,
    );

    const response = await service.respond({
      context: createContext(),
      text: '这个仓库还有文件残余，把它都清空',
      intent: {
        kind: 'create_issue',
        title: '这个仓库还有文件残余，把它都清空',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response).not.toBeNull();
    expect(response?.message).toContain('受控清理仓库残余文件');
    expect(response?.message).toContain('不删除业务源码');
    expect(response?.message).toContain('批准受控清理');
    expect(runtime.createIssueCalls).toHaveLength(0);
    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]?.repoIntelligence?.decision_memory_count).toBe(4);
    expect(seenInputs[0]?.recentEvents.map((event) => event.event_kind)).toContain('user_message');

    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('awaiting_user_approval');
    expect(session?.plan_card?.title).toBe('受控清理仓库残余文件');
    expect(events.listBySession(session!.id).map((event) => event.event_kind)).toContain('plan_brain_applied');
  });

  test('auto-starts a small focused issue after generating a compact plan card', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const response = await service.respond({
      context: createContext(),
      text: '写一个 hello world 的 Python 脚本',
      intent: {
        kind: 'create_issue',
        title: '写一个 hello world 的 Python 脚本',
        description: '输出到终端即可',
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response).not.toBeNull();
    expect(response?.format).toBe('telegram_html');
    expect(response?.message).toContain('计划执行中');
    expect(response?.session_id).toBeTruthy();
    expect(runtime.createIssueCalls).toHaveLength(1);
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('executing');
    expect(session?.approval_mode).toBe('auto');
  });

  test('honors explicit user request to wait for approval even for a focused issue', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const response = await service.respond({
      context: createContext(),
      text: '帮我新增 supervisor live smoke 文档，完成后跑测试。先给我计划卡，我批准后再做。',
      intent: {
        kind: 'create_issue',
        title: '帮我新增 supervisor live smoke 文档，完成后跑测试。先给我计划卡，我批准后再做。',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response).not.toBeNull();
    expect(response?.format).toBe('telegram_html');
    expect(response?.message).toContain('计划待你批准');
    expect(response?.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('awaiting_user_approval');
    expect(session?.approval_mode).toBe('explicit_user_approval');
  });

  test('asks for a repo first when the request does not yet bind to a project and resumes once the repo is clarified', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const context = createContext();

    const first = await service.respond({
      context,
      text: '帮我做一个 hello world 脚本',
      intent: {
        kind: 'create_issue',
        title: '帮我做一个 hello world 脚本',
        description: null,
        project_slug: null,
      },
      runtimeContext: createRuntimeContext({
        default_project_slug: null,
      }),
      canWrite: true,
    });

    expect(first).not.toBeNull();
    expect(first?.message).toContain('告诉我这条需求应该落到哪个 project slug / 仓库');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('clarifying');

    const second = await service.respond({
      context,
      text: '仓库 test2',
      intent: null,
      runtimeContext: createRuntimeContext({
        default_project_slug: null,
      }),
      canWrite: true,
    });

    expect(second).not.toBeNull();
    expect(second?.format).toBe('telegram_html');
    expect(second?.message).toContain('计划执行中');
    expect(runtime.createIssueCalls).toHaveLength(1);
    const updated = sessions.findById(session!.id);
    expect(updated?.repo_ref).toBe('test2');
    expect(updated?.state).toBe('executing');
  });

  test('preserves explicit approval gate after repo clarification', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const context = createContext();

    const first = await service.respond({
      context,
      text: '帮我新增 supervisor live smoke 文档，完成后跑测试。先给我计划卡，我批准后再做。',
      intent: {
        kind: 'create_issue',
        title: '帮我新增 supervisor live smoke 文档，完成后跑测试。先给我计划卡，我批准后再做。',
        description: null,
        project_slug: null,
      },
      runtimeContext: createRuntimeContext({
        default_project_slug: null,
      }),
      canWrite: true,
    });

    expect(first).not.toBeNull();
    expect(first?.message).toContain('一起补计划');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });

    const second = await service.respond({
      context,
      text: '仓库 test2',
      intent: null,
      runtimeContext: createRuntimeContext({
        default_project_slug: null,
      }),
      canWrite: true,
    });

    expect(second).not.toBeNull();
    expect(second?.message).toContain('计划待你批准');
    expect(second?.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const updated = sessions.findById(session!.id);
    expect(updated?.repo_ref).toBe('test2');
    expect(updated?.state).toBe('awaiting_user_approval');
    expect(updated?.approval_mode).toBe('explicit_user_approval');
  });

  test('stores clarification answers in the plan before auto materializing a focused issue', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const context = createContext();

    const first = await service.respond({
      context,
      text: '改善用户体验',
      intent: {
        kind: 'create_issue',
        title: '改善用户体验',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(first).not.toBeNull();
    expect(first?.message).toContain('还缺什么');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('clarifying');

    const second = await service.respond({
      context,
      text: '完成后能在 /settings 页面保存主题，测试通过',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(second).not.toBeNull();
    expect(second?.message).toContain('计划执行中');
    expect(runtime.createIssueCalls).toHaveLength(1);
    expect(String(runtime.createIssueCalls[0]?.description)).toContain('/settings 页面保存主题');
    const updated = sessions.findById(session!.id);
    expect(updated?.plan_card?.acceptance.join('\n')).toContain('/settings 页面保存主题');
    expect(events.listBySession(session!.id).some((event) => event.event_kind === 'clarification_answer_recorded')).toBe(true);
  });

  test('walks a Telegram-first supervisor session from repo clarification to approval to materialized execution', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const context = createContext();

    const first = await service.respond({
      context,
      text: '把 runtime API 和 Telegram 文案一起收口',
      intent: {
        kind: 'create_issue',
        title: '把 runtime API 和 Telegram 文案一起收口',
        description: '希望这轮一起推进，但我还没指定仓库',
        project_slug: null,
      },
      runtimeContext: createRuntimeContext({
        default_project_slug: null,
      }),
      canWrite: true,
    });

    expect(first).not.toBeNull();
    expect(first?.format).toBe('telegram_html');
    expect(first?.message).toContain('一起补计划');
    expect(first?.message).toContain('还缺什么');
    expect(first?.message).toContain('直接回复即可');
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('clarifying');
    expect(runtime.createIssueCalls).toHaveLength(0);

    const second = await service.respond({
      context,
      text: '仓库 test2',
      intent: null,
      runtimeContext: createRuntimeContext({
        default_project_slug: null,
      }),
      canWrite: true,
    });

    expect(second).not.toBeNull();
    expect(second?.format).toBe('telegram_html');
    expect(second?.message).toContain('计划待你批准');
    expect(second?.message).toContain('我已理解的计划');
    expect(second?.message).toContain('批准后会发生什么');
    expect(second?.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    const updated = sessions.findById(session!.id);
    expect(updated?.state).toBe('awaiting_user_approval');
    expect(updated?.repo_ref).toBe('test2');

    const third = await service.respond({
      context,
      text: '批准并开始',
      intent: null,
      runtimeContext: createRuntimeContext({
        default_project_slug: null,
      }),
      canWrite: true,
    });

    expect(third).not.toBeNull();
    expect(third?.format).toBe('telegram_html');
    expect(third?.message).toContain('计划执行中');
    expect(third?.message).toContain('当前子任务');
    expect(third?.message).toContain('我会继续推进，只在关键节点回来找你');
    expect(runtime.createIssueCalls).toHaveLength(1);
    expect(runtime.splitGovernanceCalls).toEqual(['issue-1']);
    const finalSession = sessions.findById(session!.id);
    expect(finalSession?.state).toBe('executing');
    expect(finalSession?.current_child_issue_id).toBe('issue-2');
  });

  test('executes the recommended governance action from an awaiting-user-decision session', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    runtime.issues.set('issue-1', createIssueView({
      issue_id: 'issue-1',
      identifier: 'INT-1',
      title: 'Blocked root issue',
      tracker_state: 'In Progress',
      governance_status: 'blocked',
      governance_decision: 'split_before_implement',
      governance_summary: 'This issue spans multiple objectives and should be split before implementation.',
      governance_thread_state: 'blocked',
      actions: {
        can_stop: false,
        can_retry: false,
        can_override_governance: true,
        can_rewrite_governance: true,
        can_split_governance: true,
        can_open_pr: false,
      },
    }));

    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_decision',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-1',
      plan_card: {
        title: 'Blocked root issue',
        user_goal: 'Blocked root issue',
        in_scope: ['Blocked root issue'],
        out_of_scope: ['不顺手扩展到无关模块。'],
        acceptance: ['完成 blocked root issue，并让结果可验证。'],
        known_risks: ['当前治理层要求先拆分。'],
        execution_strategy: '先把源目标收成 root thread，再只放行当前 child。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '先执行当前推荐的治理动作。',
        },
        alternate_option: {
          label: '改一下计划',
          summary: '如果不想按当前方案走，可以先改计划。',
        },
        governance_preview: {
          decision: 'split_before_implement',
          summary: 'This issue spans multiple objectives and should be split before implementation.',
          split_suggestions: ['先拆出 runtime/control-plane 变更。'],
          rewrite_title: null,
          rewrite_description: null,
        },
      },
    });

    const response = await service.respond({
      context: createContext(),
      text: '按推荐继续',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response).not.toBeNull();
    expect(response?.format).toBe('telegram_html');
    expect(response?.message).toContain('INT-2');
    expect(runtime.splitGovernanceCalls).toEqual(['issue-1']);
    expect(sessions.findById(session.id)?.state).toBe('executing');
  });

  test('records high-signal runtime milestones into supervisor session memory without duplicating unchanged updates', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-1',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['Root issue'],
        out_of_scope: ['不顺手扩展到无关模块。'],
        acceptance: ['完成 root issue，并让结果可验证。'],
        known_risks: [],
        execution_strategy: 'root issue 保持主线程推进。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const deliveryFailed = createIssueView({
      issue_id: 'issue-1',
      identifier: 'INT-1',
      governance_root_issue_id: 'issue-1',
      delivery_state: 'delivery_failed',
      delivery_code: 'dirty_workspace_no_commit',
      delivery_summary: '证据已满足，但工作区有未提交改动，PR 没建成。',
    });

    runtime.emit({ type: 'issue', data: deliveryFailed });
    runtime.emit({ type: 'issue', data: deliveryFailed });

    const milestoneEvents = events
      .listBySession(session.id)
      .filter((event) => event.event_kind === 'orchestrator_milestone');
    expect(milestoneEvents).toHaveLength(1);
    expect(milestoneEvents[0]?.payload_json?.milestone_kind).toBe('delivery_failed');
    expect(sessions.findById(session.id)?.delivery_summary).toContain('PR 没建成');
  });

  test('switches an executing root session into awaiting-user-decision when the current child delivery fails', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-root',
      current_child_issue_id: 'issue-child-1',
      plan_card: {
        title: 'Root plan',
        user_goal: 'Root plan',
        in_scope: ['按 child queue 顺序推进'],
        out_of_scope: ['不并发推进后续 child'],
        acceptance: ['当前 child 完成后自动接力下一个 child'],
        known_risks: [],
        execution_strategy: '只放行 current child，后续自动接力。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进当前 child。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    runtime.emit({
      type: 'issue',
      data: createIssueView({
        issue_id: 'issue-child-1',
        identifier: 'INT-2',
        title: 'First child',
        governance_root_issue_id: 'issue-root',
        governance_root_issue_identifier: 'INT-1',
        orchestrator_state: 'failed',
        delivery_state: 'delivery_failed',
        delivery_code: 'review_submit_failed',
        delivery_summary: 'INT-2 已拿到证据，但卡在 review 提交。',
      }),
    });

    const updated = sessions.findById(session.id);
    expect(updated?.state).toBe('awaiting_user_decision');
    expect(updated?.delivery_state).toBe('delivery_failed');
    expect(updated?.delivery_summary).toContain('INT-2 已拿到证据');
    const milestoneEvents = events
      .listBySession(session.id)
      .filter((event) => event.event_kind === 'orchestrator_milestone');
    expect(milestoneEvents.at(-1)?.payload_json?.milestone_kind).toBe('child_failed');
  });

  test('rewrites the plan card and requires reapproval when execution receives a scope-changing user message', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'direct_run',
      approval_mode: 'auto',
      plan_version: 1,
      root_issue_id: 'issue-1',
      plan_card: {
        title: '做设置页面',
        user_goal: '做设置页面',
        in_scope: ['实现设置页面主题保存'],
        out_of_scope: ['不改登录流程'],
        acceptance: ['能在 /settings 保存主题，测试通过'],
        known_risks: [],
        execution_strategy: '保持单目标推进，避免顺手扩大范围。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进当前设置页面任务。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const response = await service.respond({
      context: createContext(),
      text: '顺便把登录页主题也一起改了',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response).not.toBeNull();
    expect(response?.format).toBe('telegram_html');
    expect(response?.message).toContain('计划待你批准 · v2');
    expect(response?.message).toContain('顺便把登录页主题也一起改了');
    const updated = sessions.findById(session.id);
    expect(updated?.state).toBe('awaiting_user_approval');
    expect(updated?.approval_mode).toBe('explicit_reapproval');
    expect(updated?.plan_version).toBe(2);
    expect(updated?.plan_card?.in_scope.join('\n')).toContain('顺便把登录页主题也一起改了');
    expect(events.listBySession(session.id).some((event) => event.event_kind === 'scope_change_detected')).toBe(true);
  });

  test('reapproval of an executing session resumes the existing root thread instead of creating a duplicate issue', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    runtime.issues.set('issue-1', createIssueView({
      issue_id: 'issue-1',
      identifier: 'INT-1',
      title: '做设置页面',
      orchestrator_state: 'dev_running',
    }));
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'direct_run',
      approval_mode: 'explicit_reapproval',
      plan_version: 2,
      root_issue_id: 'issue-1',
      plan_card: {
        title: '做设置页面',
        user_goal: '做设置页面',
        in_scope: ['实现设置页面主题保存', '新增范围候选：顺便把登录页主题也一起改了'],
        out_of_scope: ['不扩大到无关模块'],
        acceptance: ['能在 /settings 保存主题，测试通过'],
        known_risks: ['执行中出现范围变化，需要重新批准后再继续，避免静默漂移。'],
        execution_strategy: '保持单目标推进，避免顺手扩大范围。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '批准第新版计划',
          summary: '确认新增范围后，再继续推进执行线程。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const response = await service.respond({
      context: createContext(),
      text: '按推荐继续',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response).not.toBeNull();
    expect(response?.message).toContain('第 2 版计划已批准');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const updated = sessions.findById(session.id);
    expect(updated?.state).toBe('executing');
    expect(updated?.root_issue_id).toBe('issue-1');
    expect(events.listBySession(session.id).some((event) => event.event_kind === 'plan_revision_approved')).toBe(true);
  });

  test('keeps the root session executing when a child issue completes and records a child-completed milestone', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-root',
      current_child_issue_id: 'issue-child-1',
      plan_card: {
        title: 'Root plan',
        user_goal: 'Root plan',
        in_scope: ['按 child queue 顺序推进'],
        out_of_scope: ['不并发推进后续 child'],
        acceptance: ['所有 child 完成后 root 才算完成'],
        known_risks: [],
        execution_strategy: '只放行 current child，后续自动接力。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进当前 child。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    runtime.emit({
      type: 'issue',
      data: createIssueView({
        issue_id: 'issue-child-1',
        identifier: 'INT-2',
        title: 'First child',
        governance_root_issue_id: 'issue-root',
        governance_root_issue_identifier: 'INT-1',
        orchestrator_state: 'completed',
        delivery_state: 'completed',
        delivery_summary: '第一个 child 已完成。',
      }),
    });

    const updated = sessions.findById(session.id);
    expect(updated?.state).toBe('executing');
    expect(updated?.current_child_issue_id).toBe('issue-child-1');
    const milestoneEvents = events
      .listBySession(session.id)
      .filter((event) => event.event_kind === 'orchestrator_milestone');
    expect(milestoneEvents).toHaveLength(1);
    expect(milestoneEvents[0]?.payload_json?.milestone_kind).toBe('child_completed');
  });

  test('answers plan-scope questions from active session memory while executing', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    runtime.issues.set('issue-root', createIssueView({
      issue_id: 'issue-root',
      identifier: 'INT-1',
      title: '设置体验计划',
      governance_root_issue_id: 'issue-root',
      governance_thread_state: 'waiting_on_child',
      governance_current_child: {
        issue_id: 'issue-child',
        issue_identifier: 'INT-2',
        title: '实现主题保存',
        tracker_state: 'In Progress',
        orchestrator_state: 'dev_running',
        governance_decision: null,
        governance_summary: null,
        queue_state: 'current',
        delivery_state: null,
        delivery_code: null,
        delivery_summary: null,
      },
      governance_child_queue: [],
    }));

    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'direct_run',
      approval_mode: 'auto',
      plan_version: 1,
      root_issue_id: 'issue-root',
      current_child_issue_id: 'issue-child',
      plan_card: {
        title: '设置体验计划',
        user_goal: '让用户能保存主题偏好',
        in_scope: ['实现 /settings 的主题保存'],
        out_of_scope: ['不重做登录页'],
        acceptance: ['刷新页面后主题仍然生效'],
        known_risks: [],
        execution_strategy: '先完成当前 child，再顺序接力。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进 INT-2。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const response = await service.respond({
      context: createContext(),
      text: '这个计划范围是什么，完成算什么？',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response).not.toBeNull();
    expect(response?.format).toBe('telegram_html');
    expect(response?.message).toContain('计划记忆');
    expect(response?.message).toContain('让用户能保存主题偏好');
    expect(response?.message).toContain('/settings 的主题保存');
    expect(response?.message).toContain('刷新页面后主题仍然生效');
    expect(response?.message).toContain('INT-2');
  });

  test('records an execution oversight instruction when a running issue publishes a new milestone', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-oversight',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'direct_run',
      approval_mode: 'auto',
      plan_version: 1,
      root_issue_id: 'issue-root',
      plan_card: {
        title: '新增设置页主题保存',
        user_goal: '让用户能保存主题偏好',
        in_scope: ['实现主题保存并补测试'],
        out_of_scope: ['不重做登录页'],
        acceptance: ['刷新页面后主题仍然生效', '相关测试通过'],
        known_risks: [],
        execution_strategy: '小步实现后跑测试。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '自动执行',
          summary: '继续推进实现。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    runtime.emit({
      type: 'issue',
      data: createIssueView({
        issue_id: 'issue-root',
        identifier: 'INT-1',
        title: '新增设置页主题保存',
        orchestrator_state: 'retry_scheduled',
        delivery_summary: '测试第一次失败，准备重试。',
        governance_root_issue_id: 'issue-root',
        updated_at: '2026-01-01T01:00:00.000Z',
      }),
    });

    const oversightEvents = events
      .listBySession(session.id)
      .filter((event) => event.event_kind === 'supervisor_oversight');
    expect(oversightEvents).toHaveLength(1);
    expect(oversightEvents[0]?.payload_json?.decision).toBe('continue');
    expect(String(oversightEvents[0]?.payload_json?.dev_instruction)).toContain('刷新页面后主题仍然生效');
    expect(sessions.findById(session.id)?.last_material_outcome?.supervisor_decision).toBe('continue');
  });

  test('escalates execution oversight to user approval when delivery fails', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-failure',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'direct_run',
      approval_mode: 'auto',
      plan_version: 1,
      root_issue_id: 'issue-root',
      plan_card: {
        title: '清理仓库残余文件',
        user_goal: '安全清理仓库残余文件',
        in_scope: ['识别并清理无用文件'],
        out_of_scope: ['不删除业务源码'],
        acceptance: ['清理结果可解释', '测试通过'],
        known_risks: ['误删风险较高'],
        execution_strategy: '先识别再清理。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '自动执行',
          summary: '继续推进实现。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    runtime.emit({
      type: 'issue',
      data: createIssueView({
        issue_id: 'issue-root',
        identifier: 'INT-1',
        title: '清理仓库残余文件',
        orchestrator_state: 'failed',
        delivery_state: 'delivery_failed',
        delivery_code: 'dirty_workspace_no_commit',
        delivery_summary: '证据已满足，但交付卡在 dirty workspace，没有可提交代码。',
        governance_root_issue_id: 'issue-root',
        updated_at: '2026-01-01T01:00:00.000Z',
      }),
    });

    const updated = sessions.findById(session.id);
    expect(updated?.state).toBe('awaiting_user_decision');
    expect(updated?.active_decision_kind).toBe('delivery_failure');
    expect(updated?.last_material_outcome?.supervisor_decision).toBe('ask_user');
    const oversightEvents = events
      .listBySession(session.id)
      .filter((event) => event.event_kind === 'supervisor_oversight');
    expect(String(oversightEvents[0]?.payload_json?.user_summary)).toContain('dirty workspace');
  });
});
