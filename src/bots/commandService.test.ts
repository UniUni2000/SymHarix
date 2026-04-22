import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BotCommandService, parseTextCommand } from './commandService';
import { BotSubscriptionService } from './subscriptions';
import { BotConversationPreferenceRepository, initializeSchema } from '../database';
import type { RuntimeControlPlane, RuntimeStreamEvent } from '../runtime/types';
import type { BotRecipient, BotTransportNotifier } from './types';

function createRuntimeControlPlane(): RuntimeControlPlane & { emit: (event: RuntimeStreamEvent) => void } {
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  const runtime: RuntimeControlPlane & { emit: (event: RuntimeStreamEvent) => void } = {
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
      ['issue-1', 'INT-1'].includes(id) ? runtime.getOverview().issues[0] ?? null : null,
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
      issue: null,
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
  };
  return runtime;
}

class MemoryNotifier implements BotTransportNotifier {
  public readonly messages: Array<{ recipient: BotRecipient; message: string }> = [];

  async sendMessage(recipient: BotRecipient, message: string): Promise<void> {
    this.messages.push({ recipient, message });
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
    expect(created.message).toContain('Created');

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
    expect(notifier.messages[0]?.message).toContain('Write completed');

    const stop = await service.executeText(context, '/stop INT-1');
    expect(stop.message).toBe('Stopping INT-1');

    const retry = await service.executeText(context, '/retry INT-1');
    expect(retry.message).toBe('Queued INT-1');

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
