import type { SupervisorSessionRecord } from '../database/types';
import type { RuntimeLocale } from '../i18n/locale';
import type { RuntimeGovernanceChildIssueView } from '../runtime/types';

interface SupervisorThreadSummaryParams {
  session: Pick<SupervisorSessionRecord, 'state' | 'delivery_summary' | 'plan_card'>;
  currentChild: RuntimeGovernanceChildIssueView | null;
  childQueue?: RuntimeGovernanceChildIssueView[] | null;
  locale?: RuntimeLocale | null;
}

function childFailureSummary(child: RuntimeGovernanceChildIssueView, locale: RuntimeLocale): string {
  if (locale === 'en') {
    return child.delivery_summary
      ? `${child.issue_identifier} is currently blocked: ${child.delivery_summary}`
      : `${child.issue_identifier} delivery failed. Handle this child task before continuing.`;
  }
  return child.delivery_summary
    ? `${child.issue_identifier} 当前卡住：${child.delivery_summary}`
    : `${child.issue_identifier} 当前交付失败，先处理这张子任务再继续。`;
}

function formatQueuedChildren(queue: RuntimeGovernanceChildIssueView[] | null | undefined): string[] {
  return (queue ?? [])
    .filter((child) => child.queue_state === 'queued')
    .map((child) => child.issue_identifier)
    .filter(Boolean);
}

export function describeSupervisorThread(params: SupervisorThreadSummaryParams): string {
  const locale = params.locale === 'en' ? 'en' : 'zh';
  const planTitle = params.session.plan_card?.title ?? (locale === 'en' ? 'current plan thread' : '当前计划线程');
  const currentChild = params.currentChild;
  const queuedChildren = formatQueuedChildren(params.childQueue);

  if (
    currentChild &&
    params.session.state === 'awaiting_user_decision' &&
    (currentChild.delivery_state === 'delivery_failed' || currentChild.orchestrator_state === 'failed')
  ) {
    const fallbackSummary = params.session.delivery_summary
      ? (locale === 'en'
        ? `${currentChild.issue_identifier} is currently blocked: ${params.session.delivery_summary}`
        : `${currentChild.issue_identifier} 当前卡住：${params.session.delivery_summary}`)
      : childFailureSummary(currentChild, locale);
    if (locale === 'en') {
      return `Plan "${planTitle}" is paused at ${currentChild.issue_identifier}; the root issue remains paused. ${currentChild.delivery_summary ? childFailureSummary(currentChild, locale) : fallbackSummary}${queuedChildren.length > 0 ? ` After this is handled, the queue will continue with ${queuedChildren.join(', ')}.` : ''}`;
    }
    return `计划「${planTitle}」当前暂停在 ${currentChild.issue_identifier}；源单仍暂停。${currentChild.delivery_summary ? childFailureSummary(currentChild, locale) : fallbackSummary}${queuedChildren.length > 0 ? ` 处理完后会自动接力 ${queuedChildren.join('、')}。` : ''}`;
  }

  if (currentChild) {
    if (locale === 'en') {
      return `Plan "${planTitle}" is executing; current child task is ${currentChild.issue_identifier}. ${queuedChildren.length > 0 ? `After it completes, the queue will continue with ${queuedChildren.join(', ')}.` : 'Remaining child tasks will continue in order.'}`;
    }
    return `计划「${planTitle}」正在执行；当前子任务 ${currentChild.issue_identifier}，${queuedChildren.length > 0 ? `完成后会自动接力 ${queuedChildren.join('、')}。` : '后续子任务会按顺序接力。'}`;
  }

  if (params.session.delivery_summary) {
    if (locale === 'en') {
      return `Plan "${planTitle}" status: ${params.session.delivery_summary}`;
    }
    return `计划「${planTitle}」当前状态：${params.session.delivery_summary}`;
  }

  switch (params.session.state) {
    case 'clarifying':
      if (locale === 'en') return `Plan "${planTitle}" is still gathering details.`;
      return `计划「${planTitle}」还在补充信息。`;
    case 'awaiting_user_approval':
    case 'plan_ready':
      if (locale === 'en') return `Plan "${planTitle}" is waiting for Telegram approval.`;
      return `计划「${planTitle}」正在等待 Telegram 批准。`;
    case 'awaiting_user_decision':
      if (locale === 'en') return `Plan "${planTitle}" is waiting for your next decision.`;
      return `计划「${planTitle}」正在等待你决定下一步。`;
    case 'completed':
      if (locale === 'en') return `Plan "${planTitle}" is complete.`;
      return `计划「${planTitle}」已经完成。`;
    case 'cancelled':
      if (locale === 'en') return `Plan "${planTitle}" has been cancelled.`;
      return `计划「${planTitle}」已经取消。`;
    default:
      if (locale === 'en') return `Plan "${planTitle}" is in progress.`;
      return `计划「${planTitle}」正在推进。`;
  }
}
