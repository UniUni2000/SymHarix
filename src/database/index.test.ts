/**
 * Tests for the trimmed control-plane database layer
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  AgentRunRepository,
  BotConversationPreferenceRepository,
  BotPendingActionRepository,
  BotWatchSubscriptionRepository,
  RepoCacheRepository,
  ReviewEventRepository,
  ServiceLeaseRepository,
  SyncEventRepository,
  WorkItemRepository,
} from './index';
import { dropAllTables, initializeSchema } from './schema';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
});

describe('database schema', () => {
  test('creates only control-plane tables', () => {
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = rows.map((row) => row.name);

    expect(tableNames).toContain('work_items');
    expect(tableNames).toContain('repo_caches');
    expect(tableNames).toContain('agent_runs');
    expect(tableNames).toContain('review_events');
    expect(tableNames).toContain('sync_events');
    expect(tableNames).toContain('service_leases');
    expect(tableNames).toContain('bot_watch_subscriptions');
    expect(tableNames).toContain('bot_conversation_preferences');
    expect(tableNames).toContain('bot_pending_actions');
    expect(tableNames).not.toContain('tasks');
    expect(tableNames).not.toContain('execution_events');
  });

  test('dropAllTables removes control-plane tables', () => {
    dropAllTables(db);

    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;

    expect(rows).toEqual([]);
  });
});

describe('WorkItemRepository', () => {
  test('creates and updates a work item', () => {
    const repository = new WorkItemRepository(db);

    repository.create({
      id: 'wi-1',
      linear_issue_id: 'linear-1',
      linear_identifier: 'INT-1',
      linear_title: 'First item',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
    });

    const updated = repository.update({
      id: 'wi-1',
      linear_state: 'In Review',
      active_pr_number: 42,
      orchestrator_state: 'review_running',
    });

    expect(updated?.linear_state).toBe('In Review');
    expect(updated?.active_pr_number).toBe(42);
    expect(repository.findByIdentifier('INT-1')?.id).toBe('wi-1');
  });
});

describe('RepoCacheRepository', () => {
  test('stores repo cache metadata', () => {
    const repository = new RepoCacheRepository(db);

    repository.create({
      id: 'cache-1',
      github_repo: 'acme/repo',
      local_source_path: '/tmp/cache/repo/source',
      last_fetch_commit: 'abc123',
    });

    const cache = repository.findByGitHubRepo('acme/repo');
    expect(cache?.local_source_path).toBe('/tmp/cache/repo/source');
    expect(cache?.last_fetch_commit).toBe('abc123');
  });
});

describe('AgentRunRepository', () => {
  test('stores runs in start order', () => {
    const workItems = new WorkItemRepository(db);
    const repository = new AgentRunRepository(db);

    workItems.create({
      id: 'wi-runs',
      linear_issue_id: 'linear-runs',
      linear_identifier: 'INT-RUNS',
      linear_title: 'Run item',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
    });

    repository.create({
      id: 'run-1',
      work_item_id: 'wi-runs',
      agent_type: 'dev',
      phase: 'dev',
      input_summary: 'first',
    });
    repository.create({
      id: 'run-2',
      work_item_id: 'wi-runs',
      agent_type: 'review',
      phase: 'review',
      input_summary: 'second',
    });

    const runs = repository.findByWorkItemId('wi-runs');
    expect(runs.map((run) => run.id)).toEqual(['run-1', 'run-2']);
  });
});

describe('ReviewEventRepository', () => {
  test('returns latest review event', () => {
    const workItems = new WorkItemRepository(db);
    const repository = new ReviewEventRepository(db);

    workItems.create({
      id: 'wi-review',
      linear_issue_id: 'linear-review',
      linear_identifier: 'INT-REVIEW',
      linear_title: 'Review item',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      active_pr_number: 99,
    });

    repository.create({
      id: 'review-1',
      work_item_id: 'wi-review',
      pr_number: 99,
      review_round: 1,
      decision: 'REQUEST_CHANGES',
      summary_md: 'Need tests',
    });
    repository.create({
      id: 'review-2',
      work_item_id: 'wi-review',
      pr_number: 99,
      review_round: 2,
      decision: 'APPROVE',
      summary_md: 'Looks good',
    });

    expect(repository.findLatestByWorkItemId('wi-review')?.id).toBe('review-2');
  });
});

describe('SyncEventRepository', () => {
  test('stores failed sync events for retry/audit', () => {
    const workItems = new WorkItemRepository(db);
    const repository = new SyncEventRepository(db);

    workItems.create({
      id: 'wi-sync',
      linear_issue_id: 'linear-sync',
      linear_identifier: 'INT-SYNC',
      linear_title: 'Sync item',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
    });

    repository.create({
      id: 'sync-1',
      work_item_id: 'wi-sync',
      target_system: 'github',
      action: 'comment',
      payload_json: { body: 'summary' },
      result: 'failed',
      error: 'boom',
    });

    const failed = repository.findFailed();
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('boom');
  });
});

describe('ServiceLeaseRepository', () => {
  test('acquires, blocks competing holders, and releases leases', () => {
    const repository = new ServiceLeaseRepository(db);
    const now = new Date('2026-04-21T00:00:00.000Z');

    const first = repository.acquire({
      lease_key: 'orchestrator:primary',
      holder_id: 'holder-a',
      holder_pid: 1001,
      holder_host: 'host-a',
      ttl_ms: 30_000,
      now,
    });
    expect(first.acquired).toBe(true);
    expect(first.lease?.holder_id).toBe('holder-a');

    const blocked = repository.acquire({
      lease_key: 'orchestrator:primary',
      holder_id: 'holder-b',
      holder_pid: 1002,
      holder_host: 'host-b',
      ttl_ms: 30_000,
      now: new Date('2026-04-21T00:00:10.000Z'),
    });
    expect(blocked.acquired).toBe(false);
    expect(blocked.lease?.holder_id).toBe('holder-a');

    expect(repository.release('orchestrator:primary', 'holder-a')).toBe(true);

    const second = repository.acquire({
      lease_key: 'orchestrator:primary',
      holder_id: 'holder-b',
      holder_pid: 1002,
      holder_host: 'host-b',
      ttl_ms: 30_000,
      now: new Date('2026-04-21T00:00:11.000Z'),
    });
    expect(second.acquired).toBe(true);
    expect(second.lease?.holder_id).toBe('holder-b');
  });

  test('allows takeover after lease expiry', () => {
    const repository = new ServiceLeaseRepository(db);

    repository.acquire({
      lease_key: 'orchestrator:primary',
      holder_id: 'holder-a',
      ttl_ms: 1_000,
      now: new Date('2026-04-21T00:00:00.000Z'),
    });

    const takeover = repository.acquire({
      lease_key: 'orchestrator:primary',
      holder_id: 'holder-b',
      ttl_ms: 30_000,
      now: new Date('2026-04-21T00:00:05.000Z'),
    });

    expect(takeover.acquired).toBe(true);
    expect(takeover.lease?.holder_id).toBe('holder-b');
  });
});

describe('BotWatchSubscriptionRepository', () => {
  test('persists and removes watch subscriptions by conversation and issue', () => {
    const repository = new BotWatchSubscriptionRepository(db);

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      preset: 'verbose',
    });

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      preset: 'failures',
    });

    const stored = repository.findAll();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.preset).toBe('failures');

    expect(
      repository.delete({
        transport: 'telegram',
        conversation_id: 'chat-1',
        issue_id: 'issue-1',
      }),
    ).toBe(true);
    expect(repository.findAll()).toHaveLength(0);
  });
});

describe('BotConversationPreferenceRepository', () => {
  test('persists, updates, and clears a default project per conversation', () => {
    const repository = new BotConversationPreferenceRepository(db);

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      default_project_slug: 'test2',
    });

    expect(
      repository.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      })?.default_project_slug,
    ).toBe('test2');

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      default_project_slug: 'backend-core',
    });

    expect(
      repository.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      })?.default_project_slug,
    ).toBe('backend-core');

    expect(
      repository.delete({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toBe(true);
    expect(
      repository.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toBeNull();
  });
});

describe('BotPendingActionRepository', () => {
  test('stores one pending action per conversation and deletes expired actions', () => {
    const repository = new BotPendingActionRepository(db);

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      intent_kind: 'create_issue',
      normalized_payload: {
        command: 'new',
        create_issue: {
          title: 'Build dashboard',
          description: 'Track progress',
          project_slug: 'test2',
        },
      },
      summary_message: 'Action: create issue',
      expires_at: new Date('2026-01-01T00:15:00.000Z'),
    });

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      intent_kind: 'retry',
      normalized_payload: {
        command: 'retry',
        issue_id: 'INT-1',
      },
      summary_message: 'Action: retry',
      expires_at: new Date('2026-01-01T00:20:00.000Z'),
    });

    const stored = repository.findByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    expect(stored?.intent_kind).toBe('retry');
    expect(stored?.summary_message).toBe('Action: retry');

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-expired',
      user_id: 'user-1',
      intent_kind: 'create_issue',
      normalized_payload: {
        command: 'new',
      },
      summary_message: 'Expired action',
      expires_at: new Date('2025-12-31T23:59:59.000Z'),
    });

    expect(repository.deleteExpired(new Date('2026-01-01T00:00:00.000Z'))).toBe(1);
    expect(
      repository.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-expired',
      }),
    ).toBeNull();

    expect(
      repository.delete({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toBe(true);
    expect(
      repository.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toBeNull();
  });
});
