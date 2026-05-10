import type {
  BotConversationFocusRepository,
  BotConversationPreferenceRepository,
  SupervisorMemoryRepository,
  SupervisorSessionRepository,
} from '../database';
import type { BotCommandContext } from '../bots/types';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import type { TrackerProjectResolutionService } from '../tracker/projectResolution';
import type { ResolvedRepositoryRoute } from '../types';
import { DefaultRepoProfileService, type RepoProfileService } from './repoProfileService';
import type { SupervisorRepoUnderstandingService } from './repoUnderstanding';
import type { SupervisorRepoSourceResolver } from './repoSourceResolver';
import type { SupervisorRepoIntelligenceResolver } from './repoIntelligence';

export interface SupervisorContextBrokerOptions {
  runtime: RuntimeControlPlane;
  preferences?: BotConversationPreferenceRepository | null;
  conversationFocuses?: BotConversationFocusRepository | null;
  projectResolver?: TrackerProjectResolutionService | null;
  repoProfileService?: RepoProfileService;
  repoUnderstandingService?: SupervisorRepoUnderstandingService | null;
  repoSourceResolver?: SupervisorRepoSourceResolver | null;
  supervisorMemories?: SupervisorMemoryRepository | null;
  supervisorSessions?: SupervisorSessionRepository | null;
  repoIntelligenceResolver?: SupervisorRepoIntelligenceResolver | null;
}

export interface SupervisorContextRequest {
  context: BotCommandContext;
  text?: string;
}

export const SUPERVISOR_CONTEXT_SOURCES = [
  'runtime_overview',
  'recent_completed_issues',
  'issue',
  'issue_history',
  'issue_timeline',
  'conversation_state',
  'repo_route',
  'repo_source',
  'repo_profile',
  'repo_understanding',
  'supervisor_memory',
  'plan_session',
  'governance_signals',
  'repo_issue_recommendation',
] as const;

export const SUPERVISOR_CONTEXT_TOOL_NAMES = [
  'list_context_sources',
  'get_runtime_overview',
  'get_recent_completed_issues',
  'get_issue',
  'get_issue_history',
  'get_issue_timeline',
  'get_conversation_state',
  'get_repo_route',
  'prepare_repo_source',
  'get_repo_profile',
  'get_repo_understanding',
  'search_supervisor_memory',
  'get_plan_session',
  'get_governance_signals',
  'recommend_repo_issue',
] as const;

