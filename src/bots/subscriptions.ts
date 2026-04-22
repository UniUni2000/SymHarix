import type { RuntimeControlPlane, RuntimeIssueView, RuntimeStreamEvent, RuntimeTimelineEvent } from '../runtime/types';
import type { BotWatchSubscriptionRepository } from '../database';
import type {
  BotRecipient,
  BotTransport,
  BotTransportNotifier,
  BotWatchPreset,
  BotWatchSubscription,
} from './types';

function compact(value: string | null | undefined, maxLength = 120): string {
  if (!value) {
    return 'n/a';
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatIssueSummary(issue: RuntimeIssueView): string {
  const session = issue.session;
  const parts = [
    `${issue.identifier} · ${issue.title}`,
    `phase ${issue.phase}`,
    `tracker ${issue.tracker_state}`,
    `orchestrator ${issue.orchestrator_state || 'unknown'}`,
  ];

  if (session?.stage) {
    parts.push(`stage ${session.stage}`);
  }
  if (session) {
    parts.push(`turns ${session.turn_count}`);
    parts.push(`tokens ${session.tokens.total_tokens}`);
  }

  const details = [
    issue.workspace_path ? `workspace ${compact(issue.workspace_path, 90)}` : null,
    issue.branch_name ? `branch ${issue.branch_name}` : null,
  ].filter(Boolean);

  return [parts.join(' · '), details.join(' · ')].filter(Boolean).join('\n');
}

function formatTimelineSummary(event: RuntimeTimelineEvent): string {
  const detail =
    event.detail && typeof event.detail === 'object'
      ? (event.detail.summary ||
          event.detail.path ||
          event.detail.command_preview ||
          event.detail.url ||
          null)
      : null;

  return [
    `${event.issue_identifier || event.issue_id} · ${event.message}`,
    detail ? compact(String(detail), 110) : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function shouldNotifyTimeline(event: RuntimeTimelineEvent): boolean {
  return [
    'turn_started',
    'tool_completed',
    'tool_failed',
    'todo_updated',
    'rate_limit_retry',
    'turn_completed',
    'turn_failed',
    'turn_cancelled',
  ].includes(event.code);
}

function shouldNotifyTimelineForPreset(
  event: RuntimeTimelineEvent,
  preset: BotWatchPreset,
): boolean {
  if (!shouldNotifyTimeline(event)) {
    return false;
  }

  if (preset === 'failures') {
    return ['tool_failed', 'turn_failed', 'turn_cancelled', 'rate_limit_retry'].includes(event.code);
  }

  if (preset === 'status') {
    return ['turn_completed', 'turn_failed', 'turn_cancelled'].includes(event.code);
  }

  return true;
}

function shouldNotifyIssueForPreset(
  issue: RuntimeIssueView,
  preset: BotWatchPreset,
): boolean {
  if (preset !== 'failures') {
    return true;
  }

  return ['failed', 'needs_rework', 'retry_scheduled', 'cancelled'].includes(issue.orchestrator_state || '');
}

function subscriptionKey(subscription: Pick<BotWatchSubscription, 'transport' | 'conversation_id' | 'issue_id'>): string {
  return `${subscription.transport}:${subscription.conversation_id}:${subscription.issue_id}`;
}

export class BotSubscriptionService {
  private readonly subscriptions = new Map<string, BotWatchSubscription>();
  private readonly unsubscribeRuntime: () => void;
  private readonly notifiedEventIds = new Set<string>();

  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly notifiers: Partial<Record<BotTransport, BotTransportNotifier>>,
    private readonly repository: BotWatchSubscriptionRepository | null = null,
  ) {
    this.restorePersistedSubscriptions();
    this.unsubscribeRuntime = this.runtime.subscribe((event) => {
      void this.handleRuntimeEvent(event);
    });
  }

  dispose(): void {
    this.unsubscribeRuntime();
    this.subscriptions.clear();
    this.notifiedEventIds.clear();
  }

  canWatch(transport: BotTransport): boolean {
    return Boolean(this.notifiers[transport]);
  }

  listByConversation(params: {
    transport: BotTransport;
    conversation_id: string;
  }): BotWatchSubscription[] {
    return Array.from(this.subscriptions.values()).filter(
      (subscription) =>
        subscription.transport === params.transport &&
        subscription.conversation_id === params.conversation_id,
    );
  }

  watch(params: {
    recipient: BotRecipient;
    issue_id: string;
    issue_identifier?: string | null;
    user_id?: string | null;
    preset?: BotWatchPreset | null;
  }): { created: boolean; subscription: BotWatchSubscription } {
    const subscription: BotWatchSubscription = {
      transport: params.recipient.transport,
      conversation_id: params.recipient.conversation_id,
      issue_id: params.issue_id,
      issue_identifier: params.issue_identifier ?? null,
      user_id: params.user_id ?? null,
      preset: params.preset ?? 'default',
    };

    const key = subscriptionKey(subscription);
    const created = !this.subscriptions.has(key);
    this.subscriptions.set(key, subscription);
    this.repository?.upsert({
      transport: subscription.transport,
      conversation_id: subscription.conversation_id,
      issue_id: subscription.issue_id,
      issue_identifier: subscription.issue_identifier,
      user_id: subscription.user_id,
      preset: subscription.preset,
    });
    return { created, subscription };
  }

  unwatch(params: {
    transport: BotTransport;
    conversation_id: string;
    issue_id: string;
  }): boolean {
    const removed = this.subscriptions.delete(subscriptionKey(params));
    const deleted = this.repository?.delete(params) ?? false;
    return removed || deleted;
  }

  private restorePersistedSubscriptions(): void {
    if (!this.repository) {
      return;
    }

    for (const record of this.repository.findAll()) {
      const subscription: BotWatchSubscription = {
        transport: record.transport,
        conversation_id: record.conversation_id,
        issue_id: record.issue_id,
        issue_identifier: record.issue_identifier,
        user_id: record.user_id,
        preset: record.preset,
      };
      this.subscriptions.set(subscriptionKey(subscription), subscription);
    }
  }

  private async handleRuntimeEvent(event: RuntimeStreamEvent): Promise<void> {
    if (event.type === 'overview' || event.type === 'snapshot') {
      return;
    }

    if (event.type === 'issue') {
      const issue = event.data;
      const related = this.findSubscriptions(issue.issue_id);
      if (related.length === 0) {
        return;
      }

      await Promise.allSettled(
        related
          .filter((subscription) => shouldNotifyIssueForPreset(issue, subscription.preset))
          .map(async (subscription) => {
            const historyView = this.runtime.getHistoryView(issue.issue_id, 3);
            const content = historyView?.digest
              ? `${historyView.digest.headline}\n${historyView.digest.detail}${historyView.digest.history_blurb ? `\n${historyView.digest.history_blurb}` : ''}`
              : formatIssueSummary(issue);
            await this.sendToSubscription(subscription, `Symphony update\n${content}`);
          }),
      );
      return;
    }

    if (event.type === 'timeline') {
      const timeline = event.data;
      if (this.notifiedEventIds.has(timeline.id)) {
        return;
      }

      this.notifiedEventIds.add(timeline.id);
      if (this.notifiedEventIds.size > 2000) {
        const first = this.notifiedEventIds.values().next();
        if (!first.done) {
          this.notifiedEventIds.delete(first.value);
        }
      }

      const related = this.findSubscriptions(timeline.issue_id);
      if (related.length === 0) {
        return;
      }

      await Promise.allSettled(
        related
          .filter((subscription) => shouldNotifyTimelineForPreset(timeline, subscription.preset))
          .map((subscription) =>
            this.sendToSubscription(
              subscription,
              subscription.preset === 'verbose'
                ? `Symphony timeline\n${formatTimelineSummary(timeline)}`
                : `Symphony timeline\n${timeline.issue_identifier || timeline.issue_id} · ${timeline.message}`,
            ),
          ),
      );
    }
  }

  private findSubscriptions(issueId: string): BotWatchSubscription[] {
    return Array.from(this.subscriptions.values()).filter(
      (subscription) => subscription.issue_id === issueId,
    );
  }

  private async sendToSubscription(
    subscription: BotWatchSubscription,
    message: string,
  ): Promise<void> {
    const notifier = this.notifiers[subscription.transport];
    if (!notifier) {
      return;
    }

    await notifier.sendMessage(
      {
        transport: subscription.transport,
        conversation_id: subscription.conversation_id,
      },
      message,
    );
  }
}
