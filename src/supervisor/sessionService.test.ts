import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema, SupervisorSessionEventRepository, SupervisorSessionRepository } from '../database';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeStreamEvent } from '../runtime/types';
import type { BotAssistantIntent, BotCommandContext, BotRuntimeCopilotContext } from '../bots/types';
import { SupervisorSessionService, type SupervisorPlanBrain } from './sessionService';
import type { SupervisorExecutionOverseer } from './executionOverseer';

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
  retryIssueCalls: string[];
  stopIssueCalls: string[];
  closeIssueCalls: Array<{ id: string; reason: string | null }>;
  issues: Map<string, RuntimeIssueView>;
  emit: (event: RuntimeStreamEvent) => void;
} {
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  const createIssueCalls: Array<Record<string, unknown>> = [];
  const splitGovernanceCalls: string[] = [];
  const retryIssueCalls: string[] = [];
  const stopIssueCalls: string[] = [];
  const closeIssueCalls: Array<{ id: string; reason: string | null }> = [];
  const issues = new Map<string, RuntimeIssueView>();

  const runtime: RuntimeControlPlane & {
    createIssueCalls: Array<Record<string, unknown>>;
    splitGovernanceCalls: string[];
    retryIssueCalls: string[];
    stopIssueCalls: string[];
    closeIssueCalls: Array<{ id: string; reason: string | null }>;
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
      const sequence = createIssueCalls.length;
      const issueId = `issue-${sequence}`;
      const identifier = `INT-${sequence}`;
      const issue = createIssueView({
        issue_id: issueId,
        work_item_id: `work-item-${sequence}`,
        identifier,
        title: input.title,
        governance_root_issue_id: input.governance_lineage?.root_issue_id ?? issueId,
        governance_parent_issue_id: input.governance_lineage?.parent_issue_id ?? null,
        governance_generation: input.governance_lineage?.generation ?? 0,
        governance_status: 'blocked',
        governance_decision: 'split_before_implement',
        governance_summary: 'This issue spans multiple objectives and should be split before implementation.',
        governance_thread_state: input.governance_lineage ? null : 'blocked',
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
      if (input.governance_lineage?.root_issue_id) {
        const root = issues.get(input.governance_lineage.root_issue_id);
        if (root) {
          const children = [...issues.values()]
            .filter((candidate) => candidate.governance_root_issue_id === root.issue_id && candidate.issue_id !== root.issue_id)
            .map((candidate, index) => ({
              issue_id: candidate.issue_id,
              issue_identifier: candidate.identifier,
              title: candidate.title,
              tracker_state: candidate.tracker_state,
              orchestrator_state: index === 0 ? 'discovering' : 'halted',
              governance_decision: candidate.governance_decision,
              governance_summary: candidate.governance_summary,
              queue_state: index === 0 ? 'current' as const : 'queued' as const,
              delivery_state: candidate.delivery_state,
              delivery_code: candidate.delivery_code,
              delivery_summary: candidate.delivery_summary,
            }));
          issues.set(root.issue_id, {
            ...root,
            governance_thread_state: 'waiting_on_child',
            governance_current_child: children[0] ?? null,
            governance_child_queue: children,
            next_recommended_action: children[0]
              ? `先处理治理子任务 ${children[0].issue_identifier}；其余子任务会按顺序自动接力。`
              : null,
          });
        }
      }
      return {
        accepted: true,
        status: 'accepted',
        message: `Created ${identifier}`,
        issue_id: issue.issue_id,
        issue_identifier: issue.identifier,
        issue,
      };
    },
    stopIssue: async (id: string) => {
      stopIssueCalls.push(id);
      return {
        accepted: true,
        status: 'completed',
        message: `Stopped ${id}`,
        issue_id: id,
        issue_identifier: id,
      };
    },
    retryIssue: async (id: string) => {
      retryIssueCalls.push(id);
      const issue = issues.get(id) ?? [...issues.values()].find((candidate) => candidate.identifier === id) ?? null;
      if (issue) {
        issues.set(issue.issue_id, {
          ...issue,
          orchestrator_state: 'retry_scheduled',
          delivery_state: null,
          delivery_code: null,
          delivery_summary: null,
          next_recommended_action: '正在重试交付恢复。',
        });
      }
      return {
        accepted: true,
        status: 'queued',
        message: `Queued ${issue?.identifier ?? id} for retry`,
        issue_id: issue?.issue_id ?? id,
        issue_identifier: issue?.identifier ?? id,
      };
    },
    closeIssue: async (id: string, request = {}) => {
      closeIssueCalls.push({
        id,
        reason: request.reason ?? null,
      });
      const issue = issues.get(id) ?? [...issues.values()].find((candidate) => candidate.identifier === id) ?? null;
      if (issue) {
        issues.set(issue.issue_id, {
          ...issue,
          tracker_state: 'Canceled',
          orchestrator_state: 'cancelled',
          delivery_state: 'cancelled',
          delivery_code: 'manual_close',
          delivery_summary: '这张单已按用户要求关闭，不会继续自动推进。',
        });
      }
      return {
        accepted: true,
        status: 'completed',
        message: `Closed ${issue?.identifier ?? id}`,
        issue_id: issue?.issue_id ?? id,
        issue_identifier: issue?.identifier ?? id,
      };
    },
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
    retryIssueCalls,
    stopIssueCalls,
    closeIssueCalls,
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
    repo_profile: null,
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
    expect(runtime.createIssueCalls).toHaveLength(3);
    expect(runtime.createIssueCalls[0]?.supervisor_execution_intent).toEqual(expect.objectContaining({
      root_session_id: session!.id,
      repo_ref: 'test2',
      approved_execution_mode: 'root_with_split_queue',
      plan_summary: expect.stringContaining('Refactor runtime API'),
      acceptance_summary: expect.stringContaining('Do all three together'),
    }));
    expect(runtime.splitGovernanceCalls).toEqual([]);
    const updated = sessions.findById(session!.id);
    expect(updated?.state).toBe('executing');
    expect(updated?.root_issue_id).toBe('issue-1');
    expect(updated?.current_child_issue_id).toBe('issue-2');
    const eventKinds = events.listBySession(session!.id).map((event) => event.event_kind);
    expect(eventKinds).toContain('execution_intent_approved');
    expect(eventKinds).toContain('materialized_plan_created');
  });

  test('limits explicit root plus child queue plans to the two user-visible child deliverables', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      plan_card: {
        title: '治理验证：顺序子任务拆分 (Root + Child Queue)',
        user_goal: '创建 docs/supervisor-live-root.md 和 docs/supervisor-live-child.md，验证 root + child queue 机制。',
        in_scope: [
          '创建 docs/supervisor-live-root.md',
          '创建 docs/supervisor-live-child.md',
          '验证子任务排队逻辑',
        ],
        out_of_scope: ['非顺序执行'],
        acceptance: ['Root 文档已创建', 'Child 文档已创建', 'Queue 机制生效，仅当前 Child 运行'],
        known_risks: [],
        execution_strategy: '1. 创建 Root Issue 对应 root.md。 2. 创建 Child Issue 对应 child.md。 3. 验证 child queue。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: { label: '批准并开始', summary: '按顺序创建 Root 和 Child 文档。' },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const response = await service.respond({
      context: createContext(),
      text: '批准并开始',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response).not.toBeNull();
    expect(runtime.createIssueCalls).toHaveLength(3);
    expect(runtime.createIssueCalls[1]?.title).toContain('[SUPERVISOR CHILD 1/2 for INT-1]');
    expect(runtime.createIssueCalls[1]?.title).toContain('docs/supervisor-live-root.md');
    expect(runtime.createIssueCalls[2]?.title).toContain('[SUPERVISOR CHILD 2/2 for INT-1]');
    expect(runtime.createIssueCalls[2]?.title).toContain('docs/supervisor-live-child.md');
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
    expect(response?.message).not.toContain('shadow harness');
    expect(response?.message).not.toContain('.symphony-constitution.md');
    expect(response?.message).not.toContain('runtime 控制面已经积累了待清理债务');
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

  test('renders pending supervisor notifications and latest directives on the executing plan card', async () => {
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
    const session = sessions.findById(response!.session_id!)!;
    const updated = sessions.update({
      id: session.id,
      last_material_outcome: {
        latest_dev_directive_kind: 'request_evidence',
        latest_dev_instruction: '下一轮请先补齐 git status 和验证证据。',
        pending_user_notification_summary: '当前需要补证据后再继续。',
      },
    })!;

    const card = service.renderSessionCard(updated, runtime.getIssue(updated.root_issue_id!));

    expect(card.message).toContain('计划执行中');
    expect(card.message).toContain('监督更新');
    expect(card.message).toContain('当前需要补证据后再继续');
    expect(card.message).toContain('下一轮请先补齐 git status');
    expect(card.material_key).toContain('directive:request_evidence');
  });

  test('keeps executing card material key stable when only supervisor job id changes', async () => {
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
    const session = sessions.findById(response!.session_id!)!;
    const first = sessions.update({
      id: session.id,
      last_material_outcome: {
        latest_dev_directive_kind: 'request_evidence',
        latest_dev_instruction: '下一轮请先补齐 git status 和验证证据。',
        pending_user_notification_job_id: 'job-1',
        pending_user_notification_summary: '当前需要补证据后再继续。',
      },
    })!;
    const second = sessions.update({
      id: session.id,
      last_material_outcome: {
        ...(first.last_material_outcome ?? {}),
        pending_user_notification_job_id: 'job-2',
      },
    })!;

    const firstCard = service.renderSessionCard(first, runtime.getIssue(first.root_issue_id!));
    const secondCard = service.renderSessionCard(second, runtime.getIssue(second.root_issue_id!));

    expect(firstCard.material_key).toBe(secondCard.material_key);
    expect(firstCard.material_key).not.toContain('job-1');
    expect(secondCard.material_key).not.toContain('job-2');
  });

  test('renders a visual Telegram issue card with a stable media key and Mini App action', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const session = sessions.create({
      id: 'session-visual-card',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      plan_card: {
        title: 'Production Ready 计划',
        user_goal: '把这个 repo 做成 production ready',
        in_scope: ['评估 repo 信号', '制定生产就绪计划', '拆成顺序子任务'],
        out_of_scope: ['不做一次性大改'],
        acceptance: ['计划可执行', '验收标准明确'],
        known_risks: ['跨层改动，先锁定验收标准。'],
        execution_strategy: '建议先拆成 3 个顺序子任务，避免一次性大改。',
        needs_user_approval: true,
        repo_ref: 'acme/demo-app',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '先生成 root plan，再顺序 dispatch child。',
        },
        alternate_option: {
          label: '改一下计划',
          summary: '先调整范围或验收标准。',
        },
        governance_preview: null,
      },
    });
    const issue = createIssueView({
      issue_id: 'issue-248',
      identifier: 'INT-248',
      title: 'Production Ready 计划',
      github_repo: 'acme/demo-app',
      tracker_state: 'In Progress',
      orchestrator_state: 'dev_running',
      session: {
        session_id: 'thread-1',
        turn_count: 2,
        stage: 'coding',
        last_event: 'timeline',
        last_message: 'Bash completed',
        started_at: '2026-01-01T00:00:00.000Z',
        last_event_at: '2026-01-01T00:02:00.000Z',
        tokens: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        recent_tools: [],
        recent_files: [],
      },
      governance_child_queue: [
        {
          issue_id: 'issue-child-1',
          issue_identifier: 'INT-249',
          title: '补齐 repo harness',
          tracker_state: 'In Progress',
          orchestrator_state: 'dev_running',
          governance_decision: null,
          governance_summary: null,
          queue_state: 'current',
          delivery_state: null,
          delivery_code: null,
          delivery_summary: null,
        },
      ],
      next_recommended_action: '继续完善 harness，确保测试通过。',
    });

    const firstCard = service.renderSessionCard(session, issue);
    const secondCard = service.renderSessionCard(session, issue);

    expect(firstCard.photo?.content_type).toBe('image/png');
    expect(firstCard.photo?.filename).toBe('INT-248-supervisor-card.png');
    expect(firstCard.photo?.bytes.length).toBeGreaterThan(1000);
    expect(firstCard.media_key).toBe(secondCard.media_key);
    expect(firstCard.media_key).toContain('visual|session');
    expect(firstCard.caption).toContain('INT-248');
    expect(firstCard.action_rows?.flat().map((action) => action.label)).toEqual([
      '批准并开始',
      '改一下计划',
      '打开运行视图',
    ]);
    expect(firstCard.action_rows?.map((row) => row.map((action) => action.label))).toEqual([
      ['批准并开始'],
      ['改一下计划', '打开运行视图'],
    ]);
    expect(firstCard.action_rows?.[1]?.[1]?.web_app?.url).toBe('/runtime/issues/INT-248/app');
  });

  test('changes the root card material key when Mini App live activity changes', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const session = sessions.create({
      id: 'session-live-sync-card',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-144',
      plan_card: {
        title: '删除 docs 文件夹',
        user_goal: '删除 docs 文件夹',
        in_scope: ['删除 docs 文件夹'],
        out_of_scope: ['不删除其他目录'],
        acceptance: ['docs 不存在'],
        known_risks: [],
        execution_strategy: '执行并验证。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '继续',
          summary: '继续执行。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });
    const firstIssue = createIssueView({
      issue_id: 'issue-144',
      identifier: 'INT-144',
      title: '删除 docs 文件夹',
      github_repo: 'UniUni2000/test2',
      orchestrator_state: 'dev_running',
      session: {
        session_id: 'live-1',
        turn_count: 1,
        stage: 'coding',
        last_event: 'tool_started',
        last_message: '正在读取文件结构。',
        started_at: '2026-01-01T00:00:00.000Z',
        last_event_at: '2026-01-01T00:01:00.000Z',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        recent_tools: [
          {
            tool_name: 'Bash',
            status: 'started',
            message: 'find docs -maxdepth 2 -type f',
            summary: null,
            path: null,
            timestamp: '2026-01-01T00:01:00.000Z',
          },
        ],
        recent_files: [],
      },
    });
    const secondIssue = createIssueView({
      ...firstIssue,
      session: {
        ...firstIssue.session!,
        last_message: '正在删除 docs 目录并验证。',
        last_event_at: '2026-01-01T00:02:00.000Z',
        recent_tools: [
          ...firstIssue.session!.recent_tools,
          {
            tool_name: 'Bash',
            status: 'completed',
            message: 'rm -rf docs && git status --short',
            summary: null,
            path: null,
            timestamp: '2026-01-01T00:02:00.000Z',
          },
        ],
        recent_files: [
          {
            path: '/Users/liupenghui/Documents/code/agent/test-cc/worktrees/int-144/docs',
            operation: 'edit',
            status: 'completed',
            timestamp: '2026-01-01T00:02:00.000Z',
          },
        ],
      },
    });

    const firstCard = service.renderSessionCard(session, firstIssue);
    const secondCard = service.renderSessionCard(session, secondIssue);

    expect(firstCard.material_key).not.toBe(secondCard.material_key);
    expect(firstCard.media_key).not.toBe(secondCard.media_key);
    expect(secondCard.material_key).toContain('tool:Bash:completed');
    expect(secondCard.material_key).toContain('file:edit:completed');
  });

  test('keeps the full Telegram action panel on executing cards and targets the root issue cockpit', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const session = sessions.create({
      id: 'session-running-card',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-143',
      plan_card: {
        title: 'E2E 删除 docs 文件夹',
        user_goal: '删除 docs 文件夹',
        in_scope: ['删除 docs 文件夹', '验证路径不存在'],
        out_of_scope: [],
        acceptance: ['docs 不存在', '测试通过'],
        known_risks: [],
        execution_strategy: '执行并验证。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '批准并开始',
          summary: '继续执行。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });
    const issue = createIssueView({
      issue_id: 'issue-143',
      identifier: 'INT-143',
      title: 'E2E 删除 docs 文件夹',
      github_repo: 'UniUni2000/test2',
      orchestrator_state: 'dev_running',
    });

    const card = service.renderSessionCard(session, issue);

    expect(card.action_rows?.map((row) => row.map((action) => action.label))).toEqual([
      ['已批准开始'],
      ['改一下计划', '打开运行视图'],
    ]);
    expect(card.action_rows?.[0]?.[0]?.callback_data).toBe(`sup|${session.id}|focus`);
    expect(card.action_rows?.[1]?.[0]?.callback_data).toBe(`sup|${session.id}|edit`);
    expect(card.action_rows?.[1]?.[1]?.web_app?.url).toBe('/runtime/issues/INT-143/app');
  });

  test('collapses completed Telegram cards to completion status and runtime view only', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const session = sessions.create({
      id: 'session-completed-card',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'completed',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-155',
      plan_card: {
        title: '清空仓库内容，仅保留空 README',
        user_goal: '清空仓库内容，仅保留空 README',
        in_scope: ['清空仓库内容', '保留 README'],
        out_of_scope: [],
        acceptance: ['仓库根目录仅保留 README.md'],
        known_risks: [],
        execution_strategy: '执行并验证。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: null,
        alternate_option: null,
        governance_preview: null,
      },
    });
    const issue = createIssueView({
      issue_id: 'issue-155',
      identifier: 'INT-155',
      title: '清空仓库内容，仅保留空 README',
      github_repo: 'UniUni2000/test2',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      delivery_summary: '已清空仓库，仅保留 README。',
    });

    const card = service.renderSessionCard(session, issue);

    expect(card.action_rows?.map((row) => row.map((action) => action.label))).toEqual([
      ['已完成', '打开运行视图'],
    ]);
    expect(card.action_rows?.flat().map((action) => action.label)).not.toContain('已批准开始');
    expect(card.action_rows?.flat().map((action) => action.label)).not.toContain('改一下计划');
    expect(card.action_rows?.[0]?.[0]?.callback_data).toBe(`sup|${session.id}|focus`);
    expect(card.action_rows?.[0]?.[1]?.web_app?.url).toBe('/runtime/issues/INT-155/app');
  });

  test('renders delivery decision callback replies as the same visual Telegram card', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const issue = createIssueView({
      issue_id: 'issue-149',
      identifier: 'INT-149',
      title: '清空当前仓库（安全清理计划）',
      github_repo: 'UniUni2000/test2',
      orchestrator_state: 'failed',
      delivery_state: 'delivery_failed',
      delivery_summary: '证据已满足，但交付卡在 Command failed with code 1。',
      next_recommended_action: null,
    });
    runtime.issues.set(issue.issue_id, issue);
    const session = sessions.create({
      id: 'session-delivery-decision-card',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_decision',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: issue.issue_id,
      active_decision_kind: 'delivery_failure',
      delivery_state: 'delivery_failed',
      delivery_summary: issue.delivery_summary,
      last_material_outcome: {
        pending_user_notification_summary: issue.delivery_summary,
        milestone_kind: 'delivery_failed',
        supervisor_decision: 'ask_user',
      },
      plan_card: {
        title: '清空当前仓库（安全清理计划）',
        user_goal: '清空当前仓库',
        in_scope: ['确认清理边界', '执行清理操作并提交变更'],
        out_of_scope: ['不删除 GitHub 仓库本身'],
        acceptance: ['清理范围已确认', '提供变更证明'],
        known_risks: ['误删有效文件风险高'],
        execution_strategy: '先确认范围，再执行清理。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '批准并开始',
          summary: '按受控清理计划执行。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const response = await service.respondToAction({
      context: createContext(),
      sessionId: session.id,
      action: 'focus',
      canWrite: true,
      runtimeContext: createRuntimeContext(),
    });

    expect(response.format).toBe('telegram_html');
    expect(response.photo?.content_type).toBe('image/png');
    expect(response.media_key).toContain('visual|session');
    expect(response.caption).toContain('需要决策');
    expect(response.action_rows?.flat().map((action) => action.label)).toEqual([
      '修复交付并重试',
      '改一下计划',
      '打开运行视图',
    ]);
  });

  test('continues a delivery failure by retrying the root issue instead of leaving the user stuck', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const issue = createIssueView({
      issue_id: 'issue-delivery-retry',
      identifier: 'INT-155',
      title: '清空仓库内容，仅保留空 README',
      orchestrator_state: 'failed',
      delivery_state: 'delivery_failed',
      delivery_code: 'dirty_workspace_no_commit',
      delivery_summary: 'Failed to remove workflow artifacts from branch feature/int-155: Symphony workflow artifacts must not be committed: DEVELOPMENT_LOG.md HANDOVER.md REVIEW_REPORT.md',
      actions: {
        can_stop: false,
        can_retry: true,
        can_open_pr: false,
      },
    });
    runtime.issues.set(issue.issue_id, issue);

    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-delivery-retry',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_decision',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: issue.issue_id,
      active_decision_kind: 'delivery_failure',
      delivery_state: 'delivery_failed',
      delivery_summary: issue.delivery_summary,
      plan_card: {
        title: '清空仓库内容，仅保留空 README',
        user_goal: '清空仓库内容，仅保留空 README',
        in_scope: ['清空仓库内容', '保留空 README'],
        out_of_scope: ['不提交工作流产物'],
        acceptance: ['仓库仅保留 README', 'PR 可提交'],
        known_risks: ['清理动作不可逆'],
        execution_strategy: '先清理，再提交 PR。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '批准并开始',
          summary: '执行清理并交付。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const response = await service.respondToAction({
      context: createContext(),
      sessionId: session.id,
      action: 'approve',
      canWrite: true,
      runtimeContext: createRuntimeContext(),
    });

    expect(runtime.retryIssueCalls).toEqual([issue.issue_id]);
    expect(sessions.findById(session.id)?.state).toBe('executing');
    expect(sessions.findById(session.id)?.active_decision_kind).toBeNull();
    expect(response.caption).toContain('执行中');
    expect(response.action_rows?.[0]?.[0]?.label).toBe('已批准开始');
  });

  test('keeps lifecycle steps inside one issue instead of splitting delete PR and review into child issues', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const planBrain: SupervisorPlanBrain = {
      refinePlan: async () => ({
        state: 'awaiting_user_approval',
        approvalMode: 'explicit_user_approval',
        planCard: {
          title: '删除 docs 文件夹并创建 PR',
          user_goal: '删除 docs 文件夹',
          in_scope: ['删除 docs 目录', '创建 PR', 'Review/Delivery'],
          out_of_scope: ['不改其他文件'],
          acceptance: ['docs 不存在', 'PR 已创建', 'review 通过'],
          execution_strategy: '先删除 docs，再创建 PR，最后 review/delivery。',
          needs_user_approval: true,
          repo_ref: 'UniUni2000/test2',
          project_slug: 'test2',
          materialization_mode: 'root_with_split_queue',
          recommended_option: {
            label: '批准并开始',
            summary: '按单 issue 执行删除、验证、PR 和 review。',
          },
        },
      }),
    };
    const service = new SupervisorSessionService(
      runtime,
      createProjectResolver(),
      sessions,
      events,
      null,
      planBrain,
    );

    const first = await service.respond({
      context: createContext(),
      text: '请在 UniUni2000/test2 删除 docs 文件夹，并创建 PR 完成 review/delivery。',
      intent: {
        kind: 'create_issue',
        title: '删除 docs 文件夹并创建 PR',
        description: '只删除 docs 目录，不动其他文件；完成后创建 PR 并 review。',
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    const session = first?.session_id ? sessions.findById(first.session_id) : null;
    expect(session?.plan_card?.materialization_mode).toBe('root_only');

    const approved = await service.respond({
      context: createContext(),
      text: '批准并开始',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(approved).not.toBeNull();
    expect(runtime.createIssueCalls).toHaveLength(1);
    expect(runtime.createIssueCalls[0]?.defer_dispatch).toBe(false);
    expect(runtime.createIssueCalls[0]?.supervisor_execution_intent).toEqual(expect.objectContaining({
      approved_execution_mode: 'root_only',
    }));
  });

  test('keeps focused repository cleanup as one root issue even when the planning brain asks for child queue', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const planBrain: SupervisorPlanBrain = {
      refinePlan: async () => ({
        state: 'awaiting_user_approval',
        approvalMode: 'explicit_user_approval',
        planCard: {
          title: '清空仓库，只保留 README',
          user_goal: '清空这个仓库，只保留一个空的 README 即可',
          in_scope: [
            '确认清理边界，只保留 .git 历史和一个空 README',
            '生成待清理文件/目录清单',
            '执行清理操作并提交变更',
            '提供 git diff 和文件列表证明',
          ],
          out_of_scope: ['不删除 GitHub 仓库本身', '不改写历史提交'],
          acceptance: [
            '仓库工作区只剩一个空 README 文件',
            'git diff / 文件列表能证明清理结果',
          ],
          execution_strategy: '误判为需要拆成 4 个顺序子任务：先建 issue、再清理、再提交、最后 review/delivery。',
          needs_user_approval: true,
          repo_ref: 'UniUni2000/test2',
          project_slug: 'test2',
          materialization_mode: 'root_with_split_queue',
          recommended_option: {
            label: '批准并开始',
            summary: '按一张单执行清理、验证和交付。',
          },
        },
      }),
    };
    const service = new SupervisorSessionService(
      runtime,
      createProjectResolver(),
      sessions,
      events,
      null,
      planBrain,
    );

    const first = await service.respond({
      context: createContext(),
      text: '帮我建立 issue：清空这个仓库，只保留一个空的 README 即可',
      intent: {
        kind: 'create_issue',
        title: '清空这个仓库，只保留一个空的 README 即可',
        description: '目标仓库 UniUni2000/test2，只保留一个空 README。',
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    const session = first?.session_id ? sessions.findById(first.session_id) : null;
    expect(session?.plan_card?.materialization_mode).toBe('root_only');

    const approved = await service.respond({
      context: createContext(),
      text: '批准并开始',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(approved).not.toBeNull();
    expect(runtime.createIssueCalls).toHaveLength(1);
    expect(runtime.createIssueCalls[0]?.title).not.toContain('[SUPERVISOR CHILD');
    expect(runtime.createIssueCalls[0]?.defer_dispatch).toBe(false);
    expect(runtime.createIssueCalls[0]?.supervisor_execution_intent).toEqual(expect.objectContaining({
      approved_execution_mode: 'root_only',
    }));
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

  test('does not let the planning brain downgrade an explicit Plan Card request to auto execution', async () => {
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
      null,
      {
        refinePlan: async () => ({
          intakeMode: 'direct_run',
          approvalMode: 'auto',
          state: 'plan_ready',
          rationale: 'small task',
          planCard: {
            title: '新增 supervisor live smoke 文档',
            user_goal: '新增 supervisor live smoke 文档',
            in_scope: ['新增文档'],
            out_of_scope: [],
            acceptance: ['文档存在'],
            known_risks: [],
            execution_strategy: '直接执行。',
            needs_user_approval: false,
            repo_ref: 'UniUni2000/test2',
            project_slug: 'test2',
            clarification_question: null,
            materialization_mode: 'root_only',
            recommended_option: { label: '自动执行', summary: '直接执行。' },
            alternate_option: null,
            governance_preview: null,
          },
        }),
      },
    );

    const response = await service.respond({
      context: createContext(),
      text: '新开线程 请新增 supervisor live smoke 文档。请先给 Plan Card，不要直接建单。',
      intent: {
        kind: 'create_issue',
        title: '请新增 supervisor live smoke 文档。请先给 Plan Card，不要直接建单。',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response?.message).toContain('计划待你批准');
    expect(response?.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(runtime.createIssueCalls).toHaveLength(0);
    expect(sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })?.approval_mode).toBe('explicit_user_approval');
  });

  test('does not let the planning brain downgrade an explicit split queue request to root-only materialization', async () => {
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
      null,
      {
        refinePlan: async () => ({
          intakeMode: 'direct_run',
          approvalMode: 'auto',
          state: 'plan_ready',
          rationale: 'mistakenly treats this as one task',
          planCard: {
            title: '顺序子任务验证',
            user_goal: '顺序子任务验证',
            in_scope: ['创建两个文件'],
            out_of_scope: [],
            acceptance: ['两个文件都存在'],
            known_risks: [],
            execution_strategy: '直接做。',
            needs_user_approval: false,
            repo_ref: 'UniUni2000/test2',
            project_slug: 'test2',
            clarification_question: null,
            materialization_mode: 'root_only',
            recommended_option: { label: '自动执行', summary: '直接执行。' },
            alternate_option: null,
            governance_preview: null,
          },
        }),
      },
    );

    const response = await service.respond({
      context: createContext(),
      text: '新开线程 请规划一个需要拆成两个顺序子任务的治理验证，要求使用 root + child queue，只放行当前 child。请先给 Plan Card。',
      intent: {
        kind: 'create_issue',
        title: '请规划一个需要拆成两个顺序子任务的治理验证，要求使用 root + child queue，只放行当前 child。',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response?.message).toContain('计划待你批准');
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.plan_card?.materialization_mode).toBe('root_with_split_queue');
    expect(session?.approval_mode).toBe('explicit_user_approval');
  });

  test('does not let the planning brain upgrade an explicit root-only verifier request to split queue materialization', async () => {
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
      null,
      {
        refinePlan: async () => ({
          intakeMode: 'plan_then_approve',
          approvalMode: 'explicit_user_approval',
          state: 'awaiting_user_approval',
          rationale: 'mistakenly expands a verifier into a queue',
          planCard: {
            title: '破坏性清理审批验证',
            user_goal: '破坏性清理审批验证',
            in_scope: ['扫描仓库残余', '创建验证标记文件'],
            out_of_scope: [],
            acceptance: ['标记文件存在'],
            known_risks: ['清理可能误删文件'],
            execution_strategy: '拆成 root + child queue。',
            needs_user_approval: true,
            repo_ref: 'UniUni2000/test2',
            project_slug: 'test2',
            clarification_question: null,
            materialization_mode: 'root_with_split_queue',
            recommended_option: { label: '批准并开始', summary: '创建 root 和 child queue。' },
            alternate_option: null,
            governance_preview: null,
          },
        }),
      },
    );

    const response = await service.respond({
      context: createContext(),
      text: [
        '新开线程 supervisor live E2E test2',
        '请验证破坏性清理审批：不要拆分，不要创建 child queue，只创建一张 root-only 单。',
        '不要扫描全仓，只创建 docs/supervisor-live-cleanup-approval-verifier.md。',
        '请先给 Plan Card，不要直接建单。',
      ].join(' '),
      intent: {
        kind: 'create_issue',
        title: '请验证破坏性清理审批：不要拆分，不要创建 child queue，只创建一张 root-only 单。',
        description: '不要扫描全仓，只创建 docs/supervisor-live-cleanup-approval-verifier.md。',
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response?.message).toContain('计划待你批准');
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.plan_card?.materialization_mode).toBe('root_only');
    expect(session?.approval_mode).toBe('explicit_user_approval');
    expect(runtime.createIssueCalls).toHaveLength(0);
  });

  test('strips Telegram supervisor control phrases before materializing the issue title', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const context = createContext();

    const first = await service.respond({
      context,
      text: '新开线程 supervisor live E2E test2 请新建一条很小的验证任务：创建 docs/supervisor-live-smoke.md，写一句 supervisor live e2e passed。 请先给 Plan Card，不要直接建单。 nonce smoke-123',
      intent: {
        kind: 'create_issue',
        title: 'supervisor live E2E test2 请新建一条很小的验证任务：创建 docs/supervisor-live-smoke.md，写一句 supervisor live e2e passed。 请先给 Plan Card，不要直接建单。 nonce smoke-123',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(first?.message).toContain('计划待你批准');
    expect(first?.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(runtime.createIssueCalls).toHaveLength(0);

    await service.respond({
      context,
      text: '批准并开始',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(runtime.createIssueCalls[0]?.title).toBe('创建 docs/supervisor-live-smoke.md，写一句 supervisor live e2e passed');
    expect(String(runtime.createIssueCalls[0]?.description)).not.toContain('Plan Card');
    expect(String(runtime.createIssueCalls[0]?.description)).not.toContain('nonce');
  });

  test('keeps a focused English approval-gated smoke request root-only even when it contains and', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const context = createContext();
    const request = [
      'new thread live smoke:',
      'please show a Plan Card first and do not create an issue before approval.',
      'After approval create docs/supervisor-live-smoke-20260427-1305.md with text supervisor live smoke passed.',
    ].join(' ');

    const first = await service.respond({
      context,
      text: request,
      intent: {
        kind: 'create_issue',
        title: request,
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(first?.message).toContain('Plan awaiting approval');
    expect(first?.message).toContain('Scope');
    expect(first?.message).not.toContain('计划待你批准');
    expect(first?.message).not.toMatch(/[\u3400-\u9fff\uf900-\ufaff]/);
    expect(first?.action_rows?.flat().map((action) => action.label)).toEqual([
      'Approve and Start',
      'Edit Plan',
      'Open Runtime View',
    ]);
    expect(runtime.createIssueCalls).toHaveLength(0);
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.plan_card?.materialization_mode).toBe('root_only');
    expect(session?.supervisor_locale).toBe('en');

    await service.respond({
      context,
      text: '批准并开始',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(runtime.createIssueCalls).toHaveLength(1);
    expect(runtime.createIssueCalls[0]?.supervisor_locale).toBe('en');
    expect(runtime.createIssueCalls[0]?.governance_lineage).toBeUndefined();
    expect(runtime.createIssueCalls[0]?.title).toContain('docs/supervisor-live-smoke-20260427-1305.md');
  });

  test('materializes destructive live verifier requests with a concise issue title', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const context = createContext();

    await service.respond({
      context,
      text: [
        '新开线程 supervisor live E2E test2',
        '请验证破坏性清理审批：这是一条 root-only 单，不要拆分，不要创建 child queue，不要创建子任务。',
        '不要扫描全仓；批准后只创建这个可提交的验证标记文件：docs/supervisor-live-cleanup-approval-smoke.md。',
        '请先给 Plan Card，不要直接建单。',
        'nonce destructive-smoke',
      ].join(' '),
      intent: {
        kind: 'create_issue',
        title: [
          'supervisor live E2E test2',
          '请验证破坏性清理审批：这是一条 root-only 单，不要拆分，不要创建 child queue，不要创建子任务。',
          '不要扫描全仓；批准后只创建这个可提交的验证标记文件：docs/supervisor-live-cleanup-approval-smoke.md。',
          '请先给 Plan Card，不要直接建单。',
          'nonce destructive-smoke',
        ].join(' '),
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    await service.respond({
      context,
      text: '批准并开始',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(runtime.createIssueCalls[0]?.title).toBe('验证破坏性清理审批 marker');
    expect(String(runtime.createIssueCalls[0]?.description)).toContain('docs/supervisor-live-cleanup-approval-smoke.md');
    expect(String(runtime.createIssueCalls[0]?.description)).not.toContain('nonce');
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

    const session = sessions.create({
      id: 'session-clarify-answer',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'clarifying',
      repo_ref: 'test2',
      intake_mode: 'clarify_then_plan',
      approval_mode: 'auto',
      plan_version: 1,
      plan_card: {
        title: '改善用户体验',
        user_goal: '改善用户体验',
        in_scope: ['改善用户体验'],
        out_of_scope: [],
        acceptance: ['结果可验证。'],
        known_risks: ['当前验收条件还不够稳，需要先补清楚。'],
        execution_strategy: '保持单目标推进，避免顺手扩大范围。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: '这条需求完成以后，你最想看到的可验证结果是什么？',
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '按这张精简计划直接开跑。',
        },
        alternate_option: {
          label: '改一下计划',
          summary: '如果你不想按推荐路径走，我可以先把计划重写得更合适。',
        },
        governance_preview: null,
      },
    });

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
    const updated = sessions.findById(session.id);
    expect(updated?.plan_card?.acceptance.join('\n')).toContain('/settings 页面保存主题');
    expect(events.listBySession(session.id).some((event) => event.event_kind === 'clarification_answer_recorded')).toBe(true);
  });

  test('treats "你自己决定吧" as authorization to fill a default acceptance target and show a recommendation-first approval card for Telegram chat', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const context = createContext();

    const session = sessions.create({
      id: 'session-clarify-defaults',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'clarifying',
      repo_ref: 'test2',
      intake_mode: 'clarify_then_plan',
      approval_mode: 'auto',
      plan_version: 1,
      plan_card: {
        title: '改善用户体验',
        user_goal: '改善用户体验',
        in_scope: ['改善用户体验'],
        out_of_scope: [],
        acceptance: ['结果可验证。'],
        known_risks: ['当前验收条件还不够稳，需要先补清楚。'],
        execution_strategy: '保持单目标推进，避免顺手扩大范围。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: '这条需求完成以后，你最想看到的可验证结果是什么？',
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '按这张精简计划直接开跑。',
        },
        alternate_option: {
          label: '改一下计划',
          summary: '如果你不想按推荐路径走，我可以先把计划重写得更合适。',
        },
        governance_preview: null,
      },
    });

    const second = await service.respond({
      context,
      text: '你自己决定吧',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
      source: 'telegram_chat',
    });

    expect(second).not.toBeNull();
    expect(second?.format).toBe('telegram_html');
    expect(second?.message).not.toContain('一起补计划');
    expect(second?.action_rows?.flat().map((action) => action.callback_data ?? null)).toEqual(expect.arrayContaining([
      expect.stringContaining('|approve'),
    ]));
    expect(runtime.createIssueCalls).toHaveLength(0);
    const updated = sessions.findById(session.id);
    expect(updated?.state).toBe('awaiting_user_approval');
    expect(updated?.active_decision_kind).toBe('plan_approval');
    expect(updated?.plan_card?.clarification_question).toBeNull();
    expect(updated?.plan_card?.acceptance.join('\n')).toContain('给出至少一个可直接验证的用户结果');
    expect(events.listBySession(session.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_kind: 'clarification_answer_recorded',
        payload_json: expect.objectContaining({
          delegated_default_used: true,
        }),
      }),
    ]));
  });

  test('treats "别再问我" as authorization to fill sensible defaults for Telegram chat instead of looping another clarification', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const session = sessions.create({
      id: 'session-clarify-stop-asking',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'clarifying',
      repo_ref: 'test2',
      intake_mode: 'clarify_then_plan',
      approval_mode: 'auto',
      plan_version: 1,
      plan_card: {
        title: '改善用户体验',
        user_goal: '改善用户体验',
        in_scope: ['改善用户体验'],
        out_of_scope: [],
        acceptance: ['结果可验证。'],
        known_risks: ['当前验收条件还不够稳，需要先补清楚。'],
        execution_strategy: '保持单目标推进，避免顺手扩大范围。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: '这条需求完成以后，你最想看到的可验证结果是什么？',
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '按这张精简计划直接开跑。',
        },
        alternate_option: {
          label: '改一下计划',
          summary: '如果你不想按推荐路径走，我可以先把计划重写得更合适。',
        },
        governance_preview: null,
      },
    });

    const response = await service.respond({
      context: createContext(),
      text: '别再问我',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
      source: 'telegram_chat',
    });

    expect(response).not.toBeNull();
    expect(response?.format).toBe('telegram_html');
    expect(response?.message).not.toContain('一起补计划');
    expect(response?.message).not.toContain('最想看到的可验证结果是什么');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const updated = sessions.findById(session.id);
    expect(updated?.state).toBe('awaiting_user_approval');
    expect(updated?.plan_card?.clarification_question).toBeNull();
    expect(updated?.plan_card?.acceptance.join('\n')).toContain('给出至少一个可直接验证的用户结果');
  });

  test('treats "随便" as authorization to fill sensible defaults for Telegram chat instead of looping another clarification', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const session = sessions.create({
      id: 'session-clarify-whatever',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'clarifying',
      repo_ref: 'test2',
      intake_mode: 'clarify_then_plan',
      approval_mode: 'auto',
      plan_version: 1,
      plan_card: {
        title: '改善用户体验',
        user_goal: '改善用户体验',
        in_scope: ['改善用户体验'],
        out_of_scope: [],
        acceptance: ['结果可验证。'],
        known_risks: ['当前验收条件还不够稳，需要先补清楚。'],
        execution_strategy: '保持单目标推进，避免顺手扩大范围。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: '这条需求完成以后，你最想看到的可验证结果是什么？',
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '按这张精简计划直接开跑。',
        },
        alternate_option: {
          label: '改一下计划',
          summary: '如果你不想按推荐路径走，我可以先把计划重写得更合适。',
        },
        governance_preview: null,
      },
    });

    const response = await service.respond({
      context: createContext(),
      text: '随便',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
      source: 'telegram_chat',
    });

    expect(response).not.toBeNull();
    expect(response?.format).toBe('telegram_html');
    expect(response?.message).not.toContain('一起补计划');
    expect(response?.message).not.toContain('最想看到的可验证结果是什么');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const updated = sessions.findById(session.id);
    expect(updated?.state).toBe('awaiting_user_approval');
    expect(updated?.plan_card?.clarification_question).toBeNull();
    expect(updated?.plan_card?.acceptance.join('\n')).toContain('给出至少一个可直接验证的用户结果');
  });

  test('answers ordinary supervisor-facing Telegram questions without creating a session', async () => {
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

    expect(response).toEqual({
      message: '当前活跃 issue：INT-31 · Hello world',
    });
    expect(sessions.findAll()).toHaveLength(0);
  });

  test('returns conversational clarification prompts directly for Telegram when no session exists', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const response = await service.respond({
      context: createContext(),
      text: '你说得再具体一点？',
      intent: {
        kind: 'clarify',
        question: '你更想优化建单入口，还是推荐卡的展示方式？',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
      source: 'telegram_chat',
    });

    expect(response).toEqual({
      message: '你更想优化建单入口，还是推荐卡的展示方式？',
    });
    expect(sessions.findAll()).toHaveLength(0);
  });

  test('renders a recommendation-first issue card for a low-risk conversational create-issue request', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const response = await service.respond({
      context: createContext(),
      text: '创建 Issue：计算不同质量恒星的光度等参数随 M 的变化',
      intent: {
        kind: 'create_issue',
        title: '创建 Issue：计算不同质量恒星的光度等参数随 M 的变化',
        description: '主要包含理论公式/标度律总结，还需要附带一段可运行的 Python 计算脚本或绘图代码',
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
      source: 'telegram_chat',
    });

    expect(response).not.toBeNull();
    expect(response?.format).toBe('telegram_html');
    expect(response?.message).not.toContain('一起补计划');
    expect(response?.action_rows?.length).toBeGreaterThan(0);
    expect(response?.action_rows?.flat().map((action) => action.callback_data ?? null)).toEqual(expect.arrayContaining([
      expect.stringContaining('|approve'),
    ]));
    expect(runtime.createIssueCalls).toHaveLength(0);
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('awaiting_user_approval');
    expect(session?.active_decision_kind).toBe('plan_approval');
    expect(session?.plan_card?.clarification_question).toBeNull();
    expect(session?.plan_card?.title).toBe('分析不同质量恒星的光度等参数随质量 M 的变化');
    expect(session?.plan_card?.acceptance.join('\n')).toContain('标明采用的主要标度律、假设条件或适用质量范围');
  });

  test('drafts repo-aware acceptance and advisor-style recommendation copy for conversational supervisor product requests', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);

    const response = await service.respond({
      context: createContext(),
      text: '我希望 supervisor 能像人一样理解需求，然后帮我建一个更像样的 issue',
      intent: {
        kind: 'create_issue',
        title: '创建 Issue：让 supervisor 自然语言建单',
        description: '用户普通聊天时，先给推荐 issue 卡，再等用户点头',
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
      source: 'telegram_chat',
    });

    expect(response).not.toBeNull();
    expect(response?.format).toBe('telegram_html');
    expect(response?.message).toContain('计划待你批准');
    expect(response?.message).toContain('Telegram');
    expect(response?.message).toContain('slash');
    expect(response?.message).not.toContain('按这张精简计划直接开跑');
    expect(runtime.createIssueCalls).toHaveLength(0);

    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.plan_card?.title).toBe('让 supervisor 自然语言建单');
    expect(session?.plan_card?.acceptance).toEqual(expect.arrayContaining([
      expect.stringContaining('Telegram'),
      expect.stringContaining('推荐 issue 卡'),
      expect.stringContaining('slash 命令'),
    ]));
    expect(session?.plan_card?.recommended_option.summary).toContain('Telegram');
    expect(session?.plan_card?.recommended_option.summary).toContain('slash');
  });

  test('does not repeat a stale typo clarification once the user provides a concrete cleanup target', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    let refineCount = 0;
    const planBrain: SupervisorPlanBrain = {
      refinePlan: async () => {
        refineCount += 1;
        return {
          state: 'clarifying',
          approvalMode: 'auto',
          planCard: {
            title: '明确并安全清理目标',
            user_goal: '创建 Issue：明确并安全清理目标',
            in_scope: ['创建 Issue：明确并安全清理目标'],
            out_of_scope: ['在确认具体目标前，不启动真正执行。'],
            acceptance: ['用户确认要清理的具体对象。'],
            known_risks: ['清理目标不明确。'],
            execution_strategy: '先确认清理目标，再生成安全计划。',
            clarification_question: '‘档裤’是否为笔误？您实际想清空的是当前代码、数据库、缓存、分支还是其他内容？',
            materialization_mode: 'root_only',
            recommended_option: {
              label: '补充目标',
              summary: '先确认清理目标。',
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
      null,
      planBrain,
    );
    const context = createContext();

    const first = await service.respond({
      context,
      text: '帮我建立一个 issue：清空当前档裤',
      intent: {
        kind: 'create_issue',
        title: '清空当前档裤',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(first).not.toBeNull();
    expect(first?.message).toContain('档裤');
    const session = sessions.findActiveByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(session?.state).toBe('clarifying');

    const second = await service.respond({
      context,
      text: '清空当前仓库',
      intent: {
        kind: 'create_issue',
        title: '清空当前仓库',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(refineCount).toBe(2);
    expect(second).not.toBeNull();
    expect(second?.message).not.toContain('当前会话已经有一条活跃计划线程');
    expect(second?.message).not.toContain('档裤');
    expect(second?.message).toContain('计划待你批准');
    expect(second?.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(runtime.createIssueCalls).toHaveLength(0);
    const updated = sessions.findById(session!.id);
    expect(updated?.state).toBe('awaiting_user_approval');
    expect(updated?.plan_card?.clarification_question).toBeNull();
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
    expect(runtime.createIssueCalls).toHaveLength(3);
    expect(runtime.splitGovernanceCalls).toEqual([]);
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

  test('keeps the root session executing when children complete before the root issue is finalized', async () => {
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
      current_child_issue_id: 'issue-child-2',
      plan_card: {
        title: 'Root plus child queue',
        user_goal: 'Root plus child queue',
        in_scope: ['完成 root child', '完成 second child'],
        out_of_scope: [],
        acceptance: ['所有 child 完成后 root 线程完成'],
        known_risks: [],
        execution_strategy: '只放行 current child，完成后自动接力。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: { label: '按推荐继续', summary: '继续推进。' },
        alternate_option: null,
        governance_preview: null,
      },
    });

    runtime.emit({
      type: 'issue',
      data: createIssueView({
        issue_id: 'issue-root',
        identifier: 'INT-1',
        title: 'Root plus child queue',
        governance_root_issue_id: 'issue-root',
        governance_root_issue_identifier: 'INT-1',
        governance_thread_state: 'waiting_on_child',
        governance_current_child: null,
        governance_child_queue: [
          {
            issue_id: 'issue-child-1',
            issue_identifier: 'INT-2',
            title: 'First child',
            tracker_state: 'Done',
            orchestrator_state: 'completed',
            governance_decision: null,
            governance_summary: null,
            queue_state: 'completed',
            delivery_state: 'completed',
            delivery_code: null,
            delivery_summary: 'First child completed.',
          },
          {
            issue_id: 'issue-child-2',
            issue_identifier: 'INT-3',
            title: 'Second child',
            tracker_state: 'Done',
            orchestrator_state: 'completed',
            governance_decision: null,
            governance_summary: null,
            queue_state: 'completed',
            delivery_state: 'completed',
            delivery_code: null,
            delivery_summary: 'Second child completed.',
          },
        ],
        next_recommended_action: '等待根治理线程重新评估。',
      }),
    });

    expect(sessions.findById(session.id)?.state).toBe('executing');
    const milestoneEvents = events
      .listBySession(session.id)
      .filter((event) => event.event_kind === 'orchestrator_milestone');
    expect(milestoneEvents.at(-1)?.payload_json?.milestone_kind).toBe('waiting_on_child');
  });

  test('marks the root session completed after queued children and root delivery are finalized', async () => {
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
      current_child_issue_id: 'issue-child-2',
      plan_card: {
        title: 'Root plus child queue',
        user_goal: 'Root plus child queue',
        in_scope: ['完成 root child', '完成 second child'],
        out_of_scope: [],
        acceptance: ['所有 child 完成后 root 线程完成'],
        known_risks: [],
        execution_strategy: '只放行 current child，完成后自动接力。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: { label: '按推荐继续', summary: '继续推进。' },
        alternate_option: null,
        governance_preview: null,
      },
    });

    runtime.emit({
      type: 'issue',
      data: createIssueView({
        issue_id: 'issue-root',
        identifier: 'INT-1',
        title: 'Root plus child queue',
        orchestrator_state: 'completed',
        delivery_state: 'completed',
        delivery_summary: 'Root thread finalized after children completed.',
        governance_root_issue_id: 'issue-root',
        governance_root_issue_identifier: 'INT-1',
        governance_thread_state: 'resolved',
        governance_current_child: null,
        governance_child_queue: [
          {
            issue_id: 'issue-child-1',
            issue_identifier: 'INT-2',
            title: 'First child',
            tracker_state: 'Done',
            orchestrator_state: 'completed',
            governance_decision: null,
            governance_summary: null,
            queue_state: 'completed',
            delivery_state: 'completed',
            delivery_code: null,
            delivery_summary: 'First child completed.',
          },
          {
            issue_id: 'issue-child-2',
            issue_identifier: 'INT-3',
            title: 'Second child',
            tracker_state: 'Done',
            orchestrator_state: 'completed',
            governance_decision: null,
            governance_summary: null,
            queue_state: 'completed',
            delivery_state: 'completed',
            delivery_code: null,
            delivery_summary: 'Second child completed.',
          },
        ],
      }),
    });

    expect(sessions.findById(session.id)?.state).toBe('completed');
    const milestoneEvents = events
      .listBySession(session.id)
      .filter((event) => event.event_kind === 'orchestrator_milestone');
    expect(milestoneEvents.at(-1)?.payload_json?.milestone_kind).toBe('completed');
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

  test('shows explicit active-session choices when a different new request arrives', async () => {
    db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, null, sessions, events);
    sessions.create({
      id: 'session-active',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'awaiting_user_approval',
      plan_card: {
        title: '旧计划',
        user_goal: '旧计划',
        in_scope: ['旧计划'],
        out_of_scope: [],
        acceptance: ['旧计划可验证'],
        known_risks: [],
        execution_strategy: '批准后执行。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '批准并开始', summary: '执行旧计划。' },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const response = await service.respond({
      context: createContext(),
      text: '新需求',
      intent: {
        kind: 'create_issue',
        title: '新需求',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response?.message).toContain('当前会话已经有一条活跃计划线程');
    expect(response?.message).toContain('新开线程');
    expect(response?.action_rows?.flat().map((action) => action.label)).toEqual(expect.arrayContaining([
      '查看当前计划',
      '取消当前计划',
    ]));
  });

  test('new thread cancels every stale active session in the same Telegram conversation before starting fresh', async () => {
    db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const planCard = {
      title: '旧计划',
      user_goal: '旧计划',
      in_scope: ['旧计划'],
      out_of_scope: [],
      acceptance: ['旧计划可验证'],
      known_risks: [],
      execution_strategy: '批准后执行。',
      needs_user_approval: true,
      repo_ref: 'UniUni2000/test2',
      project_slug: 'test2',
      clarification_question: null,
      materialization_mode: 'root_only' as const,
      recommended_option: { label: '批准并开始', summary: '执行旧计划。' },
      alternate_option: null,
      governance_preview: null,
    };
    sessions.create({
      id: 'stale-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'awaiting_user_decision',
      plan_card: planCard,
    });
    sessions.create({
      id: 'stale-2',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'executing',
      plan_card: planCard,
    });

    const response = await service.respond({
      context: createContext(),
      text: '新开线程 请新增 supervisor live smoke 文档。请先给 Plan Card，不要直接建单。',
      intent: {
        kind: 'create_issue',
        title: '请新增 supervisor live smoke 文档。请先给 Plan Card，不要直接建单。',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response?.message).toContain('计划待你批准');
    expect(sessions.findById('stale-1')?.state).toBe('cancelled');
    expect(sessions.findById('stale-2')?.state).toBe('cancelled');
    const activeInConversation = sessions.findAll()
      .filter((session) => session.transport === 'telegram' && session.conversation_id === 'chat-1')
      .filter((session) => session.state !== 'cancelled' && session.state !== 'completed');
    expect(activeInConversation).toHaveLength(1);
    expect(activeInConversation[0]?.plan_card?.title).toBe('请新增 supervisor live smoke 文档');
  });

  test('does not revive a cancelled historical session when its old root issue publishes a runtime update', () => {
    db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, null, sessions, events);

    sessions.create({
      id: 'cancelled-old-root',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'cancelled',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_card: null,
      plan_version: 1,
      root_issue_id: 'old-root',
      root_work_item_id: null,
      current_child_issue_id: null,
      active_decision_kind: null,
      delivery_state: null,
      delivery_summary: '用户已新开线程，旧线程取消。',
      last_material_outcome: null,
      last_message_id: '200',
      last_card_key: 'session|old',
    });

    service.syncIssue(createIssueView({
      issue_id: 'old-root',
      identifier: 'INT-OLD',
      governance_root_issue_id: 'old-root',
      governance_root_issue_identifier: 'INT-OLD',
      orchestrator_state: 'failed',
      delivery_state: 'delivery_failed',
      delivery_summary: '旧 root 后续失败事件。',
    }));

    expect(sessions.findById('cancelled-old-root')?.state).toBe('cancelled');
    expect(events.listBySession('cancelled-old-root')).toHaveLength(0);

    service.dispose();
  });

  test('cancels an active supervisor session when the root issue is cancelled in the tracker', () => {
    db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, null, sessions, events);

    sessions.create({
      id: 'session-root-cancelled',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_decision',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_card: null,
      plan_version: 1,
      root_issue_id: 'issue-root',
      root_work_item_id: null,
      current_child_issue_id: null,
      active_decision_kind: 'delivery_failure',
      delivery_state: 'delivery_failed',
      delivery_summary: '之前卡在交付。',
      last_material_outcome: null,
      last_message_id: '200',
      last_card_key: 'session|root',
    });

    service.syncIssue(createIssueView({
      issue_id: 'issue-root',
      identifier: 'INT-149',
      title: '清空当前仓库（安全清理计划）',
      tracker_state: 'Canceled',
      orchestrator_state: 'failed',
      delivery_state: 'delivery_failed',
      delivery_summary: '旧的交付失败不应盖过用户取消。',
      governance_root_issue_id: 'issue-root',
      governance_root_issue_identifier: 'INT-149',
      updated_at: '2026-05-04T12:00:00.000Z',
    }));

    const updated = sessions.findById('session-root-cancelled');
    expect(updated?.state).toBe('cancelled');
    expect(updated?.active_decision_kind).toBeNull();
    expect(
      events.listBySession('session-root-cancelled')
        .some((event) => event.event_kind === 'orchestrator_milestone'
          && event.payload_json?.milestone_kind === 'cancelled'),
    ).toBe(true);

    service.dispose();
  });

  test('allows a user to explicitly cancel the active supervisor session', async () => {
    db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, null, sessions, events);
    sessions.create({
      id: 'session-cancel',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'awaiting_user_approval',
      root_issue_id: 'issue-root',
      current_child_issue_id: 'issue-child',
      plan_card: {
        title: '旧计划',
        user_goal: '旧计划',
        in_scope: ['旧计划'],
        out_of_scope: [],
        acceptance: ['旧计划可验证'],
        known_risks: [],
        execution_strategy: '批准后执行。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '批准并开始', summary: '执行旧计划。' },
        alternate_option: null,
        governance_preview: null,
      },
    });
    runtime.issues.set('issue-root', createIssueView({
      issue_id: 'issue-root',
      identifier: 'INT-ROOT',
      governance_current_child: {
        issue_id: 'issue-child',
        issue_identifier: 'INT-CHILD',
        title: '当前 child',
        tracker_state: 'In Progress',
        orchestrator_state: 'dev_running',
        governance_decision: null,
        governance_summary: null,
        queue_state: 'current',
        delivery_state: null,
        delivery_code: null,
        delivery_summary: null,
      },
    }));

    const response = await service.respond({
      context: createContext(),
      text: '取消当前计划',
      intent: null,
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response?.message).toContain('计划已取消');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.findById('session-cancel')?.state).toBe('cancelled');
    expect(runtime.stopIssueCalls).toEqual([]);
    expect(runtime.closeIssueCalls).toEqual([{
      id: 'issue-child',
      reason: 'Supervisor session cancelled by user.',
    }]);
  });

  test('allows a new thread prefix to bypass an unrelated active session', async () => {
    db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, null, sessions, events);
    sessions.create({
      id: 'session-old',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'awaiting_user_approval',
      root_issue_id: 'old-root',
      plan_card: {
        title: '旧计划',
        user_goal: '旧计划',
        in_scope: ['旧计划'],
        out_of_scope: [],
        acceptance: ['旧计划可验证'],
        known_risks: [],
        execution_strategy: '批准后执行。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '批准并开始', summary: '执行旧计划。' },
        alternate_option: null,
        governance_preview: null,
      },
    });
    runtime.issues.set('old-root', createIssueView({
      issue_id: 'old-root',
      identifier: 'INT-OLD',
    }));

    const response = await service.respond({
      context: createContext(),
      text: '新开线程 新计划',
      intent: {
        kind: 'create_issue',
        title: '新计划',
        description: null,
        project_slug: 'test2',
      },
      runtimeContext: createRuntimeContext(),
      canWrite: true,
    });

    expect(response?.message).toContain('新计划');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.findById('session-old')?.state).toBe('cancelled');
    expect(runtime.stopIssueCalls).toEqual([]);
    expect(runtime.closeIssueCalls).toEqual([{
      id: 'old-root',
      reason: 'Supervisor session cancelled by user.',
    }]);
    expect(sessions.findActiveByConversation({ transport: 'telegram', conversation_id: 'chat-1' })?.plan_card?.title).toBe('新计划');
  });

  test('preemptively cancels and stops active sessions as soon as a new-thread Telegram text arrives', async () => {
    db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const service = new SupervisorSessionService(runtime, null, sessions, events);
    sessions.create({
      id: 'session-preempt-old',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'executing',
      root_issue_id: 'old-root',
      current_child_issue_id: 'old-child',
      plan_card: {
        title: '旧计划',
        user_goal: '旧计划',
        in_scope: ['旧计划'],
        out_of_scope: [],
        acceptance: ['旧计划可验证'],
        known_risks: [],
        execution_strategy: '执行中。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '自动执行', summary: '执行旧计划。' },
        alternate_option: null,
        governance_preview: null,
      },
    });
    runtime.issues.set('old-root', createIssueView({
      issue_id: 'old-root',
      identifier: 'INT-OLD',
      governance_current_child: {
        issue_id: 'old-child',
        issue_identifier: 'INT-CHILD',
        title: '旧 child',
        tracker_state: 'In Progress',
        orchestrator_state: 'dev_running',
        governance_decision: null,
        governance_summary: null,
        queue_state: 'current',
        delivery_state: null,
        delivery_code: null,
        delivery_summary: null,
      },
    }));

    const cancelled = service.preemptActiveSessionsForNewThread(
      createContext(),
      '新开线程 新计划',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cancelled).toBe(1);
    expect(sessions.findById('session-preempt-old')?.state).toBe('cancelled');
    expect(runtime.stopIssueCalls).toEqual([]);
    expect(runtime.closeIssueCalls).toEqual([{
      id: 'old-child',
      reason: 'Supervisor session cancelled by user.',
    }]);
    expect(events.listBySession('session-preempt-old').map((event) => event.event_kind))
      .toContain('session_cancelled_for_new_thread_preemptive');
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

  test('requires a user decision before continuing destructive repository cleanup execution', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    new SupervisorSessionService(runtime, createProjectResolver(), sessions, events);
    const session = sessions.create({
      id: 'session-destructive-cleanup',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-root',
      plan_card: {
        title: '把仓库清空成 GitHub 空仓库状态',
        user_goal: '把仓库清空成 GitHub 空仓库状态',
        in_scope: ['删除所有 tracked files'],
        out_of_scope: ['不删除 .git 目录', '不跳过最终范围确认'],
        acceptance: ['最终交付前用户确认 PR 和清理范围'],
        known_risks: ['误删有效文件风险高'],
        execution_strategy: '先确认范围，再执行清空并交付。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '批准并开始',
          summary: '按受控清理计划执行。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    runtime.emit({
      type: 'issue',
      data: createIssueView({
        issue_id: 'issue-root',
        identifier: 'INT-139',
        title: '把仓库清空成 GitHub 空仓库状态',
        orchestrator_state: 'retry_scheduled',
        governance_root_issue_id: 'issue-root',
        updated_at: '2026-01-01T01:00:00.000Z',
      }),
    });

    const updated = sessions.findById(session.id);
    const oversightEvents = events
      .listBySession(session.id)
      .filter((event) => event.event_kind === 'supervisor_oversight');
    expect(updated?.state).toBe('awaiting_user_decision');
    expect(updated?.active_decision_kind).toBe('execution_decision');
    expect(updated?.last_material_outcome?.supervisor_decision).toBe('ask_user');
    expect(oversightEvents[0]?.payload_json?.reason).toBe('approval_policy_destructive_cleanup');
  });

  test('records asynchronous LLM oversight after the runtime milestone is received', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const asyncOverseer: SupervisorExecutionOverseer = {
      assess: async ({ session, milestone }) => {
        await Promise.resolve();
        return milestone
          ? {
              decision: 'continue',
              reason: 'llm_supervision',
              dev_instruction: `继续按计划 ${session.plan_card?.title ?? ''} 推进，并先验证当前 diff。`,
              user_summary: '监督脑已给 dev agent 下一轮指令。',
              active_decision_kind: null,
              key: `async|${milestone.key}`,
              source: 'llm',
              fallback_reason: null,
            }
          : null;
      },
    };
    new SupervisorSessionService(
      runtime,
      createProjectResolver(),
      sessions,
      events,
      null,
      null,
      asyncOverseer,
    );
    const session = sessions.create({
      id: 'session-async-overseer',
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
        orchestrator_state: 'retry_scheduled',
        governance_root_issue_id: 'issue-root',
        updated_at: '2026-01-01T01:00:00.000Z',
      }),
    });

    expect(events.listBySession(session.id).filter((event) => event.event_kind === 'orchestrator_milestone')).toHaveLength(1);
    expect(events.listBySession(session.id).filter((event) => event.event_kind === 'supervisor_oversight')).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const oversightEvents = events
      .listBySession(session.id)
      .filter((event) => event.event_kind === 'supervisor_oversight');
    expect(oversightEvents).toHaveLength(1);
    expect(oversightEvents[0]?.payload_json?.reason).toBe('llm_supervision');
    expect(oversightEvents[0]?.payload_json?.source).toBe('llm');
    expect(sessions.findById(session.id)?.last_material_outcome?.dev_instruction).toContain('验证当前 diff');
    expect(sessions.findById(session.id)?.last_material_outcome?.oversight_source).toBe('llm');
  });

  test('does not let asynchronous oversight revive a session cancelled after the runtime milestone', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntime();
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    let releaseOverseer: (() => void) | null = null;
    const overseerReleased = new Promise<void>((resolve) => {
      releaseOverseer = resolve;
    });
    const asyncOverseer: SupervisorExecutionOverseer = {
      assess: async ({ milestone }) => {
        await overseerReleased;
        return milestone
          ? {
              decision: 'continue',
              reason: 'llm_supervision',
              dev_instruction: '继续推进当前 child。',
              user_summary: '监督脑已给出下一步。',
              active_decision_kind: null,
              key: `async|${milestone.key}`,
              source: 'llm',
              fallback_reason: null,
            }
          : null;
      },
    };
    new SupervisorSessionService(
      runtime,
      createProjectResolver(),
      sessions,
      events,
      null,
      null,
      asyncOverseer,
    );
    const session = sessions.create({
      id: 'session-cancelled-before-async-overseer',
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
        title: '旧执行线程',
        user_goal: '旧执行线程',
        in_scope: ['推进旧任务'],
        out_of_scope: [],
        acceptance: ['旧任务完成'],
        known_risks: [],
        execution_strategy: '继续执行。',
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
        title: '旧执行线程',
        orchestrator_state: 'retry_scheduled',
        governance_root_issue_id: 'issue-root',
        updated_at: '2026-01-01T01:00:00.000Z',
      }),
    });
    sessions.update({
      id: session.id,
      state: 'cancelled',
      delivery_summary: '用户已新开线程，旧线程取消。',
    });

    releaseOverseer?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updated = sessions.findById(session.id);
    expect(updated?.state).toBe('cancelled');
    expect(updated?.delivery_summary).toBe('用户已新开线程，旧线程取消。');
    expect(events.listBySession(session.id).filter((event) => event.event_kind === 'supervisor_oversight')).toHaveLength(0);
  });
});
