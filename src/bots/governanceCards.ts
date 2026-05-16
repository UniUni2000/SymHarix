import type { BotTransportMessage } from './types';
import type { RuntimeIssueView } from '../runtime/types';
import { localizeKnownRuntimeText, type RuntimeLocale } from '../i18n/locale';
import { buildGovernanceQuickActions, toGovernanceQuickActionRows } from './governanceQuickActions';

function compact(value: string | null | undefined, maxLength = 180): string {
  if (!value) {
    return 'n/a';
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isDegradedBoilerplate(value: string | null | undefined): boolean {
  const normalized = compact(value, 400).toLowerCase();
  return (
    normalized.includes('no .symphony-constitution.md found yet') ||
    normalized.includes('no .symphony-repo.yaml found') ||
    normalized.includes('governance is running in degraded mode') ||
    normalized.includes('using a shadow harness')
  );
}

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isEnglishLocale(locale: RuntimeLocale | null | undefined): boolean {
  return locale === 'en';
}

function issueLocale(issue: RuntimeIssueView): RuntimeLocale | null | undefined {
  return issue.supervisor_locale;
}

function textForLocale(locale: RuntimeLocale | null | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function localizedKnown(value: string | null | undefined, locale: RuntimeLocale | null | undefined): string {
  const text = String(value || '');
  return isEnglishLocale(locale) ? localizeKnownRuntimeText(text, locale) : text;
}

function compressGovernanceSummary(summary: string | null | undefined): {
  conclusion: string;
  repoReason: string | null;
} {
  if (isDegradedBoilerplate(summary)) {
    return {
      conclusion: '当前治理层要求你先确认下一步，再继续执行。',
      repoReason: null,
    };
  }

  const normalized = compact(summary, 320);
  const repoContextMatch = normalized.match(/Repo context[^:]*:\s*(.+)$/i);
  const conclusion = repoContextMatch
    ? normalized.slice(0, repoContextMatch.index).trim()
    : normalized;
  const repoReason = repoContextMatch?.[1] ? compact(repoContextMatch[1], 160) : null;
  return {
    conclusion: conclusion || '当前治理层要求你先确认下一步，再继续执行。',
    repoReason,
  };
}

function normalizedBlockedReason(issue: RuntimeIssueView): string {
  const { conclusion, repoReason } = compressGovernanceSummary(issue.governance_summary);
  return [conclusion, repoReason].filter(Boolean).join(' | ');
}

function primaryActionKey(issue: RuntimeIssueView): string {
  const primary = buildGovernanceQuickActions(issue)[0] ?? null;
  if (!primary) {
    return 'none';
  }

  switch (primary.kind) {
    case 'execute_suggestion':
      return `suggestion:${primary.suggestion_type}:${primary.label}`;
    case 'split':
    case 'rewrite':
    case 'override':
      return `${primary.kind}:${primary.label}`;
  }
}

function buildSystemSuggestion(issue: RuntimeIssueView): string | null {
  const firstSuggestion = issue.active_governance_suggestions?.find((suggestion) => suggestion.can_execute) ?? null;
  if (!firstSuggestion) {
    return null;
  }
  return compact(firstSuggestion.summary || firstSuggestion.title, 160);
}

function describeQueueState(queueState: RuntimeIssueView['governance_child_queue'] extends Array<infer T>
  ? T extends { queue_state?: infer S } ? S : never
  : never, locale: RuntimeLocale | null | undefined = null): string {
  switch (queueState) {
    case 'current':
      return textForLocale(locale, '当前处理', 'Current');
    case 'queued':
      return textForLocale(locale, '排队中', 'Queued');
    case 'blocked':
      return textForLocale(locale, '等待放行', 'Blocked');
    case 'failed':
      return textForLocale(locale, '执行失败', 'Failed');
    case 'completed':
      return textForLocale(locale, '已完成', 'Completed');
    default:
      return textForLocale(locale, '处理中', 'Processing');
  }
}

function findCurrentChild(issue: RuntimeIssueView) {
  return issue.governance_current_child
    ?? issue.governance_child_queue?.find((child) => child.queue_state === 'current')
    ?? issue.governance_child_issues?.[0]
    ?? null;
}

function stripConfirmationTail(summary: string): string {
  return summary
    .replace(/\n?Reply with:\s*确认\s*\/\s*取消\.?/gi, '')
    .replace(/\n?Reply with\s*确认\s*\/\s*取消\.?/gi, '')
    .replace(/\n?确认后执行，回复确认\/取消。?/g, '')
    .trim();
}

function joinHtmlLines(lines: Array<string | null | undefined>): string {
  return lines.filter(Boolean).join('\n');
}

function summarizeChildIssues(issue: RuntimeIssueView, locale: RuntimeLocale | null | undefined = issueLocale(issue)): string[] {
  return (issue.governance_child_queue ?? issue.governance_child_issues ?? []).map((child) => {
    const deliveryReason = child.delivery_state === 'delivery_failed' && child.delivery_summary
      ? compact(localizedKnown(child.delivery_summary, locale), 140)
      : null;
    const governanceReason = child.governance_summary && !isDegradedBoilerplate(child.governance_summary)
      ? compact(localizedKnown(child.governance_summary, locale), 120)
      : null;
    const reason = deliveryReason
      ?? governanceReason
      ?? (child.queue_state ? describeQueueState(child.queue_state, locale) : textForLocale(locale, '等待处理', 'Waiting'));
    return `${child.issue_identifier} · ${describeQueueState(child.queue_state, locale)}${textForLocale(locale, '：', ': ')}${reason}`;
  });
}

export function isGovernanceBlockedIssue(issue: RuntimeIssueView | null | undefined): boolean {
  if (!issue) {
    return false;
  }

  return issue.orchestrator_state === 'halted' && Boolean(
    issue.governance_decision &&
    issue.governance_decision !== 'accept',
  );
}

export function buildGovernanceCardKey(issue: RuntimeIssueView): string {
  if (issue.governance_thread_state === 'waiting_on_child' || issue.governance_thread_state === 'child_failed') {
    const currentChild = findCurrentChild(issue);
    return [
      'root_thread',
      issue.identifier,
      issue.governance_thread_state ?? 'waiting_on_child',
      currentChild?.issue_identifier ?? '',
      currentChild?.delivery_state ?? '',
      currentChild?.delivery_summary ? compact(currentChild.delivery_summary, 140) : '',
      issue.governance_pause_reason ? compact(issue.governance_pause_reason, 160) : '',
      issue.governance_expected_handoff ? compact(issue.governance_expected_handoff, 160) : '',
      issue.next_recommended_action ?? '',
      (issue.governance_child_queue ?? issue.governance_child_issues ?? [])
        .map((child) => `${child.issue_identifier}:${child.queue_state ?? '-'}`)
        .filter(Boolean)
        .join(','),
    ].join('|');
  }

  return [
    issue.governance_thread_state ?? 'blocked',
    issue.identifier,
    issue.governance_decision ?? '',
    primaryActionKey(issue),
    normalizedBlockedReason(issue),
    (issue.governance_child_queue ?? issue.governance_child_issues ?? [])
      .map((child) => `${child.issue_identifier}:${child.queue_state ?? '-'}`)
      .join(','),
  ].join('|');
}

export function buildGovernanceBlockedMessage(issue: RuntimeIssueView): BotTransportMessage {
  const locale = issueLocale(issue);
  const { conclusion, repoReason } = compressGovernanceSummary(issue.governance_summary);
  const systemSuggestion = buildSystemSuggestion(issue);

  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>${textForLocale(locale, '待你处理', 'Needs Your Decision')} · ${escapeHtml(issue.identifier)}</b>`,
      textForLocale(locale, '这张单已被治理拦住，正在等你决定下一步。', 'This issue is blocked by governance and is waiting for your next decision.'),
      null,
      `<b>${textForLocale(locale, '仓库', 'Repository')}</b>`,
      issue.github_repo ? `<code>${escapeHtml(issue.github_repo)}</code>` : textForLocale(locale, '未识别仓库', 'Unknown repository'),
      null,
      `<b>${textForLocale(locale, '当前建议', 'Current Recommendation')}</b>`,
      issue.governance_decision === 'split_before_implement'
        ? textForLocale(locale, '先拆成两个更聚焦的任务，再继续开发。', 'Split this into two more focused tasks before continuing development.')
        : issue.governance_decision === 'accept_with_rewrite'
          ? textForLocale(locale, '先把需求改写得更聚焦，再继续开发。', 'Rewrite the requirement into a more focused form before continuing development.')
          : textForLocale(locale, '先处理下面的治理建议，再继续开发。', 'Handle the governance suggestion below before continuing development.'),
      null,
      `<b>${textForLocale(locale, '为什么被拦', 'Why It Is Blocked')}</b>`,
      `${textForLocale(locale, '结论：', 'Conclusion: ')}${escapeHtml(localizedKnown(conclusion, locale))}`,
      repoReason ? `${textForLocale(locale, 'Repo 原因：', 'Repo reason: ')}${escapeHtml(localizedKnown(repoReason, locale))}` : null,
      systemSuggestion ? `${textForLocale(locale, '系统建议：', 'System suggestion: ')}${escapeHtml(localizedKnown(systemSuggestion, locale))}` : null,
      null,
      textForLocale(locale, '也可以直接回复你的想法，例如“拆成两个任务”', 'You can also reply with your preference, for example "split it into two tasks".'),
    ]),
    action_rows: toGovernanceQuickActionRows(issue),
  };
}

export function buildGovernanceConfirmingMessage(params: {
  issue: RuntimeIssueView;
  actionLabel: string;
  confirmationSummary: string;
  notice?: string | null;
}): BotTransportMessage {
  const locale = issueLocale(params.issue);
  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>${textForLocale(locale, '请确认', 'Please Confirm')} · ${escapeHtml(params.issue.identifier)}</b>`,
      textForLocale(locale, '你即将执行下面的操作；确认后 SymHarix 会立即发起对应动作。', 'You are about to run the action below. Once confirmed, SymHarix will start it immediately.'),
      params.notice ? escapeHtml(params.notice) : null,
      null,
      `<b>${textForLocale(locale, '准备执行', 'Action')}</b>`,
      escapeHtml(params.actionLabel),
      null,
      `<b>${textForLocale(locale, '执行说明', 'Execution Note')}</b>`,
      escapeHtml(stripConfirmationTail(compact(params.confirmationSummary, 220))),
      null,
      textForLocale(locale, '使用下面的按钮继续，或返回上一步。', 'Use the buttons below to continue or go back.'),
    ]),
    action_rows: [
      [{ label: textForLocale(locale, '确认执行', 'Confirm'), callback_data: 'pending|confirm' }],
      [{ label: textForLocale(locale, '返回上一步', 'Go Back'), callback_data: 'pending|cancel' }],
    ],
  };
}

