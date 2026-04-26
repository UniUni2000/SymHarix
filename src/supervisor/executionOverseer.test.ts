import { describe, expect, test } from 'bun:test';
import type { SupervisorSessionRecord } from '../database/types';
import type { RuntimeIssueView } from '../runtime/types';
import type { SupervisorMilestone } from './types';
import { HttpSupervisorExecutionOverseer } from './executionOverseer';

function createSession(overrides: Partial<SupervisorSessionRecord> = {}): SupervisorSessionRecord {
  return {
    id: 'session-1',
    transport: 'telegram',
    conversation_id: 'chat-1',
    user_id: 'user-1',
    state: 'executing',
    repo_ref: 'UniUni2000/test2',
    intake_mode: 'plan_then_approve',
    approval_mode: 'explicit_user_approval',
    plan_card: {
      title: '清理仓库残余文件',
      user_goal: '把仓库里无用残留清干净',
      in_scope: ['识别残留文件', '删除安全范围内的残留', '跑验证'],
      out_of_scope: ['不删除真实业务文件'],
      acceptance: ['无残留临时文件', '测试通过'],
      known_risks: ['误删风险'],
      execution_strategy: '先审计，再最小变更。',
      needs_user_approval: true,
      repo_ref: 'UniUni2000/test2',
      project_slug: null,
      clarification_question: null,
      materialization_mode: 'root_only',
      recommended_option: { label: '批准并开始', summary: '按安全清理计划执行' },
      alternate_option: null,
      governance_preview: null,
    },
    plan_version: 2,
    root_issue_id: 'issue-1',
    root_work_item_id: 'work-item-1',
    current_child_issue_id: null,
    active_decision_kind: null,
    delivery_state: null,
    delivery_summary: null,
    last_material_outcome: null,
    last_message_id: null,
    last_card_key: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createIssue(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-1',
    work_item_id: 'work-item-1',
    identifier: 'INT-60',
    title: '清理仓库残余文件',
    phase: 'DEV',
    tracker_state: 'In Progress',
    orchestrator_state: 'dev_running',
    workspace_path: '/tmp/workspace',
    branch_name: 'liupenghui/int-60-cleanup',
    github_repo: 'UniUni2000/test2',
    github_issue_number: 60,
    active_pr_number: null,
    session: null,
    governance_status: null,
    governance_decision: null,
    governance_summary: null,
    governance_root_issue_id: 'issue-1',
    governance_root_issue_identifier: 'INT-60',
    governance_thread_state: 'executing',
    governance_child_issues: [],
    governance_current_child: null,
    governance_child_queue: [],
    next_recommended_action: '继续清理并验证',
    delivery_state: null,
    delivery_code: null,
    delivery_summary: null,
    active_governance_suggestions: [],
    actions: {
      can_stop: true,
      can_retry: true,
      can_override_governance: false,
      can_rewrite_governance: false,
      can_split_governance: false,
      can_open_pr: false,
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:05:00.000Z',
    ...overrides,
  };
}

function createMilestone(overrides: Partial<SupervisorMilestone> = {}): SupervisorMilestone {
  return {
    kind: 'retrying',
    key: 'retrying|issue-1|1',
    issue_id: 'issue-1',
    issue_identifier: 'INT-60',
    summary: '开发进程刚重试，需要判断下一轮如何推进。',
    delivery_state: null,
    delivery_code: null,
    governance_thread_state: 'executing',
    current_child_issue_id: null,
    ...overrides,
  };
}

function anthropicText(text: string): Response {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text }],
  }), { status: 200 });
}

describe('HttpSupervisorExecutionOverseer', () => {
  test('uses model JSON to produce the next dev instruction', async () => {
    const overseer = new HttpSupervisorExecutionOverseer({
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      timeoutMs: 5_000,
    }, async () => anthropicText(JSON.stringify({
      decision: 'continue',
      reason: 'workspace_cleanup_can_continue',
      dev_instruction: '先列出候选残留文件，逐个确认是否属于临时产物，再提交最小删除。',
      user_summary: '我会让 dev agent 先做安全审计，再清理。',
      active_decision_kind: null,
      confidence: 0.82,
    })));

    const result = await overseer.assess({
      session: createSession(),
      issue: createIssue(),
      milestone: createMilestone(),
    });

    expect(result?.decision).toBe('continue');
    expect(result?.reason).toBe('workspace_cleanup_can_continue');
    expect(result?.dev_instruction).toContain('残留文件');
    expect(result?.user_summary).toContain('dev agent');
    expect(result?.key).toContain('llm');
    expect(result?.source).toBe('llm');
    expect(result?.fallback_reason).toBeNull();
  });

  test('falls back to deterministic oversight when model output is invalid', async () => {
    const overseer = new HttpSupervisorExecutionOverseer({
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      timeoutMs: 5_000,
    }, async () => anthropicText('不是 JSON'));

    const result = await overseer.assess({
      session: createSession(),
      issue: createIssue(),
      milestone: createMilestone(),
    });

    expect(result?.decision).toBe('continue');
    expect(result?.reason).toBe('retrying');
    expect(result?.key).toContain('fallback');
    expect(result?.source).toBe('deterministic');
    expect(result?.fallback_reason).toBe('invalid_model_output');
    expect(result?.dev_instruction).toContain('像架构师复核一样');
  });

  test('does not let the model silently continue after a delivery failure', async () => {
    const overseer = new HttpSupervisorExecutionOverseer({
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      timeoutMs: 5_000,
    }, async () => anthropicText(JSON.stringify({
      decision: 'continue',
      reason: 'ignore_failure',
      dev_instruction: '继续尝试提交。',
      user_summary: '继续。',
      active_decision_kind: null,
    })));

    const result = await overseer.assess({
      session: createSession(),
      issue: createIssue({
        orchestrator_state: 'failed',
        delivery_state: 'delivery_failed',
        delivery_code: 'dirty_workspace_no_commit',
        delivery_summary: '证据满足，但没有可提交代码。',
      }),
      milestone: createMilestone({
        kind: 'delivery_failed',
        key: 'delivery_failed|issue-1|dirty_workspace_no_commit',
        summary: '证据满足，但没有可提交代码。',
        delivery_state: 'delivery_failed',
        delivery_code: 'dirty_workspace_no_commit',
      }),
    });

    expect(result?.decision).toBe('ask_user');
    expect(result?.reason).toBe('delivery_failed');
    expect(result?.active_decision_kind).toBe('delivery_failure');
    expect(result?.key).toContain('guarded');
    expect(result?.source).toBe('deterministic');
    expect(result?.fallback_reason).toBe('guarded_model_continue');
  });
});
