import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initializeSchema,
  SupervisorMemoryRepository,
  SupervisorJobRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import { SupervisorJobLoop } from './jobLoop';
import { SupervisorDevConversationService } from './devConversation';

function createIssue(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-root',
    work_item_id: 'work-item-root',
    identifier: 'INT-91',
    title: '清理 runtime 残余文件',
    phase: 'DEV',
    tracker_state: 'In Progress',
    orchestrator_state: 'retry_scheduled',
    workspace_path: '/tmp/workspace',
    branch_name: 'liupenghui/int-91-cleanup',
    github_repo: 'UniUni2000/test2',
    github_issue_number: 91,
    active_pr_number: null,
    session: null,
    governance_status: null,
    governance_decision: null,
    governance_summary: null,
    governance_root_issue_id: 'issue-root',
    governance_root_issue_identifier: 'INT-91',
    governance_thread_state: 'executing',
    governance_child_issues: [],
    governance_current_child: null,
    governance_child_queue: [],
    next_recommended_action: '继续按计划清理。',
    delivery_state: null,
    delivery_code: null,
    delivery_summary: null,
    active_governance_suggestions: [],
    actions: {
      can_stop: true,
      can_retry: true,
      can_open_pr: false,
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T01:00:00.000Z',
    ...overrides,
  };
}