export type SupervisorContextToolName = typeof SUPERVISOR_CONTEXT_TOOL_NAMES[number];

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractIssueIdentifier(text: string | null | undefined): string | null {
  const match = text?.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function compact(value: string | null | undefined, maxLength = 220): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function latestMilestone(issue: RuntimeIssueView, predicate: (kind: string) => boolean) {
  return [...(issue.milestones ?? [])]
    .filter((milestone) => predicate(milestone.kind) && milestone.timestamp)
    .sort((left, right) => (right.timestamp ?? '').localeCompare(left.timestamp ?? ''))[0] ?? null;
}

function isCancelledIssue(issue: RuntimeIssueView): boolean {
  return /cancelled|canceled/i.test(issue.tracker_state ?? '') ||
    /cancelled|canceled/i.test(issue.orchestrator_state ?? '');
}

function isCompletedIssue(issue: RuntimeIssueView): boolean {
  if (isCancelledIssue(issue)) {
    return false;
  }
  return /done|completed|closed/i.test(issue.tracker_state ?? '') ||
    /completed/i.test(issue.orchestrator_state ?? '') ||
    issue.delivery_state === 'completed';
}

function completionEvidence(issue: RuntimeIssueView): {
  completed_at: string | null;
  completed_at_source: 'review_completed' | 'delivery_completed' | 'updated_at';
  evidence_rank: number;
} {
  const review = latestMilestone(issue, (kind) => kind === 'review_completed');
  if (review?.timestamp) {
    return {
      completed_at: review.timestamp,
      completed_at_source: 'review_completed',
      evidence_rank: 2,
    };
  }

  const delivery = latestMilestone(issue, (kind) => kind === 'completed' || kind === 'delivery_completed');
  if (delivery?.timestamp && (issue.active_pr_number || issue.github_issue_number)) {
    return {
      completed_at: delivery.timestamp,
      completed_at_source: 'delivery_completed',
      evidence_rank: 1,
    };
  }

  return {
    completed_at: issue.updated_at,
    completed_at_source: 'updated_at',
    evidence_rank: 0,
  };
}

export class SupervisorContextBroker {
  private readonly repoProfileService: RepoProfileService;

  constructor(private readonly options: SupervisorContextBrokerOptions) {
    this.repoProfileService = options.repoProfileService ?? new DefaultRepoProfileService();
  }

  listContextSources(): Array<{ name: typeof SUPERVISOR_CONTEXT_SOURCES[number]; description: string }> {
    return [
      { name: 'runtime_overview', description: 'Compact runtime counts, active issues, failed issues, and recent completed issues.' },
      { name: 'recent_completed_issues', description: 'Recently completed Done issues ranked by review/PR delivery evidence instead of overview list order.' },
      { name: 'issue', description: 'One issue projection including tracker, orchestrator, delivery, session, and governance state.' },
      { name: 'issue_history', description: 'Compact replay digest for one issue.' },
      { name: 'issue_timeline', description: 'Recent runtime timeline events for one issue.' },
      { name: 'conversation_state', description: 'Default project, focus issue, focus repo, active plan, and latest supervisor conversation state.' },
      { name: 'repo_route', description: 'Configured project-to-repository route.' },
      { name: 'repo_source', description: 'Prepared read-only source cache status and commit.' },
      { name: 'repo_profile', description: 'Fast shallow repository profile from README, manifests, and top-level paths.' },
      { name: 'repo_understanding', description: 'Cached Claude Code repository understanding by commit.' },
      { name: 'supervisor_memory', description: 'Relevant prior execution failures, patterns, and repo-specific lessons.' },
      { name: 'plan_session', description: 'Active supervisor Plan Card and materialization state for this Telegram conversation.' },
      { name: 'governance_signals', description: 'Harness, constitution, decision memory, conflict memory, and debt signals.' },
      { name: 'repo_issue_recommendation', description: 'One evidence-backed next issue recommendation.' },
    ];
  }

  async resolveWorkspace(request: SupervisorContextRequest): Promise<{
    repoRef: string | null;
    localPath: string | null;
  }> {
    const repo = await this.resolveRepoAccess(request);
    return {
      repoRef: repo.repoRef,
      localPath: repo.localPath,
    };
  }

  async callTool(
    name: SupervisorContextToolName,
    args: Record<string, unknown>,
    request: SupervisorContextRequest,
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case 'list_context_sources':
        return { sources: this.listContextSources() };
      case 'get_runtime_overview':
        return { overview: this.getCompactRuntimeOverview() };
      case 'get_recent_completed_issues':
        return this.getRecentCompletedIssues(this.limit(args, 8));
      case 'get_issue': {
        const issue = this.resolveIssueFromArgs(args, request);
        return issue ? { issue } : { error: 'issue_not_found' };
      }
      case 'get_issue_history': {
        const issue = this.resolveIssueFromArgs(args, request);
        const history = issue ? this.options.runtime.getHistoryView(issue.issue_id, this.limit(args, 20)) : null;
        return history ? { history } : { error: 'issue_history_not_found' };
      }
      case 'get_issue_timeline': {
        const issue = this.resolveIssueFromArgs(args, request);
        const timeline = issue ? this.options.runtime.getTimeline(issue.issue_id, this.limit(args, 20)) : null;
        return timeline ? { timeline } : { error: 'issue_timeline_not_found' };
      }
      case 'get_conversation_state':
        return { conversation: this.getConversationState(request) };
      case 'get_repo_route':
        return { route: this.resolveRoute(request) };
      case 'prepare_repo_source': {
        const route = this.resolveRoute(request);
        const source = route && this.options.repoSourceResolver
          ? await this.options.repoSourceResolver.resolve(route)
          : null;
        return { source };
      }
      case 'get_repo_profile': {
        const repo = await this.resolveRepoAccess(request);
        const profile = repo.repoRef
          ? await this.repoProfileService.resolve({ repoRef: repo.repoRef, localPath: repo.localPath })
          : null;
        return { profile };
      }
      case 'get_repo_understanding': {
        const repo = await this.resolveRepoAccess(request);
        const understanding = repo.repoRef && this.options.repoUnderstandingService
          ? await this.options.repoUnderstandingService.understand({
              repoRef: repo.repoRef,
              localPath: repo.localPath,
              forceRefresh: args.force_refresh === true,
              cacheOnly: args.force_refresh !== true,
            }).catch(() => null)
          : null;
        return { understanding };
      }
      case 'search_supervisor_memory': {
        const route = this.resolveRoute(request);
        const repoRef = route?.github_repo_full ?? this.resolveFocusedIssue(request)?.github_repo ?? null;
        const query = nonBlank(args.query) ?? request.text ?? '';
        const memories = repoRef && this.options.supervisorMemories
          ? this.options.supervisorMemories.searchRelevant({ repo_ref: repoRef, query, limit: this.limit(args, 8) })
          : [];
        return { memories };
      }
      case 'get_plan_session':
        return {
          session: this.options.supervisorSessions?.findActiveByConversation({
            transport: request.context.transport,
            conversation_id: request.context.recipient.conversation_id,
          }) ?? null,
        };
      case 'get_governance_signals': {
        const route = this.resolveRoute(request);
        const projectSlug = route?.project_slug ?? this.defaultProjectSlug(request);
        const signals = projectSlug && this.options.repoIntelligenceResolver
          ? await this.options.repoIntelligenceResolver.resolve({ projectSlug, route }).catch(() => null)
          : null;
        return { signals };
      }
      case 'recommend_repo_issue':
        return { recommendation: await this.recommendRepoIssue(request) };
    }
  }

  private async recommendRepoIssue(request: SupervisorContextRequest): Promise<Record<string, unknown>> {
    const route = this.resolveRoute(request);
    const repoRef = route?.github_repo_full ?? this.resolveFocusedIssue(request)?.github_repo ?? null;
    const [profileResult, understandingResult, memoryResult, governanceResult] = await Promise.all([
      this.callTool('get_repo_profile', {}, request),
      this.callTool('get_repo_understanding', {}, request),
      this.callTool('search_supervisor_memory', { query: request.text ?? '', limit: 4 }, request),
      this.callTool('get_governance_signals', {}, request),
    ]);
    const overview = this.options.runtime.getOverview();
    const active = overview.issues.filter((issue) => issue.actions.can_stop || issue.orchestrator_state === 'dev_running');
    const understanding = understandingResult.understanding as { understanding?: { risks?: string[]; artifact_opportunities?: string[] } } | null;
    const firstRisk = understanding?.understanding?.risks?.[0] ?? null;
    const firstOpportunity = understanding?.understanding?.artifact_opportunities?.[0] ?? null;
    const title = firstRisk
      ? `Reduce repo risk: ${compact(firstRisk, 80)}`
      : firstOpportunity
        ? `Turn repo opportunity into a tracked issue: ${compact(firstOpportunity, 72)}`
        : 'Add a repo readiness issue backed by current supervisor context';
    return {
      repo_ref: repoRef,
      title,
      summary: active.length > 0
        ? `There are ${active.length} active runtime issue(s); avoid starting broad work until this recommendation is scoped.`
        : 'No active runtime issue is blocking a focused repo-improvement recommendation.',
      rationale: 'Built from runtime overview, repo profile, cached repo understanding, supervisor memory, and governance signals.',
      evidence: {
        runtime_issue_count: overview.counts.total,
        active_issue_count: active.length,
        repo_profile_available: Boolean(profileResult.profile),
        repo_understanding_available: Boolean(understandingResult.understanding),
        memory_count: Array.isArray(memoryResult.memories) ? memoryResult.memories.length : 0,
        governance_available: Boolean(governanceResult.signals),
      },
      next_step: 'Ask for approval before creating or executing this issue.',
    };
  }

  private getCompactRuntimeOverview(): Record<string, unknown> {
    const overview = this.options.runtime.getOverview();
    const activeIssues = overview.issues
      .filter((issue) => issue.actions.can_stop || issue.actions.can_retry || issue.session)
      .slice(0, 8)
      .map((issue) => this.toIssueSummary(issue));
    const failedIssues = overview.issues
      .filter((issue) => /failed|blocked/i.test(issue.orchestrator_state ?? '') || issue.delivery_state === 'delivery_failed')
      .slice(0, 8)
      .map((issue) => this.toIssueSummary(issue));
    const recentCompleted = this.getRecentCompletedIssueSummaries(5);
    return {
      generated_at: overview.generated_at,
      counts: overview.counts,
      active_issues: activeIssues,
      failed_issues: failedIssues,
      recent_completed_issues: recentCompleted,
      notes: [
        'This overview is compact by design; use get_issue for full issue details.',
        'For "recently completed" questions, trust recent_completed_issues or call get_recent_completed_issues; raw updated_at can be changed by sync/repair jobs.',
      ],
    };
  }

  private getRecentCompletedIssues(limit: number): Record<string, unknown> {
    return {
      issues: this.getRecentCompletedIssueSummaries(limit),
      ranking: 'Done/non-cancelled issues ranked by review_completed evidence first, then PR delivery evidence, then updated_at fallback.',
      warning: 'Do not infer "recently completed" from the first item in runtime overview; bulk sync can refresh old issue updated_at values.',
    };
  }

  private getRecentCompletedIssueSummaries(limit: number): Array<Record<string, unknown>> {
    return this.options.runtime.getOverview().issues
      .filter(isCompletedIssue)
      .map((issue) => {
        const evidence = completionEvidence(issue);
        return {
          ...this.toIssueSummary(issue),
          completed_at: evidence.completed_at,
          completed_at_source: evidence.completed_at_source,
          evidence_rank: evidence.evidence_rank,
          review_summary: compact(latestMilestone(issue, (kind) => kind === 'review_completed')?.summary, 180),
          delivery_summary: compact(issue.delivery_summary, 180),
          evidence: [
            issue.tracker_state ? `tracker=${issue.tracker_state}` : null,
            issue.orchestrator_state ? `orchestrator=${issue.orchestrator_state}` : null,
            issue.delivery_state ? `delivery=${issue.delivery_state}` : null,
            issue.active_pr_number ? `pr=#${issue.active_pr_number}` : null,
            evidence.completed_at ? `${evidence.completed_at_source}=${evidence.completed_at}` : null,
          ].filter(Boolean),
        };
      })
      .sort((left, right) => {
        const leftRank = typeof left.evidence_rank === 'number' ? left.evidence_rank : 0;
        const rightRank = typeof right.evidence_rank === 'number' ? right.evidence_rank : 0;
        if (leftRank !== rightRank) {
          return rightRank - leftRank;
        }
        return String(right.completed_at ?? '').localeCompare(String(left.completed_at ?? ''));
      })
      .slice(0, limit);
  }

  private toIssueSummary(issue: RuntimeIssueView): Record<string, unknown> {
    return {
      issue_id: issue.issue_id,
      identifier: issue.identifier,
      title: issue.title,
      tracker_state: issue.tracker_state,
      orchestrator_state: issue.orchestrator_state,
      delivery_state: issue.delivery_state ?? null,
      github_repo: issue.github_repo,
      github_issue_number: issue.github_issue_number,
      active_pr_number: issue.active_pr_number,
      updated_at: issue.updated_at,
      can_stop: issue.actions.can_stop,
      can_retry: issue.actions.can_retry,
    };
  }

  private limit(args: Record<string, unknown>, fallback: number): number {
    return typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(100, Math.trunc(args.limit)))
      : fallback;
  }

  private resolveIssueFromArgs(args: Record<string, unknown>, request: SupervisorContextRequest): RuntimeIssueView | null {
    const issueId = nonBlank(args.issue_id) ?? extractIssueIdentifier(request.text) ?? this.resolveFocusedIssue(request)?.identifier ?? null;
    if (!issueId) {
      return null;
    }
    return this.options.runtime.getIssue(issueId);
  }

  private getConversationState(request: SupervisorContextRequest): Record<string, unknown> {
    const focus = this.options.conversationFocuses?.findByConversation({
      transport: request.context.transport,
      conversation_id: request.context.recipient.conversation_id,
    }) ?? null;
    const session = this.options.supervisorSessions?.findActiveByConversation({
      transport: request.context.transport,
      conversation_id: request.context.recipient.conversation_id,
    }) ?? null;
    return {
      default_project_slug: this.defaultProjectSlug(request),
      focus,
      active_plan_session: session,
      available_projects: this.options.projectResolver?.listConfiguredRoutes().map((route) => ({
        project_slug: route.project_slug,
        github_repo_full: route.github_repo_full,
        local_path: route.local_path,
      })) ?? [],
    };
  }

  private resolveFocusedIssue(request: SupervisorContextRequest): RuntimeIssueView | null {
    const explicit = extractIssueIdentifier(request.text);
    if (explicit) {
      return this.options.runtime.getIssue(explicit);
    }
    const focus = this.options.conversationFocuses?.findByConversation({
      transport: request.context.transport,
      conversation_id: request.context.recipient.conversation_id,
    }) ?? null;
    const focusId = focus?.issue_id ?? focus?.issue_identifier ?? null;
    if (focusId) {
      const issue = this.options.runtime.getIssue(focusId);
      if (issue) {
        return issue;
      }
    }
    const visible = this.options.runtime.getOverview().issues.filter((issue) => issue.actions.can_stop || issue.actions.can_retry);
    return visible.length === 1 ? visible[0] ?? null : null;
  }

  private resolveRoute(request: SupervisorContextRequest) {
    const routes = this.options.projectResolver?.listConfiguredRoutes() ?? [];
    const defaultProject = this.defaultProjectSlug(request);
    const issue = this.resolveFocusedIssue(request);
    return (
      (issue?.github_repo ? routes.find((route) => route.github_repo_full === issue.github_repo) ?? null : null)
      || (defaultProject ? routes.find((route) => route.project_slug === defaultProject) ?? null : null)
      || (routes.length === 1 ? routes[0] ?? null : null)
    );
  }

  private defaultProjectSlug(request: SupervisorContextRequest): string | null {
    return this.options.preferences?.findByConversation({
      transport: request.context.transport,
      conversation_id: request.context.recipient.conversation_id,
    })?.default_project_slug ?? null;
  }

  private async resolveRepoAccess(request: SupervisorContextRequest): Promise<{
    route: ResolvedRepositoryRoute | null;
    repoRef: string | null;
    localPath: string | null;
  }> {
    const route = this.resolveRoute(request);
    const repoRef = route?.github_repo_full ?? this.resolveFocusedIssue(request)?.github_repo ?? null;
    return {
      route,
      repoRef,
      localPath: await this.resolvePreparedLocalPath(route),
    };
  }

  private async resolvePreparedLocalPath(route: ResolvedRepositoryRoute | null): Promise<string | null> {
    if (!route) {
      return null;
    }
    if (route.local_path) {
      return route.local_path;
    }
    if (!this.options.repoSourceResolver) {
      return null;
    }
    const source = await this.options.repoSourceResolver.resolve(route).catch(() => null);
    if (!source || source.status === 'failed') {
      return null;
    }
    return source.analysis_path ?? source.source_path ?? null;
  }
}
