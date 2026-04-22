import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BotSubscriptionService } from './subscriptions';
import { BotWatchSubscriptionRepository } from '../database';
import { initializeSchema } from '../database/schema';
import type { RuntimeControlPlane, RuntimeStreamEvent } from '../runtime/types';
import type { BotRecipient, BotTransportNotifier } from './types';

function createRuntimeControlPlane(): RuntimeControlPlane & { emit: (event: RuntimeStreamEvent) => void } {
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  const issue = {
    issue_id: 'issue-1',
    work_item_id: 'issue-1',
    identifier: 'INT-1',
    title: 'Subscription test',
    phase: 'DEV' as const,
    tracker_state: 'In Progress',
    orchestrator_state: 'dev_running' as const,
    workspace_path: '/tmp/workspaces/INT-1',
    branch_name: 'feature/int-1',
    github_repo: 'acme/repo',
    github_issue_number: 10,
    active_pr_number: null,
    session: null,
    actions: {
      can_stop: true,
      can_retry: false,
      can_open_pr: false,
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  const runtime: RuntimeControlPlane & { emit: (event: RuntimeStreamEvent) => void } = {
    getOverview: () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 1, retrying: 0, total: 1 },
      issues: [issue],
    }),
    getIssue: (id: string) => (id === 'issue-1' || id === 'INT-1' ? issue : null),
    getTimeline: () => [],
    getHistoryView: () => ({
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      digest: {
        headline: 'INT-1 · DEV · In Progress',
        detail: 'Latest update from runtime summary.',
        history_blurb: 'Last review: none',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      entries: [],
    }),
    createIssue: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Created',
      issue_id: 'issue-2',
      issue_identifier: 'INT-2',
      issue: null,
    }),
    stopIssue: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Stopped',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    retryIssue: async () => ({
      accepted: true,
      status: 'queued',
      message: 'Queued',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    rewriteGovernance: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Rewritten',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    splitGovernance: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Split',
      issue_id: 'issue-1',
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

describe('BotSubscriptionService', () => {
  test('supports failure-only watch preferences', async () => {
    const runtime = createRuntimeControlPlane();
    const notifier = new MemoryNotifier();
    const subscriptions = new BotSubscriptionService(runtime, {
      telegram: notifier,
    });

    subscriptions.watch({
      recipient: {
        transport: 'telegram',
        conversation_id: 'chat-1',
      },
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      preset: 'failures',
    } as any);

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-ok',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:01:00.000Z',
        level: 'info',
        category: 'tool',
        code: 'tool_completed',
        message: 'Write completed',
        turn: 1,
        tool_name: 'Write',
        detail: {
          path: '/tmp/workspaces/INT-1/report.txt',
        },
      },
    });

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-fail',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:02:00.000Z',
        level: 'error',
        category: 'tool',
        code: 'tool_failed',
        message: 'Write failed',
        turn: 1,
        tool_name: 'Write',
        detail: {
          path: '/tmp/workspaces/INT-1/report.txt',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]?.message).toContain('Write failed');

    subscriptions.dispose();
  });

  test('restores persisted subscriptions after service recreation', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const repository = new BotWatchSubscriptionRepository(db);
    const runtime = createRuntimeControlPlane();
    const firstNotifier = new MemoryNotifier();
    const firstService = new BotSubscriptionService(
      runtime,
      {
        telegram: firstNotifier,
      },
      repository,
    );

    firstService.watch({
      recipient: {
        transport: 'telegram',
        conversation_id: 'chat-1',
      },
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      preset: 'status',
    } as any);
    firstService.dispose();

    const secondNotifier = new MemoryNotifier();
    const restoredService = new BotSubscriptionService(
      runtime,
      {
        telegram: secondNotifier,
      },
      repository,
    );

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-status',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:03:00.000Z',
        level: 'info',
        category: 'turn',
        code: 'turn_completed',
        message: 'Turn 1 completed',
        turn: 1,
        tool_name: null,
        detail: null,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(secondNotifier.messages).toHaveLength(1);
    expect(secondNotifier.messages[0]?.message).toContain('Turn 1 completed');

    restoredService.dispose();
    db.close();
  });

  test('does not restore a subscription after unwatch removes it from persistence', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const repository = new BotWatchSubscriptionRepository(db);
    const runtime = createRuntimeControlPlane();
    const firstService = new BotSubscriptionService(runtime, {}, repository);

    firstService.watch({
      recipient: {
        transport: 'telegram',
        conversation_id: 'chat-1',
      },
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      preset: 'default',
    } as any);
    expect(
      firstService.unwatch({
        transport: 'telegram',
        conversation_id: 'chat-1',
        issue_id: 'issue-1',
      }),
    ).toBe(true);
    firstService.dispose();

    const secondNotifier = new MemoryNotifier();
    const restoredService = new BotSubscriptionService(
      runtime,
      {
        telegram: secondNotifier,
      },
      repository,
    );

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-default',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:04:00.000Z',
        level: 'info',
        category: 'tool',
        code: 'tool_completed',
        message: 'Read completed',
        turn: 1,
        tool_name: 'Read',
        detail: {
          path: '/tmp/workspaces/INT-1/app.py',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(secondNotifier.messages).toHaveLength(0);

    restoredService.dispose();
    db.close();
  });
});
