import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BotCommandService, parseTextCommand } from './commandService';
import { BotSubscriptionService } from './subscriptions';
import {
  BotConversationPreferenceRepository,
  BotIssueFollowupRepository,
  initializeSchema,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeStreamEvent } from '../runtime/types';
import type { BotRecipient, BotTransportMessage, BotTransportNotifier } from './types';

function createRuntimeControlPlane(): RuntimeControlPlane & {
  emit: (event: RuntimeStreamEvent) => void;
  closeIssueCalls: Array<{ id: string; successorIssueId: string | null; reason: string | null }>;
} {
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  const closeIssueCalls: Array<{ id: string; successorIssueId: string | null; reason: string | null }> = [];
  const createdIssue: RuntimeIssueView = {
    issue_id: 'issue-2',
    work_item_id: 'issue-2',
    identifier: 'INT-2',
    title: 'Created by bot',
    phase: 'DEV',
    tracker_state: 'Todo',
    orchestrator_state: 'halted',
    workspace_path: null,
    branch_name: null,
    github_repo: 'acme/repo',
    github_issue_number: 11,
    active_pr_number: null,
    session: null,
    governance_status: 'advisory',
    governance_decision: 'split_before_implement',
    governance_summary: 'Split this issue before dispatch.',
    active_governance_suggestions: [
      {
        id: 'suggestion-1',
        suggestion_type: 'cleanup',
        status: 'pending',
        title: 'Create a cleanup issue',
        summary: 'Split the runtime and bot cleanup into a dedicated governance issue.',
        can_execute: true,
        can_dismiss: true,
      },
    ],
    actions: {
      can_stop: false,
      can_retry: false,
      can_override_governance: true,
      can_rewrite_governance: false,
      can_split_governance: true,
      can_open_pr: false,
    },
    created_at: '2026-01-01T00:02:00.000Z',
    updated_at: '2026-01-01T00:02:00.000Z',
  };
  const runtime: RuntimeControlPlane & {
    emit: (event: RuntimeStreamEvent) => void;
    closeIssueCalls: Array<{ id: string; successorIssueId: string | null; reason: string | null }>;
  } = {
    getOverview: () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: {
        running: 1,
        retrying: 0,
        total: 1,
      },
      issues: [
        {
          issue_id: 'issue-1',
          work_item_id: 'issue-1',
          identifier: 'INT-1',
          title: 'Bot command test',
          phase: 'DEV',
          tracker_state: 'In Progress',
          orchestrator_state: 'dev_running',
          workspace_path: '/tmp/workspaces/INT-1',
          branch_name: 'feature/int-1',
          github_repo: 'acme/repo',
          github_issue_number: 10,
          active_pr_number: null,
          session: {
            session_id: 'thread-1-turn-1',
            turn_count: 2,
            stage: 'coding',
            last_event: 'timeline',
            last_message: 'Read completed',
            started_at: '2026-01-01T00:00:00.000Z',
            last_event_at: '2026-01-01T00:01:00.000Z',
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
                summary: '/tmp/workspaces/INT-1/app.py',
                path: '/tmp/workspaces/INT-1/app.py',
                timestamp: '2026-01-01T00:01:00.000Z',
              },
            ],
            recent_files: [
              {
                path: '/tmp/workspaces/INT-1/app.py',
                operation: 'read',
                status: 'completed',
                timestamp: '2026-01-01T00:01:00.000Z',
              },
            ],
          },
          actions: {
            can_stop: true,
            can_retry: false,
            can_override_governance: true,
            can_rewrite_governance: true,
            can_split_governance: true,
            can_open_pr: false,
          },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    getIssue: (id: string) =>
      ['issue-1', 'INT-1'].includes(id)
        ? runtime.getOverview().issues[0] ?? null
        : ['issue-2', 'INT-2'].includes(id)
          ? createdIssue
          : null,
    getTimeline: () => [
      {
        id: 'event-1',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:01:00.000Z',
        level: 'info',
        category: 'tool',
        code: 'tool_completed',
        message: 'Read completed',
        turn: 2,
        tool_name: 'Read',
        detail: {
          path: '/tmp/workspaces/INT-1/app.py',
        },
      },
    ],
    getHistoryView: () => ({
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      digest: {
        headline: 'INT-1 · DEV · In Progress',
        detail: 'Latest update from runtime summary.',
        history_blurb: 'Last review: none',
        updated_at: '2026-01-01T00:01:00.000Z',
      },
      entries: [
        {
          id: 'history-1',
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
          source: 'agent_run',
          title: 'Dev run completed',
          summary: 'Implemented the first version.',
          timestamp: '2026-01-01T00:00:59.000Z',
          detail: null,
        },
      ],
    }),
    createIssue: async (input) => ({
      accepted: true,
      status: 'accepted',
      message: `Created ${input.title}`,
      issue_id: 'issue-2',
      issue_identifier: 'INT-2',
      issue: createdIssue,
    }),
    stopIssue: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Stopping ${id}`,
      issue_id: id,
      issue_identifier: 'INT-1',
    }),
    retryIssue: async (id: string) => ({
      accepted: true,
      status: 'queued',
      message: `Queued ${id}`,
      issue_id: id,
      issue_identifier: 'INT-1',
    }),
    closeIssue: async (id: string, request = {}) => {
      closeIssueCalls.push({
        id,
        successorIssueId: request.successor_issue_id ?? null,
        reason: request.reason ?? null,
      });
      return {
        accepted: true,
        status: 'completed',
        message: request.successor_issue_id
          ? `Closed ${id}; successor ${request.successor_issue_id}`
          : `Closed ${id}`,
        issue_id: id,
        issue_identifier: 'INT-1',
      };
    },
    overrideGovernance: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Governance override approved for ${id}`,
      issue_id: id,
      issue_identifier: 'INT-1',
    }),
    rewriteGovernance: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Governance rewrite applied for ${id}`,
      issue_id: id,
      issue_identifier: 'INT-1',
    }),
    splitGovernance: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Governance split applied for ${id}`,
      issue_id: id,
      issue_identifier: 'INT-1',
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
    closeIssueCalls,
  };
  return runtime;
}

