import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  BotConversationPreferenceRepository,
  RepoClaudeConversationRepository,
  SupervisorPendingActionRepository,
  SupervisorRunEventRepository,
  SupervisorRunRepository,
  SupervisorToolCallRepository,
  initializeSchema,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeStreamEvent } from '../runtime/types';
import { BotCommandService } from '../bots/commandService';
import { BotSubscriptionService } from '../bots/subscriptions';
import type { BotCommandContext } from '../bots/types';
import {
  SupervisorActionPolicy,
  SupervisorAgentRuntimeService,
  createSupervisorToolRouterModel,
  type SupervisorModelLoop,
} from './agentRuntime';

function issue(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-158',
    work_item_id: 'work-158',
    identifier: 'INT-158',
    title: 'Runtime is stuck',
    phase: 'DEV',
    tracker_state: 'In Progress',
    orchestrator_state: 'dev_running',
    workspace_path: '/tmp/workspaces/INT-158',
    branch_name: 'codex/int-158',
    github_repo: 'UniUni2000/test2',
    github_issue_number: 158,
    active_pr_number: null,
    session: {
      session_id: 'session-158',
      turn_count: 3,
      stage: 'coding',
      last_event: 'tool_completed',
      last_message: 'Read completed',
      started_at: '2026-05-08T00:00:00.000Z',
      last_event_at: '2026-05-08T00:01:00.000Z',
      tokens: {
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
      },
      recent_tools: [],
      recent_files: [],
    },
    governance_status: 'advisory',
    governance_decision: null,
    governance_summary: null,
    active_governance_suggestions: [],
    actions: {
      can_stop: true,
      can_retry: true,
      can_override_governance: false,
      can_rewrite_governance: false,
      can_split_governance: false,
      can_open_pr: false,
    },
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:01:00.000Z',
    ...overrides,
  };
}

function createRuntimeControlPlane(): RuntimeControlPlane & {
  retryCalls: string[];
  closeCalls: Array<{ id: string; successor_issue_id: string | null }>;
} {
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  const issues = [
    issue(),
    issue({
      issue_id: 'issue-157',
      work_item_id: 'work-157',
      identifier: 'INT-157',
      title: 'Old runtime task',
      orchestrator_state: 'halted',
      actions: {
        can_stop: false,
        can_retry: false,
        can_override_governance: false,
        can_rewrite_governance: false,
        can_split_governance: false,
        can_open_pr: false,
      },
    }),
  ];
  const retryCalls: string[] = [];
  const closeCalls: Array<{ id: string; successor_issue_id: string | null }> = [];
  return {
    getOverview: () => ({
      generated_at: '2026-05-08T00:02:00.000Z',
      counts: {
        running: 1,
        retrying: 0,
        total: issues.length,
      },
      issues,
    }),
    getIssue: (id: string) =>
      issues.find((item) => item.issue_id === id || item.identifier === id) ?? null,
    getTimeline: () => [
      {
        id: 'event-1',
        issue_id: 'issue-158',
        issue_identifier: 'INT-158',
        timestamp: '2026-05-08T00:01:00.000Z',
        level: 'info',
        category: 'tool',
        code: 'tool_completed',
        message: 'Read completed',
        turn: 3,
        tool_name: 'Read',
        detail: null,
      },
    ],
    getHistoryView: () => ({
      issue_id: 'issue-158',
      issue_identifier: 'INT-158',
      digest: {
        headline: 'INT-158 is running',
        detail: 'Latest runtime activity was a read step.',
        history_blurb: 'No failures recorded.',
        updated_at: '2026-05-08T00:01:00.000Z',
      },
      entries: [],
    }),
    createIssue: async (input) => {
      const created = issue({
        issue_id: 'issue-new',
        work_item_id: 'work-new',
        identifier: 'INT-999',
        title: input.title,
        tracker_state: 'In Progress',
        orchestrator_state: 'dev_running',
      });
      issues.unshift(created);
      return {
        accepted: true,
        status: 'accepted',
        message: `Created ${input.title}`,
        issue_id: 'issue-new',
        issue_identifier: 'INT-999',
        issue: created,
      };
    },
    stopIssue: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Stopped ${id}`,
      issue_id: id,
      issue_identifier: id,
    }),
    retryIssue: async (id: string) => {
      retryCalls.push(id);
      return {
        accepted: true,
        status: 'queued',
        message: `Queued ${id}`,
        issue_id: id,
        issue_identifier: id,
      };
    },
    closeIssue: async (id: string, request = {}) => {
      closeCalls.push({
        id,
        successor_issue_id: request.successor_issue_id ?? null,
      });
      return {
        accepted: true,
        status: 'completed',
        message: `Closed ${id}`,
        issue_id: id,
        issue_identifier: id,
      };
    },
    overrideGovernance: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Override ${id}`,
      issue_id: id,
      issue_identifier: id,
    }),
    rewriteGovernance: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Rewrite ${id}`,
      issue_id: id,
      issue_identifier: id,
    }),
    splitGovernance: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Split ${id}`,
      issue_id: id,
      issue_identifier: id,
    }),
    executeGovernanceSuggestion: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Execute suggestion ${id}`,
      issue_id: id,
      issue_identifier: id,
    }),
    dismissGovernanceSuggestion: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Dismiss suggestion ${id}`,
      issue_id: id,
      issue_identifier: id,
    }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retryCalls,
    closeCalls,
  };
}

