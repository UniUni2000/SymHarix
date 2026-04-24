import type { BotTransportMessage } from './types';
import type { RuntimeIssueView } from '../runtime/types';
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
  : never): string {
  switch (queueState) {
    case 'current':
      return '当前处理';
    case 'queued':
      return '排队中';
    case 'blocked':
      return '等待放行';
    case 'failed':
      return '执行失败';
    case 'completed':
      return '已完成';
    default:
      return '处理中';
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

function summarizeChildIssues(issue: RuntimeIssueView): string[] {
  return (issue.governance_child_queue ?? issue.governance_child_issues ?? []).map((child) => {
    const deliveryReason = child.delivery_state === 'delivery_failed' && child.delivery_summary
      ? compact(child.delivery_summary, 140)
      : null;
    const governanceReason = child.governance_summary && !isDegradedBoilerplate(child.governance_summary)
      ? compact(child.governance_summary, 120)
      : null;
    const reason = deliveryReason
      ?? governanceReason
      ?? (child.queue_state ? describeQueueState(child.queue_state) : '等待处理');
    return `${child.issue_identifier} · ${describeQueueState(child.queue_state)}：${reason}`;
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
  const { conclusion, repoReason } = compressGovernanceSummary(issue.governance_summary);
  const systemSuggestion = buildSystemSuggestion(issue);

  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>待你处理 · ${escapeHtml(issue.identifier)}</b>`,
      '这张单已被治理拦住，正在等你决定下一步。',
      null,
      '<b>仓库</b>',
      issue.github_repo ? `<code>${escapeHtml(issue.github_repo)}</code>` : '未识别仓库',
      null,
      '<b>当前建议</b>',
      issue.governance_decision === 'split_before_implement'
        ? '先拆成两个更聚焦的任务，再继续开发。'
        : issue.governance_decision === 'accept_with_rewrite'
          ? '先把需求改写得更聚焦，再继续开发。'
          : '先处理下面的治理建议，再继续开发。',
      null,
      '<b>为什么被拦</b>',
      `结论：${escapeHtml(conclusion)}`,
      repoReason ? `Repo 原因：${escapeHtml(repoReason)}` : null,
      systemSuggestion ? `系统建议：${escapeHtml(systemSuggestion)}` : null,
      null,
      '也可以直接回复你的想法，例如“拆成两个任务”',
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
  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>请确认 · ${escapeHtml(params.issue.identifier)}</b>`,
      '你即将执行下面的操作；确认后 Symphony 会立即发起对应动作。',
      params.notice ? escapeHtml(params.notice) : null,
      null,
      '<b>准备执行</b>',
      escapeHtml(params.actionLabel),
      null,
      '<b>执行说明</b>',
      escapeHtml(stripConfirmationTail(compact(params.confirmationSummary, 220))),
      null,
      '使用下面的按钮继续，或返回上一步。',
    ]),
    action_rows: [
      [{ label: '确认执行', callback_data: 'pending|confirm' }],
      [{ label: '返回上一步', callback_data: 'pending|cancel' }],
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
  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>正在执行 · ${escapeHtml(issue.identifier)}</b>`,
      'Symphony 正在处理你的治理操作，请稍等片刻。',
      params.notice ? escapeHtml(params.notice) : null,
      null,
      '<b>当前动作</b>',
      escapeHtml(params.actionLabel),
      null,
      '处理完成后，这张卡会自动更新结果。',
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
  const childQueue = issue.governance_child_queue ?? issue.governance_child_issues ?? [];
  const childIdentifiers = options.createdIssueIdentifiers ?? childQueue.map((child) => child.issue_identifier);
  const childSummaryLines = options.childSummaries ?? summarizeChildIssues(issue);
  const currentChild = findCurrentChild(issue);
  const prioritizedChild = currentChild?.issue_identifier ?? childIdentifiers[0] ?? null;
  const currentChildTitle = currentChild?.title ? compact(currentChild.title, 120) : null;
  const currentChildDelivery = currentChild?.delivery_state === 'delivery_failed'
    ? compact(currentChild.delivery_summary, 180)
    : currentChild?.orchestrator_state === 'failed'
      ? compact(currentChild.delivery_summary || '当前子任务执行失败，正在等待重试或人工处理。', 180)
      : currentChild?.delivery_state === 'proof_satisfied'
        ? '代码和证据已经满足，正在等最终交付动作完成。'
        : null;
  const progressSummary = compact(
    options.userSummary
      || (childIdentifiers.length > 0
        ? `已创建治理子任务 ${childIdentifiers.join('、')}，源单会在当前子任务处理完成后按顺序接力。`
        : '已进入治理子任务阶段，源单暂时继续等待。'),
    220,
  );

  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>治理线程 · ${escapeHtml(issue.identifier)}</b>`,
      '这张源单还没有继续开发，当前先处理下面这张子任务。',
      options.notice ? escapeHtml(options.notice) : null,
      null,
      '<b>当前进展</b>',
      escapeHtml(progressSummary),
      null,
      prioritizedChild ? '<b>当前子任务</b>' : null,
      prioritizedChild ? `<code>${escapeHtml(prioritizedChild)}</code>${currentChildTitle ? ` · ${escapeHtml(currentChildTitle)}` : ''}` : null,
      currentChildDelivery
        ? `${issue.governance_thread_state === 'child_failed' || currentChild?.orchestrator_state === 'failed' ? '当前失败：' : '当前卡点：'}${escapeHtml(currentChildDelivery)}`
        : null,
      null,
      childIdentifiers.length > 0 ? '<b>子任务队列</b>' : null,
      ...childSummaryLines.map((line) => escapeHtml(line)),
      prioritizedChild ? `当前优先处理：${escapeHtml(prioritizedChild)}；后续子任务会按顺序自动接力。` : null,
      null,
      '<b>源单状态</b>',
      '源单仍暂停，不会并发把所有子任务一起推进。',
      null,
      '<b>下一步建议</b>',
      escapeHtml(options.nextRecommendedAction || issue.next_recommended_action || '先处理子任务，再决定是否回到源单。'),
      null,
      '如果你想换个方案，也可以直接回复你的想法。',
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
  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>执行失败 · ${escapeHtml(issue.identifier)}</b>`,
      '这次治理动作没有成功落地，源单仍停在当前状态。',
      options.notice ? escapeHtml(options.notice) : null,
      null,
      '<b>失败原因</b>',
      escapeHtml(compact(options.resultSummary || '执行失败，请稍后重试。', 220)),
      null,
      '你可以稍后重试，或者直接回复新的处理思路。',
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
  return {
    format: 'telegram_html',
    text: joinHtmlLines([
      `<b>已处理 · ${escapeHtml(issue.identifier)}</b>`,
      '这张治理卡片已经处理完成，后续状态会继续同步到这里。',
      options.notice ? escapeHtml(options.notice) : null,
      null,
      issue.github_repo ? `<b>仓库</b>\n<code>${escapeHtml(issue.github_repo)}</code>` : null,
      null,
      '<b>处理结果</b>',
      escapeHtml(compact(options.resultSummary || '已恢复自动执行，这张治理卡片已结束。', 220)),
      null,
      `当前状态：${escapeHtml([issue.phase, issue.tracker_state, issue.orchestrator_state || 'unknown'].join(' · '))}`,
    ]),
    action_rows: [],
  };
}

export function buildGovernanceActionSummary(issue: RuntimeIssueView): string {
  return buildGovernanceQuickActions(issue)
    .map((action) => action.label)
    .join(' / ');
}
