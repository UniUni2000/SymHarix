import { BotConversationPreferenceRepository, type BotFollowupMessageStateRepository } from '../database';
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
    architectural_target: issue.architectural_target ?? null,
    path_families: issue.path_families ?? [],
    boundary_edges: issue.boundary_edges ?? [],
    import_edges: issue.import_edges ?? [],
    fitness_signals: (issue.fitness_signals ?? []).map((signal) => signal.code),
    governance_root_issue_identifier: issue.governance_root_issue_identifier ?? issue.identifier,
    governance_thread_state: issue.governance_thread_state ?? null,
    governance_child_issues: (issue.governance_child_issues ?? []).map((child) => ({
      issue_id: child.issue_id,
      issue_identifier: child.issue_identifier,
      title: child.title,
      tracker_state: child.tracker_state,
      orchestrator_state: child.orchestrator_state,
      governance_decision: child.governance_decision,
      governance_summary: child.governance_summary,
      delivery_code: child.delivery_code ?? null,
      delivery_summary: child.delivery_summary ?? null,
    })),
    next_recommended_action: issue.next_recommended_action ?? null,
    delivery_state: issue.delivery_state ?? null,
    delivery_code: issue.delivery_code ?? null,
    delivery_summary: issue.delivery_summary ?? null,
    repo_harness_status: issue.repo_harness_status
      ? {
          status: issue.repo_harness_status.status,
          learning_confidence: issue.repo_harness_status.learning_confidence ?? null,
          learned_command_count: issue.repo_harness_status.learned_command_count ?? 0,
          learned_artifact_count: issue.repo_harness_status.learned_artifact_count ?? 0,
          learned_runtime_hint_count: issue.repo_harness_status.learned_runtime_hint_count ?? 0,
        }
      : null,
  };
}

function compareTimeline(left: RuntimeTimelineEvent, right: RuntimeTimelineEvent): number {
  return left.timestamp.localeCompare(right.timestamp);
}

function resolveFocusIssue(
  runtime: RuntimeControlPlane,
  overviewIssues: RuntimeIssueView[],
  openFollowupIssueId: string | null,
  text: string,
): RuntimeIssueView | null {
  const identifier = extractIssueIdentifier(text);
  if (identifier) {
    return runtime.getIssue(identifier);
  }

  if (openFollowupIssueId) {
    const openFollowupIssue = runtime.getIssue(openFollowupIssueId);
    if (openFollowupIssue) {
      return openFollowupIssue;
    }
  }

  const runningIssues = overviewIssues.filter((issue) => issue.actions.can_stop);
  if (runningIssues.length === 1) {
    return runningIssues[0] ?? null;
  }

  const activeIssues = overviewIssues.filter((issue) =>
    issue.actions.can_stop ||
    issue.actions.can_retry ||
    issue.actions.can_override_governance ||
    issue.actions.can_rewrite_governance ||
    issue.actions.can_split_governance,
  );
  if (activeIssues.length === 1) {
    return activeIssues[0] ?? null;
  }

  return null;
}

export class BotRuntimeContextService {
  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly preferences: BotConversationPreferenceRepository | null,
    private readonly projectResolver: TrackerProjectResolutionService | null,
    private readonly subscriptions: Pick<BotSubscriptionService, 'listByConversation'> | null,
    private readonly followupMessageStates: BotFollowupMessageStateRepository | null = null,
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
    const openGovernanceCards = this.followupMessageStates?.findOpenByConversation({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    }).filter((record) => record.card_kind === 'governance_blocked') ?? [];
    const focusIssue = resolveFocusIssue(
      this.runtime,
      overview.issues,
      openGovernanceCards.length === 1 ? openGovernanceCards[0]?.issue_id ?? null : null,
      text,
    );
    const historyView = focusIssue ? this.runtime.getHistoryView(focusIssue.issue_id, 3) : null;
    const recentTimeline = focusIssue
      ? this.runtime.getTimeline(focusIssue.issue_id, 6).slice().sort(compareTimeline)
      : [];

    const focusedIssueContext: BotFocusedIssueContext | null = focusIssue
      ? {
          issue: toIssueContextView(focusIssue),
          digest: historyView?.digest ?? null,
          governance: {
            status: focusIssue.governance_status ?? null,
            decision: focusIssue.governance_decision ?? null,
            summary: focusIssue.governance_summary ?? null,
            root_issue_identifier: focusIssue.governance_root_issue_identifier ?? focusIssue.identifier,
            thread_state: focusIssue.governance_thread_state ?? null,
            child_issues: (focusIssue.governance_child_issues ?? []).map((child) => ({
              issue_identifier: child.issue_identifier,
              title: child.title,
              tracker_state: child.tracker_state,
              governance_decision: child.governance_decision ?? null,
              governance_summary: child.governance_summary ?? null,
            })),
            next_recommended_action: focusIssue.next_recommended_action ?? null,
            suggestions: (focusIssue.active_governance_suggestions ?? []).map((suggestion) => ({
              id: suggestion.id,
              suggestion_type: suggestion.suggestion_type,
              status: suggestion.status,
              title: suggestion.title,
              summary: suggestion.summary,
              can_execute: Boolean(suggestion.can_execute),
              can_dismiss: Boolean(suggestion.can_dismiss),
            })),
          },
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
