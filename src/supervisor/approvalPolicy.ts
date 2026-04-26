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

export function applySupervisorApprovalPolicy(params: {
  assessment: SupervisorOversightAssessment;
  milestone_kind: SupervisorMilestoneKind | null;
  delivery_code: RuntimeDeliveryCode | string | null;
  delivery_summary: string | null;
  plan_title: string | null;
  user_text: string | null;
}): SupervisorOversightAssessment {
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
