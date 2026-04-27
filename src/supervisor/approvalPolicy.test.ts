import { describe, expect, test } from 'bun:test';
import type { SupervisorOversightAssessment } from './executionOverseer';
import { applySupervisorApprovalPolicy } from './approvalPolicy';

function continueAssessment(overrides: Partial<SupervisorOversightAssessment> = {}): SupervisorOversightAssessment {
  return {
    decision: 'continue',
    reason: 'llm_continue',
    dev_instruction: '继续推进。',
    user_summary: '继续推进。',
    active_decision_kind: null,
    key: 'oversight|session|1|milestone|llm',
    source: 'llm',
    fallback_reason: null,
    ...overrides,
  };
}

describe('applySupervisorApprovalPolicy', () => {
  test('pauses for user approval when a delivery failure is present even if the model says continue', () => {
    const result = applySupervisorApprovalPolicy({
      assessment: continueAssessment(),
      milestone_kind: 'delivery_failed',
      delivery_code: 'dirty_workspace_no_commit',
      delivery_summary: '证据满足，但没有可提交代码。',
      plan_title: '清理仓库残余文件',
      user_text: null,
    });

    expect(result.decision).toBe('ask_user');
    expect(result.active_decision_kind).toBe('delivery_failure');
    expect(result.reason).toBe('approval_policy_delivery_failed');
    expect(result.key).toContain('policy:delivery_failed');
  });

  test('requires reapproval for explicit mid-flight scope changes', () => {
    const result = applySupervisorApprovalPolicy({
      assessment: continueAssessment(),
      milestone_kind: 'retrying',
      delivery_code: null,
      delivery_summary: null,
      plan_title: '实现设置页主题保存',
      user_text: '顺便把登录系统也重构一下',
    });

    expect(result.decision).toBe('ask_user');
    expect(result.active_decision_kind).toBe('scope_change');
    expect(result.reason).toBe('approval_policy_scope_change');
  });

  test('allows low-risk continue decisions to pass through unchanged', () => {
    const assessment = continueAssessment();
    const result = applySupervisorApprovalPolicy({
      assessment,
      milestone_kind: 'retrying',
      delivery_code: null,
      delivery_summary: null,
      plan_title: '实现设置页主题保存',
      user_text: null,
    });

    expect(result).toEqual(assessment);
  });

  test('requires user approval for destructive cleanup wording during execution', () => {
    const result = applySupervisorApprovalPolicy({
      assessment: continueAssessment(),
      milestone_kind: 'retrying',
      delivery_code: null,
      delivery_summary: null,
      plan_title: '清理仓库残余',
      user_text: '把仓库里残余文件都删光',
    });

    expect(result.decision).toBe('ask_user');
    expect(result.reason).toBe('approval_policy_destructive_cleanup');
    expect(result.active_decision_kind).toBe('execution_decision');
  });

  test('hard pauses repeated delivery failures instead of letting the supervisor self-approve retries', () => {
    const result = applySupervisorApprovalPolicy({
      assessment: continueAssessment({ reason: 'llm_continue_after_repeated_failure' }),
      milestone_kind: 'delivery_failed',
      delivery_code: 'review_submit_failed',
      delivery_summary: 'GitHub review 422 repeated twice.',
      plan_title: '提交 review',
      user_text: null,
      repeated_failure_count: 2,
    });

    expect(result.decision).toBe('ask_user');
    expect(result.reason).toBe('approval_policy_hard_pause_repeated_failure');
    expect(result.user_summary).toContain('连续失败');
  });
});
