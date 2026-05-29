import type {
  BotFollowupDeliveryStateRepository,
  BotFollowupMessageStateRepository,
  BotIssueFollowupRepository,
  BotTransportEventRepository,
  SupervisorSessionRepository,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeStreamEvent, RuntimeTimelineEvent } from '../runtime/types';
import { isRuntimeIssueCompleted } from '../runtime/issueProgress';
import { buildSupervisorIssueVisualCard } from '../supervisor/issueVisualCard';
import { getTelegramThemePreference } from './telegramThemePreference';
import {
  buildGovernanceBlockedMessage,
  buildGovernanceCardKey,
  buildGovernanceResolvedMessage,
  buildGovernanceWaitingOnChildMessage,
  isGovernanceBlockedIssue,
} from './governanceCards';
import {
  getBotMessageEditFailureKind,
  type BotRecipient,
  type BotTransport,
  type BotTransportMessage,
  type BotTransportNotifier,
} from './types';
import { buildIssueCardActionRows } from './issueCardActions';
import { isTerminalIssue } from './issueVisibility';
import type { RuntimeIssueCardLock } from './runtimeIssueCardLock';
import { inferRuntimeLocaleFromText, type RuntimeLocale } from '../i18n/locale';

interface BotFollowupServiceOptions {
  telegramOperationsChatId?: string | null;
  feishuOperationsChatId?: string | null;
  bootstrapCurrentGovernanceCards?: boolean;
  deliveryStateRepository?: BotFollowupDeliveryStateRepository | null;
  transportEventRepository?: BotTransportEventRepository | null;
  supervisorSessionRepository?: SupervisorSessionRepository | null;
  runtimeIssueCardLock?: RuntimeIssueCardLock | null;
}

export type LifecycleNotificationClass = 'retrying' | 'failed' | 'delivery_failed' | 'done' | 'cancelled';
type RuntimeIssueTokenUsage = NonNullable<RuntimeIssueView['session']>['tokens'];

function shouldNotifyTimeline(event: RuntimeTimelineEvent): boolean {
  if (
    event.code === 'governance_assessed'
    && /(?:No \.symphony-constitution\.md found|shadow harness|governance is running in degraded mode|governance is degraded)/i.test(event.message)
  ) {
    return false;
  }
  return [
    'governance_blocked',
    'governance_assessed',
    'governance_suggestion_created',
    'governance_override_approved',
  ].includes(event.code);
}

export function classifyLifecycleNotification(issue: RuntimeIssueView): LifecycleNotificationClass | null {
  const trackerState = issue.tracker_state.trim().toLowerCase();
  const orchestratorState = (issue.orchestrator_state ?? '').trim().toLowerCase();

  if (trackerState === 'cancelled' || trackerState === 'canceled' || orchestratorState === 'cancelled') {
    return 'cancelled';
  }

  if (orchestratorState === 'failed') {
    return 'failed';
  }

  if (
    issue.delivery_state === 'delivery_failed' ||
    (issue.delivery_code && issue.delivery_code !== 'manual_stop')
  ) {
    return 'delivery_failed';
  }

  if (orchestratorState === 'retry_scheduled') {
    return 'retrying';
  }

  if (
    trackerState === 'done' ||
    trackerState === 'duplicate' ||
    (orchestratorState === 'completed' && issue.delivery_state === 'completed')
  ) {
    return 'done';
  }

  return null;
}

function shouldRefreshRuntimeIssueCard(issue: RuntimeIssueView): boolean {
  const trackerState = issue.tracker_state.trim().toLowerCase();
  const orchestratorState = (issue.orchestrator_state ?? '').trim().toLowerCase();

  if (
    trackerState === 'done' ||
    trackerState === 'duplicate' ||
    trackerState === 'cancelled' ||
    trackerState === 'canceled' ||
    orchestratorState === 'completed' ||
    orchestratorState === 'failed' ||
    orchestratorState === 'cancelled' ||
    orchestratorState === 'retry_scheduled'
  ) {
    return false;
  }

  if (orchestratorState === 'dev_running' || orchestratorState === 'review_running') {
    return true;
  }

  if (issue.phase === 'REVIEW' && /review|progress/i.test(issue.tracker_state)) {
    return true;
  }

  return issue.phase === 'DEV' && Boolean(issue.session);
}

function shouldRefreshExistingRuntimeIssueCard(issue: RuntimeIssueView): boolean {
  return shouldRefreshRuntimeIssueCard(issue) ||
    classifyLifecycleNotification(issue) !== null ||
    isRuntimeIssueCompleted(issue);
}

function shouldCreateInitialTerminalRuntimeIssueCard(issue: RuntimeIssueView): boolean {
  return isRuntimeIssueCompleted(issue) ||
    isTerminalIssue(issue) ||
    issue.delivery_state === 'delivery_failed' ||
    issue.orchestrator_state === 'failed';
}

function runtimeIssueCardState(issue: RuntimeIssueView): 'open' | 'resolved' | 'failed' {
  if (
    issue.delivery_state === 'delivery_failed' ||
    (issue.delivery_code && issue.delivery_code !== 'manual_stop') ||
    issue.orchestrator_state === 'failed'
  ) {
    return 'failed';
  }
  return (isTerminalIssue(issue) || isRuntimeIssueCompleted(issue)) ? 'resolved' : 'open';
}

function buildRuntimeIssueCardMessage(issue: RuntimeIssueView, recipient: BotRecipient): BotTransportMessage {
  const visual = buildSupervisorIssueVisualCard(issue, {
    theme: recipient.transport === 'telegram'
      ? (getTelegramThemePreference(recipient.conversation_id) ?? 'light')
      : 'light',
  });
  return {
    text: visual.caption,
    caption: visual.caption,
    format: 'telegram_html',
    media_key: visual.media_key,
    photo: visual.photo,
    show_caption_above_media: false,
    action_rows: buildIssueCardActionRows(issue),
  };
}

function isGovernanceThreadActive(issue: RuntimeIssueView | null | undefined): boolean {
  if (!issue) {
    return false;
  }

  return ['waiting_on_child', 'child_failed'].includes(issue.governance_thread_state ?? '') || isGovernanceBlockedIssue(issue);
}

function isChildFailureState(orchestratorState: RuntimeIssueView['orchestrator_state'] | null | undefined): boolean {
  return orchestratorState === 'failed';
}

function cardKeyRepresentsChildFailure(cardKey: string | null | undefined, currentChildIdentifier: string | null | undefined): boolean {
  if (!cardKey || !currentChildIdentifier) {
    return false;
  }
  return cardKey.includes('|child_failed|') && cardKey.includes(`|${currentChildIdentifier}|`);
}

