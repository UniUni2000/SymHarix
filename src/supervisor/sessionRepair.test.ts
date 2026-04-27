import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema, SupervisorSessionRepository } from '../database';
import type { RuntimeControlPlane } from '../runtime/types';
import { SupervisorSessionRepairService } from './sessionRepair';

function runtimeWithNoIssues(): RuntimeControlPlane {
  return {
    getOverview: () => ({ generated_at: new Date().toISOString(), counts: { running: 0, retrying: 0, total: 0 }, issues: [] }),
    getIssue: () => null,
    getTimeline: () => [],
    getHistoryView: () => null,
    createIssue: async () => ({ accepted: false, status: 'rejected', message: 'unsupported' }),
    stopIssue: async () => ({ accepted: false, status: 'rejected', message: 'unsupported' }),
    retryIssue: async () => ({ accepted: false, status: 'rejected', message: 'unsupported' }),
    rewriteGovernance: async () => ({ accepted: false, status: 'rejected', message: 'unsupported' }),
    splitGovernance: async () => ({ accepted: false, status: 'rejected', message: 'unsupported' }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: () => () => undefined,
  };
}

describe('SupervisorSessionRepairService', () => {
  test('cancels stale pre-materialization sessions so old Telegram threads do not block new work', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    sessions.create({
      id: 'session-stale',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_card: null,
      plan_version: 1,
      root_issue_id: null,
      root_work_item_id: null,
      current_child_issue_id: null,
      active_decision_kind: 'plan_approval',
      delivery_state: null,
      delivery_summary: null,
      last_material_outcome: null,
      last_message_id: '100',
      last_card_key: 'session|stale',
    });
    db.prepare(`UPDATE supervisor_sessions SET updated_at = ? WHERE id = ?`)
      .run('2026-01-01T00:00:00.000Z', 'session-stale');

    const summary = new SupervisorSessionRepairService(
      runtimeWithNoIssues(),
      sessions,
      { staleSessionMaxAgeMs: 60_000 },
    ).repair(new Date('2026-01-01T00:10:00.000Z'));

    expect(summary.stale_sessions_cancelled).toBe(1);
    expect(sessions.findById('session-stale')?.state).toBe('cancelled');
  });

  test('completes sessions whose root issue is already completed', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    sessions.create({
      id: 'session-done',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'direct_run',
      approval_mode: 'auto',
      plan_card: null,
      plan_version: 1,
      root_issue_id: 'issue-done',
      root_work_item_id: null,
      current_child_issue_id: null,
      active_decision_kind: null,
      delivery_state: null,
      delivery_summary: null,
      last_material_outcome: null,
      last_message_id: '101',
      last_card_key: 'session|done',
    });

    const runtime = {
      ...runtimeWithNoIssues(),
      getIssue: () => ({
        issue_id: 'issue-done',
        identifier: 'INT-1',
        title: 'Done',
        phase: 'DONE',
        tracker_state: 'Done',
        orchestrator_state: 'completed',
        workspace_path: null,
        branch_name: null,
        github_repo: null,
        github_issue_number: null,
        active_pr_number: null,
        session: null,
        actions: { can_stop: false, can_retry: false, can_open_pr: false },
        created_at: null,
        updated_at: null,
      }),
    } as RuntimeControlPlane;

    const summary = new SupervisorSessionRepairService(runtime, sessions).repair(new Date('2026-01-01T00:10:00.000Z'));

    expect(summary.completed_sessions_closed).toBe(1);
    expect(sessions.findById('session-done')?.state).toBe('completed');
  });

  test('keeps only the newest active session per Telegram conversation', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    for (const id of ['older', 'newer']) {
      sessions.create({
        id,
        transport: 'telegram',
        conversation_id: 'chat-1',
        user_id: 'user-1',
        state: 'awaiting_user_decision',
        repo_ref: 'test2',
        intake_mode: 'plan_then_approve',
        approval_mode: 'explicit_user_approval',
        plan_card: null,
        plan_version: 1,
        root_issue_id: id === 'older' ? 'issue-old' : 'issue-new',
        root_work_item_id: null,
        current_child_issue_id: null,
        active_decision_kind: 'delivery_failure',
        delivery_state: 'delivery_failed',
        delivery_summary: null,
        last_material_outcome: null,
        last_message_id: null,
        last_card_key: null,
      });
    }
    db.prepare(`UPDATE supervisor_sessions SET created_at = ?, updated_at = ? WHERE id = ?`)
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:09:00.000Z', 'older');
    db.prepare(`UPDATE supervisor_sessions SET created_at = ?, updated_at = ? WHERE id = ?`)
      .run('2026-01-01T00:05:00.000Z', '2026-01-01T00:05:00.000Z', 'newer');

    const summary = new SupervisorSessionRepairService(runtimeWithNoIssues(), sessions).repair(new Date('2026-01-01T00:10:00.000Z'));

    expect(summary.superseded_sessions_cancelled).toBe(1);
    expect(sessions.findById('older')?.state).toBe('cancelled');
    expect(sessions.findById('newer')?.state).toBe('awaiting_user_decision');
  });
});
