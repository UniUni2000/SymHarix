import type { RuntimeDeliveryCode } from '../runtime/types';
import type { SupervisorMilestoneKind } from './types';
import type { SupervisorOversightAssessment } from './executionOverseer';

const SCOPE_CHANGE_HINTS = [
  '顺便',
  '也把',
  '一起把',
  '重构',
  '换成',
  '改成另一个',
  '新增一个',
];

const DESTRUCTIVE_CLEANUP_HINTS = [
  '删光',
  '全删',
  '全部删除',
  '清空',
  '都清掉',
  '都删掉',
  'remove everything',
  'delete everything',
];

export function applySupervisorApprovalPolicy(params: {
  assessment: SupervisorOversightAssessment;
  milestone_kind: SupervisorMilestoneKind | null;
  delivery_code: RuntimeDeliveryCode | string | null;
  delivery_summary: string | null;
  plan_title: string | null;
  user_text: string | null;
  repeated_failure_count?: number | null;
}): SupervisorOversightAssessment {
  if ((params.repeated_failure_count ?? 0) >= 2) {
    return {
      ...params.assessment,
      decision: 'ask_user',
      reason: 'approval_policy_hard_pause_repeated_failure',
      dev_instruction: null,
      user_summary: params.delivery_summary
        ? `连续失败，需要用户确认下一步：${params.delivery_summary}`
        : '连续失败，需要用户确认下一步。',
      active_decision_kind: 'delivery_failure',
      key: `${params.assessment.key}|policy:hard_pause_repeated_failure`,
      source: params.assessment.source ?? 'deterministic',
      fallback_reason: params.assessment.fallback_reason ?? null,
    };
  }

  if (
    params.milestone_kind === 'delivery_failed' ||
    params.milestone_kind === 'child_failed' ||
    params.delivery_code
  ) {
    return {
      ...params.assessment,
      decision: 'ask_user',
      reason: 'approval_policy_delivery_failed',
      dev_instruction: null,
      user_summary: params.delivery_summary
        ?? params.assessment.user_summary
        ?? '执行遇到交付失败，需要你确认下一步。',
      active_decision_kind: 'delivery_failure',
      key: `${params.assessment.key}|policy:delivery_failed`,
      source: params.assessment.source ?? 'deterministic',
      fallback_reason: params.assessment.fallback_reason ?? null,
    };
  }

  const normalizedText = params.user_text?.replace(/\s+/g, ' ').trim() ?? '';
  if (
    normalizedText &&
    params.assessment.decision === 'continue' &&
    DESTRUCTIVE_CLEANUP_HINTS.some((hint) => normalizedText.toLowerCase().includes(hint))
  ) {
    return {
      ...params.assessment,
      decision: 'ask_user',
      reason: 'approval_policy_destructive_cleanup',
      dev_instruction: null,
      user_summary: `这看起来可能删除较多文件。继续执行计划「${params.plan_title ?? '当前计划'}」前，需要你确认清理边界。`,
      active_decision_kind: 'execution_decision',
      key: `${params.assessment.key}|policy:destructive_cleanup`,
      source: params.assessment.source ?? 'deterministic',
      fallback_reason: params.assessment.fallback_reason ?? null,
    };
  }

  if (
    normalizedText &&
    params.assessment.decision === 'continue' &&
    SCOPE_CHANGE_HINTS.some((hint) => normalizedText.includes(hint))
  ) {
    return {
      ...params.assessment,
      decision: 'ask_user',
      reason: 'approval_policy_scope_change',
      dev_instruction: null,
      user_summary: `这看起来会改变当前计划「${params.plan_title ?? '当前计划'}」的范围，需要先更新计划再继续。`,
      active_decision_kind: 'scope_change',
      key: `${params.assessment.key}|policy:scope_change`,
      source: params.assessment.source ?? 'deterministic',
      fallback_reason: params.assessment.fallback_reason ?? null,
    };
  }

  return params.assessment;
}
