import type { Database } from 'bun:sqlite';
import {
  AgentRunRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  SyncEventRepository,
  WorkItemRepository,
} from '../database';
import type { WorkItem } from '../database/types';
import type { OrchestratorStateSnapshot } from '../orchestrator';
import type { AgentEvent, AgentTimelinePayload, Issue } from '../types';
import type {
  CreateIssueRequest,
  CreateIssueResult,
  RuntimeActionResult,
  RuntimeControlPlane,
  RuntimeFileActivity,
  RuntimeHistoryEntry,
  RuntimeIssueDigest,
  RuntimeIssueHistoryView,
  RuntimeIssueView,
  RuntimeOverview,
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
  overrideGovernance(issueId: string): Promise<RuntimeActionResult>;
  rewriteGovernance(issueId: string): Promise<RuntimeActionResult>;
  splitGovernance(issueId: string): Promise<RuntimeActionResult>;
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

export class RuntimeHub implements RuntimeControlPlane {
  private readonly workItemRepository: WorkItemRepository;
  private readonly agentRunRepository: AgentRunRepository;
  private readonly governanceAssessmentRepository: GovernanceAssessmentRepository;
  private readonly reviewEventRepository: ReviewEventRepository;
  private readonly syncEventRepository: SyncEventRepository;
  private readonly governanceSuggestionRepository: GovernanceSuggestionRepository;
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

    return {
      issue_id: workItem.linear_issue_id,
      work_item_id: workItem.id,
      identifier: workItem.linear_identifier,
      title: workItem.linear_title,
      phase: derivePhase(workItem.linear_state),
      tracker_state: workItem.linear_state,
      orchestrator_state: workItem.orchestrator_state,
      workspace_path: workItem.workspace_path,
      branch_name: workItem.branch_name,
      github_repo: workItem.github_repo,
      github_issue_number: workItem.github_issue_number,
      active_pr_number: workItem.active_pr_number,
      session: running ? this.buildSessionView(running, timeline) : null,
      repo_harness_status: workItem.repo_harness_status
        ? {
            status: workItem.repo_harness_status,
            adoption_suggested: this.governanceSuggestionRepository
              .findPendingByIssueId(workItem.linear_issue_id)
              .some((suggestion) => suggestion.suggestion_type === 'harness_adoption'),
          }
        : null,
      constitution_status: workItem.constitution_status,
      change_pack_summary: workItem.change_pack_summary,
      task_status: workItem.task_status,
      evidence_summary: workItem.evidence_summary,
      missing_requirements: workItem.missing_requirements,
      governance_status: workItem.governance_status,
      governance_decision: workItem.governance_decision,
      governance_summary: workItem.governance_summary,
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
      session: running ? this.buildSessionView(running, timeline) : null,
      repo_harness_status: null,
      constitution_status: null,
      change_pack_summary: null,
      task_status: null,
      evidence_summary: null,
      missing_requirements: [],
      governance_status: null,
      governance_decision: null,
      governance_summary: null,
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
}