export function buildGovernanceExecutingMessage(
  issue: RuntimeIssueView,
  params: {
  actionLabel: string;
  notice?: string | null;
} = {
    actionLabel: '执行治理动作',
  },
): BotTransportMessage {
  const locale = issueLocale(issue);
  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>${textForLocale(locale, '正在执行', 'Running')} · ${escapeHtml(issue.identifier)}</b>`,
      textForLocale(locale, 'SymHarix 正在处理你的治理操作，请稍等片刻。', 'SymHarix is processing your governance action. Please wait a moment.'),
      params.notice ? escapeHtml(params.notice) : null,
      null,
      `<b>${textForLocale(locale, '当前动作', 'Current Action')}</b>`,
      escapeHtml(params.actionLabel),
      null,
      textForLocale(locale, '处理完成后，这张卡会自动更新结果。', 'This card will update automatically when processing finishes.'),
    ]),
    action_rows: [],
  };
}

export function buildGovernanceWaitingOnChildMessage(
  issue: RuntimeIssueView,
  options: {
    createdIssueIdentifiers?: string[];
    childSummaries?: string[];
    nextRecommendedAction?: string | null;
    userSummary?: string | null;
    notice?: string | null;
  } = {},
): BotTransportMessage {
  const locale = issueLocale(issue);
  const childQueue = issue.governance_child_queue ?? issue.governance_child_issues ?? [];
  const childIdentifiers = options.createdIssueIdentifiers ?? childQueue.map((child) => child.issue_identifier);
  const childSummaryLines = options.childSummaries ?? summarizeChildIssues(issue, locale);
  const currentChild = findCurrentChild(issue);
  const prioritizedChild = currentChild?.issue_identifier ?? childIdentifiers[0] ?? null;
  const currentChildTitle = currentChild?.title ? compact(localizedKnown(currentChild.title, locale), 120) : null;
  const currentChildDelivery = currentChild?.delivery_state === 'delivery_failed'
    ? compact(localizedKnown(currentChild.delivery_summary, locale), 180)
    : currentChild?.orchestrator_state === 'failed'
      ? compact(localizedKnown(currentChild.delivery_summary || textForLocale(locale, '当前子任务执行失败，正在等待重试或人工处理。', 'The current child task failed and is waiting for retry or manual handling.'), locale), 180)
      : currentChild?.delivery_state === 'proof_satisfied'
        ? textForLocale(locale, '代码和证据已经满足，正在等最终交付动作完成。', 'Code and evidence are satisfied; final delivery is pending.')
        : null;
  const fallbackProgress = childIdentifiers.length > 0
    ? textForLocale(locale, `已创建治理子任务 ${childIdentifiers.join('、')}，源单会在当前子任务处理完成后按顺序接力。`, `Created governance child task(s) ${childIdentifiers.join(', ')}. The source issue will continue in order after the current child is handled.`)
    : textForLocale(locale, '已进入治理子任务阶段，源单暂时继续等待。', 'Entered the governance child-task phase; the source issue is waiting for now.');
  const progressSummary = compact(
    localizedKnown(options.userSummary, locale) || fallbackProgress,
    220,
  );

  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>${textForLocale(locale, '治理线程', 'Governance Thread')} · ${escapeHtml(issue.identifier)}</b>`,
      textForLocale(locale, '这张源单还没有继续开发，当前先处理下面这张子任务。', 'The source issue has not resumed development yet; the child task below is being handled first.'),
      options.notice ? escapeHtml(options.notice) : null,
      null,
      `<b>${textForLocale(locale, '当前进展', 'Current Progress')}</b>`,
      escapeHtml(progressSummary),
      null,
      prioritizedChild ? `<b>${textForLocale(locale, '当前子任务', 'Current Child Task')}</b>` : null,
      prioritizedChild ? `<code>${escapeHtml(prioritizedChild)}</code>${currentChildTitle ? ` · ${escapeHtml(currentChildTitle)}` : ''}` : null,
      currentChildDelivery
        ? `${issue.governance_thread_state === 'child_failed' || currentChild?.orchestrator_state === 'failed' ? textForLocale(locale, '当前失败：', 'Current failure: ') : textForLocale(locale, '当前卡点：', 'Current blocker: ')}${escapeHtml(currentChildDelivery)}`
        : null,
      null,
      childIdentifiers.length > 0 ? `<b>${textForLocale(locale, '子任务队列', 'Child Queue')}</b>` : null,
      ...childSummaryLines.map((line) => escapeHtml(line)),
      prioritizedChild ? textForLocale(locale, `当前优先处理：${escapeHtml(prioritizedChild)}；后续子任务会按顺序自动接力。`, `Current priority: ${escapeHtml(prioritizedChild)}. Later child tasks will continue in order automatically.`) : null,
      null,
      `<b>${textForLocale(locale, '源单状态', 'Source Issue Status')}</b>`,
      textForLocale(locale, '源单仍暂停，不会并发把所有子任务一起推进。', 'The source issue is still paused; child tasks will not all run concurrently.'),
      issue.governance_pause_reason ? escapeHtml(localizedKnown(issue.governance_pause_reason, locale)) : null,
      issue.governance_expected_handoff ? `${textForLocale(locale, '接力方式', 'Handoff')}: ${escapeHtml(localizedKnown(issue.governance_expected_handoff, locale))}` : null,
      null,
      `<b>${textForLocale(locale, '下一步建议', 'Recommended Next Step')}</b>`,
      escapeHtml(localizedKnown(options.nextRecommendedAction || issue.next_recommended_action || textForLocale(locale, '先处理子任务，再决定是否回到源单。', 'Handle the child task first, then decide whether to return to the source issue.'), locale)),
      null,
      textForLocale(locale, '如果你想换个方案，也可以直接回复你的想法。', 'If you want a different approach, reply with your preference.'),
    ]),
    action_rows: [],
  };
}

