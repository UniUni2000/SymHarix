import { execFileSync } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import {
  AgentRunRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  ShadowHarnessRepository,
  SupervisorJobRepository,
  SupervisorSessionRepository,
  SyncEventRepository,
  WorkItemRepository,
} from '../database';
import type { SupervisorSessionRecord, WorkItem } from '../database/types';
import type { OrchestratorStateSnapshot } from '../orchestrator';
import { describeSupervisorThread } from '../supervisor/threadSummary';
import { localizeKnownRuntimeText } from '../i18n/locale';
import type { AgentEvent, AgentTimelinePayload, Issue } from '../types';
import type {
  CreateIssueRequest,
  CreateIssueResult,
  CloseIssueRequest,
  RuntimeActionResult,
  RuntimeAgentProgressItem,
  RuntimeComplexityLevel,
  RuntimeControlPlane,
  RuntimeDeliveryState,
  RuntimeFileActivity,
  RuntimeGovernanceChildIssueView,
  RuntimeHistoryEntry,
  RuntimeHistoryFileDiff,
  RuntimeIssueDigest,
  RuntimeIssueHistoryView,
  RuntimeIssueView,
  RuntimeMilestoneView,
  RuntimeOverview,
  RuntimeRoundView,
  RuntimeSessionView,
  RuntimeStreamEvent,
  RuntimeStreamEventType,
  RuntimeTimelineEvent,
  RuntimeToolActivity,
} from './types';

interface RuntimeHubController {
  getStateSnapshot(): OrchestratorStateSnapshot;
  createIssue(input: CreateIssueRequest): Promise<CreateIssueResult>;
  stopIssue(issueId: string): Promise<RuntimeActionResult>;
  retryIssue(issueId: string): Promise<RuntimeActionResult>;
  closeIssue(issueId: string, request?: CloseIssueRequest): Promise<RuntimeActionResult>;
  overrideGovernance(issueId: string): Promise<RuntimeActionResult>;
  rewriteGovernance(issueId: string): Promise<RuntimeActionResult>;
  splitGovernance(issueId: string): Promise<RuntimeActionResult>;
  executeGovernanceSuggestion?(issueId: string, suggestionId: string): Promise<RuntimeActionResult>;
  dismissGovernanceSuggestion?(issueId: string, suggestionId: string): Promise<RuntimeActionResult>;
  on(event: string, listener: (...args: any[]) => void): this;
  off?(event: string, listener: (...args: any[]) => void): this;
}

interface RuntimeHubOptions {
  timelineHistoryLimit?: number;
}