function createHarness(
  model?: SupervisorModelLoop,
  options: {
    onProgress?: ConstructorParameters<typeof SupervisorAgentRuntimeService>[0]['onProgress'];
    supervisorAgentService?: ConstructorParameters<typeof SupervisorAgentRuntimeService>[0]['supervisorAgentService'];
  } = {},
) {
  const db = new Database(':memory:');
  initializeSchema(db);
  const runtime = createRuntimeControlPlane();
  const preferences = new BotConversationPreferenceRepository(db);
  preferences.upsert({
    transport: 'telegram',
    conversation_id: 'chat-1',
    default_project_slug: 'test2',
  });
  const commandService = new BotCommandService(
    runtime,
    new BotSubscriptionService(runtime, {}),
    () => true,
    preferences,
  );
  const runs = new SupervisorRunRepository(db);
  const events = new SupervisorRunEventRepository(db);
  const toolCalls = new SupervisorToolCallRepository(db);
  const pendingActions = new SupervisorPendingActionRepository(db);
  const repoConversations = new RepoClaudeConversationRepository(db);
  const context: BotCommandContext = {
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
  const service = new SupervisorAgentRuntimeService({
    runtime,
    commandService,
    preferences,
    projectResolver: {
      listConfiguredProjectSlugs: () => ['test2'],
      listConfiguredRoutes: () => [
        {
          project_slug: 'test2',
          project_name: 'Test Two',
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          github_repo_full: 'UniUni2000/test2',
          local_path: null,
          cache_key: 'uniuni2000__test2',
          require_repo_harness: false,
        },
      ],
      resolveProjectSlug: async (projectSlug: string) => ({
        project: {
          project_id: 'project-1',
          project_slug: projectSlug,
          project_name: 'Test Two',
        },
        route: {
          project_slug: projectSlug,
          project_name: 'Test Two',
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          github_repo_full: 'UniUni2000/test2',
          local_path: null,
          cache_key: 'uniuni2000__test2',
          require_repo_harness: false,
        },
      }),
    } as any,
    runs,
    events,
    toolCalls,
    pendingActions,
    repoConversations,
    actionPolicy: new SupervisorActionPolicy(),
    model,
    onProgress: options.onProgress,
    supervisorAgentService: options.supervisorAgentService ?? {
      respond: async (input) => ({
        mode: 'repo_answer',
        repoRef: input.defaultRepoRef,
        answer: `Repo answer for ${input.userText}`,
        citations: ['README.md'],
      }),
      getRepoConversationDiagnostics: () => [],
    },
  });

  return {
    db,
    runtime,
    service,
    context,
    runs,
    events,
    toolCalls,
    pendingActions,
    repoConversations,
  };
}

const FORBIDDEN_USER_OUTPUT_PATTERNS = [
  /我还不能确定要做什么/,
  /仓库分析已完成，但需要进一步确认下一步/,
  /当前没有等待确认/,
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

describe('SupervisorAgentRuntimeService', () => {
  test('treats create issue text with cleanup-smoke file names as a new issue request', async () => {
    const h = createHarness();

    const response = await h.service.respond({
      context: h.context,
      text: 'create an issue: live cancel cleanup smoke 2026-05-08 20:47. Goal: add docs/cancel-cleanup-smoke-20260508-2047.md with one line.',
    });

    expect(response.message).toContain('Action: create issue');
    expect(response.message).not.toContain('SMOKE-20260508');
    expect(h.runtime.closeCalls).toEqual([]);
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })?.tool_name).toBe('create_issue');
  });

  test('treats explicit open-an-issue text as a new issue request', async () => {
    const h = createHarness();

    const response = await h.service.respond({
      context: h.context,
      text: 'open an issue for README cleanup',
    });

    expect(response.message).toContain('Action: create issue');
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })?.tool_name).toBe('create_issue');
  });

  test('asks the supervisor for issue recommendations instead of creating from advisory wording', async () => {
    const agentInputs: Array<{ userText: string; repoRef: string | null }> = [];
    const h = createHarness(undefined, {
      supervisorAgentService: {
        respond: async (input) => {
          agentInputs.push({
            userText: input.userText,
            repoRef: input.repoRef,
          });
          return {
            mode: 'issue_recommendation',
            repoRef: input.repoRef,
            title: 'Add a focused README smoke test',
            summary: 'This would protect the documentation path that users see first.',
            nextStep: 'Review the recommendation, then ask me to create it if it looks right.',
          };
        },
        getRepoConversationDiagnostics: () => [],
      },
    });

    for (const text of [
      '你建议这个仓库当前做什么 issue 最能提升',
      '如果让你来提个issue，你觉得当前最应该提的是什么',
      'if you were to suggest an issue, what should be next?',
    ]) {
      const response = await h.service.respond({
        context: h.context,
        text,
      });

      expect(response.message).toContain('我建议先做这个 issue');
      expect(response.message).toContain('Add a focused README smoke test');
      expect(response.message).toContain('This would protect the documentation path');
      expect(response.message).not.toContain('Action: create issue');
      expect(response.message).not.toContain('仓库分析已完成，但需要进一步确认下一步');
      expect(h.pendingActions.findOpenByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      })).toBeNull();
      const run = h.runs.findLatestByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      });
      expect(h.toolCalls.findByRun(run!.id).map((call) => call.tool_name)).toEqual([]);
    }

    expect(agentInputs).toEqual([
      {
        userText: '你建议这个仓库当前做什么 issue 最能提升',
        repoRef: 'UniUni2000/test2',
      },
      {
        userText: '如果让你来提个issue，你觉得当前最应该提的是什么',
        repoRef: 'UniUni2000/test2',
      },
      {
        userText: 'if you were to suggest an issue, what should be next?',
        repoRef: 'UniUni2000/test2',
      },
    ]);
  });

  test('does not fall back to issue-list answers when repo-aware issue recommendation is temporarily unavailable', async () => {
    const h = createHarness(undefined, {
      supervisorAgentService: {
        respond: async () => null,
        getRepoConversationDiagnostics: () => [],
      },
    });

    const response = await h.service.respond({
      context: h.context,
      text: 'if you were to suggest an issue, what should be next?',
    });

    expect(response.message).toContain('仓库只读分析暂时没有返回结果');
    expect(response.message).not.toContain('tracked issues');
    expect(response.message).not.toContain('当前有 2 个');
    expectAssistantSafeMessage(response.message);

    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(h.toolCalls.findByRun(run!.id).map((call) => call.tool_name)).toEqual(['read_repo_with_claude']);
  });

  test('turns a follow-up approval of the last issue recommendation into a create confirmation', async () => {
    const h = createHarness(undefined, {
      supervisorAgentService: {
        respond: async (input) => ({
          mode: 'issue_recommendation',
          repoRef: input.repoRef,
          title: 'Add GitHub Actions CI for Python tests',
          summary: 'Run the stellar mass-luminosity test suite on push and pull requests.',
          nextStep: 'Ask me to create it if this recommendation looks right.',
        }),
        getRepoConversationDiagnostics: () => [],
      },
    });

    const recommendation = await h.service.respond({
      context: h.context,
      text: 'if you were to suggest an issue, what should be next?',
    });
    expect(recommendation.message).toContain('Add GitHub Actions CI for Python tests');

    const response = await h.service.respond({
      context: h.context,
      text: '就按你的来',
    });

    expect(response.message).toContain('Action: create issue');
    expect(response.message).toContain('Title: Add GitHub Actions CI for Python tests');
    expect(response.message).toContain('Reply with: 确认 / 取消');
    expectAssistantSafeMessage(response.message);

    const pending = h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(pending?.tool_name).toBe('create_issue');
    expect(pending?.tool_args).toMatchObject({
      title: 'Add GitHub Actions CI for Python tests',
    });
    expect(String(pending?.tool_args.description)).toContain('Run the stellar mass-luminosity test suite');
  });

  test('turns conversational Chinese approval of the last issue recommendation into a create confirmation', async () => {
    const h = createHarness(undefined, {
      supervisorAgentService: {
        respond: async (input) => ({
          mode: 'issue_recommendation',
          repoRef: input.repoRef,
          title: '为 stellar_mass_luminosity.py 添加 Python 类型注解',
          summary: '为核心计算函数添加 type hints，并让测试继续保护现有行为。',
          nextStep: 'Ask me to create it if this recommendation looks right.',
        }),
        getRepoConversationDiagnostics: () => [],
      },
    });

    await h.service.respond({
      context: h.context,
      text: '除了这一方面，还有那些可以提的 issue，能提高这个项目',
    });

    const response = await h.service.respond({
      context: h.context,
      text: '可以，你帮我提了',
    });

    expect(response.message).toContain('Action: create issue');
    expect(response.message).toContain('Title: 为 stellar_mass_luminosity.py 添加 Python 类型注解');
    expect(response.message).toContain('Reply with: 确认 / 取消');
    expectAssistantSafeMessage(response.message);

    const pending = h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(pending?.tool_name).toBe('create_issue');
    expect(pending?.tool_args).toMatchObject({
      title: '为 stellar_mass_luminosity.py 添加 Python 类型注解',
    });
  });

  test('shows the runtime issue card immediately after a confirmed create issue action', async () => {
    const h = createHarness();

    const pending = await h.service.respond({
      context: h.context,
      text: 'open an issue for an HTML 2048 game',
    });

    expect(pending.message).toContain('Action: create issue');
    expect(pending.message).toContain('Reply with: 确认 / 取消');
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })?.tool_name).toBe('create_issue');

    const confirmed = await h.service.respond({
      context: h.context,
      text: '确认',
    });

    expect(confirmed.message).toContain('Issue Card · INT-999');
    expect(confirmed.issue_id).toBe('issue-new');
    expect(confirmed.media_key).toContain('issue-card|INT-999');
    expect(confirmed.photo?.content_type).toBe('image/png');
    expect(confirmed.action_rows?.flat().map((action) => action.label)).toEqual([
      '停止',
      '刷新卡片',
      '打开运行视图',
    ]);
    expect(confirmed.action_rows?.[1]?.[1]?.web_app?.url).toBe('/runtime/issues/INT-999/app');
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })).toBeNull();

    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(h.toolCalls.findByRun(run!.id).map((call) => call.tool_name)).toEqual([
      'create_issue',
      'show_issue_card',
    ]);
  });

  test('uses the last issue recommendation when the user asks to create that suggested issue', async () => {
    const h = createHarness(undefined, {
      supervisorAgentService: {
        respond: async (input) => ({
          mode: 'issue_recommendation',
          repoRef: input.repoRef,
          title: 'Add GitHub Actions CI for Python tests',
          summary: 'Run the stellar mass-luminosity test suite on push and pull requests.',
          nextStep: 'Ask me to create it if this recommendation looks right.',
        }),
        getRepoConversationDiagnostics: () => [],
      },
    });

    await h.service.respond({
      context: h.context,
      text: 'if you were to suggest an issue, what should be next?',
    });

    const response = await h.service.respond({
      context: h.context,
      text: '就按你的建议建一个 issue',
    });

    expect(response.message).toContain('Action: create issue');
    expect(response.message).toContain('Title: Add GitHub Actions CI for Python tests');
    expect(response.message).not.toContain('我是只读 brain');
    expect(response.message).not.toContain('无法在 Linear 中创建 issue');
    expectAssistantSafeMessage(response.message);
  });

  test('turns vague acknowledgements into calm assistant guidance instead of useless fallback', async () => {
    for (const text of ['好的', '嗯', '随便你看看', '没事，先这样']) {
      const h = createHarness();

      const response = await h.service.respond({
        context: h.context,
        text,
      });

      expect(response.message).toContain('先保持当前状态');
      expect(response.message).toContain('不会启动新动作');
      expect(response.message).not.toContain('我还不能确定');
      expect(response.message).not.toContain('当前没有等待确认');
      expect(response.message).not.toContain('Action:');
      expectAssistantSafeMessage(response.message);
      expect(h.pendingActions.findOpenByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      })).toBeNull();
    }
  });

  test('answers conversational cleanup follow-ups from the control plane instead of showing no-action guidance', async () => {
    const h = createHarness();

    const response = await h.service.respond({
      context: h.context,
      text: '比较干净了吧',
    });

    expect(response.message).toContain('当前 supervisor 控制面');
    expect(response.message).toContain('Issues:');
    expect(response.message).not.toContain('当前没有等待确认');
    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(run).not.toBeNull();
    expect(h.toolCalls.findByRun(run!.id).map((call) => call.tool_name)).toEqual(['summarize_control_plane']);
    expectAssistantSafeMessage(response.message);
  });

  test('persists a run transcript, leaves high-risk close pending, and lets read questions bypass it', async () => {
    const h = createHarness();

    const close = await h.service.respond({
      context: h.context,
      text: '把 157 给我关了吧',
    });

    expect(close.message).toContain('Action: close issue');
    expect(close.message).toContain('Reply with: 确认 / 取消');
    expect(h.runtime.closeCalls).toEqual([]);
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })?.tool_name).toBe('close_issue');

    const read = await h.service.respond({
      context: h.context,
      text: '有哪些 issue',
    });

    expect(read.message).toContain('INT-158');
    expect(read.message).toContain('INT-157');
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })?.status).toBe('pending_confirm');

    const confirm = await h.service.respond({
      context: h.context,
      text: '确认',
    });

    expect(confirm.message).toContain('Closed INT-157');
    expect(h.runtime.closeCalls).toEqual([
      {
        id: 'INT-157',
        successor_issue_id: null,
      },
    ]);
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })).toBeNull();

    const completedRuns = h.runs.listByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    }).filter((run) => run.state === 'completed');
    expect(completedRuns.some((run) =>
      h.events.listByRun(run.id).map((event) => event.event_kind).includes('final_answer')
    )).toBe(true);
    expect(completedRuns.some((run) =>
      h.toolCalls.findByRun(run.id).some((call) => call.tool_name === 'close_issue')
    )).toBe(true);
  });

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

  test('answers active issue query variants from runtime state instead of read-only repo Claude', async () => {
    for (const text of [
      '活跃的 issue 呢',
      '活跃的呢',
      '正在处理哪些任务',
      'open issues',
      "what's running",
    ]) {
      const h = createHarness();

      const response = await h.service.respond({
        context: h.context,
        text,
      });

      expect(response.message).toContain('当前有 1 个活跃 issue');
      expect(response.message).toContain('INT-158');
      expect(response.message).not.toContain('INT-157');
      expect(response.message).not.toContain('Repo answer');
      expect(response.message).not.toContain('读取最新仓库信息');

      const run = h.runs.findLatestByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      });
      const toolCalls = h.toolCalls.findByRun(run!.id);
      expect(toolCalls.map((call) => call.tool_name)).toEqual(['list_issues']);
      expect(toolCalls[0]?.args).toEqual({ active_only: true, state_filter: 'active' });
    }
  });

  test('routes broad control-plane questions to runtime summaries instead of read-only repo Claude', async () => {
    for (const text of [
      'github 上还有哪些 pr 没关',
      'Linear 里面还有开发中的单吗',
      '默认项目是什么',
      '现在 pending 的确认有哪些',
      'supervisor 现在在跑什么',
    ]) {
      const h = createHarness();

      const response = await h.service.respond({
        context: h.context,
        text,
      });

      expect(response.message).toContain('当前 supervisor 控制面');
      expect(response.message).toContain('INT-158');
      expect(response.message).not.toContain('Repo answer');
      expect(response.message).not.toContain('读取最新仓库信息');

      const run = h.runs.findLatestByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      });
      expect(h.toolCalls.findByRun(run!.id).map((call) => call.tool_name))
        .toEqual(['summarize_control_plane']);
    }
  });

  test('runs low-risk retry directly only when action policy validates the target state', async () => {
    const h = createHarness();

    const response = await h.service.respond({
      context: h.context,
      text: '重试 INT-158',
    });

    expect(response.message).toContain('Queued INT-158');
    expect(h.runtime.retryCalls).toEqual(['INT-158']);
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })).toBeNull();
  });

  test('retries the only visible active issue when the user says this issue', async () => {
    const h = createHarness();

    const list = await h.service.respond({
      context: h.context,
      text: 'active issues',
    });
    expect(list.message).toContain('INT-158');

    const response = await h.service.respond({
      context: h.context,
      text: '重试这个 issue',
    });

    expect(response.message).toContain('Queued INT-158');
    expect(h.runtime.retryCalls).toEqual(['INT-158']);
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })).toBeNull();
  });

  test('accepts yes-style Chinese confirmation for pending supervisor runtime actions', async () => {
    const h = createHarness();

    const close = await h.service.respond({
      context: h.context,
      text: '把 157 给我关了吧',
    });
    expect(close.message).toContain('Reply with: 确认 / 取消');

    const confirmed = await h.service.respond({
      context: h.context,
      text: '是的',
    });

    expect(confirmed.message).toContain('Closed INT-157');
    expect(h.runtime.closeCalls).toEqual([
      {
        id: 'INT-157',
        successor_issue_id: null,
      },
    ]);
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })).toBeNull();
  });

  test('accepts approval wording for pending supervisor runtime actions', async () => {
    const h = createHarness();

    const close = await h.service.respond({
      context: h.context,
      text: '把 157 给我关了吧',
    });
    expect(close.message).toContain('Reply with: 确认 / 取消');

    const confirmed = await h.service.respond({
      context: h.context,
      text: '批准',
    });

    expect(confirmed.message).toContain('Closed INT-157');
    expect(h.runtime.closeCalls).toEqual([
      {
        id: 'INT-157',
        successor_issue_id: null,
      },
    ]);
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })).toBeNull();
  });

  test('treats cancel this issue as a contextual close request', async () => {
    const h = createHarness();

    const response = await h.service.respond({
      context: h.context,
      text: 'cancel this issue now no confirmation',
    });

    expect(response.message).toContain('Closed INT-158');
    expect(h.runtime.closeCalls).toEqual([
      {
        id: 'INT-158',
        successor_issue_id: null,
      },
    ]);
  });

  test('routes stale residue cleanup text to confirmed issue close', async () => {
    const h = createHarness();

    const response = await h.service.respond({
      context: h.context,
      text: '清理 INT-157 的 GitHub 和 Linear 残留垃圾',
    });

    expect(response.message).toContain('Action: close issue');
    expect(response.message).toContain('Reply with: 确认 / 取消');
    expect(h.runtime.closeCalls).toEqual([]);
    expect(h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })?.tool_name).toBe('close_issue');
  });

  test('cancels a superseded pending close run when a new cleanup control turn replaces it', async () => {
    const h = createHarness();

    await h.service.respond({
      context: h.context,
      text: 'cleanup INT-157 stale GitHub and Linear residue',
    });
    const firstPending = h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })!;

    await h.service.respond({
      context: h.context,
      text: 'cleanup INT-158 stale GitHub and Linear residue',
    });
    const currentPending = h.pendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    })!;

    expect(currentPending.id).not.toBe(firstPending.id);
    expect(currentPending.tool_args.issue_id).toBe('INT-158');
    expect(h.pendingActions.findById(firstPending.id)?.status).toBe('cancelled');
    expect(h.runs.findById(firstPending.run_id)?.state).toBe('cancelled');
    expect(h.events.listByRun(firstPending.run_id).map((event) => event.event_kind))
      .toContain('confirmation_cancelled');
  });

  test('uses read-only repo Claude as a business tool and stores the repo conversation key', async () => {
    const h = createHarness();

    const response = await h.service.respond({
      context: h.context,
      text: 'README 有啥',
    });

    expect(response.message).toContain('Repo answer for README 有啥');
    expect(h.repoConversations.findByConversationRepo({
      transport: 'telegram',
      conversation_id: 'chat-1',
      repo_ref: 'UniUni2000/test2',
    })?.status).toBe('active');
    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(h.toolCalls.findByRun(run!.id).map((call) => call.tool_name)).toContain('read_repo_with_claude');
  });

  test('formats issue recommendations returned from read-only repo analysis', async () => {
    const h = createHarness(undefined, {
      supervisorAgentService: {
        respond: async (input) => ({
          mode: 'issue_recommendation',
          repoRef: input.repoRef,
          title: 'Add README verification',
          summary: 'The repo should prove README examples stay accurate.',
          nextStep: 'Ask me to create it if this recommendation looks right.',
        }),
        getRepoConversationDiagnostics: () => [],
      },
    });

    const response = await h.service.respond({
      context: h.context,
      text: 'README 有啥内容',
    });

    expect(response.message).toContain('我建议先做这个 issue');
    expect(response.message).toContain('Add README verification');
    expect(response.message).toContain('The repo should prove README examples stay accurate.');
    expect(response.message).not.toContain('仓库分析已完成，但需要进一步确认下一步');
  });

  test('understands numeric issue status text and uses that issue for follow-up card requests', async () => {
    const h = createHarness();

    const status = await h.service.respond({
      context: h.context,
      text: '158 怎么样了',
    });

    expect(status.message).toContain('INT-158');
    const statusRun = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(h.toolCalls.findByRun(statusRun!.id).map((call) => call.tool_name).sort()).toEqual([
      'diagnose_issue',
      'get_issue',
    ]);

    const card = await h.service.respond({
      context: h.context,
      text: '卡片给我',
    });

    expect(card.message).toContain('Issue Card · INT-158');
    expect(card.issue_id).toBe('issue-158');
    expect(card.media_key).toContain('issue-card|INT-158');
    expect(card.photo?.content_type).toBe('image/png');
    expect(card.photo?.filename).toBe('INT-158-issue-card.png');
    expect(card.photo?.bytes?.length ?? 0).toBeGreaterThan(1000);
    expect(card.action_rows).toEqual([
      [
        { label: '停止', style: 'danger', callback_data: 'rt|INT-158|stop' },
      ],
      [
        { label: '刷新卡片', callback_data: 'rt|INT-158|refresh' },
        {
          label: '打开运行视图',
          style: 'primary',
          web_app: { url: '/runtime/issues/INT-158/app' },
        },
      ],
    ]);
  });

  test('lets the LLM tool router resolve a contextual card request from the latest created issue', async () => {
    const modelInputs: Array<Parameters<SupervisorModelLoop>[0]> = [];
    const model = createSupervisorToolRouterModel({
      decide: async (input) => {
        modelInputs.push(input as Parameters<SupervisorModelLoop>[0]);
        if (input.text === '这个单子卡片') {
          return JSON.stringify({
            intent: {
              kind: 'show_issue_card',
              issue_id: input.context.focus_issue?.issue.identifier ?? null,
            },
          });
        }
        return null;
      },
      getDiagnostics: () => ({
        provider: 'test',
        model: 'test-router',
        configured: true,
        health: 'healthy',
        fallback_available: true,
        last_error_code: null,
      }),
    });
    const h = createHarness(model);

    const created = await h.service.respond({
      context: h.context,
      text: 'create an issue: 添加 Python 类型注解 no confirmation',
    });
    expect(created.message).toContain('已创建 INT-999');

    const createRun = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(createRun?.active_issue_id).toBe('issue-new');

    const card = await h.service.respond({
      context: h.context,
      text: '这个单子卡片',
    });

    expect(card.message).toContain('Issue Card · INT-999');
    expect(card.issue_id).toBe('issue-new');
    expect(card.media_key).toContain('issue-card|INT-999');
    expect(modelInputs.at(-1)?.context.focus_issue?.issue.identifier).toBe('INT-999');
    const cardRun = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(h.toolCalls.findByRun(cardRun!.id).map((call) => call.tool_name)).toEqual(['show_issue_card']);
  });

  test('falls back to the deterministic runtime router when the LLM router returns no turn', async () => {
    const h = createHarness(async () => null);

    const response = await h.service.respond({
      context: h.context,
      text: 'open issues',
    });

    expect(response.message).toContain('当前有 1 个活跃 issue');
    expect(response.message).toContain('INT-158');
    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(h.toolCalls.findByRun(run!.id).map((call) => call.tool_name)).toEqual(['list_issues']);
  });

  test('sets the default project through the runtime tool policy', async () => {
    const h = createHarness();

    const response = await h.service.respond({
      context: h.context,
      text: 'set project to test2',
    });

    expect(response.message).toContain('Default project set to test2');
    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(h.toolCalls.findByRun(run!.id).map((call) => call.tool_name)).toEqual(['set_default_project']);
  });

  test('records progress events and prevents unchanged duplicate tool calls from looping forever', async () => {
    let turn = 0;
    const h = createHarness(async () => {
      turn += 1;
      if (turn === 1) {
        return {
          type: 'progress_update',
          message: 'Checking current issues.',
        };
      }
      return {
        type: 'tool_call',
        tool: 'list_issues',
        args: {},
        reason: 'Need current issue list.',
      };
    });

    const response = await h.service.respond({
      context: h.context,
      text: 'loop test',
    });

    expect(response.message).toContain('我已经用同样条件查过一次');
    expect(response.message).toContain('不会重复空转');
    expect(response.message).toContain('当前有 2 个 tracked issues');
    expectAssistantSafeMessage(response.message);
    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    const eventKinds = h.events.listByRun(run!.id).map((event) => event.event_kind);
    expect(eventKinds).toContain('progress_message');
    expect(h.toolCalls.findByRun(run!.id).filter((call) => call.tool_name === 'list_issues')).toHaveLength(1);
  });

  test('emits model progress updates through the runtime progress callback', async () => {
    const progressMessages: string[] = [];
    let turn = 0;
    const h = createHarness(async () => {
      turn += 1;
      if (turn === 1) {
        return {
          type: 'progress_update',
          message: 'I am checking the current runtime state.',
        };
      }
      return {
        type: 'final_answer',
        message: 'The current runtime state is clear.',
      };
    }, {
      onProgress: async ({ message }) => {
        progressMessages.push(message);
      },
    });

    const response = await h.service.respond({
      context: h.context,
      text: 'check slowly',
    });

    expect(response.message).toBe('The current runtime state is clear.');
    expect(progressMessages).toEqual(['I am checking the current runtime state.']);
  });

  test('summarizes step-limit stop without exposing runtime internals', async () => {
    const h = createHarness(async () => ({
      type: 'progress_update',
      message: 'I am still checking.',
    }));

    const response = await h.service.respond({
      context: h.context,
      text: '慢慢查',
    });

    expect(response.message).toContain('我先停在安全位置');
    expect(response.message).toContain('没有执行新的写入');
    expect(response.message).toContain('可以让我给结论');
    expectAssistantSafeMessage(response.message);
  });

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
    expect(response.message).not.toContain('Invalid args');
    expectAssistantSafeMessage(response.message);
    expect(h.runtime.retryCalls).toEqual([]);
    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(h.toolCalls.findByRun(run!.id)).toHaveLength(0);
    expect(h.events.listByRun(run!.id).map((event) => event.event_kind)).toContain('tool_call_rejected');
  });

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
    expect(response.message).not.toContain('Unsupported supervisor tool');
    expectAssistantSafeMessage(response.message);
    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(h.toolCalls.findByRun(run!.id)).toHaveLength(0);
  });

  test('recovers stale running runs with an explicit recovery event during startup', () => {
    const h = createHarness();
    h.runs.create({
      id: 'run-stale',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'running',
      user_message: 'old request',
    });
    h.runs.create({
      id: 'run-waiting',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'waiting_confirmation',
      user_message: 'pending request',
    });
    h.pendingActions.create({
      run_id: 'run-waiting',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      tool_name: 'close_issue',
      tool_args: { issue_id: 'INT-157' },
      policy_decision: {
        allowed: false,
        requires_confirmation: true,
        risk: 'high_write',
        reason: 'test',
      },
      reason: 'test',
      summary_message: 'Action: close issue',
      expires_at: new Date(Date.now() + 60_000),
    });
    h.runs.create({
      id: 'run-orphan-waiting',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'waiting_confirmation',
      user_message: 'orphan pending request',
    });

    expect(h.service.recoverStartupState()).toBe(2);
    expect(h.runs.findById('run-stale')?.state).toBe('failed');
    expect(h.runs.findById('run-waiting')?.state).toBe('waiting_confirmation');
    expect(h.runs.findById('run-orphan-waiting')?.state).toBe('cancelled');
    expect(h.events.listByRun('run-stale').map((event) => event.event_kind)).toContain('run_recovered');
    expect(h.events.listByRun('run-orphan-waiting').map((event) => event.event_kind))
      .toContain('confirmation_cancelled');
  });
});