export function buildGovernanceFailedMessage(
  issue: RuntimeIssueView,
  options: {
    resultSummary?: string | null;
    notice?: string | null;
  } = {},
): BotTransportMessage {
  const locale = issueLocale(issue);
  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>${textForLocale(locale, '执行失败', 'Execution Failed')} · ${escapeHtml(issue.identifier)}</b>`,
      textForLocale(locale, '这次治理动作没有成功落地，源单仍停在当前状态。', 'This governance action did not complete. The source issue remains in its current state.'),
      options.notice ? escapeHtml(options.notice) : null,
      null,
      `<b>${textForLocale(locale, '失败原因', 'Failure Reason')}</b>`,
      escapeHtml(compact(localizedKnown(options.resultSummary || textForLocale(locale, '执行失败，请稍后重试。', 'Execution failed. Please retry later.'), locale), 220)),
      null,
      textForLocale(locale, '你可以稍后重试，或者直接回复新的处理思路。', 'You can retry later or reply with a new handling approach.'),
    ]),
    action_rows: [],
  };
}

export function buildGovernanceResolvedMessage(
  issue: RuntimeIssueView,
  options: {
    resultSummary?: string | null;
    notice?: string | null;
  } = {},
): BotTransportMessage {
  const locale = issueLocale(issue);
  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>${textForLocale(locale, '已处理', 'Processed')} · ${escapeHtml(issue.identifier)}</b>`,
      textForLocale(locale, '这张治理卡片已经处理完成，后续状态会继续同步到这里。', 'This governance card has been processed. Follow-up status will continue syncing here.'),
      options.notice ? escapeHtml(options.notice) : null,
      null,
      issue.github_repo ? `<b>${textForLocale(locale, '仓库', 'Repository')}</b>\n<code>${escapeHtml(issue.github_repo)}</code>` : null,
      null,
      `<b>${textForLocale(locale, '处理结果', 'Result')}</b>`,
      escapeHtml(compact(localizedKnown(options.resultSummary || textForLocale(locale, '已恢复自动执行，这张治理卡片已结束。', 'Automatic execution has resumed and this governance card is closed.'), locale), 220)),
      null,
      `${textForLocale(locale, '当前状态', 'Current status')}: ${escapeHtml([issue.phase, issue.tracker_state, issue.orchestrator_state || 'unknown'].join(' · '))}`,
    ]),
    action_rows: [],
  };
}

export function buildGovernanceActionSummary(issue: RuntimeIssueView): string {
  return buildGovernanceQuickActions(issue)
    .map((action) => action.label)
    .join(' / ');
}
