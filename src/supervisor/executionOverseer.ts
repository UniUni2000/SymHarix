import type { SupervisorPlanCard, SupervisorSessionRecord } from '../database/types';
import type { RuntimeIssueView } from '../runtime/types';
import type { SupervisorMilestone } from './types';

export type SupervisorOversightDecision = 'continue' | 'ask_user' | 'report' | 'complete';

export interface SupervisorOversightAssessment {
  decision: SupervisorOversightDecision;
  reason: string;
  dev_instruction: string | null;
  user_summary: string | null;
  active_decision_kind: 'delivery_failure' | 'scope_change' | 'governance_decision' | null;
  key: string;
}

export interface SupervisorExecutionOverseer {
  assess(input: {
    session: SupervisorSessionRecord;
    issue: RuntimeIssueView;
    milestone: SupervisorMilestone | null;
  }): SupervisorOversightAssessment | null;
}

function compact(value: string | null | undefined, maxLength = 220): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

function summarizePlan(planCard: SupervisorPlanCard | null): string {
  if (!planCard) {
    return '按当前计划推进。';
  }

  const acceptance = planCard.acceptance?.length
    ? `验收标准：${planCard.acceptance.join('；')}`
    : '验收标准：结果可验证。';
  const scope = planCard.in_scope?.length
    ? `范围：${planCard.in_scope.join('；')}`
    : `范围：${planCard.title}`;

  return `${scope}。${acceptance}。`;
}

function buildContinueInstruction(
  session: SupervisorSessionRecord,
  issue: RuntimeIssueView,
  milestone: SupervisorMilestone | null,
): string {
  const plan = summarizePlan(session.plan_card);
  const current = issue.governance_current_child
    ? `当前只推进子任务 ${issue.governance_current_child.issue_identifier}：${issue.governance_current_child.title}。`
    : `当前推进 ${issue.identifier}：${issue.title}。`;
  const milestoneSummary = compact(milestone?.summary ?? issue.delivery_summary ?? issue.next_recommended_action);

  return [
    current,
    plan,
    milestoneSummary ? `最新进展：${milestoneSummary}。` : null,
    '下一轮请像架构师复核一样先确认是否仍符合计划范围，再做最小可验证推进；如果发现范围漂移、误删风险或交付阻塞，不要静默吸收，明确停下来等待 supervisor/user 决策。',
  ].filter(Boolean).join('\n');
}

export class DefaultSupervisorExecutionOverseer implements SupervisorExecutionOverseer {
  assess(input: {
    session: SupervisorSessionRecord;
    issue: RuntimeIssueView;
    milestone: SupervisorMilestone | null;
  }): SupervisorOversightAssessment | null {
    const { session, issue, milestone } = input;
    if (!milestone) {
      return null;
    }

    const baseKey = [
      'oversight',
      session.id,
      session.plan_version,
      milestone.key,
    ].join('|');

    if (milestone.kind === 'completed') {
      return {
        decision: 'complete',
        reason: 'root_issue_completed',
        dev_instruction: null,
        user_summary: milestone.summary ?? '计划线程已完成。',
        active_decision_kind: null,
        key: baseKey,
      };
    }

    if (milestone.kind === 'cancelled') {
      return {
        decision: 'report',
        reason: 'root_issue_cancelled',
        dev_instruction: null,
        user_summary: milestone.summary ?? '计划线程已取消。',
        active_decision_kind: null,
        key: baseKey,
      };
    }

    if (
      milestone.kind === 'delivery_failed' ||
      milestone.kind === 'child_failed' ||
      milestone.kind === 'requires_user_decision'
    ) {
      const summary = compact(
        milestone.summary ??
        issue.delivery_summary ??
        issue.governance_summary ??
        '执行遇到需要人工判断的节点。',
        260,
      );
      return {
        decision: 'ask_user',
        reason: milestone.kind,
        dev_instruction: null,
        user_summary: summary || '执行遇到需要人工判断的节点。',
        active_decision_kind: milestone.kind === 'requires_user_decision'
          ? 'governance_decision'
          : 'delivery_failure',
        key: baseKey,
      };
    }

    return {
      decision: 'continue',
      reason: milestone.kind,
      dev_instruction: buildContinueInstruction(session, issue, milestone),
      user_summary: compact(milestone.summary ?? issue.next_recommended_action ?? '监督判断：继续推进当前计划。'),
      active_decision_kind: null,
      key: baseKey,
    };
  }
}
