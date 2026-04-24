/**
 * Tests for the trimmed control-plane database layer
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  AgentRunRepository,
  BotFollowupDeliveryStateRepository,
  BotFollowupMessageStateRepository,
  BotConversationPreferenceRepository,
  BotIssueFollowupRepository,
  BotPendingActionRepository,
  BotTransportEventRepository,
  BotWatchSubscriptionRepository,
  ConflictMemoryRepository,
  DebtSignalRepository,
  DecisionMemoryRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  RepoCacheRepository,
  ReviewEventRepository,
  ServiceLeaseRepository,
  ShadowHarnessRepository,
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
    expect(tableNames).toContain('bot_issue_followups');
    expect(tableNames).toContain('bot_followup_message_states');
    expect(tableNames).toContain('bot_followup_delivery_states');
    expect(tableNames).toContain('bot_transport_events');
    expect(tableNames).toContain('shadow_harnesses');
    expect(tableNames).toContain('governance_assessments');
    expect(tableNames).toContain('decision_memories');
    expect(tableNames).toContain('conflict_memories');
    expect(tableNames).toContain('debt_signals');
    expect(tableNames).toContain('governance_suggestions');
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
      touched_paths: ['src/runtime/hub.ts'],
      touched_areas: ['runtime'],
      path_families: ['runtime/hub'],
      boundary_edges: [],
      import_edges: ['runtime/hub->server/routes'],
      architectural_target: 'runtime/hub->server/routes',
    });

    const updated = repository.update({
      id: 'wi-1',
      linear_state: 'In Review',
      active_pr_number: 42,
      orchestrator_state: 'review_running',
      touched_paths: ['src/runtime/hub.ts', 'src/runtime/types.ts'],
      touched_areas: ['runtime', 'server'],
      path_families: ['runtime/hub', 'runtime/types'],
      boundary_edges: ['runtime<->server'],
      import_edges: ['runtime/hub->server/routes'],
      architectural_target: 'runtime<->server',
    });

    expect(updated?.linear_state).toBe('In Review');
    expect(updated?.active_pr_number).toBe(42);
    expect(updated?.touched_paths).toEqual(['src/runtime/hub.ts', 'src/runtime/types.ts']);
    expect(updated?.touched_areas).toEqual(['runtime', 'server']);
    expect(updated?.path_families).toEqual(['runtime/hub', 'runtime/types']);
    expect(updated?.boundary_edges).toEqual(['runtime<->server']);
    expect(updated?.import_edges).toEqual(['runtime/hub->server/routes']);
    expect(updated?.architectural_target).toBe('runtime<->server');
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

describe('ShadowHarnessRepository', () => {
  test('stores provisional repo harness metadata by repo key', () => {
    const repository = new ShadowHarnessRepository(db);

    repository.upsert({
      repo_key: 'acme/repo',
      source: 'shadow',
      config_json: {
        commands: {
          test: 'bun test',
        },
      },
      inference_details_json: {
        inferred_from: ['package.json'],
      },
      successful_runs: 1,
      failed_runs: 0,
    });

    const stored = repository.findByRepoKey('acme/repo');
    expect(stored?.config_json.commands?.test).toBe('bun test');
    expect(stored?.inference_details_json.inferred_from).toEqual(['package.json']);
    expect(stored?.inference_details_json.learning_confidence).toBe('low');
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

describe('Governance repositories', () => {
  test('store governance assessments, suggestions, and repo memories', () => {
    const workItems = new WorkItemRepository(db);
    const assessmentRepository = new GovernanceAssessmentRepository(db);
    const suggestionRepository = new GovernanceSuggestionRepository(db);
    const decisionRepository = new DecisionMemoryRepository(db);
    const conflictRepository = new ConflictMemoryRepository(db);
    const debtSignalRepository = new DebtSignalRepository(db);

    workItems.create({
      id: 'wi-governance',
      linear_issue_id: 'linear-governance',
      linear_identifier: 'INT-GOV',
      linear_title: 'Governance item',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
    });

    assessmentRepository.create({
      id: 'assessment-1',
      work_item_id: 'wi-governance',
      issue_id: 'linear-governance',
      decision: 'accept_with_rewrite',
      status: 'advisory',
      summary: 'Prefer consolidating this path into the existing runtime control plane.',
      constitution_hits_json: [{ section: 'Preferred Directions', phrase: 'single runtime control plane' }],
      detail_json: { source: 'test' },
    });

    suggestionRepository.create({
      id: 'suggestion-1',
      work_item_id: 'wi-governance',
      issue_id: 'linear-governance',
      suggestion_type: 'cleanup',
      status: 'pending',
      title: '[GOVERNANCE] Clean up duplicate runtime paths',
      summary: 'The runtime control plane is starting to split.',
      detail_json: { severity: 'medium' },
    });

    decisionRepository.create({
      id: 'decision-1',
      repo_key: 'acme/repo',
      summary: 'Runtime DTO changes should stay inside the shared control plane.',
      detail_json: {
        source_issue_identifier: 'INT-GOV',
        touched_areas: ['runtime'],
      },
    });

    conflictRepository.create({
      id: 'conflict-1',
      repo_key: 'acme/repo',
      summary: 'Vague multi-surface runtime changes keep getting rewritten or split.',
      detail_json: {
        trigger: 'split_before_implement',
      },
    });

    debtSignalRepository.create({
      id: 'debt-1',
      repo_key: 'acme/repo',
      signal_code: 'repeated_review_churn',
      summary: 'Runtime changes are repeatedly sent back from review.',
      severity: 'high',
      detail_json: {
        review_rounds: 3,
      },
    });

    expect(assessmentRepository.findLatestByWorkItemId('wi-governance')?.decision).toBe('accept_with_rewrite');
    expect(suggestionRepository.findPendingByIssueId('linear-governance')).toHaveLength(1);
    expect(decisionRepository.findByRepoKey('acme/repo')).toHaveLength(1);
    expect(conflictRepository.findByRepoKey('acme/repo')).toHaveLength(1);
    expect(debtSignalRepository.findByRepoKey('acme/repo')).toHaveLength(1);
    expect(debtSignalRepository.findActiveByRepoKey('acme/repo')[0]?.signal_code).toBe('repeated_review_churn');
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

describe('BotIssueFollowupRepository', () => {
  test('persists origin follow-up bindings by conversation and issue', () => {
    const repository = new BotIssueFollowupRepository(db);

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-2',
      role: 'origin',
    });

    expect(repository.findByIssueId('issue-1')).toHaveLength(1);
    expect(repository.findByIssueId('issue-1')[0]?.user_id).toBe('user-2');
    expect(
      repository.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toHaveLength(1);
  });
});

describe('BotFollowupMessageStateRepository', () => {
  test('persists one active follow-up card state per conversation and issue', () => {
    const repository = new BotFollowupMessageStateRepository(db);

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      message_id: '101',
      card_kind: 'governance_blocked',
      card_key: 'blocked|split_before_implement|suggestion-1',
      card_state: 'open',
    });

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      message_id: '101',
      card_kind: 'governance_blocked',
      card_key: 'blocked|split_before_implement|suggestion-1|confirm',
      card_state: 'confirming',
    });

    const stored = repository.findByConversationIssue({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
    });

    expect(stored?.message_id).toBe('101');
    expect(stored?.card_key).toContain('confirm');
    expect(stored?.card_state).toBe('confirming');
    expect(
      repository.findOpenByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toHaveLength(1);

    repository.updateState({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
      card_state: 'resolved',
    });

    expect(
      repository.findOpenByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toHaveLength(0);
  });
});

describe('BotFollowupDeliveryStateRepository', () => {
  test('persists one delivery baseline per conversation, root issue, and delivery kind', () => {
    const repository = new BotFollowupDeliveryStateRepository(db);

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      root_issue_id: 'issue-root',
      root_issue_identifier: 'INT-1',
      delivery_kind: 'governance_card',
      last_material_key: 'blocked|split|reason-a',
      last_notification_class: null,
      last_message_id: '101',
    });

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      root_issue_id: 'issue-root',
      root_issue_identifier: 'INT-1',
      delivery_kind: 'governance_card',
      last_material_key: 'blocked|split|reason-a',
      last_notification_class: null,
      last_message_id: '101',
    });

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      root_issue_id: 'issue-root',
      root_issue_identifier: 'INT-1',
      delivery_kind: 'lifecycle_digest',
      last_material_key: 'class:retrying',
      last_notification_class: 'retrying',
      last_message_id: '202',
    });

    expect(
      repository.findByKey({
        transport: 'telegram',
        conversation_id: 'chat-1',
        root_issue_id: 'issue-root',
        delivery_kind: 'governance_card',
      }),
    ).toEqual(expect.objectContaining({
      last_material_key: 'blocked|split|reason-a',
      last_message_id: '101',
    }));
    expect(
      repository.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toHaveLength(2);
  });
});

describe('BotTransportEventRepository', () => {
  test('stores outbound bot transport audit events for replay and debugging', () => {
    const repository = new BotTransportEventRepository(db);

    repository.create({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-root',
      root_issue_id: 'issue-root',
      source: 'followup_card',
      message_id: '101',
      action: 'send',
      result: 'success',
      material_key: 'blocked|split|reason-a',
    });

    repository.create({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-root',
      root_issue_id: 'issue-root',
      source: 'callback_update',
      message_id: '101',
      action: 'edit',
      result: 'failed',
      material_key: 'confirming|blocked|split|reason-a',
      error_message: 'message to edit not found',
    });

    const events = repository.findByRootIssue({
      transport: 'telegram',
      conversation_id: 'chat-1',
      root_issue_id: 'issue-root',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({
      source: 'callback_update',
      action: 'edit',
      result: 'failed',
      error_message: 'message to edit not found',
    }));
    expect(events[1]).toEqual(expect.objectContaining({
      source: 'followup_card',
      action: 'send',
      result: 'success',
    }));
  });
});

describe('BotPendingActionRepository', () => {
  test('stores generic and issue-scoped pending actions independently and deletes expired actions', () => {
    const repository = new BotPendingActionRepository(db);

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: null,
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
      status: 'pending_confirm',
      message_id: null,
      card_key: null,
    });

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
      user_id: 'user-1',
      intent_kind: 'split',
      normalized_payload: {
        command: 'split',
        issue_id: 'issue-1',
      },
      summary_message: 'Action: split',
      expires_at: new Date('2026-01-01T00:20:00.000Z'),
      status: 'executing',
      message_id: '101',
      card_key: 'blocked|INT-1',
    });

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-2',
      user_id: 'user-1',
      intent_kind: 'override',
      normalized_payload: {
        command: 'override',
        issue_id: 'issue-2',
      },
      summary_message: 'Action: override',
      expires_at: new Date('2026-01-01T00:25:00.000Z'),
      status: 'pending_confirm',
      message_id: '202',
      card_key: 'blocked|INT-2',
    });

    const generic = repository.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-1',
    });
    const issueScoped = repository.findByConversationIssue({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-1',
    });
    expect(generic?.intent_kind).toBe('create_issue');
    expect(generic?.summary_message).toBe('Action: create issue');
    expect(issueScoped?.intent_kind).toBe('split');
    expect(issueScoped?.status).toBe('executing');
    expect(issueScoped?.message_id).toBe('101');
    expect(
      repository.findOpenByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }).map((record) => [record.issue_id, record.status]),
    ).toEqual([
      ['issue-2', 'pending_confirm'],
      ['issue-1', 'executing'],
    ]);

    repository.upsert({
      transport: 'telegram',
      conversation_id: 'chat-expired',
      issue_id: 'issue-expired',
      user_id: 'user-1',
      intent_kind: 'create_issue',
      normalized_payload: {
        command: 'new',
      },
      summary_message: 'Expired action',
      expires_at: new Date('2025-12-31T23:59:59.000Z'),
      status: 'pending_confirm',
      message_id: '303',
      card_key: 'blocked|expired',
    });

    expect(repository.deleteExpired(new Date('2026-01-01T00:00:00.000Z'))).toBe(1);
    expect(
      repository.findByConversationIssue({
        transport: 'telegram',
        conversation_id: 'chat-expired',
        issue_id: 'issue-expired',
      }),
    ).toBeNull();

    expect(
      repository.delete({
        transport: 'telegram',
        conversation_id: 'chat-1',
        issue_id: 'issue-1',
      }),
    ).toBe(true);
    expect(
      repository.findByConversationIssue({
        transport: 'telegram',
        conversation_id: 'chat-1',
        issue_id: 'issue-1',
      }),
    ).toBeNull();
  });
});
