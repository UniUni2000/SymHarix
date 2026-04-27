import type { SupervisorMemoryRecord, SupervisorSessionRecord } from '../database/types';
import type { RuntimeIssueView, RuntimeTimelineEvent } from '../runtime/types';

export type SupervisorDevDirectiveKind =
  | 'continue_dev'
  | 'request_evidence'
  | 'repair_delivery'
  | 'pause_for_user'
  | 'noop';

export interface SupervisorDevDirective {
  directive_kind: SupervisorDevDirectiveKind;
  instruction: string;
  required_evidence: string[];
  stop_conditions: string[];
  source: 'deterministic' | 'llm';
  memory_summaries: string[];
}

function compact(value: string | null | undefined, maxLength = 220): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function evidenceMissing(issue: RuntimeIssueView): string[] {
  const summary = issue.evidence_summary;
  if (!summary) {
    return [];
  }
  const missing = Array.isArray(summary.missing) ? summary.missing : [];
  return missing.map((item) => compact(String(item), 120)).filter(Boolean);
}

function timelineTail(timeline: RuntimeTimelineEvent[]): string {
  return timeline.slice(-3).map((event) => compact(event.message, 120)).filter(Boolean).join(' / ');
}

function timelineText(timeline: RuntimeTimelineEvent[]): string {
  return timeline.map((event) => event.message).filter(Boolean).join('\n');
}

function memorySummaries(memories: SupervisorMemoryRecord[]): string[] {
  return memories
    .slice(0, 4)
    .map((memory) => compact(memory.summary, 140))
    .filter(Boolean);
}

export class SupervisorDevConversationService {
  buildDirective(input: {
    session: SupervisorSessionRecord;
    issue: RuntimeIssueView;
    timeline: RuntimeTimelineEvent[];
    memories: SupervisorMemoryRecord[];
  }): SupervisorDevDirective {
    const { session, issue, timeline, memories } = input;
    const planTitle = session.plan_card?.title ?? issue.title;
    const memoryHints = memorySummaries(memories);
    const recentTimelineText = timelineText(timeline);

    if (issue.delivery_state === 'delivery_failed' || issue.delivery_code) {
      const summary = compact(issue.delivery_summary ?? '交付阶段失败。', 260);
      const canRepairLocally = issue.delivery_code === 'review_submit_failed' || issue.delivery_code === 'tracker_state_conflict';
      if (canRepairLocally) {
        return {
          directive_kind: 'repair_delivery',
          instruction: [
            `当前计划「${planTitle}」代码/证据可能已经接近完成，但交付卡住：${summary}`,
            '下一轮只处理交付恢复：刷新 PR/Tracker 状态，确认 head branch 与 runtime branch 一致；如果等价 review 或目标状态已存在，按 recovered success 收尾。',
            '不要扩大产品范围，不要新建无关 issue。',
          ].join('\n'),
          required_evidence: ['PR/head 状态', '恢复动作结果'],
          stop_conditions: ['交付恢复失败超过一次', '需要用户选择新的交付策略'],
          source: 'deterministic',
          memory_summaries: memoryHints,
        };
      }
      return {
        directive_kind: 'pause_for_user',
        instruction: [
          `当前计划「${planTitle}」不要继续重试：${summary}`,
          '先向用户说明 proof 与 delivery 的差异，并等待用户确认交付恢复策略。',
        ].join('\n'),
        required_evidence: [],
        stop_conditions: ['用户确认交付恢复策略'],
        source: 'deterministic',
        memory_summaries: memoryHints,
      };
    }

    const reviewRequestedChanges = (
      issue.phase === 'REVIEW' &&
      (
        issue.orchestrator_state === 'failed' ||
        /REQUEST_CHANGES|CHANGES_REQUESTED|review requested changes|缺少|missing/i.test(recentTimelineText)
      )
    );
    if (reviewRequestedChanges) {
      const reviewSignal = compact(recentTimelineText, 260) || compact(issue.delivery_summary, 260) || 'review requested changes';
      return {
        directive_kind: 'request_evidence',
        instruction: [
          `当前计划「${planTitle}」review 阶段没有通过，不要泛化重试。`,
          `请先按 review 反馈做最小 rework，并补齐对应证据：${reviewSignal}。`,
          '只处理 review 指出的缺口，不扩大产品范围或顺手重构。',
        ].join('\n'),
        required_evidence: ['review 反馈处理说明', 'rework 后验证证据'],
        stop_conditions: ['review 再次要求修改', '需要改变验收标准'],
        source: 'deterministic',
        memory_summaries: memoryHints,
      };
    }

    const missingEvidence = evidenceMissing(issue);
    if (missingEvidence.length > 0) {
      return {
        directive_kind: 'request_evidence',
        instruction: [
          `当前计划「${planTitle}」先不要盲目重试功能开发，下一轮请补齐证据：${missingEvidence.join('、')}。`,
          '补证据时只读取和验证当前范围，不要扩大清理或重构范围。',
          timelineTail(timeline) ? `最近执行信号：${timelineTail(timeline)}。` : null,
        ].filter(Boolean).join('\n'),
        required_evidence: missingEvidence,
        stop_conditions: ['证据仍缺失', '发现需要改变验收标准'],
        source: 'deterministic',
        memory_summaries: memoryHints,
      };
    }

    if (issue.orchestrator_state === 'completed' || issue.delivery_state === 'completed') {
      return {
        directive_kind: 'noop',
        instruction: `当前计划「${planTitle}」已经完成，不再向 dev agent 追加指令。`,
        required_evidence: [],
        stop_conditions: [],
        source: 'deterministic',
        memory_summaries: memoryHints,
      };
    }

    const queuedChildren = issue.governance_child_queue
      ?.filter((child) => child.queue_state === 'queued')
      .map((child) => child.issue_identifier)
      .filter(Boolean) ?? [];

    return {
      directive_kind: 'continue_dev',
      instruction: [
        `继续推进计划「${planTitle}」。`,
        session.plan_card?.acceptance?.length
          ? `完成标准：${session.plan_card.acceptance.join('；')}。`
          : '完成标准：交付物可验证。',
        issue.governance_current_child
          ? `当前只推进子单 ${issue.governance_current_child.issue_identifier}，${queuedChildren.length ? `后续 ${queuedChildren.join('、')} 保持排队。` : '其余子单保持排队。'}`
          : null,
        memoryHints.length ? `历史提醒：${memoryHints.join('；')}。` : null,
      ].filter(Boolean).join('\n'),
      required_evidence: session.plan_card?.acceptance ?? [],
      stop_conditions: ['范围变化', '破坏性清理风险', '交付失败'],
      source: 'deterministic',
      memory_summaries: memoryHints,
    };
  }
}