describe('SupervisorJobLoop', () => {
  test('recovers active sessions, replays current runtime state, and writes durable supervision memory', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const memories = new SupervisorMemoryRepository(db);
    const issue = createIssue();
    const runtime: RuntimeControlPlane = {
      getOverview: () => ({
        generated_at: '2026-01-01T01:00:00.000Z',
        counts: { running: 1, retrying: 1, total: 1 },
        issues: [issue],
      }),
      getIssue: () => issue,
      getTimeline: () => [],
      getHistoryView: () => null,
      subscribe: () => () => undefined,
      createIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null, issue: null }),
      stopIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      retryIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      overrideGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      rewriteGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      splitGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      executeGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      dismissGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
    };
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'executing',
      repo_ref: 'UniUni2000/test2',
      root_issue_id: issue.issue_id,
      plan_card: {
        title: '清理 runtime 残余文件',
        user_goal: '清空安全范围内的残余文件',
        in_scope: ['识别残余文件', '删除临时产物'],
        out_of_scope: ['不删除业务源码'],
        acceptance: ['残余文件清理完成'],
        known_risks: ['误删风险'],
        execution_strategy: '先审计再删除。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '自动执行', summary: '继续推进。' },
        alternate_option: null,
        governance_preview: null,
      },
      last_material_outcome: {
        oversight_key: 'oversight|session-1|1|retrying|llm',
        supervisor_decision: 'continue',
        supervisor_reason: 'llm_supervision',
        dev_instruction: '下一轮先检查 git status，再删除临时产物。',
        user_summary: '监督脑已给出下一轮清理指令。',
      },
    });

    const loop = new SupervisorJobLoop({
      runtime,
      sessionRepository: sessions,
      eventRepository: events,
      memoryRepository: memories,
      syncIssue: (runtimeIssue) => {
        events.create({
          id: `sync-${runtimeIssue.issue_id}`,
          session_id: 'session-1',
          event_kind: 'test_sync',
          payload_json: { issue_id: runtimeIssue.issue_id },
        });
      },
    });

    const result = await loop.tick();

    expect(result.sessions_checked).toBe(1);
    expect(result.issues_synced).toBe(1);
    expect(result.memories_written).toBe(1);
    expect(events.listBySession('session-1').some((event) => event.event_kind === 'supervisor_job_tick')).toBe(true);
    expect(memories.listRelevant('UniUni2000/test2', 5)[0]?.summary).toContain('下一轮先检查 git status');
  });

  test('leases a durable milestone job and writes a supervisor dev directive', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const memories = new SupervisorMemoryRepository(db);
    const jobs = new SupervisorJobRepository(db);
    const issue = createIssue({
      evidence_summary: {
        satisfied: 1,
        total: 2,
        missing: ['git status 证明'],
        requirements: [],
      },
    });
    const runtime: RuntimeControlPlane = {
      getOverview: () => ({
        generated_at: '2026-01-01T01:00:00.000Z',
        counts: { running: 1, retrying: 1, total: 1 },
        issues: [issue],
      }),
      getIssue: () => issue,
      getTimeline: () => [{
        id: 'timeline-1',
        issue_id: issue.issue_id,
        issue_identifier: issue.identifier,
        timestamp: '2026-01-01T01:00:00.000Z',
        type: 'message',
        message: 'Retry scheduled without evidence.',
      } as any],
      getHistoryView: () => null,
      subscribe: () => () => undefined,
      createIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null, issue: null }),
      stopIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      retryIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      overrideGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      rewriteGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      splitGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      executeGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      dismissGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
    };
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'executing',
      repo_ref: 'UniUni2000/test2',
      root_issue_id: issue.issue_id,
      plan_card: {
        title: '清理 runtime 残余文件',
        user_goal: '清空安全范围内的残余文件',
        in_scope: ['识别残余文件', '删除临时产物'],
        out_of_scope: ['不删除业务源码'],
        acceptance: ['git status 证明'],
        known_risks: [],
        execution_strategy: '先审计再删除。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '自动执行', summary: '继续推进。' },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const loop = new SupervisorJobLoop({
      runtime,
      sessionRepository: sessions,
      eventRepository: events,
      memoryRepository: memories,
      jobRepository: jobs,
      devConversationService: new SupervisorDevConversationService(),
      workerId: 'test-loop',
      syncIssue: () => undefined,
    });

    const result = await loop.tick();

    expect(result.jobs_processed).toBe(1);
    const updated = sessions.findById('session-1');
    expect(updated?.last_material_outcome?.latest_dev_directive_kind).toBe('request_evidence');
    expect(String(updated?.last_material_outcome?.latest_dev_instruction)).toContain('补齐证据');
    expect(events.listBySession('session-1').some((event) => event.event_kind === 'supervisor_dev_directive')).toBe(true);
    const directiveJob = jobs.listBySession('session-1')
      .find((job) => job.job_kind === 'issue_dev_instruction');
    expect(directiveJob?.status).toBe('succeeded');
  });

  test('collapses superseded active sessions before polling runtime so stale Telegram decisions do not block new work', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const memories = new SupervisorMemoryRepository(db);
    const issue = createIssue({ issue_id: 'issue-new', identifier: 'INT-102' });
    const runtime: RuntimeControlPlane = {
      getOverview: () => ({
        generated_at: '2026-01-01T01:00:00.000Z',
        counts: { running: 1, retrying: 0, total: 1 },
        issues: [issue],
      }),
      getIssue: (issueId) => issueId === 'issue-new' ? issue : null,
      getTimeline: () => [],
      getHistoryView: () => null,
      subscribe: () => () => undefined,
      createIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null, issue: null }),
      stopIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      retryIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      overrideGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      rewriteGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      splitGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      executeGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      dismissGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
    };

    for (const id of ['old-delivery-decision', 'new-plan']) {
      sessions.create({
        id,
        transport: 'telegram',
        conversation_id: 'chat-1',
        state: 'awaiting_user_decision',
        repo_ref: 'UniUni2000/test2',
        root_issue_id: id === 'new-plan' ? 'issue-new' : 'issue-old',
        active_decision_kind: 'delivery_failure',
        plan_card: {
          title: id,
          user_goal: id,
          in_scope: [id],
          out_of_scope: [],
          acceptance: [id],
          known_risks: [],
          execution_strategy: 'test',
          needs_user_approval: false,
          repo_ref: 'UniUni2000/test2',
          project_slug: 'test2',
          clarification_question: null,
          materialization_mode: 'root_only',
          recommended_option: null,
          alternate_option: null,
          governance_preview: null,
        },
      });
    }
    db.prepare(`UPDATE supervisor_sessions SET created_at = ?, updated_at = ? WHERE id = ?`)
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z', 'old-delivery-decision');
    db.prepare(`UPDATE supervisor_sessions SET created_at = ?, updated_at = ? WHERE id = ?`)
      .run('2026-01-01T00:10:00.000Z', '2026-01-01T00:10:00.000Z', 'new-plan');

    const loop = new SupervisorJobLoop({
      runtime,
      sessionRepository: sessions,
      eventRepository: events,
      memoryRepository: memories,
      syncIssue: () => undefined,
    });

    const result = await loop.tick();

    expect(result.superseded_sessions_cancelled).toBe(1);
    expect(result.sessions_checked).toBe(1);
    expect(sessions.findById('old-delivery-decision')?.state).toBe('cancelled');
    expect(sessions.findById('new-plan')?.state).toBe('awaiting_user_decision');
  });

  test('processes durable supervision jobs for sync, milestone assessment, notification, handoff verification, and memory summary', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const memories = new SupervisorMemoryRepository(db);
    const jobs = new SupervisorJobRepository(db);
    const issue = createIssue({
      orchestrator_state: 'failed',
      delivery_state: 'delivery_failed',
      delivery_code: 'dirty_workspace_no_commit',
      delivery_summary: 'Proof satisfied, but no actionable diff remained after cleanup.',
    });
    let syncedIssueIds: string[] = [];
    const runtime: RuntimeControlPlane = {
      getOverview: () => ({
        generated_at: '2026-01-01T01:00:00.000Z',
        counts: { running: 0, retrying: 0, total: 1 },
        issues: [issue],
      }),
      getIssue: () => issue,
      getTimeline: () => [{
        id: 'timeline-delivery-failed',
        issue_id: issue.issue_id,
        issue_identifier: issue.identifier,
        timestamp: '2026-01-01T01:00:00.000Z',
        type: 'message',
        message: 'Delivery failed after proof was satisfied.',
      } as any],
      getHistoryView: () => null,
      subscribe: () => () => undefined,
      createIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null, issue: null }),
      stopIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      retryIssue: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      overrideGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      rewriteGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      splitGovernance: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      executeGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
      dismissGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'no', issue_id: null, issue_identifier: null }),
    };
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'executing',
      repo_ref: 'UniUni2000/test2',
      root_issue_id: issue.issue_id,
      delivery_state: 'delivery_failed',
      delivery_summary: 'Proof satisfied, delivery failed.',
      active_decision_kind: 'execution_decision',
      plan_card: {
        title: '清理 runtime 残余文件',
        user_goal: '清空安全范围内的残余文件',
        in_scope: ['识别残余文件', '删除临时产物'],
        out_of_scope: ['不删除业务源码'],
        acceptance: ['git status 证明'],
        known_risks: [],
        execution_strategy: '先审计再删除。',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '自动执行', summary: '继续推进。' },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const loop = new SupervisorJobLoop({
      runtime,
      sessionRepository: sessions,
      eventRepository: events,
      memoryRepository: memories,
      jobRepository: jobs,
      devConversationService: new SupervisorDevConversationService(),
      workerId: 'test-loop',
      syncIssue: (runtimeIssue) => {
        syncedIssueIds = [...syncedIssueIds, runtimeIssue.issue_id];
      },
    });

    await loop.tick();
    for (let index = 0; index < 8; index += 1) {
      await loop.tick();
    }

    const sessionEvents = events.listBySession('session-1').map((event) => event.event_kind);
    expect(jobs.listBySession('session-1').map((job) => job.job_kind).sort()).toEqual([
      'assess_milestone',
      'issue_dev_instruction',
      'notify_user',
      'summarize_memory',
      'sync_runtime_state',
      'verify_handoff',
    ].sort());
    expect(jobs.listBySession('session-1').every((job) => job.status === 'succeeded')).toBe(true);
    expect(syncedIssueIds).toContain(issue.issue_id);
    expect(sessionEvents).toContain('supervisor_runtime_state_synced');
    expect(sessionEvents).toContain('supervisor_milestone_assessed');
    expect(sessionEvents).toContain('supervisor_user_notification_requested');
    expect(sessionEvents).toContain('supervisor_handoff_verified');
    expect(sessionEvents).toContain('supervisor_memory_summarized');
    expect(memories.searchRelevant({
      repo_ref: 'UniUni2000/test2',
      query: 'dirty workspace no actionable diff delivery failed',
    })[0]?.summary).toContain('dirty_workspace_no_commit');
  });
});
