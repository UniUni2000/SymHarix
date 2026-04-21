import type { Database } from 'bun:sqlite';
import { WorkItemRepository } from '../database';
import type { WorkItem } from '../database/types';
import type { OrchestratorStateSnapshot } from '../orchestrator';
import type { AgentEvent, AgentTimelinePayload, Issue } from '../types';
import type {
  CreateIssueRequest,
  CreateIssueResult,
  RuntimeActionResult,
  RuntimeControlPlane,
  RuntimeFileActivity,
  RuntimeIssueView,
  RuntimeOverview,
  RuntimeSessionView,
  RuntimeStreamEvent,
  RuntimeTimelineEvent,
  RuntimeToolActivity,
} from './types';

interface RuntimeHubController {
  getStateSnapshot(): OrchestratorStateSnapshot;
  createIssue(input: CreateIssueRequest): Promise<CreateIssueResult>;
  stopIssue(issueId: string): Promise<RuntimeActionResult>;
  retryIssue(issueId: string): Promise<RuntimeActionResult>;
  on(event: string, listener: (...args: unknown[]) => void): this;
  off?(event: string, listener: (...args: unknown[]) => void): this;
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

export class RuntimeHub implements RuntimeControlPlane {
  private readonly workItemRepository: WorkItemRepository;
  private readonly timelineHistoryLimit: number;
  private readonly timelineByIssueId = new Map<string, RuntimeTimelineEvent[]>();
  private readonly subscribers = new Map<number, (event: RuntimeStreamEvent) => void>();
  private readonly listeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = [];
  private nextSubscriberId = 1;

  constructor(
    db: Database,
    private readonly controller: RuntimeHubController,
    options: RuntimeHubOptions = {},
  ) {
    this.workItemRepository = new WorkItemRepository(db);
    this.timelineHistoryLimit = Math.max(10, options.timelineHistoryLimit ?? 200);

    this.bind('state:changed', () => {
      this.publishOverview();
    });
    this.bind('issue:dispatched', (issue: Issue) => {
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('issue:completed', (issue: Issue) => {
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('issue:failed', (issue: Issue) => {
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('issue:retrying', (issue: Issue) => {
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('issue:reconciled', (issue: Issue) => {
      this.publishIssue(issue.id);
      this.publishOverview();
    });
    this.bind('session:event', (issueId: string, event: AgentEvent) => {
      this.handleSessionEvent(issueId, event);
    });
  }

  dispose(): void {
    for (const { event, listener } of this.listeners) {
      this.controller.off?.(event, listener);
    }
    this.listeners.length = 0;
    this.subscribers.clear();
  }

  getOverview(): RuntimeOverview {
    const snapshot = this.controller.getStateSnapshot();
    const workItems = this.workItemRepository.findAll();
    const issues = workItems
      .map((workItem) => this.buildIssueView(workItem, snapshot))
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
    if (!workItem) {
      return null;
    }

    return this.buildIssueView(workItem, this.controller.getStateSnapshot());
  }

  getTimeline(id: string, limit = 100): RuntimeTimelineEvent[] {
    const workItem = this.resolveWorkItem(id);
    const issueId = workItem?.linear_issue_id ?? id;
    const events = this.timelineByIssueId.get(issueId) ?? [];
    const bounded = Math.max(1, limit);
    return events.slice(-bounded);
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

  createStream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let subscriberId: number | null = null;
    let heartbeat: Timer | null = null;

    const encode = (event: RuntimeStreamEventType, data: unknown): Uint8Array => {
      return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriberId = this.subscribe((event) => {
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

  private bind(event: string, listener: (...args: unknown[]) => void): void {
    this.controller.on(event, listener);
    this.listeners.push({ event, listener });
  }

  private subscribe(listener: (event: RuntimeStreamEvent) => void): number {
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
      actions: {
        can_stop: Boolean(running || retrying),
        can_retry:
          !running &&
          !retrying &&
          !this.isTerminalState(workItem.linear_state) &&
          !['discovering', 'mapping', 'workspace_ready'].includes(workItem.orchestrator_state),
        can_open_pr: workItem.active_pr_number !== null,
      },
      created_at: toIso(workItem.created_at),
      updated_at: toIso(workItem.updated_at),
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