class MemoryNotifier implements BotTransportNotifier {
  public readonly messages: Array<{ recipient: BotRecipient; message: BotTransportMessage }> = [];

  async sendMessage(recipient: BotRecipient, message: BotTransportMessage) {
    this.messages.push({ recipient, message });
    return {
      provider_message_id: `msg-${this.messages.length}`,
    };
  }

  async editMessage(recipient: BotRecipient, _messageRef: { provider_message_id: string }, message: BotTransportMessage) {
    this.messages.push({ recipient, message });
    return {
      provider_message_id: `msg-${this.messages.length}`,
    };
  }
}

describe('BotCommandService', () => {
  test('parses Telegram-style text commands', () => {
    expect(parseTextCommand('/status INT-1')).toEqual({
      command: 'status',
      issue_id: 'INT-1',
      raw_text: '/status INT-1',
    });

    expect(parseTextCommand('/new Fix login\nAdd validation')).toEqual({
      command: 'new',
      project_slug: null,
      create_issue: {
        title: 'Fix login',
        description: 'Add validation',
        project_slug: null,
      },
      raw_text: '/new Fix login\nAdd validation',
    });

    expect(parseTextCommand('/project test2')).toEqual({
      command: 'project',
      project_slug: 'test2',
      raw_text: '/project test2',
    });

    expect(parseTextCommand('/clear')).toEqual({
      command: 'clear',
      raw_text: '/clear',
    });

    expect(parseTextCommand('/watch off INT-1').command).toBe('unwatch');
    expect(parseTextCommand('/watch verbose INT-1')).toEqual({
      command: 'watch',
      issue_id: 'INT-1',
      watch_preset: 'verbose',
      raw_text: '/watch verbose INT-1',
    });

    expect(parseTextCommand('/override INT-1')).toEqual({
      command: 'override',
      issue_id: 'INT-1',
      raw_text: '/override INT-1',
    });

    expect(parseTextCommand('/rewrite INT-1')).toEqual({
      command: 'rewrite',
      issue_id: 'INT-1',
      raw_text: '/rewrite INT-1',
    });

    expect(parseTextCommand('/split INT-1')).toEqual({
      command: 'split',
      issue_id: 'INT-1',
      raw_text: '/split INT-1',
    });

    expect(parseTextCommand('/close INT-1')).toEqual({
      command: 'close_issue',
      issue_id: 'INT-1',
      raw_text: '/close INT-1',
    });

    expect(parseTextCommand('/supersede INT-1 INT-2')).toEqual({
      command: 'supersede_issue',
      issue_id: 'INT-1',
      successor_issue_id: 'INT-2',
      raw_text: '/supersede INT-1 INT-2',
    });
  });

  test('executes status/new/stop/retry/watch commands on the shared runtime control plane', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const notifier = new MemoryNotifier();
    const subscriptions = new BotSubscriptionService(runtime, {
      telegram: notifier,
    });
    const preferences = new BotConversationPreferenceRepository(db);
    const projectResolver = {
      listConfiguredProjectSlugs: () => ['test2'],
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
        },
      }),
    } as any;
    const service = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const context = {
      transport: 'telegram' as const,
      recipient: {
        transport: 'telegram' as const,
        conversation_id: 'chat-1',
      },
      identity: {
        user_id: 'user-1',
        display_name: 'Alice',
      },
    };

    const status = await service.executeText(context, '/status INT-1');
    expect(status.message).toContain('INT-1');
    expect(status.message).toContain('recent timeline');

    const setProject = await service.executeText(context, '/project test2');
    expect(setProject.message).toContain('Default project set to test2');

    const created = await service.executeText(context, '/new Build dashboard\nTrack progress');
    expect(created.message).toBe('Got it, created INT-2 · Created by bot');
    expect(created.caption).toContain('INT-2');
    expect(created.photo?.content_type).toBe('image/png');
    expect(created.media_key).toContain('issue-card|INT-2');
    expect(created.action_rows?.flat().map((action) => action.label)).toEqual([
      'Refresh Card',
      'Refresh Card',
      'Open Runtime View',
    ]);
    expect(created.action_rows?.[1]?.[1]?.web_app?.url).toBe('/runtime/issues/INT-2/app');

    const watched = await service.executeText(context, '/watch INT-1');
    expect(watched.watch_registered).toBe(true);
    expect(watched.message).toContain('Watching INT-1');

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-2',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:02:00.000Z',
        level: 'info',
        category: 'tool',
        code: 'tool_completed',
        message: 'Write completed',
        turn: 2,
        tool_name: 'Write',
        detail: {
          path: '/tmp/workspaces/INT-1/report.txt',
        },
      },
    });
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]?.message.text).toContain('Write completed');

    const stop = await service.executeText(context, '/stop INT-1');
    expect(stop.message).toBe('Stopping INT-1');

    const retry = await service.executeText(context, '/retry INT-1');
    expect(retry.message).toBe('Queued INT-1');

    const supersede = await service.executeText(context, '/supersede INT-1 INT-2');
    expect(supersede.message).toBe('Closed INT-1; successor INT-2');
    expect(runtime.closeIssueCalls).toEqual([
      {
        id: 'INT-1',
        successorIssueId: 'INT-2',
        reason: 'Superseded from bot command.',
      },
    ]);

    const override = await service.executeText(context, '/override INT-1');
    expect(override.message).toContain('override approved');

    const rewrite = await service.executeText(context, '/rewrite INT-1');
    expect(rewrite.message).toContain('rewrite applied');

    const split = await service.executeText(context, '/split INT-1');
    expect(split.message).toContain('split applied');

    const unwatch = await service.executeText(context, '/unwatch INT-1');
    expect(unwatch.watch_registered).toBe(false);

    subscriptions.dispose();
    db.close();
  });

  test('keeps slash-command text on the explicit machine-mode path', async () => {
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const service = new BotCommandService(runtime, subscriptions);
    const context = {
      transport: 'telegram' as const,
      recipient: {
        transport: 'telegram' as const,
        conversation_id: 'chat-machine-path',
      },
      identity: {
        user_id: 'user-1',
        display_name: 'Alice',
      },
    };

    const viaText = await service.executeText(context, '/status INT-1');
    const viaParsedRequest = await service.execute(context, {
      command: 'status',
      issue_id: 'INT-1',
      raw_text: '/status INT-1',
    });

    expect(viaText).toEqual(viaParsedRequest);
    expect(viaText.message).toContain('INT-1');

    subscriptions.dispose();
  });

  test('returns a clear watch error when outbound notifications are not configured', async () => {
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const service = new BotCommandService(runtime, subscriptions);

    const response = await service.executeText(
      {
        transport: 'discord',
        recipient: {
          transport: 'discord',
          conversation_id: 'channel-1',
        },
        identity: {
          user_id: 'user-1',
          display_name: 'Alice',
        },
      },
      '/watch INT-1',
    );

    expect(response.watch_registered).toBeUndefined();
    expect(response.message).toContain('discord watch notifications are not configured');

    subscriptions.dispose();
  });

  test('registers an origin follow-up and returns an issue card when Telegram creates an issue', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const followups = new BotIssueFollowupRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-42',
      default_project_slug: 'test2',
    });

    const service = new BotCommandService(
      runtime,
      subscriptions,
      () => true,
      preferences,
      null,
      followups,
    );

    const response = await service.execute(
      {
        transport: 'telegram',
        recipient: {
          transport: 'telegram',
          conversation_id: 'chat-42',
        },
        identity: {
          user_id: 'user-1',
          display_name: 'Alice',
        },
      },
      {
        command: 'new',
        create_issue: {
          title: 'Need a split-first issue',
        },
      },
    );

    expect(response.issue_id).toBe('issue-2');
    expect(response.message).toBe('Got it, created INT-2 · Created by bot');
    expect(response.media_key).toContain('issue-card|INT-2');
    expect(response.photo?.content_type).toBe('image/png');
    expect(response.action_rows?.flat().some((action) => action.web_app?.url === '/runtime/issues/INT-2/app')).toBe(true);
    expect(followups.findByIssueId('issue-2')).toHaveLength(1);
    expect(followups.findByIssueId('issue-2')[0]?.conversation_id).toBe('chat-42');

    subscriptions.dispose();
    db.close();
  });

  test('denies write commands for read-only bot users', async () => {
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const service = new (BotCommandService as any)(
      runtime,
      subscriptions,
      () => false,
    );

    const response = await service.executeText(
      {
        transport: 'telegram',
        recipient: {
          transport: 'telegram',
          conversation_id: 'chat-1',
        },
        identity: {
          user_id: 'viewer-1',
          display_name: 'Viewer',
        },
      },
      '/stop INT-1',
    );

    expect(response.message).toContain('read-only');

    subscriptions.dispose();
  });
});
