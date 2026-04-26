import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initializeSchema,
  SupervisorMemoryRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import { SupervisorJobLoop } from './jobLoop';

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
    branch_name: 'symharix-demo/int-91-cleanup',
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
});
