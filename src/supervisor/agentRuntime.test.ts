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
    createIssue: async (input) => ({
      accepted: true,
      status: 'accepted',
      message: `Created ${input.title}`,
      issue_id: 'issue-new',
      issue_identifier: 'INT-999',
      issue: issue({
        issue_id: 'issue-new',
        identifier: 'INT-999',
        title: input.title,
      }),
    }),
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

function createHarness(model?: SupervisorModelLoop) {
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
    supervisorAgentService: {
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

describe('SupervisorAgentRuntimeService', () => {
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

    expect(response.message).toContain('I already checked list_issues');
    const run = h.runs.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    const eventKinds = h.events.listByRun(run!.id).map((event) => event.event_kind);
    expect(eventKinds).toContain('progress_message');
    expect(h.toolCalls.findByRun(run!.id).filter((call) => call.tool_name === 'list_issues')).toHaveLength(1);
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

    expect(h.service.recoverStartupState()).toBe(1);
    expect(h.runs.findById('run-stale')?.state).toBe('failed');
    expect(h.runs.findById('run-waiting')?.state).toBe('waiting_confirmation');
    expect(h.events.listByRun('run-stale').map((event) => event.event_kind)).toContain('run_recovered');
  });
});