function isTimelinePayload(payload: AgentEvent['payload']): payload is AgentTimelinePayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as AgentTimelinePayload;
  return (
    typeof candidate.level === 'string' &&
    typeof candidate.category === 'string' &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string'
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function derivePhase(state: string): 'DEV' | 'REVIEW' {
  return state.toLowerCase() === 'in review' ? 'REVIEW' : 'DEV';
}

function mapToolStatus(code: string): 'started' | 'completed' | 'failed' {
  if (code === 'tool_completed') {
    return 'completed';
  }
  if (code === 'tool_failed') {
    return 'failed';
  }
  return 'started';
}

function inferFileOperation(toolName: string | null): 'read' | 'write' | 'edit' | 'other' {
  switch ((toolName || '').toLowerCase()) {
    case 'read':
      return 'read';
    case 'write':
      return 'write';
    case 'edit':
      return 'edit';
    default:
      return 'other';
  }
}

function normalizeSummary(value: string | null | undefined, fallback: string, maxLength = 180): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim() || fallback;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function compareDatesAscending(left: Date, right: Date): number {
  return left.getTime() - right.getTime();
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch {
    return null;
  }
}

function resolveHistoryDiffBaseRef(repoPath: string): string | null {
  const originHead = runGit(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const candidates = [
    originHead,
    'origin/main',
    'origin/master',
    'main',
    'master',
    'develop',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const candidate of candidates) {
    if (runGit(repoPath, ['rev-parse', '--verify', candidate])) {
      return candidate;
    }
  }

  return null;
}

function parseNumstatValue(value: string): number | null {
  if (value === '-' || value === '') {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumstatLine(line: string): { path: string; additions: number | null; deletions: number | null } | null {
  const parts = String(line || '').split('\t');
  if (parts.length < 3) {
    return null;
  }

  const path = parts.slice(2).join('\t').trim();
  if (!path) {
    return null;
  }

  return {
    path,
    additions: parseNumstatValue(parts[0] || ''),
    deletions: parseNumstatValue(parts[1] || ''),
  };
}

export class RuntimeHub implements RuntimeControlPlane {
  private readonly workItemRepository: WorkItemRepository;
  private readonly agentRunRepository: AgentRunRepository;
  private readonly governanceAssessmentRepository: GovernanceAssessmentRepository;
  private readonly reviewEventRepository: ReviewEventRepository;
  private readonly syncEventRepository: SyncEventRepository;
  private readonly governanceSuggestionRepository: GovernanceSuggestionRepository;
  private readonly shadowHarnessRepository: ShadowHarnessRepository;
  private readonly supervisorSessionRepository: SupervisorSessionRepository;
  private readonly supervisorJobRepository: SupervisorJobRepository;
  private readonly timelineHistoryLimit: number;
  private readonly issueCacheById = new Map<string, Issue>();
  private readonly timelineByIssueId = new Map<string, RuntimeTimelineEvent[]>();
  private readonly subscribers = new Map<number, (event: RuntimeStreamEvent) => void>();
  private readonly listeners: Array<{ event: string; listener: (...args: any[]) => void }> = [];
  private nextSubscriberId = 1;
  private controller: RuntimeHubController;

  constructor(
    db: Database,
    controller: RuntimeHubController,
    options: RuntimeHubOptions = {},
  ) {
    this.workItemRepository = new WorkItemRepository(db);
    this.agentRunRepository = new AgentRunRepository(db);
    this.governanceAssessmentRepository = new GovernanceAssessmentRepository(db);
    this.reviewEventRepository = new ReviewEventRepository(db);
    this.syncEventRepository = new SyncEventRepository(db);
    this.governanceSuggestionRepository = new GovernanceSuggestionRepository(db);
    this.shadowHarnessRepository = new ShadowHarnessRepository(db);
    this.supervisorSessionRepository = new SupervisorSessionRepository(db);
    this.supervisorJobRepository = new SupervisorJobRepository(db);
    this.timelineHistoryLimit = Math.max(10, options.timelineHistoryLimit ?? 200);
    this.controller = controller;
    this.bindControllerListeners();
  }

  dispose(): void {
    this.unbindControllerListeners();
    this.subscribers.clear();
  }

  setController(controller: RuntimeHubController): void {
    if (controller === this.controller) {
      return;
    }

    this.unbindControllerListeners();
    this.controller = controller;
    this.bindControllerListeners();
    this.publishOverview();
  }

  getOverview(): RuntimeOverview {
    const snapshot = this.controller.getStateSnapshot();
    const workItems = this.workItemRepository.findAll();
    const issues = workItems
      .map((workItem) => this.buildIssueView(workItem, snapshot))
      .concat(
        [...this.issueCacheById.values()]
          .filter((issue) => !workItems.some((workItem) => workItem.linear_issue_id === issue.id))
          .map((issue) => this.buildIssueViewFromIssue(issue, snapshot)),
      )
      .sort((left, right) => this.compareIssueViews(left, right));

    return {
      generated_at: new Date().toISOString(),
      counts: {
        running: snapshot.counts.running,
        retrying: snapshot.counts.retrying,
        total: issues.length,
      },
      issues,
    };
  }

  getIssue(id: string): RuntimeIssueView | null {
    const workItem = this.resolveWorkItem(id);
    if (workItem) {
      return this.buildIssueView(workItem, this.controller.getStateSnapshot());
    }

    const cachedIssue = this.resolveCachedIssue(id);
    if (!cachedIssue) {
      return null;
    }

    return this.buildIssueViewFromIssue(cachedIssue, this.controller.getStateSnapshot());
  }

  getTimeline(id: string, limit = 100): RuntimeTimelineEvent[] {
    const workItem = this.resolveWorkItem(id);
    const cachedIssue = this.resolveCachedIssue(id);
    const issueId = workItem?.linear_issue_id ?? cachedIssue?.id ?? id;
    const events = this.timelineByIssueId.get(issueId) ?? [];
    const bounded = Math.max(1, limit);
    return events.slice(-bounded);
  }

  getHistoryView(id: string, limit = 20): RuntimeIssueHistoryView | null {
    const workItem = this.resolveWorkItem(id);
    if (!workItem) {
      return null;
    }

    const issueView = this.buildIssueView(workItem, this.controller.getStateSnapshot());
    const entries = this.buildHistoryEntries(workItem, limit);

    return {
      issue_id: issueView.issue_id,
      issue_identifier: issueView.identifier,
      digest: this.buildIssueDigest(issueView, entries),
      entries,
      file_diffs: this.buildWorkspaceFileDiffs(workItem),
    };
  }

  async createIssue(input: CreateIssueRequest): Promise<CreateIssueResult> {
    const result = await this.controller.createIssue(input);
    const issue = result.issue_id ? this.getIssue(result.issue_id) : null;
    this.publishOverview();
    if (result.issue_id) {
      this.publishIssue(result.issue_id);
    }

    return {
      ...result,
      issue,
    };
  }

  async stopIssue(id: string): Promise<RuntimeActionResult> {
    const workItem = this.resolveWorkItem(id);
    const issueId = workItem?.linear_issue_id ?? id;
    const result = await this.controller.stopIssue(issueId);
    this.publishOverview();
    if (result.issue_id) {
      this.publishIssue(result.issue_id);
    }
    return result;
  }

  async retryIssue(id: string): Promise<RuntimeActionResult> {
    const workItem = this.resolveWorkItem(id);
    const issueId = workItem?.linear_issue_id ?? id;
    const result = await this.controller.retryIssue(issueId);
    this.publishOverview();
    if (result.issue_id) {
      this.publishIssue(result.issue_id);
    }
    return result;
  }

  async closeIssue(id: string, request: CloseIssueRequest = {}): Promise<RuntimeActionResult> {
    const workItem = this.resolveWorkItem(id);
    const issueId = workItem?.linear_issue_id ?? id;
    const successorWorkItem = request.successor_issue_id
      ? this.resolveWorkItem(request.successor_issue_id)
      : null;
    const result = await this.controller.closeIssue(issueId, {
      ...request,
      successor_issue_id: successorWorkItem?.linear_issue_id ?? request.successor_issue_id ?? null,
    });
    this.publishOverview();
    if (result.issue_id) {
      this.publishIssue(result.issue_id);
    }
    if (successorWorkItem?.linear_issue_id) {
      this.publishIssue(successorWorkItem.linear_issue_id);
    }
    return result;
  }

  async overrideGovernance(id: string): Promise<RuntimeActionResult> {
    const workItem = this.resolveWorkItem(id);
    const issueId = workItem?.linear_issue_id ?? id;
    const result = await this.controller.overrideGovernance(issueId);
    this.publishOverview();
    if (result.issue_id) {
      this.publishIssue(result.issue_id);
    }
    return result;
  }

  async rewriteGovernance(id: string): Promise<RuntimeActionResult> {
    const workItem = this.resolveWorkItem(id);
    const issueId = workItem?.linear_issue_id ?? id;
    const result = await this.controller.rewriteGovernance(issueId);
    this.publishOverview();
    if (result.issue_id) {
      this.publishIssue(result.issue_id);
    }
    return result;
  }

  async splitGovernance(id: string): Promise<RuntimeActionResult> {
    const workItem = this.resolveWorkItem(id);
    const issueId = workItem?.linear_issue_id ?? id;
    const result = await this.controller.splitGovernance(issueId);
    this.publishOverview();
    if (result.issue_id) {
      this.publishIssue(result.issue_id);
    }
    return result;
  }

  async executeGovernanceSuggestion(id: string, suggestionId: string): Promise<RuntimeActionResult> {
    const workItem = this.resolveWorkItem(id);
    const issueId = workItem?.linear_issue_id ?? id;
    const result = await this.controller.executeGovernanceSuggestion?.(issueId, suggestionId) ?? {
      accepted: false,
      status: 'rejected',
      message: 'Governance suggestion execution is not available',
      issue_id: issueId,
      issue_identifier: workItem?.linear_identifier ?? null,
    };
    this.publishOverview();
    if (result.issue_id) {
      this.publishIssue(result.issue_id);
    }
    return result;
  }

  async dismissGovernanceSuggestion(id: string, suggestionId: string): Promise<RuntimeActionResult> {
    const workItem = this.resolveWorkItem(id);
    const issueId = workItem?.linear_issue_id ?? id;
    const result = await this.controller.dismissGovernanceSuggestion?.(issueId, suggestionId) ?? {
      accepted: false,
      status: 'rejected',
      message: 'Governance suggestion dismissal is not available',
      issue_id: issueId,
      issue_identifier: workItem?.linear_identifier ?? null,
    };
    this.publishOverview();
    if (result.issue_id) {
      this.publishIssue(result.issue_id);
    }
    return result;
  }

  subscribe(listener: (event: RuntimeStreamEvent) => void): () => void {
    const subscriberId = this.subscribeInternal(listener);
    return () => {
      this.subscribers.delete(subscriberId);
    };
  }

  createStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let subscriberId: number | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const encode = (event: RuntimeStreamEventType, data: unknown): Uint8Array => {
      return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriberId = this.subscribeInternal((event) => {
          controller.enqueue(encode(event.type, event.data));
        });

        controller.enqueue(encode('snapshot', this.getOverview()));
        heartbeat = setInterval(() => {
          controller.enqueue(encode('overview', this.getOverview()));
        }, 15000);
      },
      cancel: () => {
        if (subscriberId !== null) {
          this.subscribers.delete(subscriberId);
        }
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      },
    });
  }

  private bind(event: string, listener: (...args: any[]) => void): void {
    this.controller.on(event, listener);
    this.listeners.push({ event, listener });
  }

  private bindControllerListeners(): void {
    this.bind('state:changed', () => {
      this.publishOverview();
    });
    this.bind('issue:dispatched', (issue: Issue) => {
      this.issueCacheById.set(issue.id, issue);
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('issue:completed', (issue: Issue) => {
      this.issueCacheById.set(issue.id, issue);
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('issue:failed', (issue: Issue) => {
      this.issueCacheById.set(issue.id, issue);
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('issue:retrying', (issue: Issue) => {
      this.issueCacheById.set(issue.id, issue);
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('issue:reconciled', (issue: Issue) => {
      this.issueCacheById.set(issue.id, issue);
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('session:event', (issueId: string, event: AgentEvent) => {
      this.handleSessionEvent(issueId, event);
    });
  }

  private unbindControllerListeners(): void {
    for (const { event, listener } of this.listeners) {
      this.controller.off?.(event, listener);
    }
    this.listeners.length = 0;
  }

  private subscribeInternal(listener: (event: RuntimeStreamEvent) => void): number {
    const id = this.nextSubscriberId++;
    this.subscribers.set(id, listener);
    return id;
  }

  private publish(event: RuntimeStreamEvent): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber(event);
    }
  }

  private publishOverview(): void {
    this.publish({
      type: 'overview',
      data: this.getOverview(),
    });
  }

  private publishIssue(issueId: string): void {
    const issue = this.getIssue(issueId);
    if (!issue) {
      return;
    }

    this.publish({
      type: 'issue',
      data: issue,
    });
  }

  private handleSessionEvent(issueId: string, event: AgentEvent): void {
    if (event.event === 'timeline' && isTimelinePayload(event.payload)) {
      const runtimeEvent = this.buildTimelineEvent(issueId, event.timestamp, event.payload);
      const bucket = this.timelineByIssueId.get(issueId) ?? [];
      bucket.push(runtimeEvent);
      if (bucket.length > this.timelineHistoryLimit) {
        bucket.splice(0, bucket.length - this.timelineHistoryLimit);
      }
      this.timelineByIssueId.set(issueId, bucket);

      this.publish({
        type: 'timeline',
        data: runtimeEvent,
      });
    }

    this.publishIssue(issueId);
    this.publishOverview();
  }

  private buildTimelineEvent(
    issueId: string,
    timestamp: Date,
    payload: AgentTimelinePayload,
  ): RuntimeTimelineEvent {
    const workItem = this.workItemRepository.findByLinearIssueId(issueId);
    return {
      id: `${issueId}:${timestamp.toISOString()}:${payload.code}:${payload.tool_name || 'none'}`,
      issue_id: issueId,
      issue_identifier: workItem?.linear_identifier ?? null,
      timestamp: timestamp.toISOString(),
      level: payload.level,
      category: payload.category,
      code: payload.code,
      message: payload.message,
      turn: payload.turn,
      tool_name: payload.tool_name,
      detail: payload.detail,
    };
  }

  private resolveWorkItem(id: string): WorkItem | null {
    const target = id.trim();
    if (!target) {
      return null;
    }

    return (
      this.workItemRepository.findById(target) ??
      this.workItemRepository.findByLinearIssueId(target) ??
      this.workItemRepository.findByIdentifier(target)
    );
  }

  private resolveCachedIssue(id: string): Issue | null {
    const target = id.trim();
    if (!target) {
      return null;
    }

    for (const issue of this.issueCacheById.values()) {
      if (issue.id === target || issue.identifier === target) {
        return issue;
      }
    }

    return null;
  }

  private buildIssueView(
    workItem: WorkItem,
    snapshot: OrchestratorStateSnapshot,
  ): RuntimeIssueView {
    const running = snapshot.running.find(
      (entry) => entry.issue_id === workItem.linear_issue_id,
    ) ?? null;
    const retrying = snapshot.retrying.find(
      (entry) => entry.issue_id === workItem.linear_issue_id,
    ) ?? null;
    const timeline = this.timelineByIssueId.get(workItem.linear_issue_id) ?? [];
    const runtimeSession = running ? this.buildSessionView(running, timeline) : null;
    const hasOverride = Boolean(workItem.governance_override_at);
    const canOverrideGovernance =
      !hasOverride &&
      !running &&
      !retrying &&
      workItem.orchestrator_state === 'halted' &&
      Boolean(workItem.governance_decision && workItem.governance_decision !== 'accept') &&
      !this.isTerminalState(workItem.linear_state);
    const canRewriteGovernance =
      canOverrideGovernance &&
      workItem.governance_decision === 'accept_with_rewrite';
    const canSplitGovernance =
      canOverrideGovernance &&
      workItem.governance_decision === 'split_before_implement';
    const shadowHarness = workItem.github_repo
      ? this.shadowHarnessRepository.findByRepoKey(workItem.github_repo)
      : null;
    const inferredDetails = shadowHarness?.inference_details_json ?? null;
    const governanceRootIssueId = workItem.governance_root_issue_id ?? workItem.linear_issue_id;
    const governanceRootWorkItem = governanceRootIssueId === workItem.linear_issue_id
      ? workItem
      : this.workItemRepository.findByLinearIssueId(governanceRootIssueId);
    const delivery = this.buildDeliveryProjection(workItem);
    const governanceThread = governanceRootIssueId === workItem.linear_issue_id
      ? this.buildGovernanceThreadProjection(workItem)
      : null;
    const supervisorProjection = this.buildSupervisorProjection(
      governanceRootIssueId,
      workItem,
      governanceThread,
    );
    const supervisorSession = this.supervisorSessionRepository.findByRootIssueId(governanceRootIssueId);
    const complexity = this.deriveComplexityLevel(workItem, supervisorSession, governanceThread?.childQueue ?? []);
    const governanceThreadState = governanceThread?.state ?? (
      workItem.orchestrator_state === 'halted' &&
      Boolean(workItem.governance_decision && workItem.governance_decision !== 'accept')
        ? 'blocked'
        : null
    );
    const nextRecommendedAction = governanceThread?.nextRecommendedAction
      ?? (
        workItem.governance_decision === 'split_before_implement'
          ? '按推荐拆成更聚焦的任务'
          : workItem.governance_decision === 'accept_with_rewrite'
            ? '先把需求改写成一个更聚焦的任务'
            : null
      );
    const round = this.buildRoundView(workItem, supervisorSession, complexity, governanceThread?.childQueue ?? [], nextRecommendedAction);
    const agentRecentProgress = this.buildAgentRecentProgress(workItem, runtimeSession);
    const milestones = this.buildIssueMilestones(workItem, supervisorSession, delivery);
    const riskDelta = this.buildRiskDelta(workItem, supervisorSession, delivery);
    const effectiveOrchestratorState =
      ['waiting_on_child', 'child_failed'].includes(governanceThreadState ?? '') && !running && !retrying
        ? 'halted'
        : workItem.orchestrator_state;

    return {
      issue_id: workItem.linear_issue_id,
      work_item_id: workItem.id,
      identifier: workItem.linear_identifier,
      title: workItem.linear_title,
      phase: derivePhase(workItem.linear_state),
      tracker_state: workItem.linear_state,
      orchestrator_state: effectiveOrchestratorState,
      workspace_path: workItem.workspace_path,
      branch_name: workItem.branch_name,
      github_repo: workItem.github_repo,
      github_issue_number: workItem.github_issue_number,
      active_pr_number: workItem.active_pr_number,
      supervisor_locale: workItem.supervisor_locale,
      session: runtimeSession,
      complexity,
      round,
      roundGoal: round.goal,
      agentRecentProgress,
      agent_recent_progress: agentRecentProgress,
      milestones,
      riskDelta,
      risk_delta: riskDelta,
      repo_harness_status: workItem.repo_harness_status
        ? {
            status: workItem.repo_harness_status,
            adoption_suggested: this.governanceSuggestionRepository
              .findPendingByIssueId(workItem.linear_issue_id)
              .some((suggestion) => suggestion.suggestion_type === 'harness_adoption'),
            learning_confidence: inferredDetails?.learning_confidence ?? null,
            learned_command_count: Object.keys(inferredDetails?.observed_commands ?? {})
              .filter((key) => {
                const command = inferredDetails?.observed_commands?.[key];
                return (command?.success_count ?? 0) >= 2 && (command?.success_count ?? 0) > (command?.failure_count ?? 0);
              })
              .length,
            learned_artifact_count: Object.keys(inferredDetails?.observed_artifacts ?? {})
              .filter((key) => (inferredDetails?.observed_artifacts?.[key]?.success_count ?? 0) >= 2)
              .length,
            learned_runtime_hint_count: Object.keys(inferredDetails?.observed_runtime_hints ?? {})
              .filter((key) => {
                const hint = inferredDetails?.observed_runtime_hints?.[key];
                return (hint?.success_count ?? 0) >= 2 && (hint?.success_count ?? 0) > (hint?.failure_count ?? 0);
              })
              .length,
          }
        : null,
      constitution_status: workItem.constitution_status,
      change_pack_summary: workItem.change_pack_summary,
      task_status: workItem.task_status,
      evidence_summary: workItem.evidence_summary,
      missing_requirements: workItem.missing_requirements,
      architectural_target: workItem.architectural_target,
      path_families: workItem.path_families,
      boundary_edges: workItem.boundary_edges,
      import_edges: workItem.import_edges,
      governance_status: workItem.governance_status,
      governance_decision: workItem.governance_decision,
      governance_summary: workItem.governance_summary,
      governance_root_issue_id: governanceRootIssueId,
      governance_root_issue_identifier: governanceRootWorkItem?.linear_identifier ?? workItem.linear_identifier,
      governance_thread_state: governanceThreadState,
      governance_child_issues: governanceThread?.children ?? [],
      governance_current_child: governanceThread?.currentChild ?? null,
      governance_child_queue: governanceThread?.childQueue ?? [],
      next_recommended_action: nextRecommendedAction,
      governance_pause_reason: governanceThread?.pauseReason ?? null,
      governance_expected_handoff: governanceThread?.expectedHandoff ?? null,
      governance_queued_child_identifiers: governanceThread?.queuedChildIdentifiers ?? [],
      delivery_state: delivery.state,
      delivery_code: delivery.code,
      delivery_summary: delivery.summary,
      supervisor_session_state: supervisorProjection.state,
      supervisor_plan_summary: supervisorProjection.summary,
      supervisor_job_state: supervisorProjection.jobState,
      latest_supervisor_directive: supervisorProjection.latestDirective,
      active_decision_kind: supervisorProjection.activeDecisionKind,
      constitution_hits: workItem.constitution_hits,
      fitness_signals: workItem.fitness_signals,
      active_governance_suggestions: this.governanceSuggestionRepository
        .findPendingByIssueId(workItem.linear_issue_id)
        .map((suggestion) => ({
          id: suggestion.id,
          suggestion_type: suggestion.suggestion_type,
          status: suggestion.status,
          title: suggestion.title,
          summary: suggestion.summary,
          can_execute: true,
          can_dismiss: true,
        })),
      governance_override: {
        active: hasOverride,
        approved_at: toIso(workItem.governance_override_at),
        reason: workItem.governance_override_reason,
      },
      actions: {
        can_stop: Boolean(running || retrying),
        can_retry:
          !running &&
          !retrying &&
          !this.isTerminalState(workItem.linear_state) &&
          !['discovering', 'mapping', 'workspace_ready'].includes(workItem.orchestrator_state),
        can_override_governance: canOverrideGovernance,
        can_rewrite_governance: canRewriteGovernance,
        can_split_governance: canSplitGovernance,
        can_open_pr: workItem.active_pr_number !== null,
      },
      created_at: toIso(workItem.created_at),
      updated_at: toIso(workItem.updated_at),
    };
  }

  private buildIssueViewFromIssue(
    issue: Issue,
    snapshot: OrchestratorStateSnapshot,
  ): RuntimeIssueView {
    const running = snapshot.running.find(
      (entry) => entry.issue_id === issue.id,
    ) ?? null;
    const retrying = snapshot.retrying.find(
      (entry) => entry.issue_id === issue.id,
    ) ?? null;
    const timeline = this.timelineByIssueId.get(issue.id) ?? [];

    return {
      issue_id: issue.id,
      work_item_id: null,
      identifier: issue.identifier,
      title: issue.title,
      phase: derivePhase(issue.state),
      tracker_state: issue.state,
      orchestrator_state: running ? null : 'failed',
      workspace_path: null,
      branch_name: issue.branch_name,
      github_repo: null,
      github_issue_number: null,
      active_pr_number: null,
      supervisor_locale: null,
      session: running ? this.buildSessionView(running, timeline) : null,
      complexity: 'L1',
      round: {
        index: 1,
        total: 1,
        goal: 'Waiting for runtime state.',
      },
      roundGoal: 'Waiting for runtime state.',
      agentRecentProgress: {
        dev: [],
        review: [],
      },
      agent_recent_progress: {
        dev: [],
        review: [],
      },
      milestones: [],
      riskDelta: null,
      risk_delta: null,
      repo_harness_status: null,
      constitution_status: null,
      change_pack_summary: null,
      task_status: null,
      evidence_summary: null,
      missing_requirements: [],
      architectural_target: null,
      path_families: [],
      boundary_edges: [],
      import_edges: [],
      governance_status: null,
      governance_decision: null,
      governance_summary: null,
      governance_root_issue_id: issue.id,
      governance_root_issue_identifier: issue.identifier,
      governance_thread_state: null,
      governance_child_issues: [],
      governance_current_child: null,
      governance_child_queue: [],
      next_recommended_action: null,
      governance_pause_reason: null,
      governance_expected_handoff: null,
      governance_queued_child_identifiers: [],
      delivery_state: null,
      delivery_code: null,
      delivery_summary: null,
      supervisor_session_state: null,
      supervisor_plan_summary: null,
      constitution_hits: [],
      fitness_signals: [],
      active_governance_suggestions: [],
      governance_override: null,
      actions: {
        can_stop: Boolean(running || retrying),
        can_retry: !running && !retrying && !this.isTerminalState(issue.state),
        can_override_governance: false,
        can_rewrite_governance: false,
        can_split_governance: false,
        can_open_pr: false,
      },
      created_at: toIso(issue.created_at),
      updated_at: toIso(issue.updated_at),
    };
  }

  private buildSessionView(
    running: OrchestratorStateSnapshot['running'][number],
    timeline: RuntimeTimelineEvent[],
  ): RuntimeSessionView {
    return {
      session_id: running.session_id,
      turn_count: running.turn_count,
      stage: running.stage,
      last_event: running.last_event,
      last_message: running.last_message,
      started_at: running.started_at,
      last_event_at: running.last_event_at,
      tokens: running.tokens,
      recent_tools: this.extractRecentTools(timeline),
      recent_files: this.extractRecentFiles(timeline),
    };
  }

  private getOutcomeRecord(session: SupervisorSessionRecord | null): Record<string, unknown> | null {
    return asRecord(session?.last_material_outcome);
  }

  private getOutcomeString(session: SupervisorSessionRecord | null, key: string): string | null {
    const value = this.getOutcomeRecord(session)?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private getOutcomeNumber(session: SupervisorSessionRecord | null, key: string): number | null {
    const value = this.getOutcomeRecord(session)?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private deriveComplexityLevel(
    workItem: WorkItem,
    session: SupervisorSessionRecord | null,
    childQueue: RuntimeGovernanceChildIssueView[],
  ): RuntimeComplexityLevel {
    const explicit = this.getOutcomeString(session, 'complexity');
    if (explicit && /^L[1-4]$/i.test(explicit)) {
      return explicit.toUpperCase() as RuntimeComplexityLevel;
    }
    if (
      childQueue.length > 0 ||
      session?.plan_card?.materialization_mode === 'root_with_split_queue' ||
      workItem.supervisor_execution_mode === 'root_with_split_queue'
    ) {
      return 'L4';
    }
    switch (workItem.change_pack_summary?.complexity) {
      case 'small':
        return 'L1';
      case 'medium':
        return 'L2';
      case 'large':
        return 'L3';
      default:
        return workItem.governance_decision && workItem.governance_decision !== 'accept' ? 'L3' : 'L2';
    }
  }

  private buildRoundView(
    workItem: WorkItem,
    session: SupervisorSessionRecord | null,
    complexity: RuntimeComplexityLevel,
    childQueue: RuntimeGovernanceChildIssueView[],
    nextRecommendedAction: string | null,
  ): RuntimeRoundView {
    const defaultTotal = complexity === 'L1'
      ? 1
      : complexity === 'L2'
        ? 2
        : complexity === 'L3'
          ? 3
          : Math.max(4, childQueue.length || 0);
    const total = Math.max(1, this.getOutcomeNumber(session, 'round_total') ?? defaultTotal);
    const derivedIndex = Math.max(1, workItem.review_round + 1, workItem.dev_attempt_count || 0);
    const index = Math.max(1, Math.min(total, this.getOutcomeNumber(session, 'round_index') ?? derivedIndex));
    const goal = this.getOutcomeString(session, 'round_goal')
      ?? this.getOutcomeString(session, 'latest_dev_instruction')
      ?? nextRecommendedAction
      ?? workItem.delivery_summary
      ?? 'Advance the current issue to the next verified checkpoint.';
    return {
      index,
      total,
      goal: normalizeSummary(
        localizeKnownRuntimeText(goal, workItem.supervisor_locale),
        'Advance the current issue to the next verified checkpoint.',
        180,
      ),
    };
  }

  private buildAgentRecentProgress(
    workItem: WorkItem,
    session: RuntimeSessionView | null,
  ): {
    dev: RuntimeAgentProgressItem[];
    review: RuntimeAgentProgressItem[];
  } {
    const devItems: RuntimeAgentProgressItem[] = [];
    if (session?.last_message) {
      devItems.push({
        summary: normalizeSummary(session.last_message, 'Latest dev activity.'),
        status: session.stage ?? 'running',
        timestamp: session.last_event_at,
      });
    }
    for (const run of this.agentRunRepository.findByWorkItemId(workItem.id)) {
      if (run.agent_type !== 'dev') {
        continue;
      }
      devItems.push({
        summary: normalizeSummary(run.output_summary ?? run.error ?? run.decision ?? run.input_summary, `${run.phase} run ${run.run_status}.`),
        status: run.run_status,
        timestamp: (run.finished_at ?? run.started_at).toISOString(),
      });
    }

    const reviewItems = this.reviewEventRepository.findByWorkItemId(workItem.id)
      .map((review): RuntimeAgentProgressItem => ({
        summary: normalizeSummary(review.summary_md, `${review.decision} for ${workItem.linear_identifier}.`),
        status: review.decision,
        timestamp: review.created_at.toISOString(),
      }));

    const sortRecent = (items: RuntimeAgentProgressItem[]) => [...items]
      .sort((left, right) => (right.timestamp ?? '').localeCompare(left.timestamp ?? ''))
      .slice(0, 3);

    return {
      dev: sortRecent(devItems),
      review: sortRecent(reviewItems),
    };
  }

  private buildIssueMilestones(
    workItem: WorkItem,
    session: SupervisorSessionRecord | null,
    delivery: ReturnType<RuntimeHub['buildDeliveryProjection']>,
  ): RuntimeMilestoneView[] {
    const milestones: RuntimeMilestoneView[] = [];
    const outcome = this.getOutcomeRecord(session);
    const milestoneKey = typeof outcome?.milestone_key === 'string' ? outcome.milestone_key : null;
    const milestoneKind = typeof outcome?.milestone_kind === 'string' ? outcome.milestone_kind : null;
    if (milestoneKey && milestoneKind) {
      milestones.push({
        kind: milestoneKind,
        key: milestoneKey,
        summary: normalizeSummary(
          localizeKnownRuntimeText(typeof outcome?.user_summary === 'string'
            ? outcome.user_summary
            : typeof outcome?.next_recommended_action === 'string'
              ? outcome.next_recommended_action
              : delivery.summary, workItem.supervisor_locale),
          `${milestoneKind} milestone.`,
        ),
        timestamp: toIso(session?.updated_at ?? workItem.updated_at),
      });
    }
    if (delivery.state) {
      milestones.push({
        kind: delivery.state,
        key: `delivery:${workItem.linear_issue_id}:${delivery.state}:${delivery.code ?? ''}`,
        summary: normalizeSummary(
          localizeKnownRuntimeText(delivery.summary, workItem.supervisor_locale),
          `${workItem.linear_identifier} delivery state ${delivery.state}.`,
        ),
        timestamp: toIso(workItem.updated_at),
      });
    }
    for (const review of this.reviewEventRepository.findByWorkItemId(workItem.id)) {
      milestones.push({
        kind: 'review_completed',
        key: `review:${review.id}`,
        summary: normalizeSummary(
          localizeKnownRuntimeText(review.summary_md, workItem.supervisor_locale),
          `Review ${review.decision}.`,
        ),
        timestamp: review.created_at.toISOString(),
      });
    }
    const [supervisorMilestone, ...otherMilestones] = milestones;
    return [
      ...(supervisorMilestone ? [supervisorMilestone] : []),
      ...otherMilestones
        .sort((left, right) => (right.timestamp ?? '').localeCompare(left.timestamp ?? '') || left.key.localeCompare(right.key)),
    ].slice(0, 6);
  }

  private buildRiskDelta(
    workItem: WorkItem,
    session: SupervisorSessionRecord | null,
    delivery: ReturnType<RuntimeHub['buildDeliveryProjection']>,
  ): string | null {
    const explicit = this.getOutcomeString(session, 'risk_delta');
    if (explicit) {
      return explicit;
    }
    if (delivery.state === 'delivery_failed') {
      return normalizeSummary(delivery.summary, 'Risk up: delivery failed.', 180);
    }
    if (delivery.state === 'proof_satisfied') {
      return 'Risk down: required proof is satisfied and final delivery is pending.';
    }
    if (workItem.governance_status === 'blocked') {
      return normalizeSummary(workItem.governance_summary, 'Risk up: governance is blocked.', 180);
    }
    return null;
  }

  private buildIssueDigest(
    issue: RuntimeIssueView,
    entries: RuntimeHistoryEntry[],
  ): RuntimeIssueDigest {
    const headlineParts = [
      `${issue.identifier} · ${issue.phase}`,
      issue.tracker_state,
    ];
    if (issue.session?.stage) {
      headlineParts.push(`live ${issue.session.stage}`);
    } else if (issue.orchestrator_state) {
      headlineParts.push(issue.orchestrator_state);
    }

    const latestTool = issue.session?.recent_tools[issue.session.recent_tools.length - 1] ?? null;
    const latestFile = issue.session?.recent_files[issue.session.recent_files.length - 1] ?? null;
    const latestHistory = entries[0] ?? null;
    const detail =
      latestTool
        ? normalizeSummary(
            `${latestTool.tool_name} ${latestTool.status}${latestTool.summary ? ` · ${latestTool.summary}` : ''}`,
            'Latest live tool activity.',
          )
        : latestFile
          ? normalizeSummary(
              `${latestFile.operation} · ${latestFile.path}`,
              'Latest live file activity.',
            )
          : latestHistory
            ? normalizeSummary(
                `${latestHistory.title} · ${latestHistory.summary}`,
                'Recent orchestration history is available.',
              )
            : issue.delivery_summary
              ? normalizeSummary(
                  issue.delivery_summary,
                  'Recent delivery status is available.',
                )
            : normalizeSummary(issue.session?.last_message, 'No recent live or historical updates yet.');

    return {
      headline: headlineParts.join(' · '),
      detail,
      history_blurb: latestHistory ? `${latestHistory.title} · ${latestHistory.summary}` : null,
      updated_at: issue.session?.last_event_at ?? issue.updated_at,
    };
  }

  private buildHistoryEntries(
    workItem: WorkItem,
    limit: number,
  ): RuntimeHistoryEntry[] {
    const entries: RuntimeHistoryEntry[] = [];
    const bounded = Math.max(1, limit);

    for (const run of this.agentRunRepository.findByWorkItemId(workItem.id)) {
      const timestamp = run.finished_at ?? run.started_at;
      entries.push({
        id: `agent-run:${run.id}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
        source: 'agent_run',
        title: `${run.agent_type === 'review' ? 'Review' : 'Dev'} run ${run.run_status}`,
        summary: normalizeSummary(
          run.output_summary ?? run.error ?? run.decision ?? run.input_summary,
          `${run.phase} run ${run.run_status}.`,
        ),
        timestamp: timestamp.toISOString(),
        detail: {
          phase: run.phase,
          run_status: run.run_status,
          decision: run.decision,
          error: run.error,
        },
      });
    }

    for (const review of this.reviewEventRepository.findByWorkItemId(workItem.id)) {
      entries.push({
        id: `review:${review.id}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
        source: 'review',
        title: `Review round ${review.review_round} · ${review.decision}`,
        summary: normalizeSummary(
          review.summary_md,
          `${review.decision} for ${workItem.linear_identifier}.`,
        ),
        timestamp: review.created_at.toISOString(),
        detail: {
          pr_number: review.pr_number,
          decision: review.decision,
          requested_changes_md: review.requested_changes_md,
          merge_block_reason: review.merge_block_reason,
        },
      });
    }

    for (const assessment of this.governanceAssessmentRepository.findByWorkItemId(workItem.id)) {
      entries.push({
        id: `governance-assessment:${assessment.id}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
        source: 'governance',
        title: `Governance assessment · ${assessment.decision}`,
        summary: normalizeSummary(
          assessment.summary,
          `${assessment.decision} for ${workItem.linear_identifier}.`,
        ),
        timestamp: assessment.created_at.toISOString(),
        detail: {
          decision: assessment.decision,
          status: assessment.status,
          constitution_hits: assessment.constitution_hits_json,
          detail: assessment.detail_json,
        },
      });
    }

    for (const suggestion of this.governanceSuggestionRepository.findByIssueId(workItem.linear_issue_id)) {
      entries.push({
        id: `governance-suggestion:${suggestion.id}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
        source: 'governance',
        title: `Governance suggestion · ${suggestion.suggestion_type}`,
        summary: normalizeSummary(
          suggestion.summary,
          `${suggestion.suggestion_type} suggested for ${workItem.linear_identifier}.`,
        ),
        timestamp: suggestion.created_at.toISOString(),
        detail: {
          suggestion_type: suggestion.suggestion_type,
          status: suggestion.status,
          title: suggestion.title,
          detail: suggestion.detail_json,
        },
      });
    }

    for (const syncEvent of this.syncEventRepository.findByWorkItemId(workItem.id)) {
      const payloadSummary = Object.entries(syncEvent.payload_json)
        .slice(0, 3)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(', ');
      entries.push({
        id: `sync-event:${syncEvent.id}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
        source: 'sync_event',
        title: `Sync ${syncEvent.target_system} · ${syncEvent.action} · ${syncEvent.result}`,
        summary: normalizeSummary(
          syncEvent.error || payloadSummary,
          `${syncEvent.target_system} ${syncEvent.action} ${syncEvent.result}.`,
        ),
        timestamp: syncEvent.created_at.toISOString(),
        detail: {
          target_system: syncEvent.target_system,
          action: syncEvent.action,
          result: syncEvent.result,
          error: syncEvent.error,
          payload: syncEvent.payload_json,
        },
      });
    }

    if (workItem.merged_at) {
      entries.push({
        id: `work-item:${workItem.id}:merged`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
        source: 'work_item',
        title: 'Merged',
        summary: normalizeSummary(
          workItem.last_review_summary,
          `${workItem.linear_identifier} reached terminal state ${workItem.linear_state}.`,
        ),
        timestamp: workItem.merged_at.toISOString(),
        detail: {
          linear_state: workItem.linear_state,
        },
      });
    }

    if (workItem.cancelled_at) {
      entries.push({
        id: `work-item:${workItem.id}:cancelled`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
        source: 'work_item',
        title: 'Cancelled',
        summary: `${workItem.linear_identifier} was cancelled.`,
        timestamp: workItem.cancelled_at.toISOString(),
        detail: {
          linear_state: workItem.linear_state,
        },
      });
    }

    return entries
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || left.id.localeCompare(right.id))
      .slice(0, bounded);
  }

  private buildWorkspaceFileDiffs(workItem: WorkItem, limit = 12): RuntimeHistoryFileDiff[] {
    if (!workItem.workspace_path) {
      return [];
    }

    const repoRoot = runGit(workItem.workspace_path, ['rev-parse', '--show-toplevel']);
    if (!repoRoot) {
      return [];
    }

    const baseRef = resolveHistoryDiffBaseRef(repoRoot);
    if (!baseRef) {
      return [];
    }

    const baseCommit = runGit(repoRoot, ['merge-base', 'HEAD', baseRef]);
    if (!baseCommit) {
      return [];
    }

    const numstat = runGit(repoRoot, ['diff', '--numstat', '--find-renames', baseCommit, '--']);
    if (!numstat) {
      return [];
    }

    return numstat
      .split('\n')
      .map((line) => parseNumstatLine(line))
      .filter((item): item is { path: string; additions: number | null; deletions: number | null } => Boolean(item))
      .slice(0, Math.max(1, limit))
      .map((item) => ({
        path: item.path,
        additions: item.additions,
        deletions: item.deletions,
        patch: runGit(repoRoot, ['diff', '--no-ext-diff', '--find-renames', '--unified=20', baseCommit, '--', item.path]),
      }))
      .filter((item) => Boolean(item.patch) || item.additions !== null || item.deletions !== null);
  }

  private extractRecentTools(timeline: RuntimeTimelineEvent[]): RuntimeToolActivity[] {
    const tools: RuntimeToolActivity[] = [];

    for (let index = timeline.length - 1; index >= 0 && tools.length < 6; index -= 1) {
      const event = timeline[index];
      if (event.category !== 'tool' || !event.tool_name) {
        continue;
      }

      const detail = asRecord(event.detail);
      tools.unshift({
        tool_name: event.tool_name,
        status: mapToolStatus(event.code),
        message: event.message,
        summary: typeof detail?.summary === 'string' ? detail.summary : null,
        path: typeof detail?.path === 'string' ? detail.path : null,
        timestamp: event.timestamp,
      });
    }

    return tools;
  }

  private extractRecentFiles(timeline: RuntimeTimelineEvent[]): RuntimeFileActivity[] {
    const files: RuntimeFileActivity[] = [];
    const seen = new Set<string>();

    for (let index = timeline.length - 1; index >= 0 && files.length < 6; index -= 1) {
      const event = timeline[index];
      if (event.category !== 'tool' || !event.tool_name) {
        continue;
      }

      const detail = asRecord(event.detail);
      const pathValue =
        (typeof detail?.path === 'string' && detail.path) ||
        (typeof detail?.summary === 'string' &&
        ['Read', 'Write', 'Edit'].includes(event.tool_name)
          ? detail.summary
          : null);

      if (!pathValue) {
        continue;
      }

      const operation = inferFileOperation(event.tool_name);
      const key = `${operation}:${pathValue}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      files.unshift({
        path: pathValue,
        operation,
        status: mapToolStatus(event.code),
        timestamp: event.timestamp,
      });
    }

    return files;
  }

  private compareIssueViews(left: RuntimeIssueView, right: RuntimeIssueView): number {
    const leftLive = left.session ? 1 : 0;
    const rightLive = right.session ? 1 : 0;
    if (leftLive !== rightLive) {
      return rightLive - leftLive;
    }

    const leftRetry = left.actions.can_stop && !left.session ? 1 : 0;
    const rightRetry = right.actions.can_stop && !right.session ? 1 : 0;
    if (leftRetry !== rightRetry) {
      return rightRetry - leftRetry;
    }

    return (right.updated_at || '').localeCompare(left.updated_at || '');
  }

  private isTerminalState(state: string): boolean {
    return ['done', 'cancelled', 'canceled', 'duplicate', 'closed'].includes(
      state.toLowerCase(),
    );
  }

  private isCancelledState(state: string): boolean {
    return ['cancelled', 'canceled', 'duplicate'].includes(state.toLowerCase());
  }

  private buildDeliveryProjection(workItem: WorkItem): {
    state: RuntimeDeliveryState | null;
    code: RuntimeIssueView['delivery_code'];
    summary: string | null;
  } {
    const englishOutput = workItem.supervisor_locale === 'en';
    const evidenceSummary = workItem.evidence_summary;
    const missingCount = evidenceSummary?.missing ?? workItem.missing_requirements.length;
    const proofSatisfied = Boolean(
      evidenceSummary &&
      (evidenceSummary.total_requirements ?? 0) > 0 &&
      missingCount === 0,
    );
    const agentRuns = this.agentRunRepository.findByWorkItemId(workItem.id);
    const latestRun = agentRuns[agentRuns.length - 1] ?? null;
    const latestFailure = latestRun?.run_status === 'failed'
      ? normalizeSummary(
          latestRun.error ?? latestRun.output_summary ?? latestRun.decision,
          `${latestRun.phase} run failed.`,
          240,
        )
      : null;

    if (this.isTerminalState(workItem.linear_state)) {
      const cancelled = this.isCancelledState(workItem.linear_state);
      const fallback = cancelled
        ? (englishOutput
          ? `${workItem.linear_identifier} was cancelled and will not continue automatically.`
          : `${workItem.linear_identifier} 已取消，不会继续自动推进。`)
        : (englishOutput
          ? `${workItem.linear_identifier} completed final delivery.`
          : `${workItem.linear_identifier} 已完成最终交付。`);
      return {
        state: 'completed',
        code: workItem.delivery_code ?? null,
        summary: normalizeSummary(
          workItem.delivery_summary
            ?? (cancelled ? null : workItem.last_review_summary)
            ?? latestRun?.output_summary
            ?? latestRun?.decision
            ?? fallback,
          fallback,
          240,
        ),
      };
    }

    if (proofSatisfied && (workItem.orchestrator_state === 'failed' || latestFailure)) {
      return {
        state: 'delivery_failed',
        code: workItem.delivery_code ?? null,
        summary: normalizeSummary(
          workItem.delivery_summary ?? (englishOutput
            ? `Proof is satisfied, but delivery is blocked at ${latestFailure ?? 'the final delivery action failed'}.`
            : `证据已满足，但交付卡在 ${latestFailure ?? '最终交付动作失败'}。`),
          englishOutput
            ? 'Proof is satisfied, but final delivery failed.'
            : '证据已满足，但最终交付失败。',
          260,
        ),
      };
    }

    if (proofSatisfied) {
      return {
        state: 'proof_satisfied',
        code: workItem.delivery_code ?? null,
        summary: englishOutput
          ? 'Proof is satisfied and final delivery is pending.'
          : '证据已满足，正在等待最终交付动作完成。',
      };
    }

    return {
      state: null,
      code: workItem.delivery_code ?? null,
      summary: null,
    };
  }

  private buildGovernanceThreadProjection(workItem: WorkItem): {
    state: RuntimeIssueView['governance_thread_state'];
    currentChild: RuntimeGovernanceChildIssueView | null;
    childQueue: RuntimeGovernanceChildIssueView[];
    children: RuntimeGovernanceChildIssueView[];
    nextRecommendedAction: string | null;
    pauseReason: string | null;
    expectedHandoff: string | null;
    queuedChildIdentifiers: string[];
  } | null {
    const englishOutput = workItem.supervisor_locale === 'en';
    const children = this.workItemRepository
      .findByGovernanceParentIssueId(workItem.linear_issue_id)
      .filter((child) => child.linear_issue_id !== workItem.linear_issue_id)
      .sort((left, right) =>
        compareDatesAscending(left.created_at, right.created_at)
        || left.linear_identifier.localeCompare(right.linear_identifier),
      );

    if (children.length === 0) {
      return null;
    }

    const firstActiveIndex = children.findIndex((child) => !this.isTerminalState(child.linear_state));
    const currentChildIndex = firstActiveIndex >= 0 ? firstActiveIndex : -1;
    const childViews = children.map((child, index) => {
      const delivery = this.buildDeliveryProjection(child);
      const queueState = this.isTerminalState(child.linear_state)
        ? 'completed'
        : index === currentChildIndex
          ? 'current'
          : currentChildIndex >= 0 && index > currentChildIndex
            ? 'queued'
            : 'blocked';

      return {
        issue_id: child.linear_issue_id,
        issue_identifier: child.linear_identifier,
        title: child.linear_title,
        tracker_state: child.linear_state,
        orchestrator_state: child.orchestrator_state,
        governance_decision: child.governance_decision,
        governance_summary: child.governance_summary,
        queue_state: queueState,
        delivery_state: delivery.state,
        delivery_code: delivery.code,
        delivery_summary: delivery.summary,
      } satisfies RuntimeGovernanceChildIssueView;
    });
    const currentChild = currentChildIndex >= 0 ? childViews[currentChildIndex] ?? null : null;
    const queuedChildren = childViews.filter((child) => child.queue_state === 'queued');
    const queuedChildIdentifiers = queuedChildren.map((child) => child.issue_identifier);
    if (!currentChild && childViews.length > 0 && childViews.every((child) => child.queue_state === 'completed')) {
      const rootFinalized = this.isTerminalState(workItem.linear_state)
        || workItem.orchestrator_state === 'completed'
        || workItem.delivery_state === 'completed';
      if (!rootFinalized) {
        return {
          state: 'waiting_on_child',
          currentChild: null,
          childQueue: childViews,
          children: childViews,
          pauseReason: englishOutput
            ? 'All ordered child tasks are complete. Waiting for the root thread to finalize; the root will not be dispatched as a new dev task.'
            : '所有顺序子任务已完成，等待 root 线程收尾；不会把 root 当作新的开发任务派发。',
          expectedHandoff: null,
          queuedChildIdentifiers: [],
          nextRecommendedAction: englishOutput
            ? 'All ordered child tasks are complete. Waiting for the root thread to finalize and sync final delivery state.'
            : '所有顺序子任务已完成，等待 root 线程收尾并同步最终交付状态。',
        };
      }
      return {
        state: 'resolved',
        currentChild: null,
        childQueue: childViews,
        children: childViews,
        pauseReason: null,
        expectedHandoff: null,
        queuedChildIdentifiers: [],
        nextRecommendedAction: englishOutput
          ? 'All ordered child tasks are complete. The plan thread is complete.'
          : '所有顺序子任务已完成，计划线程已完成。',
      };
    }
    const pauseReason = currentChild
      ? (
        currentChild.delivery_state === 'delivery_failed' || currentChild.orchestrator_state === 'failed'
          ? (englishOutput
            ? `The root issue is paused at ${currentChild.issue_identifier}; resolve this child task's delivery failure first.`
            : `源单当前暂停在 ${currentChild.issue_identifier}；需要先处理这张子任务的交付失败。`)
          : (englishOutput
            ? `The root issue is paused at ${currentChild.issue_identifier}; later siblings will not be released until this child task completes.`
            : `源单当前暂停在 ${currentChild.issue_identifier}；完成这张子任务前不会放行后续 sibling。`)
      )
      : (englishOutput
        ? 'No governance child task is currently runnable. Waiting for the root thread to reassess.'
        : '当前没有可推进的治理子任务，等待根线程重新评估。');
    const expectedHandoff = queuedChildIdentifiers.length > 0
      ? (englishOutput
        ? `After ${currentChild?.issue_identifier ?? 'the current child task'} is handled, the queue will continue with ${queuedChildIdentifiers.join(', ')}.`
        : `处理完 ${currentChild?.issue_identifier ?? '当前子任务'} 后，会自动接力 ${queuedChildIdentifiers.join('、')}。`)
      : currentChild
        ? (englishOutput
          ? `After ${currentChild.issue_identifier} is handled, the root thread will reassess whether to resume the source issue.`
          : `处理完 ${currentChild.issue_identifier} 后，根线程会重新评估是否恢复源单。`)
        : null;

    return {
      state: currentChild?.delivery_state === 'delivery_failed' || currentChild?.orchestrator_state === 'failed'
        ? 'child_failed'
        : 'waiting_on_child',
      currentChild,
      childQueue: childViews,
      children: childViews,
      pauseReason,
      expectedHandoff,
      queuedChildIdentifiers,
      nextRecommendedAction: currentChild
        ? (
          currentChild.delivery_state === 'delivery_failed' || currentChild.orchestrator_state === 'failed'
            ? (englishOutput
              ? `Handle governance child task ${currentChild.issue_identifier} first; the root issue remains paused. ${queuedChildren.length > 0 ? `After it is handled, the queue will continue with ${queuedChildren.map((child) => child.issue_identifier).join(', ')}.` : 'After it is handled, continue the source plan.'}`
              : `先处理治理子任务 ${currentChild.issue_identifier}；源单仍暂停，${queuedChildren.length > 0 ? `处理完后会自动接力 ${queuedChildren.map((child) => child.issue_identifier).join('、')}。` : '处理完后再继续源计划。'}`)
            : queuedChildren.length > 0
              ? (englishOutput
                ? `Handle governance child task ${currentChild.issue_identifier} first; after it completes, the queue will continue with ${queuedChildren.map((child) => child.issue_identifier).join(', ')}.`
                : `先处理治理子任务 ${currentChild.issue_identifier}；完成后会自动接力 ${queuedChildren.map((child) => child.issue_identifier).join('、')}。`)
              : (englishOutput
                ? `Handle governance child task ${currentChild.issue_identifier} first.`
                : `先处理治理子任务 ${currentChild.issue_identifier}`)
        )
        : (englishOutput ? 'Waiting for the root governance thread to reassess.' : '等待根治理线程重新评估。'),
    };
  }

  private buildSupervisorProjection(
    rootIssueId: string,
    workItem: WorkItem,
    governanceThread: ReturnType<RuntimeHub['buildGovernanceThreadProjection']>,
  ): {
    state: string | null;
    summary: string | null;
    jobState: string | null;
    latestDirective: string | null;
    activeDecisionKind: string | null;
  } {
    const session = this.supervisorSessionRepository.findByRootIssueId(rootIssueId);
    if (!session) {
      if (workItem.supervisor_root_session_id || workItem.supervisor_plan_summary || workItem.supervisor_acceptance_summary) {
        const englishOutput = workItem.supervisor_locale === 'en';
        return {
          state: 'materialized',
          summary: [
            workItem.supervisor_plan_summary ?? (englishOutput
              ? 'The current plan thread is in progress.'
              : '当前计划线程正在推进。'),
            workItem.supervisor_acceptance_summary
              ? (englishOutput
                ? `Acceptance: ${workItem.supervisor_acceptance_summary}`
                : `完成标准：${workItem.supervisor_acceptance_summary}`)
              : null,
            workItem.supervisor_execution_mode === 'root_with_split_queue'
              ? (englishOutput
                ? 'Execution mode: root stays as the main thread while the child queue runs in order.'
                : '执行方式：root 保持主线程，child queue 顺序接力。')
              : workItem.supervisor_execution_mode === 'root_only'
                ? (englishOutput
                  ? 'Execution mode: single root thread.'
                  : '执行方式：单 root 线程直接推进。')
                : null,
          ].filter(Boolean).join(' '),
          jobState: null,
          latestDirective: null,
          activeDecisionKind: null,
        };
      }

      return {
        state: null,
        summary: null,
        jobState: null,
        latestDirective: null,
        activeDecisionKind: null,
      };
    }

    return {
      state: session.state,
      summary: this.describeSupervisorSession(session, governanceThread, workItem.supervisor_locale ?? session.supervisor_locale),
      jobState: this.describeSupervisorJobState(session),
      latestDirective: typeof session.last_material_outcome?.latest_dev_instruction === 'string'
        ? session.last_material_outcome.latest_dev_instruction
        : null,
      activeDecisionKind: session.active_decision_kind,
    };
  }

  private describeSupervisorJobState(session: SupervisorSessionRecord): string {
    if (session.active_decision_kind || session.state === 'awaiting_user_decision') {
      return session.state;
    }
    const latestJob = this.supervisorJobRepository.listBySession(session.id)[0] ?? null;
    if (!latestJob) {
      return session.state;
    }
    return `${latestJob.status}:${latestJob.job_kind}`;
  }

  private describeSupervisorSession(
    session: SupervisorSessionRecord,
    governanceThread: ReturnType<RuntimeHub['buildGovernanceThreadProjection']>,
    locale: WorkItem['supervisor_locale'],
  ): string {
    return describeSupervisorThread({
      session,
      currentChild: governanceThread?.currentChild ?? null,
      childQueue: governanceThread?.childQueue ?? [],
      locale,
    });
  }
}