function hasSupervisorRuntimeProjection(issue: RuntimeIssueView | null | undefined): boolean {
  return Boolean(
    issue?.supervisor_session_state ||
    issue?.supervisor_plan_summary ||
    issue?.supervisor_job_state ||
    issue?.latest_supervisor_directive ||
    issue?.active_decision_kind,
  );
}

function isGovernanceDescendantIssue(issue: RuntimeIssueView): boolean {
  return Boolean(
    (issue.governance_root_issue_id && issue.governance_root_issue_id !== issue.issue_id) ||
    (issue.governance_root_issue_identifier && issue.governance_root_issue_identifier !== issue.identifier),
  );
}

function compactLifecycleText(value: string | null | undefined, maxLength: number): string | null {
  const compacted = value?.replace(/\s+/g, ' ').trim();
  if (!compacted) {
    return null;
  }
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function issueLocale(issue: RuntimeIssueView): RuntimeLocale {
  return issue.supervisor_locale ?? inferRuntimeLocaleFromText([
    issue.title,
    issue.supervisor_plan_summary,
    issue.delivery_summary,
    issue.next_recommended_action,
  ].filter(Boolean).join('\n'));
}

function textForLocale(locale: RuntimeLocale, zh: string, en: string): string {
  return locale === 'en' ? en : zh;
}

function numberOrZero(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function formatTokenNumber(value: number): string {
  return String(numberOrZero(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function copyIssueTokenUsage(tokens: RuntimeIssueTokenUsage | null | undefined): RuntimeIssueTokenUsage | null {
  if (!tokens) {
    return null;
  }
  const inputTokens = numberOrZero(tokens.input_tokens);
  const outputTokens = numberOrZero(tokens.output_tokens);
  const totalTokens = numberOrZero(tokens.total_tokens);
  const hasExplicitUncachedInput = tokens.uncached_input_tokens != null;
  const uncachedInput = numberOrZero(tokens.uncached_input_tokens);
  const cacheReadInput = numberOrZero(tokens.cache_read_input_tokens);
  let cacheCreationInput = numberOrZero(tokens.cache_creation_input_tokens);
  const unassignedInput = Math.max(0, inputTokens - uncachedInput - cacheReadInput - cacheCreationInput);
  if (hasExplicitUncachedInput && unassignedInput > 0 && (cacheReadInput > 0 || cacheCreationInput > 0)) {
    cacheCreationInput += unassignedInput;
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(uncachedInput > 0 ? { uncached_input_tokens: uncachedInput } : {}),
    ...(cacheCreationInput > 0 ? { cache_creation_input_tokens: cacheCreationInput } : {}),
    ...(cacheReadInput > 0 ? { cache_read_input_tokens: cacheReadInput } : {}),
  };
}

function addIssueTokenUsage(
  left: RuntimeIssueTokenUsage | null | undefined,
  right: RuntimeIssueTokenUsage | null | undefined,
): RuntimeIssueTokenUsage | null {
  const base = copyIssueTokenUsage(left);
  const delta = copyIssueTokenUsage(right);
  if (!base) {
    return delta;
  }
  if (!delta) {
    return base;
  }

  const uncachedInput = numberOrZero(base.uncached_input_tokens) + numberOrZero(delta.uncached_input_tokens);
  const cacheCreationInput = numberOrZero(base.cache_creation_input_tokens) + numberOrZero(delta.cache_creation_input_tokens);
  const cacheReadInput = numberOrZero(base.cache_read_input_tokens) + numberOrZero(delta.cache_read_input_tokens);
  return {
    input_tokens: numberOrZero(base.input_tokens) + numberOrZero(delta.input_tokens),
    output_tokens: numberOrZero(base.output_tokens) + numberOrZero(delta.output_tokens),
    total_tokens: numberOrZero(base.total_tokens) + numberOrZero(delta.total_tokens),
    ...(uncachedInput > 0 ? { uncached_input_tokens: uncachedInput } : {}),
    ...(cacheCreationInput > 0 ? { cache_creation_input_tokens: cacheCreationInput } : {}),
    ...(cacheReadInput > 0 ? { cache_read_input_tokens: cacheReadInput } : {}),
  };
}

function buildTokenUsageLine(locale: RuntimeLocale, tokens: RuntimeIssueTokenUsage | null | undefined): string | null {
  const usage = copyIssueTokenUsage(tokens);
  const total = usage ? Math.max(usage.total_tokens, usage.input_tokens + usage.output_tokens) : 0;
  if (!usage || total <= 0) {
    return null;
  }

  const cacheRead = numberOrZero(usage.cache_read_input_tokens);
  const uncachedInput = Math.max(0, usage.input_tokens - cacheRead);
  const label = textForLocale(locale, 'Token 消耗', 'Tokens');
  const outputLabel = textForLocale(locale, '输出', 'output');
  const inputEquationParts = [
    `${textForLocale(locale, '未命中', 'uncached')} ${formatTokenNumber(uncachedInput)}`,
    cacheRead > 0 ? `${textForLocale(locale, '缓存读取', 'cache read')} ${formatTokenNumber(cacheRead)}` : null,
  ].filter(Boolean);
  const inputBreakdown = `${textForLocale(locale, '输入总计', 'input total')} ${formatTokenNumber(usage.input_tokens)} = ${inputEquationParts.join(' + ')}`;

  return `${label}: ${formatTokenNumber(total)} (${inputBreakdown}, ${outputLabel} ${formatTokenNumber(usage.output_tokens)})`;
}

function buildLifecycleMessage(
  issue: RuntimeIssueView,
  notificationClass: LifecycleNotificationClass,
  tokenUsage?: RuntimeIssueTokenUsage | null,
): BotTransportMessage {
  const locale = issueLocale(issue);
  const headline = notificationClass === 'retrying'
    ? textForLocale(locale, `SymHarix 重试中 · ${issue.identifier}`, `SymHarix retrying · ${issue.identifier}`)
    : notificationClass === 'failed'
      ? textForLocale(locale, `SymHarix 失败 · ${issue.identifier}`, `SymHarix failed · ${issue.identifier}`)
      : notificationClass === 'delivery_failed'
        ? textForLocale(locale, `SymHarix 交付阻塞 · ${issue.identifier}`, `SymHarix delivery blocked · ${issue.identifier}`)
      : notificationClass === 'cancelled'
        ? textForLocale(locale, `SymHarix 已取消 · ${issue.identifier}`, `SymHarix cancelled · ${issue.identifier}`)
        : textForLocale(locale, `SymHarix 完成 · ${issue.identifier}`, `SymHarix completed · ${issue.identifier}`);
  const summary = notificationClass === 'retrying'
    ? textForLocale(locale, '这张单刚进入重试队列；我会继续盯高信号结果，不再推送同类抖动。', 'This issue just entered the retry queue; I will keep watching for high-signal results without repeating the same noise.')
    : notificationClass === 'failed'
      ? textForLocale(locale, '这张单当前执行失败，等待你处理或下一次显式重试。', 'This issue is currently failed and is waiting for recovery or an explicit retry.')
      : notificationClass === 'delivery_failed'
        ? (issue.delivery_summary || issue.delivery_code || textForLocale(locale, '这张单的最终交付被阻塞，需要你处理。', 'This issue final delivery is blocked and needs attention.'))
      : notificationClass === 'cancelled'
        ? textForLocale(locale, '这张单已经结束，不会再继续自动推进。', 'This issue has ended and will not continue automatically.')
        : textForLocale(locale, '这张单已经进入终态，当前主链处理完成。', 'This issue has reached a terminal state; the main processing path is complete.');
  const failureReason = notificationClass === 'failed'
    ? compactLifecycleText(issue.delivery_summary, 260)
    : null;
  const tokenUsageLine = notificationClass === 'done'
    ? buildTokenUsageLine(locale, tokenUsage ?? issue.usage ?? issue.session?.tokens)
    : null;
  const lines = [
    headline,
    `${issue.title}`,
    summary,
    tokenUsageLine,
    failureReason ? `${textForLocale(locale, '失败原因', 'Failure reason')}：${failureReason}` : null,
    `phase ${issue.phase} · tracker ${issue.tracker_state} · orchestrator ${issue.orchestrator_state || 'unknown'}`,
    issue.delivery_code ? `delivery ${issue.delivery_code}` : null,
    issue.github_repo ? `repo ${issue.github_repo}` : null,
    issue.branch_name ? `branch ${issue.branch_name}` : null,
  ].filter(Boolean);

  return {
    text: lines.join('\n'),
  };
}

function buildTimelineDigestMessage(issue: RuntimeIssueView, event: RuntimeTimelineEvent): BotTransportMessage {
  return {
    text: [
      `SymHarix timeline · ${issue.identifier}`,
      `${event.message}`,
      issue.github_repo ? `repo ${issue.github_repo}` : null,
    ].filter(Boolean).join('\n'),
  };
}

export class BotFollowupService {
  private readonly unsubscribeRuntime: () => void;
  private readonly seenTimelineIds = new Set<string>();
  private readonly issueLifecycleClasses = new Map<string, LifecycleNotificationClass>();
  private readonly governanceEventKeys = new Map<string, string>();
  private readonly lifecycleDigestsInFlight = new Set<string>();
  private readonly governanceCardsInFlight = new Set<string>();
  private readonly runtimeIssueCardsInFlight = new Set<string>();
  private readonly issueTokenSnapshots = new Map<string, Map<string, RuntimeIssueTokenUsage>>();

  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly notifiers: Partial<Record<BotTransport, BotTransportNotifier>>,
    private readonly followups: BotIssueFollowupRepository | null,
    private readonly messageStates: BotFollowupMessageStateRepository | null,
    private readonly options: BotFollowupServiceOptions = {},
  ) {
    this.unsubscribeRuntime = this.runtime.subscribe((event) => {
      void this.handleRuntimeEvent(event);
    });
    if (this.options.bootstrapCurrentGovernanceCards !== false) {
      void this.syncCurrentGovernanceCards();
    }
    void this.syncCurrentDeliveryFailures();
  }

  dispose(): void {
    this.unsubscribeRuntime();
    this.seenTimelineIds.clear();
    this.issueLifecycleClasses.clear();
    this.governanceEventKeys.clear();
    this.governanceCardsInFlight.clear();
    this.runtimeIssueCardsInFlight.clear();
    this.issueTokenSnapshots.clear();
  }

  registerOrigin(params: {
    transport: BotTransport;
    conversation_id: string;
    issue_id: string;
    issue_identifier?: string | null;
    user_id?: string | null;
  }): void {
    this.followups?.upsert({
      transport: params.transport,
      conversation_id: params.conversation_id,
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier ?? null,
      user_id: params.user_id ?? null,
      role: 'origin',
    });
  }

  private registerOriginsForIssue(recipients: BotRecipient[], issue: RuntimeIssueView): void {
    for (const recipient of recipients) {
      this.followups?.upsert({
        transport: recipient.transport,
        conversation_id: recipient.conversation_id,
        issue_id: issue.issue_id,
        issue_identifier: issue.identifier,
        user_id: null,
        role: 'origin',
      });
    }
  }

  private async handleRuntimeEvent(event: RuntimeStreamEvent): Promise<void> {
    if (event.type === 'overview' || event.type === 'snapshot') {
      return;
    }

    if (event.type === 'issue') {
      this.rememberIssueTokens(event.data);
      const threadIssue = this.buildThreadIssue(event.data);
      this.rememberIssueTokens(threadIssue);
      const recipients = this.collectRecipients(threadIssue.issue_id);
      if (recipients.length === 0) {
        return;
      }
      if (isGovernanceDescendantIssue(event.data)) {
        this.registerOriginsForIssue(recipients, event.data);
        await this.upsertRuntimeIssueCards(recipients, event.data, {
          allowAdditionalRuntimeCard: true,
          allowInitialTerminalCard: true,
        });
      }
      await this.upsertGovernanceChildRuntimeCards(recipients, threadIssue);
      if (this.isSupervisorManagedIssue(threadIssue)) {
        return;
      }
      const followupRecipients = await this.upsertSupervisorSessionCards(recipients, threadIssue);
      if (followupRecipients.length === 0) {
        return;
      }

      if (isGovernanceThreadActive(threadIssue)) {
        await this.upsertGovernanceCard(followupRecipients, threadIssue);
        return;
      }

      const resolved = await this.resolveGovernanceCards(followupRecipients, threadIssue);
      if (resolved) {
        return;
      }

      await this.upsertRuntimeIssueCards(followupRecipients, threadIssue);

      if (threadIssue.issue_id !== event.data.issue_id) {
        return;
      }

      const notificationClass = classifyLifecycleNotification(threadIssue);
      if (!notificationClass) {
        return;
      }
      await this.sendLifecycleDigest(followupRecipients, threadIssue, notificationClass);
      return;
    }

    if (!shouldNotifyTimeline(event.data)) {
      return;
    }

    if (this.seenTimelineIds.has(event.data.id)) {
      return;
    }
    this.seenTimelineIds.add(event.data.id);
    if (this.seenTimelineIds.size > 2000) {
      const oldest = this.seenTimelineIds.values().next();
      if (!oldest.done) {
        this.seenTimelineIds.delete(oldest.value);
      }
    }

    const eventIssue = this.runtime.getIssue(event.data.issue_id);
    if (!eventIssue) {
      return;
    }
    const threadIssue = this.buildThreadIssue(eventIssue);

    const recipients = this.collectRecipients(threadIssue.issue_id);
    if (recipients.length === 0) {
      return;
    }
    if (isGovernanceDescendantIssue(eventIssue)) {
      this.registerOriginsForIssue(recipients, eventIssue);
      await this.upsertRuntimeIssueCards(recipients, eventIssue, {
        allowAdditionalRuntimeCard: true,
        allowInitialTerminalCard: true,
      });
    }
    await this.upsertGovernanceChildRuntimeCards(recipients, threadIssue);
    if (this.isSupervisorManagedIssue(threadIssue)) {
      return;
    }
    const followupRecipients = await this.upsertSupervisorSessionCards(recipients, threadIssue);
    if (followupRecipients.length === 0) {
      return;
    }

    if (['governance_blocked', 'governance_assessed', 'governance_suggestion_created', 'governance_override_approved'].includes(event.data.code)) {
      const governanceKey = [
        event.data.code,
        buildGovernanceCardKey(threadIssue),
      ].join('|');
      if (this.governanceEventKeys.get(threadIssue.issue_id) === governanceKey) {
        return;
      }
      this.governanceEventKeys.set(threadIssue.issue_id, governanceKey);

      if (isGovernanceThreadActive(threadIssue)) {
        await this.upsertGovernanceCard(followupRecipients, threadIssue);
        return;
      }

      const resolved = await this.resolveGovernanceCards(followupRecipients, threadIssue);
      if (resolved) {
        return;
      }
    }

    if (threadIssue.issue_id !== eventIssue.issue_id) {
      return;
    }

    if (this.hasActiveGovernanceCard(followupRecipients, threadIssue.issue_id)) {
      return;
    }

    await this.send(followupRecipients, buildTimelineDigestMessage(threadIssue, event.data));
  }

  private async syncCurrentGovernanceCards(): Promise<void> {
    const overview = this.runtime.getOverview();

    for (const issue of overview.issues) {
      const threadIssue = this.resolveGovernanceThreadIssue(issue);
      const recipients = this.collectRecipients(threadIssue.issue_id);
      if (recipients.length === 0) {
        continue;
      }
      if (this.isSupervisorManagedIssue(threadIssue)) {
        continue;
      }

      if (isGovernanceThreadActive(threadIssue)) {
        await this.upsertGovernanceCard(recipients, threadIssue);
        continue;
      }

      await this.resolveGovernanceCards(recipients, threadIssue);
    }
  }

  private async syncCurrentDeliveryFailures(): Promise<void> {
    const overview = this.runtime.getOverview();

    for (const issue of overview.issues) {
      const threadIssue = this.buildThreadIssue(issue);
      if (threadIssue.issue_id !== issue.issue_id) {
        continue;
      }
      if (this.isSupervisorManagedIssue(threadIssue) || isGovernanceThreadActive(threadIssue)) {
        continue;
      }
      const notificationClass = classifyLifecycleNotification(threadIssue);
      if (notificationClass !== 'delivery_failed') {
        continue;
      }
      const recipients = this.collectRecipients(threadIssue.issue_id);
      if (recipients.length === 0) {
        continue;
      }
      const followupRecipients = await this.upsertSupervisorSessionCards(recipients, threadIssue);
      if (followupRecipients.length === 0) {
        continue;
      }
      await this.sendLifecycleDigest(followupRecipients, threadIssue, notificationClass);
    }
  }

  private resolveGovernanceThreadIssue(issue: RuntimeIssueView): RuntimeIssueView {
    if (issue.governance_root_issue_id && issue.governance_root_issue_id !== issue.issue_id) {
      return this.runtime.getIssue(issue.governance_root_issue_id) ?? issue;
    }

    if (
      issue.governance_root_issue_identifier &&
      issue.governance_root_issue_identifier !== issue.identifier
    ) {
      return this.runtime.getIssue(issue.governance_root_issue_identifier) ?? issue;
    }

    return issue;
  }

  private buildThreadIssue(issue: RuntimeIssueView): RuntimeIssueView {
    const rootIssue = this.resolveGovernanceThreadIssue(issue);
    if (rootIssue.issue_id === issue.issue_id) {
      return rootIssue;
    }

    return this.mergeDescendantIntoThread(rootIssue, issue);
  }

  private mergeDescendantIntoThread(rootIssue: RuntimeIssueView, descendantIssue: RuntimeIssueView): RuntimeIssueView {
    const matchesChild = (child: NonNullable<RuntimeIssueView['governance_child_issues']>[number]): boolean =>
      child.issue_id === descendantIssue.issue_id || child.issue_identifier === descendantIssue.identifier;
    const mergeChild = (child: NonNullable<RuntimeIssueView['governance_child_issues']>[number]) =>
      matchesChild(child)
        ? {
            ...child,
            tracker_state: descendantIssue.tracker_state,
            orchestrator_state: descendantIssue.orchestrator_state,
            governance_decision: descendantIssue.governance_decision ?? child.governance_decision,
            governance_summary: descendantIssue.governance_summary ?? child.governance_summary,
            delivery_state: descendantIssue.delivery_state ?? child.delivery_state ?? null,
            delivery_summary: descendantIssue.delivery_summary ?? child.delivery_summary ?? null,
          }
        : child;

    const governanceChildIssues = (rootIssue.governance_child_issues ?? []).map(mergeChild);
    const governanceChildQueue = (rootIssue.governance_child_queue ?? governanceChildIssues).map(mergeChild);
    const governanceCurrentChild = rootIssue.governance_current_child
      ? mergeChild(rootIssue.governance_current_child)
      : governanceChildQueue.find((child) => child.queue_state === 'current')
        ?? null;
    const failureSummary = governanceCurrentChild && isChildFailureState(governanceCurrentChild.orchestrator_state)
      ? (governanceCurrentChild.delivery_summary ?? '当前子任务执行失败，正在等待重试或人工处理。')
      : null;
    const governanceThreadState = governanceCurrentChild?.delivery_state === 'delivery_failed' || Boolean(failureSummary)
      ? 'child_failed'
      : rootIssue.governance_thread_state === 'child_failed'
        ? 'waiting_on_child'
        : rootIssue.governance_thread_state;

    return {
      ...rootIssue,
      governance_thread_state: governanceThreadState,
      governance_child_issues: governanceChildIssues,
      governance_current_child: governanceCurrentChild
        ? {
            ...governanceCurrentChild,
            delivery_summary: failureSummary ?? governanceCurrentChild.delivery_summary ?? null,
          }
        : governanceCurrentChild,
      governance_child_queue: governanceChildQueue.map((child) => (
        governanceCurrentChild && child.issue_id === governanceCurrentChild.issue_id && failureSummary
          ? {
              ...child,
              delivery_summary: failureSummary,
            }
          : child
      )),
      next_recommended_action: governanceCurrentChild
        ? `先处理治理子任务 ${governanceCurrentChild.issue_identifier}`
        : rootIssue.next_recommended_action,
    };
  }

  private governanceChildIssuesForRuntimeCards(threadIssue: RuntimeIssueView): RuntimeIssueView[] {
    const childRefs = [
      threadIssue.governance_current_child,
      ...(threadIssue.governance_child_queue ?? []),
      ...(threadIssue.governance_child_issues ?? []),
    ].filter(Boolean);
    const seen = new Set<string>();
    const issues: RuntimeIssueView[] = [];

    for (const child of childRefs) {
      const issue = this.runtime.getIssue(child.issue_id) ?? this.runtime.getIssue(child.issue_identifier);
      if (!issue || issue.issue_id === threadIssue.issue_id || seen.has(issue.issue_id)) {
        continue;
      }
      seen.add(issue.issue_id);
      issues.push(issue);
    }

    return issues;
  }

  private async upsertGovernanceChildRuntimeCards(
    recipients: BotRecipient[],
    threadIssue: RuntimeIssueView,
  ): Promise<void> {
    const childIssues = this.governanceChildIssuesForRuntimeCards(threadIssue);
    for (const childIssue of childIssues) {
      this.registerOriginsForIssue(recipients, childIssue);
      await this.upsertRuntimeIssueCards(recipients, childIssue, {
        allowAdditionalRuntimeCard: true,
        allowInitialTerminalCard: true,
      });
    }
  }

  private collectRecipients(issueId: string): BotRecipient[] {
    const recipients = new Map<string, BotRecipient>();
    const followupRecords = this.followups?.findByIssueId(issueId) ?? [];
    const originTransports = new Set<BotTransport>();
    for (const record of followupRecords) {
      originTransports.add(record.transport);
      if (!this.notifiers[record.transport]) {
        continue;
      }
      recipients.set(`${record.transport}:${record.conversation_id}`, {
        transport: record.transport,
        conversation_id: record.conversation_id,
      });
    }
    const shouldIncludeOperationsChat = (transport: BotTransport): boolean =>
      originTransports.size === 0 || originTransports.has(transport);

    if (
      this.options.telegramOperationsChatId &&
      this.notifiers.telegram &&
      shouldIncludeOperationsChat('telegram')
    ) {
      recipients.set(`telegram:${this.options.telegramOperationsChatId}`, {
        transport: 'telegram',
        conversation_id: this.options.telegramOperationsChatId,
      });
    }

    if (
      this.options.feishuOperationsChatId &&
      this.notifiers.feishu &&
      shouldIncludeOperationsChat('feishu')
    ) {
      recipients.set(`feishu:${this.options.feishuOperationsChatId}`, {
        transport: 'feishu',
        conversation_id: this.options.feishuOperationsChatId,
      });
    }

    return Array.from(recipients.values());
  }

  private isSupervisorManagedIssue(issue: RuntimeIssueView): boolean {
    if (hasSupervisorRuntimeProjection(issue)) {
      return true;
    }
    return Boolean(this.options.supervisorSessionRepository?.findByRootIssueId(issue.issue_id));
  }

  private rememberIssueTokens(issue: RuntimeIssueView): void {
    if (!issue.session) {
      return;
    }
    const tokens = copyIssueTokenUsage(issue.session.tokens);
    const sessionKey = this.issueSessionTokenKey(issue);
    if (tokens && sessionKey) {
      let sessionSnapshots = this.issueTokenSnapshots.get(issue.issue_id);
      if (!sessionSnapshots) {
        sessionSnapshots = new Map<string, RuntimeIssueTokenUsage>();
        this.issueTokenSnapshots.set(issue.issue_id, sessionSnapshots);
      }
      sessionSnapshots.set(sessionKey, tokens);
    }
  }

  private latestIssueTokens(issue: RuntimeIssueView): RuntimeIssueTokenUsage | null {
    const issueUsage = copyIssueTokenUsage(issue.usage);
    if (issueUsage && Math.max(issueUsage.total_tokens, issueUsage.input_tokens + issueUsage.output_tokens) > 0) {
      return issueUsage;
    }

    const sessionSnapshots = this.issueTokenSnapshots.get(issue.issue_id);
    let total: RuntimeIssueTokenUsage | null = null;
    for (const tokens of sessionSnapshots?.values() ?? []) {
      total = addIssueTokenUsage(total, tokens);
    }

    const currentSessionKey = this.issueSessionTokenKey(issue);
    const currentTokens = copyIssueTokenUsage(issue.session?.tokens);
    if (
      currentTokens &&
      (!sessionSnapshots || !currentSessionKey || !sessionSnapshots.has(currentSessionKey))
    ) {
      total = addIssueTokenUsage(total, currentTokens);
    }

    return total;
  }

  private issueSessionTokenKey(issue: RuntimeIssueView): string | null {
    if (!issue.session) {
      return null;
    }
    const sessionId = issue.session.session_id?.trim();
    if (sessionId) {
      return `${issue.phase}:${sessionId}`;
    }
    return [
      issue.phase,
      issue.session.stage ?? 'unknown-stage',
      issue.session.started_at ?? issue.session.last_event_at ?? 'unknown-start',
    ].join(':');
  }

  private hasActiveGovernanceCard(recipients: BotRecipient[], issueId: string): boolean {
    if (!this.messageStates) {
      return false;
    }

    return recipients.some((recipient) => {
      const state = this.messageStates.findByConversationIssue({
        transport: recipient.transport,
        conversation_id: recipient.conversation_id,
        issue_id: issueId,
      });
      return Boolean(state && state.card_kind === 'governance_blocked' && state.card_state !== 'resolved');
    });
  }

  private hasActiveRuntimeIssueCard(recipient: BotRecipient): boolean {
    if (!this.messageStates) {
      return false;
    }

    return this.messageStates.findOpenByConversation({
      transport: recipient.transport,
      conversation_id: recipient.conversation_id,
    }).some((record) => record.card_kind === 'runtime_issue');
  }

  private shouldSkipLifecycleDigest(
    recipient: BotRecipient,
    issue: RuntimeIssueView,
    notificationClass: LifecycleNotificationClass,
  ): boolean {
    const memoryKey = `${recipient.transport}:${recipient.conversation_id}:${issue.issue_id}`;
    if (this.issueLifecycleClasses.get(memoryKey) === notificationClass) {
      return true;
    }
    if (this.lifecycleDigestsInFlight.has(`${memoryKey}:${notificationClass}`)) {
      return true;
    }

    if (this.options.deliveryStateRepository) {
      const existing = this.options.deliveryStateRepository.findByKey({
        transport: recipient.transport,
        conversation_id: recipient.conversation_id,
        root_issue_id: issue.issue_id,
        delivery_kind: 'lifecycle_digest',
      });
      return existing?.last_notification_class === notificationClass;
    }

    return this.issueLifecycleClasses.get(`${recipient.transport}:${recipient.conversation_id}:${issue.issue_id}`) === notificationClass;
  }

  private markLifecycleDigestSent(
    recipient: BotRecipient,
    issue: RuntimeIssueView,
    notificationClass: LifecycleNotificationClass,
    messageId: string | null,
  ): void {
    this.issueLifecycleClasses.set(
      `${recipient.transport}:${recipient.conversation_id}:${issue.issue_id}`,
      notificationClass,
    );
    this.options.deliveryStateRepository?.upsert({
      transport: recipient.transport,
      conversation_id: recipient.conversation_id,
      root_issue_id: issue.issue_id,
      root_issue_identifier: issue.identifier,
      delivery_kind: 'lifecycle_digest',
      last_material_key: `class:${notificationClass}`,
      last_notification_class: notificationClass,
      last_message_id: messageId,
    });
  }

  private recordTransportEvent(params: {
    recipient: BotRecipient;
    issue: RuntimeIssueView | null;
    source: 'followup_card' | 'lifecycle_digest';
    action: 'send' | 'edit' | 'fallback';
    result: 'success' | 'failed';
    messageId?: string | null;
    materialKey?: string | null;
    errorMessage?: string | null;
  }): void {
    this.options.transportEventRepository?.create({
      transport: params.recipient.transport,
      conversation_id: params.recipient.conversation_id,
      issue_id: params.issue?.issue_id ?? null,
      root_issue_id: params.issue?.issue_id ?? null,
      source: params.source,
      message_id: params.messageId ?? null,
      action: params.action,
      result: params.result,
      material_key: params.materialKey ?? null,
      error_message: params.errorMessage ?? null,
    });
  }

  private async sendLifecycleDigest(
    recipients: BotRecipient[],
    issue: RuntimeIssueView,
    notificationClass: LifecycleNotificationClass,
  ): Promise<void> {
    const message = buildLifecycleMessage(issue, notificationClass, this.latestIssueTokens(issue));

    await Promise.allSettled(recipients.map(async (recipient) => {
      const notifier = this.notifiers[recipient.transport];
      if (!notifier) {
        return;
      }
      if (this.hasActiveGovernanceCard([recipient], issue.issue_id)) {
        return;
      }
      if (this.shouldSkipLifecycleDigest(recipient, issue, notificationClass)) {
        return;
      }

      const memoryKey = `${recipient.transport}:${recipient.conversation_id}:${issue.issue_id}`;
      const inFlightKey = `${memoryKey}:${notificationClass}`;
      this.issueLifecycleClasses.set(memoryKey, notificationClass);
      this.lifecycleDigestsInFlight.add(inFlightKey);

      try {
        const messageRef = await notifier.sendMessage(recipient, message);
        this.markLifecycleDigestSent(recipient, issue, notificationClass, messageRef.provider_message_id);
        this.recordTransportEvent({
          recipient,
          issue,
          source: 'lifecycle_digest',
          action: 'send',
          result: 'success',
          messageId: messageRef.provider_message_id,
          materialKey: `class:${notificationClass}`,
        });
      } catch (error) {
        this.recordTransportEvent({
          recipient,
          issue,
          source: 'lifecycle_digest',
          action: 'send',
          result: 'failed',
          materialKey: `class:${notificationClass}`,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.lifecycleDigestsInFlight.delete(inFlightKey);
      }
    }));
  }

  private async upsertSupervisorSessionCards(
    recipients: BotRecipient[],
    issue: RuntimeIssueView,
  ): Promise<BotRecipient[]> {
    const sessionRepository = this.options.supervisorSessionRepository;
    if (!sessionRepository) {
      return recipients;
    }

    const remaining: BotRecipient[] = [];
    await Promise.allSettled(recipients.map(async (recipient) => {
      const session = sessionRepository.findByConversationRootIssue({
        transport: recipient.transport,
        conversation_id: recipient.conversation_id,
        root_issue_id: issue.issue_id,
      }) ?? sessionRepository.findActiveByConversation({
        transport: recipient.transport,
        conversation_id: recipient.conversation_id,
      });
      if (!session) {
        remaining.push(recipient);
        return;
      }

      if (session.root_issue_id && session.root_issue_id !== issue.issue_id) {
        remaining.push(recipient);
        return;
      }

      // SupervisorWorker owns session card send/edit. Followups only suppress
      // lifecycle/governance digests for the same root thread to avoid duplicate
      // Telegram edits when runtime issue events fan out through both paths.
    }));

    return remaining;
  }

  private async upsertGovernanceCard(recipients: BotRecipient[], issue: RuntimeIssueView): Promise<void> {
    const waitingOnChild = ['waiting_on_child', 'child_failed'].includes(issue.governance_thread_state ?? '');
    const cardState = waitingOnChild ? 'waiting_on_child' : 'open';
    const message = waitingOnChild
      ? buildGovernanceWaitingOnChildMessage(issue)
      : buildGovernanceBlockedMessage(issue);
    const cardKey = buildGovernanceCardKey(issue);

    await Promise.allSettled(recipients.map(async (recipient) => {
      const notifier = this.notifiers[recipient.transport];
      if (!notifier) {
        return;
      }
      const inFlightKey = [
        recipient.transport,
        recipient.conversation_id,
        issue.issue_id,
        cardState,
        cardKey,
      ].join(':');
      if (this.governanceCardsInFlight.has(inFlightKey)) {
        return;
      }

      const existing = this.messageStates?.findByConversationIssue({
        transport: recipient.transport,
        conversation_id: recipient.conversation_id,
        issue_id: issue.issue_id,
      }) ?? null;

      if (existing && existing.card_state !== 'resolved') {
        const existingRepresentsFailure = cardKeyRepresentsChildFailure(
          existing.card_key,
          issue.governance_current_child?.issue_identifier ?? null,
        );
        if (
          existingRepresentsFailure &&
          issue.governance_thread_state === 'waiting_on_child'
        ) {
          return;
        }

        if (existing.card_key === cardKey && existing.card_state === cardState) {
          return;
        }

        this.governanceCardsInFlight.add(inFlightKey);
        try {
          await notifier.editMessage(
            recipient,
            { provider_message_id: existing.message_id },
            message,
          );
          this.messageStates?.updateState({
            transport: recipient.transport,
            conversation_id: recipient.conversation_id,
            issue_id: issue.issue_id,
            issue_identifier: issue.identifier,
            card_key: cardKey,
            card_kind: 'governance_blocked',
            card_state: cardState,
          });
          this.options.deliveryStateRepository?.upsert({
            transport: recipient.transport,
            conversation_id: recipient.conversation_id,
            root_issue_id: issue.issue_id,
            root_issue_identifier: issue.identifier,
            delivery_kind: 'governance_card',
            last_material_key: cardKey,
            last_notification_class: null,
            last_message_id: existing.message_id,
          });
          this.recordTransportEvent({
            recipient,
            issue,
            source: 'followup_card',
            action: 'edit',
            result: 'success',
            messageId: existing.message_id,
            materialKey: cardKey,
          });
          return;
        } catch (error) {
          if (getBotMessageEditFailureKind(error) === 'not_modified') {
            this.messageStates?.updateState({
              transport: recipient.transport,
              conversation_id: recipient.conversation_id,
              issue_id: issue.issue_id,
              issue_identifier: issue.identifier,
              card_key: cardKey,
              card_kind: 'governance_blocked',
              card_state: cardState,
            });
            this.options.deliveryStateRepository?.upsert({
              transport: recipient.transport,
              conversation_id: recipient.conversation_id,
              root_issue_id: issue.issue_id,
              root_issue_identifier: issue.identifier,
              delivery_kind: 'governance_card',
              last_material_key: cardKey,
              last_notification_class: null,
              last_message_id: existing.message_id,
            });
            this.recordTransportEvent({
              recipient,
              issue,
              source: 'followup_card',
              action: 'edit',
              result: 'success',
              messageId: existing.message_id,
              materialKey: cardKey,
            });
            return;
          }
          this.recordTransportEvent({
            recipient,
            issue,
            source: 'followup_card',
            action: 'edit',
            result: 'failed',
            messageId: existing.message_id,
            materialKey: cardKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          // Fall back to posting a new message and refreshing the stored message id.
        } finally {
          this.governanceCardsInFlight.delete(inFlightKey);
        }
      }

      this.governanceCardsInFlight.add(inFlightKey);
      try {
        const messageRef = await notifier.sendMessage(recipient, message);
        this.messageStates?.upsert({
          transport: recipient.transport,
          conversation_id: recipient.conversation_id,
          issue_id: issue.issue_id,
          issue_identifier: issue.identifier,
          message_id: messageRef.provider_message_id,
          card_kind: 'governance_blocked',
          card_key: cardKey,
          card_state: cardState,
        });
        this.options.deliveryStateRepository?.upsert({
          transport: recipient.transport,
          conversation_id: recipient.conversation_id,
          root_issue_id: issue.issue_id,
          root_issue_identifier: issue.identifier,
          delivery_kind: 'governance_card',
          last_material_key: cardKey,
          last_notification_class: null,
          last_message_id: messageRef.provider_message_id,
        });
        this.recordTransportEvent({
          recipient,
          issue,
          source: 'followup_card',
          action: existing ? 'fallback' : 'send',
          result: 'success',
          messageId: messageRef.provider_message_id,
          materialKey: cardKey,
        });
      } finally {
        this.governanceCardsInFlight.delete(inFlightKey);
      }
    }));
  }

  private async upsertRuntimeIssueCards(
    recipients: BotRecipient[],
    issue: RuntimeIssueView,
    options: {
      allowAdditionalRuntimeCard?: boolean;
      allowInitialTerminalCard?: boolean;
    } = {},
  ): Promise<void> {
    const canCreateInitialTerminalCard =
      Boolean(options.allowInitialTerminalCard) &&
      shouldCreateInitialTerminalRuntimeIssueCard(issue);
    if (
      !this.messageStates ||
      (!shouldRefreshExistingRuntimeIssueCard(issue) && !canCreateInitialTerminalCard)
    ) {
      return;
    }

    const cardState = runtimeIssueCardState(issue);

    await Promise.allSettled(recipients.map(async (recipient) => {
      const message = buildRuntimeIssueCardMessage(issue, recipient);
      const materialKey = message.media_key ?? `runtime_issue_card|${issue.identifier}|${issue.updated_at}`;
      const notifier = this.notifiers[recipient.transport];
      if (!notifier) {
        return;
      }
      if (this.options.runtimeIssueCardLock?.isLocked({
        transport: recipient.transport,
        conversation_id: recipient.conversation_id,
        issue_id: issue.issue_id,
      })) {
        return;
      }
      if (this.hasActiveGovernanceCard([recipient], issue.issue_id)) {
        return;
      }

      const existing = this.messageStates?.findByConversationIssue({
        transport: recipient.transport,
        conversation_id: recipient.conversation_id,
        issue_id: issue.issue_id,
      }) ?? null;
      if (!existing && !shouldRefreshRuntimeIssueCard(issue) && !canCreateInitialTerminalCard) {
        return;
      }
      if (!existing && !options.allowAdditionalRuntimeCard && this.hasActiveRuntimeIssueCard(recipient)) {
        return;
      }

      if (
        existing?.card_kind === 'runtime_issue' &&
        existing.card_key === materialKey &&
        existing.card_state === cardState
      ) {
        return;
      }

      const inFlightKey = [
        recipient.transport,
        recipient.conversation_id,
        issue.issue_id,
      ].join(':');
      if (this.runtimeIssueCardsInFlight.has(inFlightKey)) {
        return;
      }

      this.runtimeIssueCardsInFlight.add(inFlightKey);
      try {
        if (existing?.card_kind === 'runtime_issue') {
          try {
            await notifier.editMessage(
              recipient,
              { provider_message_id: existing.message_id },
              message,
            );
            this.messageStates?.updateState({
              transport: recipient.transport,
              conversation_id: recipient.conversation_id,
              issue_id: issue.issue_id,
              issue_identifier: issue.identifier,
              card_kind: 'runtime_issue',
              card_key: materialKey,
              card_state: cardState,
            });
            this.recordTransportEvent({
              recipient,
              issue,
              source: 'followup_card',
              action: 'edit',
              result: 'success',
              messageId: existing.message_id,
              materialKey,
            });
            return;
          } catch (error) {
            if (getBotMessageEditFailureKind(error) === 'not_modified') {
              this.messageStates?.updateState({
                transport: recipient.transport,
                conversation_id: recipient.conversation_id,
                issue_id: issue.issue_id,
                issue_identifier: issue.identifier,
                card_kind: 'runtime_issue',
                card_key: materialKey,
                card_state: cardState,
              });
              this.recordTransportEvent({
                recipient,
                issue,
                source: 'followup_card',
                action: 'edit',
                result: 'success',
                messageId: existing.message_id,
                materialKey,
              });
              return;
            }

            this.recordTransportEvent({
              recipient,
              issue,
              source: 'followup_card',
              action: 'edit',
              result: 'failed',
              messageId: existing.message_id,
              materialKey,
              errorMessage: error instanceof Error ? error.message : String(error),
            });

            if (getBotMessageEditFailureKind(error) !== 'message_not_found') {
              return;
            }
          }
        }

        const messageRef = await notifier.sendMessage(recipient, message);
        this.messageStates?.upsert({
          transport: recipient.transport,
          conversation_id: recipient.conversation_id,
          issue_id: issue.issue_id,
          issue_identifier: issue.identifier,
          message_id: messageRef.provider_message_id,
          card_kind: 'runtime_issue',
          card_key: materialKey,
          card_state: cardState,
        });
        this.recordTransportEvent({
          recipient,
          issue,
          source: 'followup_card',
          action: existing?.card_kind === 'runtime_issue' ? 'fallback' : 'send',
          result: 'success',
          messageId: messageRef.provider_message_id,
          materialKey,
        });
      } finally {
        this.runtimeIssueCardsInFlight.delete(inFlightKey);
      }
    }));
  }

  private async resolveGovernanceCards(recipients: BotRecipient[], issue: RuntimeIssueView): Promise<boolean> {
    let resolvedAny = false;
    const message = buildGovernanceResolvedMessage(issue);

    await Promise.allSettled(recipients.map(async (recipient) => {
      const notifier = this.notifiers[recipient.transport];
      if (!notifier || !this.messageStates) {
        return;
      }

      const existing = this.messageStates.findByConversationIssue({
        transport: recipient.transport,
        conversation_id: recipient.conversation_id,
        issue_id: issue.issue_id,
      });

      if (!existing || existing.card_kind !== 'governance_blocked' || existing.card_state === 'resolved') {
        return;
      }

      const materialKey = `resolved|${issue.orchestrator_state || 'unknown'}|${issue.tracker_state}`;
      const inFlightKey = [
        recipient.transport,
        recipient.conversation_id,
        issue.issue_id,
        'resolved',
        materialKey,
      ].join(':');
      if (this.governanceCardsInFlight.has(inFlightKey)) {
        resolvedAny = true;
        return;
      }

      resolvedAny = true;
      this.governanceCardsInFlight.add(inFlightKey);
      try {
        await notifier.editMessage(
          recipient,
          { provider_message_id: existing.message_id },
          message,
        );
        this.messageStates.updateState({
          transport: recipient.transport,
          conversation_id: recipient.conversation_id,
          issue_id: issue.issue_id,
          issue_identifier: issue.identifier,
          card_key: materialKey,
          card_state: 'resolved',
        });
        this.options.deliveryStateRepository?.upsert({
          transport: recipient.transport,
          conversation_id: recipient.conversation_id,
          root_issue_id: issue.issue_id,
          root_issue_identifier: issue.identifier,
          delivery_kind: 'governance_card',
          last_material_key: materialKey,
          last_notification_class: null,
          last_message_id: existing.message_id,
        });
        this.recordTransportEvent({
          recipient,
          issue,
          source: 'followup_card',
          action: 'edit',
          result: 'success',
          messageId: existing.message_id,
          materialKey,
        });
      } catch (error) {
        if (getBotMessageEditFailureKind(error) === 'not_modified') {
          this.messageStates.updateState({
            transport: recipient.transport,
            conversation_id: recipient.conversation_id,
            issue_id: issue.issue_id,
            issue_identifier: issue.identifier,
            card_key: materialKey,
            card_state: 'resolved',
          });
          this.options.deliveryStateRepository?.upsert({
            transport: recipient.transport,
            conversation_id: recipient.conversation_id,
            root_issue_id: issue.issue_id,
            root_issue_identifier: issue.identifier,
            delivery_kind: 'governance_card',
            last_material_key: materialKey,
            last_notification_class: null,
            last_message_id: existing.message_id,
          });
          this.recordTransportEvent({
            recipient,
            issue,
            source: 'followup_card',
            action: 'edit',
            result: 'success',
            messageId: existing.message_id,
            materialKey,
          });
          return;
        }
        this.recordTransportEvent({
          recipient,
          issue,
          source: 'followup_card',
          action: 'edit',
          result: 'failed',
          messageId: existing.message_id,
          materialKey,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        const messageRef = await notifier.sendMessage(recipient, message);
        this.messageStates.upsert({
          transport: recipient.transport,
          conversation_id: recipient.conversation_id,
          issue_id: issue.issue_id,
          issue_identifier: issue.identifier,
          message_id: messageRef.provider_message_id,
          card_kind: 'governance_blocked',
          card_key: materialKey,
          card_state: 'resolved',
        });
        this.options.deliveryStateRepository?.upsert({
          transport: recipient.transport,
          conversation_id: recipient.conversation_id,
          root_issue_id: issue.issue_id,
          root_issue_identifier: issue.identifier,
          delivery_kind: 'governance_card',
          last_material_key: materialKey,
          last_notification_class: null,
          last_message_id: messageRef.provider_message_id,
        });
        this.recordTransportEvent({
          recipient,
          issue,
          source: 'followup_card',
          action: 'fallback',
          result: 'success',
          messageId: messageRef.provider_message_id,
          materialKey,
        });
      } finally {
        this.governanceCardsInFlight.delete(inFlightKey);
      }
    }));

    return resolvedAny;
  }

  private async send(recipients: BotRecipient[], message: BotTransportMessage): Promise<void> {
    await Promise.allSettled(
      recipients.map(async (recipient) => {
        const notifier = this.notifiers[recipient.transport];
        if (!notifier) {
          return;
        }
        await notifier.sendMessage(recipient, message);
      }),
    );
  }
}
