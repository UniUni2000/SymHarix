import { BotConversationPreferenceRepository } from '../database';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeTimelineEvent } from '../runtime/types';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import type {
  BotAssistantDiagnostics,
  BotCommandContext,
  BotFocusedIssueContext,
  BotIssueContextView,
  BotRuntimeCopilotContext,
} from './types';
import type { BotSubscriptionService } from './subscriptions';

function extractIssueIdentifier(text: string): string | null {
  const match = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/i);
  return match ? match[0].toUpperCase() : null;
}

function toIssueContextView(issue: RuntimeIssueView): BotIssueContextView {
  return {
    issue_id: issue.issue_id,
    identifier: issue.identifier,
    title: issue.title,
    phase: issue.phase,
    tracker_state: issue.tracker_state,
    orchestrator_state: issue.orchestrator_state,
    github_repo: issue.github_repo,
    branch_name: issue.branch_name,
    active_pr_number: issue.active_pr_number,
    session_stage: issue.session?.stage ?? null,
    session_message: issue.session?.last_message ?? null,
  };
}

function compareTimeline(left: RuntimeTimelineEvent, right: RuntimeTimelineEvent): number {
  return left.timestamp.localeCompare(right.timestamp);
}

function resolveFocusIssue(
  runtime: RuntimeControlPlane,
  overviewIssues: RuntimeIssueView[],
  text: string,
): RuntimeIssueView | null {
  const identifier = extractIssueIdentifier(text);
  if (identifier) {
    return runtime.getIssue(identifier);
  }

  const runningIssues = overviewIssues.filter((issue) => issue.actions.can_stop);
  if (runningIssues.length === 1) {
    return runningIssues[0] ?? null;
  }

  return null;
}

export class BotRuntimeContextService {
  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly preferences: BotConversationPreferenceRepository | null,
    private readonly projectResolver: TrackerProjectResolutionService | null,
    private readonly subscriptions: Pick<BotSubscriptionService, 'listByConversation'> | null,
  ) {}

  buildContext(
    context: BotCommandContext,
    text: string,
    assistant: BotAssistantDiagnostics,
  ): BotRuntimeCopilotContext {
    const overview = this.runtime.getOverview();
    const availableProjects = this.projectResolver?.listConfiguredRoutes().map((route) => ({
      project_slug: route.project_slug,
      github_repo_full: route.github_repo_full,
    })) ?? [];
    const defaultProjectSlug = this.preferences?.findByConversation({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    })?.default_project_slug ?? null;
    const activeIssues = overview.issues
      .filter((issue) => issue.actions.can_stop || issue.actions.can_retry)
      .slice(0, 8)
      .map(toIssueContextView);
    const focusIssue = resolveFocusIssue(this.runtime, overview.issues, text);
    const historyView = focusIssue ? this.runtime.getHistoryView(focusIssue.issue_id, 3) : null;
    const recentTimeline = focusIssue
      ? this.runtime.getTimeline(focusIssue.issue_id, 6).slice().sort(compareTimeline)
      : [];

    const focusedIssueContext: BotFocusedIssueContext | null = focusIssue
      ? {
          issue: toIssueContextView(focusIssue),
          digest: historyView?.digest ?? null,
          recent_timeline: recentTimeline.map((event) => ({
            timestamp: event.timestamp,
            message: event.message,
            code: event.code,
            tool_name: event.tool_name,
            level: event.level,
            category: event.category,
          })),
        }
      : null;

    return {
      default_project_slug: defaultProjectSlug,
      available_projects: availableProjects,
      watch_subscriptions: this.subscriptions?.listByConversation({
        transport: context.transport,
        conversation_id: context.recipient.conversation_id,
      }).map((subscription) => ({
        issue_id: subscription.issue_id,
        issue_identifier: subscription.issue_identifier,
        preset: subscription.preset,
      })) ?? [],
      overview: {
        running: overview.counts.running,
        retrying: overview.counts.retrying,
        total: overview.counts.total,
        active_issues: activeIssues,
      },
      focus_issue: focusedIssueContext,
      assistant,
    };
  }
}
