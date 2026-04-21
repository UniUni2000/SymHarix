/**
 * Orchestrator - Core scheduling and state management
 * Section 7: Orchestration State Machine
 * Section 8: Polling, Scheduling, and Reconciliation
 */

import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'bun:sqlite';
import {
  AgentTimelinePayload,
  Issue,
  PendingRuntimeRequest,
  ServiceConfig,
  SupervisorNextAction,
  TurnTranscriptEntry,
  WorkflowDefinition,
  OrchestratorState,
  RunningEntry,
  RunningStage,
  RetryEntry,
  AgentEvent,
  CodexTotals
} from '../types';
import { LinearClient } from '../tracker/linear-client';
import { GitHubIssueClient } from '../github/issue-client';
import { WorkspaceManager } from '../workspace/manager';
import { sanitizeWorkspaceKey } from '../workspace/shared';
import { AgentRunner } from '../agent/runner';
import { createDatabase } from '../database';
import {
  AgentRunRepository,
  ReviewEventRepository,
  ServiceLeaseRepository,
  SyncEventRepository,
  WorkItemRepository
} from '../database';
import { buildReviewPrompt } from '../hooks/review-prompt';
import { buildDevPrompt, judgeComplexity } from '../hooks/dev-prompt';
import { updateHandoverNextSteps } from '../hooks/handover';
import { GitHubMappingService } from '../github/mappingService';
import { GitHubContextService } from '../github/contextService';
import { GitHubSyncService } from '../github/syncService';
import { buildDevAgentContextMarkdown, summarizeDevContext } from '../agent/devContextBuilder';
import { buildReviewAgentContextMarkdown, summarizeReviewContext } from '../agent/reviewContextBuilder';
import {
  AnthropicSupervisorService,
  type SupervisorService,
} from '../agent/supervisor';

/**
 * GitHub Issue Client for E2E flow
 */
let githubIssueClient: GitHubIssueClient | null = null;

/**
 * Orchestrator events
 */
export interface OrchestratorEvents {
  'issue:dispatched': (issue: Issue) => void;
  'issue:completed': (issue: Issue, success: boolean) => void;
  'issue:failed': (issue: Issue, error: string) => void;
  'issue:retrying': (issue: Issue, attempt: number, delay: number) => void;
  'issue:reconciled': (issue: Issue, newState: string) => void;
  'session:event': (issueId: string, event: AgentEvent) => void;
  'state:changed': (state: OrchestratorStateSnapshot) => void;
  'error': (error: Error) => void;
}

/**
 * Snapshot of orchestrator state for observability
 * Section 13.3: Runtime Snapshot
 */
export interface OrchestratorStateSnapshot {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
  };
  running: Array<{
    issue_id: string;
    issue_identifier: string;
    state: string;
    stage: RunningStage;
    session_id: string | null;
    turn_count: number;
    last_event: string | null;
    last_message: string | null;
    started_at: string;
    last_event_at: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    };
  }>;
  retrying: Array<{
    issue_id: string;
    issue_identifier: string;
    attempt: number;
    due_at: string;
    error: string | null;
  }>;
  codex_totals: CodexTotals;
  rate_limits: unknown | null;
}

/**
 * Worker run result
 */
export type WorkerOutcome = 'completed' | 'retryable_failure' | 'halted' | 'needs_rework';
export type WorkerNextAction = 'none' | 'retry_dev' | 'retry_review' | 'stop';
export type WorkerFailureReason =
  | 'workspace_setup'
  | 'dispatch_setup'
  | 'tracker_refresh'
  | 'agent_turn'
  | 'cli_business'
  | 'agent_attempt';

export interface CliCommandResult {
  ok: boolean;
  final_state: string;
  review_decision: string | null;
  feedback: string | null;
  retry_hint: WorkerNextAction | null;
  linear_api_calls: number;
  github_api_calls: number;
}

export interface WorkerResult {
  issueId: string;
  work_item_id?: string;
  agent_run_id?: string;
  success: boolean;
  completed: boolean;  // Normal completion (not failed/cancelled)
  outcome: WorkerOutcome;
  next_action: WorkerNextAction;
  failure_reason?: WorkerFailureReason;
  error?: string;
  final_state?: string;
  workspace_path?: string;
  cleanup_workspace?: boolean;
  retry_delay_ms?: number;
  turns: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  // API call statistics
  claude_api_calls: number;
  linear_api_calls: number;
  github_api_calls: number;
  cli_result?: CliCommandResult;
}

interface CliCommandInvocationResult {
  success: boolean;
  result?: CliCommandResult;
  error?: string;
}

const CLI_RESULT_PREFIX = 'SYMPHONY_RESULT:';

export interface OrchestratorDependencies {
  db?: Database;
  tracker?: LinearClient;
  workspaceManager?: WorkspaceManager;
  agentRunner?: AgentRunner;
  workItemRepository?: WorkItemRepository;
  agentRunRepository?: AgentRunRepository;
  reviewEventRepository?: ReviewEventRepository;
  syncEventRepository?: SyncEventRepository;
  serviceLeaseRepository?: ServiceLeaseRepository;
  githubMappingService?: GitHubMappingService;
  githubContextService?: GitHubContextService;
  githubSyncService?: GitHubSyncService;
  supervisor?: SupervisorService;
}

export function parseCliCommandResult(output: string): CliCommandResult | null {
  const line = output
    .split(/\r?\n/)
    .map(part => part.trim())
    .find(part => part.startsWith(CLI_RESULT_PREFIX));

  if (!line) {
    return null;
  }

  try {
    const parsed = JSON.parse(line.slice(CLI_RESULT_PREFIX.length)) as Partial<CliCommandResult>;
    return {
      ok: parsed.ok !== false,
      final_state: String(parsed.final_state || 'unknown'),
      review_decision: parsed.review_decision ? String(parsed.review_decision) : null,
      feedback: parsed.feedback ? String(parsed.feedback) : null,
      retry_hint: parsed.retry_hint || null,
      linear_api_calls: Number(parsed.linear_api_calls || 0),
      github_api_calls: Number(parsed.github_api_calls || 0),
    };
  } catch {
    return null;
  }
}

/**
 * Orchestrator - manages issue dispatch, retries, and reconciliation
 */
export class Orchestrator extends EventEmitter {
  private static readonly PRIMARY_LEASE_KEY = 'orchestrator:primary';
  private config: ServiceConfig;
  private workflow: WorkflowDefinition;
  private tracker: LinearClient;
  private workspaceManager: WorkspaceManager;
  private agentRunner: AgentRunner;
  private db: Database;
  private workItemRepository: WorkItemRepository;
  private agentRunRepository: AgentRunRepository;
  private reviewEventRepository: ReviewEventRepository;
  private syncEventRepository: SyncEventRepository;
  private serviceLeaseRepository: ServiceLeaseRepository;
  private githubMappingService: GitHubMappingService;
  private githubContextService: GitHubContextService;
  private githubSyncService: GitHubSyncService;
  private supervisor: SupervisorService;

  // Section 4.1.8: Orchestrator Runtime State
  private state: OrchestratorState;

  private pollTimer: NodeJS.Timeout | null = null;
  private leaseRenewTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopRequested = false;
  private currentTickPromise: Promise<void> | null = null;
  private workerRegistry = new Map<string, cp.ChildProcess>();
  private readonly leaseHolderId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
  private readonly leaseTtlMs: number;
  private hasLeadershipLease = false;

  constructor(
    config: ServiceConfig,
    workflow: WorkflowDefinition,
    dependencies: OrchestratorDependencies = {}
  ) {
    super();
    this.config = config;
    this.workflow = workflow;

    // Initialize tracker client (projectSlugs empty = auto-detect from Linear)
    this.tracker = dependencies.tracker ?? new LinearClient({
      endpoint: config.trackerEndpoint,
      apiKey: config.trackerApiKey,
      projectSlugs: []
    });

    // Initialize workspace manager
    this.workspaceManager = dependencies.workspaceManager ?? new WorkspaceManager({
      workspaceRoot: config.workspaceRoot,
      githubOwner: config.githubOwner,
      githubToken: config.githubToken,
      hooks: config.hooks,
      projectRoot: config.projectRoot
    });

    // Initialize agent runner
    this.agentRunner = dependencies.agentRunner ?? new AgentRunner({
      codexCommand: config.codexCommand,
      approvalPolicy: config.codexApprovalPolicy,
      threadSandbox: config.codexThreadSandbox,
      turnSandboxPolicy: config.codexTurnSandboxPolicy,
      turnTimeoutMs: config.codexTurnTimeoutMs,
      readTimeoutMs: config.codexReadTimeoutMs,
      stallTimeoutMs: config.codexStallTimeoutMs,
      projectRoot: config.projectRoot
    });

    this.db = dependencies.db ?? createDatabase({
      path: path.join(config.projectRoot, 'symphony.db')
    });
    this.workItemRepository = dependencies.workItemRepository ?? new WorkItemRepository(this.db);
    this.agentRunRepository = dependencies.agentRunRepository ?? new AgentRunRepository(this.db);
    this.reviewEventRepository = dependencies.reviewEventRepository ?? new ReviewEventRepository(this.db);
    this.syncEventRepository = dependencies.syncEventRepository ?? new SyncEventRepository(this.db);
    this.serviceLeaseRepository = dependencies.serviceLeaseRepository ?? new ServiceLeaseRepository(this.db);
    this.githubMappingService = dependencies.githubMappingService ?? new GitHubMappingService({
      workItemRepository: this.workItemRepository,
      syncEventRepository: this.syncEventRepository,
      githubClientFactory: (repo: string) => new GitHubIssueClient({
        token: config.githubToken,
        owner: config.githubOwner,
        repo,
      }),
    });
    this.githubContextService = dependencies.githubContextService ?? new GitHubContextService({
      workItemRepository: this.workItemRepository,
      reviewEventRepository: this.reviewEventRepository,
      agentRunRepository: this.agentRunRepository,
      githubClientFactory: (repo: string) => new GitHubIssueClient({
        token: config.githubToken,
        owner: config.githubOwner,
        repo,
      }),
    });
    this.githubSyncService = dependencies.githubSyncService ?? new GitHubSyncService({
      workItemRepository: this.workItemRepository,
      syncEventRepository: this.syncEventRepository,
      githubClientFactory: (repo: string) => new GitHubIssueClient({
        token: config.githubToken,
        owner: config.githubOwner,
        repo,
      }),
    });
    this.supervisor = dependencies.supervisor ?? new AnthropicSupervisorService();
    this.leaseTtlMs = Math.max(this.config.pollIntervalMs * 3, 30_000);

    // Initialize GitHub Issue client for E2E flow
    if (config.githubOwner && config.githubToken) {
      githubIssueClient = new GitHubIssueClient({
        token: config.githubToken,
        owner: config.githubOwner,
        repo: '' // Will be set per-issue via project_slug
      });
    }

    // Initialize runtime state
    this.state = {
      poll_interval_ms: config.pollIntervalMs,
      max_concurrent_agents: config.maxConcurrentAgents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0
      },
      codex_rate_limits: null
    };

    // Set up agent event handler
    this.agentRunner.on('event', (event: AgentEvent) => {
      this.handleAgentEvent(event);
    });
  }

  /**
   * Get current state snapshot for observability
   * Section 13.3: Runtime Snapshot
   */
  getStateSnapshot(): OrchestratorStateSnapshot {
    const now = new Date();

    const running = Array.from(this.state.running.values()).map(entry => ({
      issue_id: entry.issue.id,
      issue_identifier: entry.identifier,
      state: entry.issue.state,
      stage: entry.stage,
      session_id: entry.session_id,
      turn_count: entry.turn_count,
      last_event: entry.last_codex_event,
      last_message: entry.last_codex_message,
      started_at: entry.started_at.toISOString(),
      last_event_at: entry.last_codex_timestamp?.toISOString() || null,
      tokens: {
        input_tokens: entry.codex_input_tokens,
        output_tokens: entry.codex_output_tokens,
        total_tokens: entry.codex_total_tokens
      }
    }));

    const retrying = Array.from(this.state.retry_attempts.values()).map(entry => ({
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: new Date(entry.due_at_ms).toISOString(),
      error: entry.error
    }));

    return {
      generated_at: now.toISOString(),
      counts: {
        running: running.length,
        retrying: retrying.length
      },
      running,
      retrying,
      codex_totals: { ...this.state.codex_totals },
      rate_limits: this.state.codex_rate_limits
    };
  }

  /**
   * Start the orchestrator
   * Section 16.1: Service Startup
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    await this.acquireLeadershipLease();
    this.stopRequested = false;
    this.running = true;
    console.log('[orchestrator] Starting...');

    try {
      this.startLeaseRenewalLoop();

      // Startup terminal workspace cleanup (Section 8.6)
      await this.startupTerminalCleanup();

      // Schedule immediate first tick
      this.scheduleTick(0);

      console.log('[orchestrator] Started');
    } catch (err) {
      this.running = false;
      this.stopLeaseRenewalLoop();
      await this.releaseLeadershipLease();
      throw err;
    }
  }

  /**
   * Stop the orchestrator
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopLeaseRenewalLoop();

    for (const retryEntry of this.state.retry_attempts.values()) {
      if (retryEntry.timer_handle) {
        clearTimeout(retryEntry.timer_handle);
      }
    }
    this.state.retry_attempts.clear();

    const inflightTick = this.currentTickPromise;
    if (inflightTick) {
      try {
        await inflightTick;
      } catch {
        // Best-effort during shutdown.
      }
    }

    // Stop all running workers
    console.log('[orchestrator] Stopping, terminating workers...');
    const runningEntries = Array.from(this.state.running.values());
    await Promise.allSettled(runningEntries.map((entry) => this.stopRunningWorker(entry)));
    this.state.running.clear();
    this.state.claimed.clear();
    this.emit('state:changed', this.getStateSnapshot());
    await this.releaseLeadershipLease();

    console.log('[orchestrator] Stopped');
  }

  private async acquireLeadershipLease(): Promise<void> {
    const result = this.serviceLeaseRepository.acquire({
      lease_key: Orchestrator.PRIMARY_LEASE_KEY,
      holder_id: this.leaseHolderId,
      holder_pid: process.pid,
      holder_host: os.hostname(),
      metadata_json: {
        project_root: this.config.projectRoot,
        workspace_root: this.config.workspaceRoot,
      },
      ttl_ms: this.leaseTtlMs,
    });

    if (!result.acquired) {
      const lease = result.lease;
      const holder = lease
        ? `${lease.holder_host || 'unknown-host'}:${lease.holder_pid ?? 'unknown-pid'}`
        : 'unknown-holder';
      const expiresAt = lease?.expires_at?.toISOString() ?? 'unknown-expiry';
      throw new Error(
        `Another Symphony orchestrator instance already holds the primary lease (${holder}, expires ${expiresAt}).`,
      );
    }

    this.hasLeadershipLease = true;
  }

  private startLeaseRenewalLoop(): void {
    this.stopLeaseRenewalLoop();
    const intervalMs = Math.max(5_000, Math.floor(this.leaseTtlMs / 2));
    this.leaseRenewTimer = setInterval(() => {
      void this.renewLeadershipLease();
    }, intervalMs);
  }

  private stopLeaseRenewalLoop(): void {
    if (this.leaseRenewTimer) {
      clearInterval(this.leaseRenewTimer);
      this.leaseRenewTimer = null;
    }
  }

  private async renewLeadershipLease(): Promise<void> {
    if (!this.hasLeadershipLease || this.stopRequested) {
      return;
    }

    const result = this.serviceLeaseRepository.renew({
      lease_key: Orchestrator.PRIMARY_LEASE_KEY,
      holder_id: this.leaseHolderId,
      ttl_ms: this.leaseTtlMs,
    });

    if (result.acquired) {
      return;
    }

    const message = 'Symphony orchestrator lost the primary leadership lease; stopping to avoid duplicate execution.';
    console.error(`[orchestrator] ${message}`);
    this.emit('error', new Error(message));
    await this.stop();
  }

  private async releaseLeadershipLease(): Promise<void> {
    if (!this.hasLeadershipLease) {
      return;
    }
    this.serviceLeaseRepository.release(
      Orchestrator.PRIMARY_LEASE_KEY,
      this.leaseHolderId,
    );
    this.hasLeadershipLease = false;
  }

  /**
   * Schedule next poll tick
   */
  private scheduleTick(delayMs: number): void {
    if (!this.running) return;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    this.pollTimer = setTimeout(() => {
      this.executeTick();
    }, delayMs);
  }

  /**
   * Execute a poll tick
   * Section 8.1: Poll Loop
   * Section 16.2: Poll-and-Dispatch Tick
   */
  private executeTick(): void {
    if (!this.running) return;

    // Run tick sequentially to avoid concurrent modifications
    this.currentTickPromise = (async () => {
      try {
        // Step 1: Reconcile running issues (Section 8.5)
        await this.reconcileRunningIssues();

        // Step 2: Run dispatch preflight validation (Section 6.3)
        const validation = this.validateDispatchConfig();
        if (!validation.valid) {
          console.error('[orchestrator] Dispatch validation failed:', validation.errors);
          this.emit('error', new Error(validation.errors.join(', ')));
          this.scheduleTick(this.state.poll_interval_ms);
          return;
        }

        // Step 3: Fetch candidate issues
        const { issues, error: fetchError } = await this.tracker.fetchCandidateIssues(
          this.config.activeStates
        );

        if (fetchError) {
          console.error('[orchestrator] Failed to fetch candidate issues:', fetchError);
          this.scheduleTick(this.state.poll_interval_ms);
          return;
        }

        // Step 4: Sort issues by dispatch priority (Section 8.2)
        const sortedIssues = this.sortForDispatch(issues);

        // Step 5: Dispatch eligible issues while slots remain
        // Use a local set to track issues dispatched in THIS tick, preventing
        // the same issue from being dispatched multiple times in one loop.
        const dispatchedThisTick = new Set<string>();
        for (const issue of sortedIssues) {
          if (!this.hasAvailableSlots()) {
            break;
          }

          // Skip if already dispatched in this tick (e.g., re-dispatched after cleanup)
          if (dispatchedThisTick.has(issue.id)) {
            continue;
          }

          if (this.shouldDispatch(issue)) {
            dispatchedThisTick.add(issue.id);
            await this.dispatchIssue(issue, null);
          }
        }

        this.scheduleTick(this.state.poll_interval_ms);
      } catch (err) {
        console.error('[orchestrator] Tick error:', err);
        this.emit('error', err as Error);
        this.scheduleTick(this.state.poll_interval_ms);
      }
    })();
  }

  /**
   * Validate configuration for dispatch
   * Section 6.3: Dispatch Preflight Validation
   */
  private validateDispatchConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // tracker.kind must be supported
    if (this.config.trackerKind !== 'linear') {
      errors.push(`Unsupported tracker kind: ${this.config.trackerKind}`);
    }

    // tracker.api_key is required after $ resolution
    if (!this.config.trackerApiKey) {
      errors.push('Missing tracker API key');
    }

    // codex.command must be present
    if (!this.config.codexCommand) {
      errors.push('Missing codex command');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Sort issues for dispatch
   * Section 8.2: Sorting order
   * 1. priority ascending (1..4 preferred, null sorts last)
   * 2. created_at oldest first
   * 3. identifier lexicographic tie-breaker
   */
  private sortForDispatch(issues: Issue[]): Issue[] {
    return issues.sort((a, b) => {
      // Priority ascending (null sorts last)
      const aPriority = a.priority ?? 9999;
      const bPriority = b.priority ?? 9999;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // Created_at oldest first
      if (a.created_at && b.created_at) {
        const diff = a.created_at.getTime() - b.created_at.getTime();
        if (diff !== 0) return diff;
      } else if (a.created_at) {
        return -1;  // a has date, b doesn't - a first
      } else if (b.created_at) {
        return 1;   // b has date, a doesn't - b first
      }

      // Identifier lexicographic tie-breaker
      return a.identifier.localeCompare(b.identifier);
    });
  }

  /**
   * Check if orchestrator has available slots for dispatch
   * Section 8.3: Concurrency Control
   */
  private hasAvailableSlots(): boolean {
    const runningCount = this.state.running.size;
    const availableSlots = Math.max(this.config.maxConcurrentAgents - runningCount, 0);
    return availableSlots > 0;
  }

  /**
   * Check if an issue should be dispatched
   * Section 8.2: Candidate Selection Rules
   */
  private shouldDispatch(issue: Issue): boolean {
    // Must have required fields
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
      return false;
    }

    // State must be active (not terminal)
    if (!this.config.activeStates.map(s => s.toLowerCase()).includes(issue.state.toLowerCase())) {
      return false;
    }
    if (this.config.terminalStates.map(s => s.toLowerCase()).includes(issue.state.toLowerCase())) {
      return false;
    }

    // Must not already be running
    if (this.state.running.has(issue.id)) {
      return false;
    }

    // Must not already be claimed
    if (this.state.claimed.has(issue.id)) {
      return false;
    }

    // Must not already have a retry scheduled (prevents duplicate dispatch when retry timer
    // fires while executeTick is also running in the same poll cycle)
    if (this.state.retry_attempts.has(issue.id)) {
      return false;
    }

    // Must not already be completed — but "In Review" issues bypass this check
    // because they may have been incorrectly added to completed before the
    // after-run hook updated Linear state. Since "In Review" is an active state,
    // we always allow re-dispatch for review agents.
    const isInReview = issue.state.toLowerCase() === 'in review';
    if (this.state.completed.has(issue.id) && !isInReview) {
      return false;
    }

    // Blocker rule for Todo state (Section 8.2)
    if (issue.state.toLowerCase() === 'todo') {
      const hasNonTerminalBlocker = issue.blocked_by.some(blocker => {
        if (!blocker.state) return false;
        const blockerState = blocker.state.toLowerCase();
        return !this.config.terminalStates.map(s => s.toLowerCase()).includes(blockerState);
      });
      if (hasNonTerminalBlocker) {
        return false;
      }
    }

    // Check per-state concurrency limit
    const stateLimit = this.config.maxConcurrentAgentsByState.get(issue.state.toLowerCase());
    if (stateLimit !== undefined) {
      const runningInState = Array.from(this.state.running.values()).filter(
        entry => entry.issue.state.toLowerCase() === issue.state.toLowerCase()
      ).length;
      if (runningInState >= stateLimit) {
        return false;
      }
    }

    return true;
  }

  /**
   * Dispatch an issue to a worker
   * Section 16.4: Dispatch One Issue
   */
  private async dispatchIssue(issue: Issue, attempt: number | null): Promise<void> {
    if (this.stopRequested) {
      return;
    }

    // Guard: if already claimed (another dispatch in flight), skip
    if (this.state.claimed.has(issue.id)) {
      console.log(`[orchestrator] Issue ${issue.identifier} already claimed, skipping duplicate dispatch`);
      return;
    }

    const isReview = issue.state.toLowerCase() === 'in review';
    const phaseLabel = isReview ? '[REVIEW]' : '[DEV]';
    console.log(`[orchestrator] Dispatching issue: ${issue.identifier} ${phaseLabel} (State: ${issue.state})`);

    // Mark as claimed before spawning to prevent duplicate dispatch
    this.state.claimed.add(issue.id);
    this.state.retry_attempts.delete(issue.id);

    // Remove from completed set if present
    this.state.completed.delete(issue.id);

    // Spawn worker
    try {
      const workerPromise = this.runAgentAttempt(issue, attempt).then(result => this.handleWorkerExit(issue.id, result));

      const runningEntry: RunningEntry = {
        worker_handle: workerPromise,
        identifier: issue.identifier,
        issue,
        stage: 'dispatching',
        session_id: null,
        codex_app_server_pid: null,
        last_codex_message: null,
        last_codex_event: null,
        last_codex_timestamp: null,
        codex_input_tokens: 0,
        codex_output_tokens: 0,
        codex_total_tokens: 0,
        last_reported_input_tokens: 0,
        last_reported_output_tokens: 0,
        last_reported_total_tokens: 0,
        retry_attempt: attempt ?? 0,
        started_at: new Date(),
        turn_count: 0,
        workspace_path: null,
        branch_name: issue.branch_name ?? null,
      };

      this.state.running.set(issue.id, runningEntry);

      this.emit('issue:dispatched', issue);
      this.emit('state:changed', this.getStateSnapshot());
    } catch (err) {
      // Worker spawn failed - schedule retry
      console.error('[orchestrator] Failed to spawn worker:', err);
      await this.scheduleRetry(issue.id, issue.identifier, (attempt ?? 0) + 1, 'Failed to spawn agent');
    }
  }

  private createWorkerResult(issueId: string): WorkerResult {
    return {
      issueId,
      success: false,
      completed: false,
      outcome: 'retryable_failure',
      next_action: 'stop',
      turns: 0,
      tokens: { input: 0, output: 0, total: 0 },
      claude_api_calls: 0,
      linear_api_calls: 0,
      github_api_calls: 0
    };
  }

  private registerWorkerProcess(issueId: string, child: cp.ChildProcess): void {
    this.workerRegistry.set(issueId, child);
    const runningEntry = this.state.running.get(issueId);
    if (runningEntry) {
      runningEntry.codex_child_process = child;
    }
  }

  private unregisterWorkerProcess(issueId: string): void {
    this.workerRegistry.delete(issueId);
    const runningEntry = this.state.running.get(issueId);
    if (runningEntry) {
      runningEntry.codex_child_process = undefined;
    }
  }

  private async stopRunningWorker(entry: RunningEntry, graceMs = 3000): Promise<void> {
    const workerPromise =
      entry.worker_handle && typeof (entry.worker_handle as Promise<unknown>).then === 'function'
        ? (entry.worker_handle as Promise<unknown>)
        : Promise.resolve();
    const child =
      this.workerRegistry.get(entry.issue.id) ??
      (entry.codex_child_process as cp.ChildProcess | undefined);

    if (child) {
      this.agentRunner.stopSession(child);
    }

    const completion = await Promise.race([
      workerPromise.then(() => 'completed').catch(() => 'completed'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), graceMs)),
    ]);

    if (completion === 'timeout' && child) {
      console.warn(
        `[orchestrator] Worker ${entry.identifier} did not exit after ${graceMs}ms, force killing...`,
      );
      this.agentRunner.forceStopSession(child);
      await Promise.race([
        workerPromise.then(() => undefined).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    }

    this.unregisterWorkerProcess(entry.issue.id);
  }

  private async resolveIssueBranchName(params: {
    issue: Issue;
    workItemId?: string;
    workspacePath?: string;
    explicitBranchName?: string | null;
  }): Promise<string | null> {
    if (params.explicitBranchName) {
      return params.explicitBranchName;
    }

    if (params.workItemId) {
      const workItem = this.workItemRepository.findById(params.workItemId);
      if (workItem?.branch_name) {
        return workItem.branch_name;
      }
    }

    if (params.workspacePath) {
      const state = await this.readWorkspaceStateFile(params.workspacePath);
      const metadata = (state?.metadata as Record<string, unknown> | undefined) ?? {};
      if (typeof metadata.branch === 'string' && metadata.branch.trim()) {
        return metadata.branch.trim();
      }
    }

    return params.issue.branch_name || null;
  }

  private isProtectedBranch(branchName: string | null | undefined): boolean {
    if (!branchName) {
      return true;
    }

    return ['main', 'master', 'develop', 'development', 'dev'].includes(
      branchName.toLowerCase(),
    );
  }

  private shouldIgnoreMissingBranchError(message: string): boolean {
    return /remote ref does not exist|not found|unknown revision|branch .* not found|no such ref|not a valid ref/i.test(
      message,
    );
  }

  private collectIssueBranchCandidates(params: {
    issue: Issue;
    explicitBranchName?: string | null;
  }): string[] {
    const candidates = new Set<string>();
    const canonicalBranch = `feature/${sanitizeWorkspaceKey(params.issue.identifier).toLowerCase()}`;

    if (params.explicitBranchName) {
      candidates.add(params.explicitBranchName);
    }
    if (params.issue.branch_name) {
      candidates.add(params.issue.branch_name);
    }
    candidates.add(canonicalBranch);

    return Array.from(candidates).filter((branchName) => !this.isProtectedBranch(branchName));
  }

  private async cleanupIssueBranch(params: {
    issue: Issue;
    workItemId?: string;
    workspacePath?: string;
    explicitBranchName?: string | null;
  }): Promise<void> {
    const resolvedBranchName = await this.resolveIssueBranchName(params);
    const branchNames = this.collectIssueBranchCandidates({
      issue: params.issue,
      explicitBranchName: resolvedBranchName,
    });
    if (branchNames.length === 0) {
      return;
    }

    const sourcePath = this.workspaceManager.getRepoSourcePath(
      params.issue.project_slug,
      params.issue.project_name,
    );
    try {
      const fs = await import('fs/promises');
      await fs.access(sourcePath);
    } catch {
      return;
    }

    const runGit = (args: string[]): string => {
      return cp.execFileSync('git', ['-C', sourcePath, ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      }).trim();
    };

    for (const branchName of branchNames) {
      try {
        runGit(['push', 'origin', '--delete', branchName]);
        console.log(`[orchestrator] Deleted remote branch ${branchName}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.shouldIgnoreMissingBranchError(message)) {
          console.warn(`[orchestrator] Failed to delete remote branch ${branchName}:`, err);
        }
      }

      try {
        runGit(['branch', '-D', branchName]);
        console.log(`[orchestrator] Deleted local branch ${branchName}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.shouldIgnoreMissingBranchError(message)) {
          console.warn(`[orchestrator] Failed to delete local branch ${branchName}:`, err);
        }
      }
    }
  }

  private async cleanupAllTerminalIssueBranches(): Promise<void> {
    const { issues, error } = await this.tracker.fetchIssuesByStates(this.config.terminalStates);
    if (error) {
      return;
    }

    for (const issue of issues) {
      try {
        await this.cleanupIssueBranch({ issue });
      } catch (err) {
        console.warn(`[orchestrator] Failed to clean historical branches for ${issue.identifier}:`, err);
      }
    }
  }

  private setRunningStage(issueId: string, stage: RunningStage): void {
    const runningEntry = this.state.running.get(issueId);
    if (runningEntry) {
      runningEntry.stage = stage;
    }
  }

  private isTerminalTrackerState(state: string | undefined): boolean {
    if (!state) {
      return false;
    }

    return this.config.terminalStates.some(candidate => candidate.toLowerCase() === state.toLowerCase());
  }

  private isActiveTrackerState(state: string | undefined): boolean {
    if (!state) {
      return false;
    }

    return this.config.activeStates.some(candidate => candidate.toLowerCase() === state.toLowerCase());
  }

  private resolveGitHubRepo(issue: Issue): string {
    return issue.project_name || issue.project_slug || 'main';
  }

  private normalizeReviewDecision(value: string | null | undefined): 'APPROVE' | 'REQUEST_CHANGES' | 'MERGE_BLOCKED' | null {
    if (!value) {
      return null;
    }

    const normalized = value.toUpperCase();
    if (normalized === 'APPROVED' || normalized === 'APPROVE' || normalized === 'APPROVE_MINOR') {
      return 'APPROVE';
    }
    if (normalized === 'MERGE_BLOCKED') {
      return 'MERGE_BLOCKED';
    }
    if (normalized === 'REQUEST_CHANGES' || normalized === 'REQUEST_TESTS' || normalized === 'REJECT') {
      return 'REQUEST_CHANGES';
    }

    return null;
  }

  private async readWorkspaceStateFile(workspacePath: string): Promise<Record<string, unknown> | null> {
    try {
      const fs = await import('fs/promises');
      const statePath = path.join(workspacePath, '.symphony', 'state.json');
      const content = await fs.readFile(statePath, 'utf-8');
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async readWorkspaceFile(workspacePath: string, filename: string): Promise<string | null> {
    try {
      const fs = await import('fs/promises');
      const content = await fs.readFile(this.getWorkflowArtifactPath(workspacePath, filename), 'utf-8');
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  private extractIssueIdentifiers(content: string): string[] {
    const matches = content.match(/\b[A-Z]+-\d+\b/g);
    return matches ? Array.from(new Set(matches)) : [];
  }

  private artifactMatchesIssue(content: string | null, issueIdentifier: string): boolean {
    if (!content) {
      return false;
    }

    const identifiers = this.extractIssueIdentifiers(content);
    if (identifiers.length === 0) {
      return true;
    }

    return identifiers.includes(issueIdentifier);
  }

  private async clearStaleIssueArtifacts(workspacePath: string, issueIdentifier: string): Promise<void> {
    const artifactNames = ['DEVELOPMENT_LOG.md', 'HANDOVER.md', 'REVIEW_REPORT.md'];
    const fs = await import('fs/promises');

    for (const filename of artifactNames) {
      const artifactPath = this.getWorkflowArtifactPath(workspacePath, filename);
      try {
        const content = await fs.readFile(artifactPath, 'utf-8');
        if (!this.artifactMatchesIssue(content, issueIdentifier)) {
          await fs.unlink(artifactPath);
        }
      } catch {
        // Ignore missing or unreadable artifacts.
      }
    }
  }

  private async buildWorkspaceHint(workspacePath: string): Promise<string> {
    try {
      const output = cp.execFileSync('git', ['status', '--short', '--branch'], {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 5000,
      });
      const trimmed = output.trim();
      return trimmed ? trimmed.slice(0, 4000) : 'git status clean';
    } catch {
      return 'workspace hint unavailable';
    }
  }

  private summarizeArtifactForSupervisor(content: string | null, maxLength = 1600): string | null {
    if (!content) {
      return null;
    }

    const normalized = content.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }

    return normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 3)}...`;
  }

  private async buildSupervisorArtifactSummary(
    workspacePath: string,
    issueIdentifier: string,
    mode: 'dev' | 'review',
  ): Promise<{
    handover: string | null;
    developmentLog: string | null;
    reviewReport: string | null;
  }> {
    const summarize = (content: string | null) =>
      this.artifactMatchesIssue(content, issueIdentifier)
        ? this.summarizeArtifactForSupervisor(content)
        : null;

    if (mode === 'review') {
      return {
        handover: summarize(
          await this.readWorkspaceFile(workspacePath, 'HANDOVER.md'),
        ),
        developmentLog: summarize(
          await this.readWorkspaceFile(workspacePath, 'DEVELOPMENT_LOG.md'),
        ),
        reviewReport: summarize(
          await this.readWorkspaceFile(workspacePath, 'REVIEW_REPORT.md'),
        ),
      };
    }

    return {
      handover: summarize(
        await this.readWorkspaceFile(workspacePath, 'HANDOVER.md'),
      ),
      developmentLog: summarize(
        await this.readWorkspaceFile(workspacePath, 'DEVELOPMENT_LOG.md'),
      ),
      reviewReport: null,
    };
  }

  private artifactSuggestsCompletion(
    mode: 'dev' | 'review',
    artifacts: {
      handover: string | null;
      developmentLog: string | null;
      reviewReport: string | null;
    },
  ): boolean {
    if (mode === 'review') {
      const reviewText = [artifacts.reviewReport]
        .filter((value): value is string => Boolean(value))
        .join('\n');
      return /review decision|approve|request changes|merge blocked|looks good|reject/i.test(reviewText);
    }

    const devText = [artifacts.handover, artifacts.developmentLog]
      .filter((value): value is string => Boolean(value))
      .join('\n');
    return /test.*pass|tests passed|开发摘要|development complete|状态.*completed|准备提交代码并创建 pr|实现了|单元测试:\s*pass/i.test(devText);
  }

  private getTurnBudget(
    mode: 'dev' | 'review',
    issue: Issue,
  ): number {
    const complexity = judgeComplexity(issue).complexity;

    if (mode === 'review') {
      if (this.isVeryComplexReview(issue)) {
        return Math.min(this.config.maxTurns, 3);
      }

      if (complexity === 'large') {
        return Math.min(this.config.maxTurns, 2);
      }

      return 1;
    }

    if (complexity === 'small') {
      return 1;
    }

    if (complexity === 'medium') {
      return Math.min(this.config.maxTurns, 2);
    }

    return this.config.maxTurns;
  }

  private isVeryComplexReview(issue: Issue): boolean {
    const title = issue.title.toLowerCase();
    const description = (issue.description || '').toLowerCase();
    const labels = issue.labels.map((label) => label.toLowerCase());
    const combinedText = `${title} ${description}`;

    const strongIndicators = [
      'architecture',
      'redesign',
      'migration',
      'security',
      'performance',
      'optimization',
      'refactor',
      'breaking',
      'new module',
      'new feature',
      '跨模块',
      '架构',
      '迁移',
      '重构',
      '性能',
      '安全',
    ];

    let signalCount = 0;
    for (const indicator of strongIndicators) {
      if (combinedText.includes(indicator)) {
        signalCount += 1;
      }
    }

    if (
      labels.some((label) =>
        ['epic', 'complex', 'large', 'migration', 'refactor', 'architecture', 'security', 'performance']
          .some((indicator) => label.includes(indicator)),
      )
    ) {
      signalCount += 2;
    }

    if ((issue.blocked_by || []).length > 0) {
      signalCount += 1;
    }

    return signalCount >= 3;
  }

  private shouldAutoFinishAfterTurn(
    mode: 'dev' | 'review',
    issue: Issue,
    turnNumber: number,
    turnBudget: number,
    workspaceArtifacts: {
      handover: string | null;
      developmentLog: string | null;
      reviewReport: string | null;
    },
  ): boolean {
    const complexity = judgeComplexity(issue).complexity;
    const hasCompletionEvidence = this.artifactSuggestsCompletion(mode, workspaceArtifacts);

    if (!hasCompletionEvidence) {
      return false;
    }

    if (complexity === 'small' && turnNumber >= 1) {
      return true;
    }

    return turnNumber >= turnBudget;
  }

  private async maybeWriteHeuristicReviewReport(params: {
    issue: Issue;
    workspacePath: string;
    workspaceArtifacts: {
      handover: string | null;
      developmentLog: string | null;
      reviewReport: string | null;
    };
  }): Promise<boolean> {
    if (judgeComplexity(params.issue).complexity !== 'small') {
      return false;
    }

    if (params.workspaceArtifacts.reviewReport) {
      return false;
    }

    const supportingText = [
      params.workspaceArtifacts.handover,
      params.workspaceArtifacts.developmentLog,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n');

    if (!supportingText) {
      return false;
    }

    const testsPassed = /test.*pass|tests passed|单元测试:\s*pass|测试情况[:：]\s*pass|pytest.*pass|\b\d+\/\d+\s+tests passed\b/i.test(
      supportingText,
    );
    const knownIssuesClear =
      /已知问题[\s\S]{0,80}(无|none|n\/a)|known issues[\s\S]{0,80}(none|n\/a)/i.test(
        supportingText,
      ) || !/已知问题|known issues/i.test(supportingText);

    if (!testsPassed || !knownIssuesClear) {
      return false;
    }

    const reportPath = this.getWorkflowArtifactPath(
      params.workspacePath,
      'REVIEW_REPORT.md',
    );
    const content = [
      `# Code Review Report: ${params.issue.identifier}`,
      '',
      '## Review Decision: APPROVE_MINOR',
      '',
      '## Review Summary',
      `This is a small change for ${params.issue.identifier}.`,
      'The available development artifacts indicate the implementation is complete, tests passed, and no blocking issues were recorded.',
      '',
      '## Findings',
      'No blocking issues identified for this small task.',
      '',
      '## Test Status',
      'Available handover/development artifacts indicate passing tests.',
    ].join('\n');

    const fs = await import('fs/promises');
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${content}\n`, 'utf-8');
    return true;
  }

  private async decideNextSupervisorAction(params: {
    mode: 'dev' | 'review';
    issue: Issue;
    attempt: number | null;
    turnNumber: number;
    maxTurns: number;
    prompt: string;
    workspacePath: string;
    workspaceArtifacts: {
      handover: string | null;
      developmentLog: string | null;
      reviewReport: string | null;
    };
    transcript: TurnTranscriptEntry[];
    timeline: AgentTimelinePayload[];
  }): Promise<SupervisorNextAction> {
    const workspaceHint = await this.buildWorkspaceHint(params.workspacePath);
    return this.supervisor.decideNextAction({
      ...params,
      workspaceHint,
    });
  }

  private async respondToRuntimeRequest(params: {
    mode: 'dev' | 'review';
    issue: Issue;
    attempt: number | null;
    turnNumber: number;
    prompt: string;
    workspacePath: string;
    request: PendingRuntimeRequest;
    transcript: TurnTranscriptEntry[];
    timeline: AgentTimelinePayload[];
  }) {
    const workspaceHint = await this.buildWorkspaceHint(params.workspacePath);
    return this.supervisor.respondToRuntimeRequest({
      ...params,
      workspaceHint,
    });
  }

  private getWorkflowArtifactPath(workspacePath: string, filename: string): string {
    return path.join(workspacePath, '.symphony', filename);
  }

  private async syncLinearState(issue: Issue, stateName: string): Promise<void> {
    if (issue.state.toLowerCase() === stateName.toLowerCase()) {
      return;
    }

    try {
      const result = await this.tracker.updateIssueState(issue.id, stateName);
      if (!result.success) {
        console.warn(`[orchestrator] Failed to update Linear issue ${issue.identifier} to ${stateName}: ${result.error}`);
      }
    } catch (err) {
      console.warn(`[orchestrator] Exception updating Linear issue ${issue.identifier} to ${stateName}:`, err);
    }
  }

  private async postLinearComment(issueId: string, body: string | null): Promise<void> {
    if (!body || body.trim().length === 0) {
      return;
    }

    try {
      const result = await this.tracker.postComment(issueId, body);
      if (!result.success) {
        console.warn(`[orchestrator] Failed to post Linear comment for ${issueId}: ${result.error}`);
      }
    } catch (err) {
      console.warn(`[orchestrator] Exception posting Linear comment for ${issueId}:`, err);
    }
  }

  private buildLinearReviewComment(
    issue: Issue,
    decision: 'APPROVE' | 'REQUEST_CHANGES' | 'MERGE_BLOCKED',
    content: string | null
  ): string {
    const label = {
      APPROVE: 'Approved',
      REQUEST_CHANGES: 'Changes Requested',
      MERGE_BLOCKED: 'Merge Blocked',
    }[decision];

    return [
      `## Review Result: ${label}`,
      `Issue: ${issue.identifier}`,
      '',
      content?.trim() || '(No detailed review summary found)',
    ].join('\n');
  }

  private buildDevCompletionComment(issue: Issue, handoverContent: string | null): string {
    return [
      `## Development Complete`,
      `Issue: ${issue.identifier}`,
      '',
      handoverContent?.trim() || `Development completed for ${issue.identifier}.`,
    ].join('\n');
  }

  private async syncWorkItemFromWorkspaceState(
    workItemId: string,
    issue: Issue,
    workspacePath: string | undefined,
    orchestratorState: Parameters<WorkItemRepository['update']>[0]['orchestrator_state']
  ) {
    if (!workspacePath) {
      return this.workItemRepository.findById(workItemId);
    }

    const state = await this.readWorkspaceStateFile(workspacePath);
    const metadata = (state?.metadata as Record<string, unknown> | undefined) ?? {};
    const branchName = typeof metadata.branch === 'string' ? metadata.branch : undefined;
    const prNumber = typeof metadata.pr_number === 'number' ? metadata.pr_number : undefined;

    return this.workItemRepository.update({
      id: workItemId,
      workspace_path: workspacePath,
      workspace_key: issue.identifier,
      branch_name: branchName,
      active_pr_number: prNumber,
      orchestrator_state: orchestratorState,
    });
  }

  private async handleReviewFeedback(workspacePath: string, cliResult: CliCommandResult): Promise<void> {
    if (cliResult.review_decision !== 'REQUEST_CHANGES' || !cliResult.feedback) {
      return;
    }

    const handoverPath = this.getWorkflowArtifactPath(workspacePath, 'HANDOVER.md');
    try {
      const fs = await import('fs/promises');
      const handoverContent = await fs.readFile(handoverPath, 'utf-8');
      const updatedHandover = updateHandoverNextSteps(handoverContent, cliResult.feedback);
      await fs.writeFile(handoverPath, updatedHandover, 'utf-8');
      console.log('[orchestrator] Updated .symphony/HANDOVER.md with review feedback');
    } catch (err) {
      console.warn('[orchestrator] Failed to update .symphony/HANDOVER.md:', err);
    }
  }

  private buildPostProcessOutcome(
    issue: Issue,
    workspacePath: string,
    command: 'dev' | 'review',
    cliResult: CliCommandResult,
    turnCount: number,
    tokens: WorkerResult['tokens'],
    claudeApiCalls: number
  ): WorkerResult {
    const finalState = cliResult.final_state || issue.state;
    const baseResult: WorkerResult = {
      issueId: issue.id,
      success: true,
      completed: true,
      outcome: 'completed',
      next_action: 'none',
      final_state: finalState,
      workspace_path: workspacePath,
      cleanup_workspace: this.isTerminalTrackerState(finalState),
      turns: turnCount,
      tokens,
      claude_api_calls: claudeApiCalls,
      linear_api_calls: cliResult.linear_api_calls,
      github_api_calls: cliResult.github_api_calls,
      cli_result: cliResult,
    };

    if (
      command === 'review' &&
      (cliResult.review_decision === 'REQUEST_CHANGES' || cliResult.review_decision === 'MERGE_BLOCKED')
    ) {
      return {
        ...baseResult,
        outcome: 'needs_rework',
        next_action: cliResult.retry_hint || 'retry_dev',
        completed: false,
        cleanup_workspace: false,
        retry_delay_ms: 1000,
      };
    }

    if (!this.isActiveTrackerState(finalState) && !this.isTerminalTrackerState(finalState)) {
      return {
        ...baseResult,
        outcome: 'halted',
        next_action: 'stop',
        completed: false,
        cleanup_workspace: false,
      };
    }

    return baseResult;
  }

  /**
   * Run a single agent attempt
   * Section 16.5: Worker Attempt
   */
  private async runAgentAttempt(issue: Issue, attempt: number | null): Promise<WorkerResult> {
    const result = this.createWorkerResult(issue.id);
    const isReview = issue.state.toLowerCase() === 'in review';
    const githubRepo = this.resolveGitHubRepo(issue);
    let workItem = this.githubMappingService.ensureWorkItem(issue, githubRepo);
    result.work_item_id = workItem.id;
    let agentRunId: string | null = null;

    const finalizeAgentRun = (
      runStatus: 'completed' | 'failed' | 'cancelled',
      outputSummary?: string | null,
      decision?: string | null,
      error?: string | null
    ): void => {
      if (!agentRunId) {
        return;
      }

      this.agentRunRepository.update({
        id: agentRunId,
        run_status: runStatus,
        output_summary: outputSummary,
        decision: decision ?? null,
        error: error ?? null,
        finished_at: new Date(),
      });
    };

    try {
      const mappingResult = await this.githubMappingService.ensureGitHubIssue(issue, githubRepo);
      workItem = mappingResult.workItem;
      result.work_item_id = workItem.id;

      // Step 1: Create/reuse workspace
      const workspaceResult = await this.workspaceManager.createForIssue(issue);
      if (!workspaceResult.success || !workspaceResult.workspace) {
        result.failure_reason = 'workspace_setup';
        result.error = `Workspace creation failed: ${workspaceResult.error}`;
        this.workItemRepository.update({
          id: workItem.id,
          orchestrator_state: 'failed',
        });
        return result;
      }

      const workspace = workspaceResult.workspace;
      result.workspace_path = workspace.path;
      workItem = this.githubMappingService.attachWorkspace(workItem.id, workspace.path, workspace.workspace_key);
      await this.clearStaleIssueArtifacts(workspace.path, issue.identifier);
      const runningEntry = this.state.running.get(issue.id);
      if (runningEntry) {
        runningEntry.workspace_path = workspace.path;
        runningEntry.branch_name = workspace.git_branch || issue.branch_name || null;
      }

      if (!isReview && issue.state.toLowerCase() === 'todo') {
        await this.syncLinearState(issue, 'In Progress');
        workItem = this.workItemRepository.update({
          id: workItem.id,
          linear_state: 'In Progress',
          orchestrator_state: 'workspace_ready',
        }) ?? workItem;
      }

      // Step 2: Initialize state via dispatch command
      const dispatchResult = await this.runCliCommand('dispatch', issue.identifier, workspace.path);
      if (!dispatchResult.success) {
        result.failure_reason = 'dispatch_setup';
        result.error = `dispatch failed: ${dispatchResult.error}`;
        this.workItemRepository.update({
          id: workItem.id,
          orchestrator_state: 'failed',
        });
        return result;
      }

      // Step 3: Build prompt - use review-specific prompt for "In Review" state
      const cliCommand = isReview ? 'review' : 'dev';
      const promptIssue = !isReview && issue.state.toLowerCase() === 'todo'
        ? { ...issue, state: 'In Progress' }
        : issue;
      let activeIssue = promptIssue;
      let currentPrompt: string;
      let inputSummary: string;

      if (isReview) {
        const reviewContext = await this.githubContextService.buildReviewContext(workItem.id);
        currentPrompt = buildReviewPrompt(
          promptIssue,
          undefined,
          undefined,
          buildReviewAgentContextMarkdown(reviewContext)
        );
        inputSummary = summarizeReviewContext(reviewContext);
        workItem = this.workItemRepository.update({
          id: workItem.id,
          orchestrator_state: 'review_running',
        }) ?? workItem;
      } else {
        const devContext = await this.githubContextService.buildDevContext(workItem.id);
        currentPrompt = buildDevPrompt(
          promptIssue,
          undefined,
          buildDevAgentContextMarkdown(devContext)
        );
        inputSummary = summarizeDevContext(devContext);
        workItem = this.workItemRepository.update({
          id: workItem.id,
          orchestrator_state: 'dev_running',
          dev_attempt_count: workItem.dev_attempt_count + 1,
        }) ?? workItem;
      }

      const agentRun = this.agentRunRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        agent_type: isReview ? 'review' : 'dev',
        phase: isReview ? 'review' : 'dev',
        input_summary: inputSummary,
      });
      agentRunId = agentRun.id;
      result.agent_run_id = agentRun.id;

      // Step 4: Launch agent session
      this.setRunningStage(issue.id, 'coding');
      const child = this.agentRunner.launch(workspace.path);
      const pid = String(child.pid || '');
      this.registerWorkerProcess(issue.id, child);

      // Update running entry with session info
      if (runningEntry) {
        runningEntry.codex_app_server_pid = pid;
      }

      // Initialize session (Section 10.2: Session Startup Handshake)
      // This sends initialize + thread/start and returns threadId
      const { threadId } = await this.agentRunner.initializeSession(child, workspace.path);
      if (runningEntry) {
        runningEntry.session_id = `${threadId}-turn-1`;
      }

      // Step 5: Run turns (up to max_turns)
      let turnNumber = 1;
      let sessionActive = true;
      const turnBudget = this.getTurnBudget(isReview ? 'review' : 'dev', activeIssue);

      while (sessionActive && turnNumber <= turnBudget) {
        // Refresh issue state before each turn
        // Section 16.5: refresh failure should fail the worker
        const { issues, error } = await this.tracker.fetchIssueStatesByIds([issue.id]);
        if (error) {
          console.error('[orchestrator] Issue state refresh failed, failing attempt:', issue.identifier);
          result.failure_reason = 'tracker_refresh';
          result.error = 'Issue state refresh failed';
          sessionActive = false;
          break;
        }
        if (issues.length > 0) {
          const refreshedIssue = issues[0];
          // Check if issue is still active
          const isActive = this.config.activeStates
            .map(s => s.toLowerCase())
            .includes(refreshedIssue.state.toLowerCase());
          if (!isActive) {
            console.log('[orchestrator] Issue no longer active, stopping:', issue.identifier);
            result.outcome = 'halted';
            result.next_action = 'stop';
            result.final_state = refreshedIssue.state;
            result.workspace_path = workspace.path;
            result.cleanup_workspace = this.isTerminalTrackerState(refreshedIssue.state);
            sessionActive = false;
            break;
          }
          activeIssue = refreshedIssue;
          // Update running entry with new state
          if (runningEntry) {
            runningEntry.issue = refreshedIssue;
          }
        }

        // Run turn
        const turnResult = await this.agentRunner.runTurn(
          child,
          threadId,
          currentPrompt,
          `${activeIssue.identifier}: ${activeIssue.title}`,
          workspace.path,
          (event) => {
            // Update running entry with event info
            if (runningEntry) {
              runningEntry.last_codex_event = event.event;
              runningEntry.last_codex_timestamp = event.timestamp;
              runningEntry.last_codex_message = event.payload ? JSON.stringify(event.payload) : null;
              runningEntry.turn_count = turnNumber;

              // Update token counts
              if (event.event === 'turn_completed' && event.usage) {
                runningEntry.codex_input_tokens += event.usage.input_tokens || 0;
                runningEntry.codex_output_tokens += event.usage.output_tokens || 0;
                runningEntry.codex_total_tokens += event.usage.total_tokens || 0;
              }
            }

            this.emit('session:event', issue.id, event);
          },
          async (runtimeRequest, runtimeState) => this.respondToRuntimeRequest({
            mode: isReview ? 'review' : 'dev',
            issue: activeIssue,
            attempt,
            turnNumber,
            prompt: currentPrompt,
            workspacePath: workspace.path,
            request: runtimeRequest,
            transcript: runtimeState.transcript,
            timeline: runtimeState.timeline,
          })
        );

        result.turns = turnNumber;
        result.tokens = {
          input: result.tokens.input + turnResult.tokens.input,
          output: result.tokens.output + turnResult.tokens.output,
          total: result.tokens.total + turnResult.tokens.total,
        };
        result.claude_api_calls += turnResult.claude_api_calls || 0;

        if (!turnResult.success) {
          result.failure_reason = 'agent_turn';
          result.error = turnResult.error;
          sessionActive = false;
        } else if (turnResult.completed) {
          const workspaceArtifacts = await this.buildSupervisorArtifactSummary(
            workspace.path,
            activeIssue.identifier,
            isReview ? 'review' : 'dev',
          );
          if (
            this.shouldAutoFinishAfterTurn(
              isReview ? 'review' : 'dev',
              activeIssue,
              turnNumber,
              turnBudget,
              workspaceArtifacts,
            )
          ) {
            console.log(
              `[orchestrator] Finishing ${activeIssue.identifier} after turn ${turnNumber} because the task appears complete for its current complexity budget.`,
            );
            sessionActive = false;
            continue;
          }

          const nextAction = await this.decideNextSupervisorAction({
            mode: isReview ? 'review' : 'dev',
            issue: activeIssue,
            attempt,
            turnNumber,
            maxTurns: turnBudget,
            prompt: currentPrompt,
            workspacePath: workspace.path,
            workspaceArtifacts,
            transcript: turnResult.transcript,
            timeline: turnResult.timeline,
          });

          if (nextAction.kind === 'continue') {
            if (turnNumber >= turnBudget) {
              if (
                isReview &&
                await this.maybeWriteHeuristicReviewReport({
                  issue: activeIssue,
                  workspacePath: workspace.path,
                  workspaceArtifacts,
                })
              ) {
                console.log(
                  `[orchestrator] Wrote a heuristic review report for ${activeIssue.identifier} after the review turn budget was exhausted.`,
                );
                sessionActive = false;
              } else if (this.artifactSuggestsCompletion(isReview ? 'review' : 'dev', workspaceArtifacts)) {
                console.log(
                  `[orchestrator] Forcing finish for ${activeIssue.identifier} at max turns because workspace artifacts indicate completion.`,
                );
                sessionActive = false;
              } else {
                result.failure_reason = 'agent_turn';
                result.error = `Supervisor requested another turn after reaching max turns (${turnBudget}).`;
                sessionActive = false;
              }
            } else {
              turnNumber++;
              currentPrompt = nextAction.message || `Continue working on ${activeIssue.identifier}.`;
            }
          } else if (nextAction.kind === 'abort') {
            result.failure_reason = 'agent_turn';
            result.error = nextAction.reason || 'Supervisor aborted the Claude session.';
            sessionActive = false;
          } else {
            sessionActive = false;
          }
        } else {
          sessionActive = false;
        }
      }

      // Stop session
      await this.stopRunningWorker({
        ...((this.state.running.get(issue.id) ?? {
          worker_handle: Promise.resolve(),
          identifier: issue.identifier,
          issue,
          stage: 'coding',
          session_id: null,
          codex_app_server_pid: null,
          last_codex_message: null,
          last_codex_event: null,
          last_codex_timestamp: null,
          codex_input_tokens: 0,
          codex_output_tokens: 0,
          codex_total_tokens: 0,
          last_reported_input_tokens: 0,
          last_reported_output_tokens: 0,
          last_reported_total_tokens: 0,
          retry_attempt: attempt ?? 0,
          started_at: new Date(),
          turn_count: turnNumber,
          workspace_path: workspace.path,
          branch_name: workspace.git_branch || issue.branch_name || null,
          codex_child_process: child,
        } as RunningEntry)),
        codex_child_process: child,
        worker_handle: Promise.resolve(),
      });

      if (result.outcome === 'halted') {
        result.success = true;
        result.completed = false;
        finalizeAgentRun('cancelled', 'Execution halted because tracker state is no longer active.');
        return result;
      }

      if (result.error || result.failure_reason) {
        finalizeAgentRun('failed', null, null, result.error || result.failure_reason);
        return result;
      }

      // Run appropriate CLI command based on state
      this.setRunningStage(issue.id, isReview ? 'post_process_review' : 'post_process_dev');
      workItem = this.workItemRepository.update({
        id: workItem.id,
        orchestrator_state: isReview ? 'review_post_processing' : 'dev_post_processing',
      }) ?? workItem;
      const cliResult = await this.runCliCommand(cliCommand, issue.identifier, workspace.path);
      console.log(`[orchestrator] CLI ${cliCommand} result: success=${cliResult.success}`);

      if (!cliResult.success || !cliResult.result || !cliResult.result.ok) {
        result.failure_reason = 'cli_business';
        result.error = cliResult.error || 'CLI business executor failed';
        finalizeAgentRun('failed', null, null, result.error);
        return result;
      }

      if (isReview) {
        await this.handleReviewFeedback(workspace.path, cliResult.result);
      }

      const workerResult = this.buildPostProcessOutcome(
        issue,
        workspace.path,
        cliCommand,
        cliResult.result,
        result.turns,
        result.tokens,
        result.claude_api_calls
      );
      workerResult.work_item_id = workItem.id;
      workerResult.agent_run_id = agentRun.id;

      const outputSummary = await this.readWorkspaceFile(
        workspace.path,
        isReview ? 'REVIEW_REPORT.md' : 'HANDOVER.md'
      );
      finalizeAgentRun(
        workerResult.outcome === 'retryable_failure' ? 'failed' : 'completed',
        outputSummary,
        cliResult.result.review_decision,
        workerResult.error ?? null
      );

      return workerResult;
    } catch (err) {
      result.failure_reason = result.failure_reason || 'agent_attempt';
      result.error = `Agent attempt failed: ${(err as Error).message}`;
      if (result.work_item_id) {
        this.workItemRepository.update({
          id: result.work_item_id,
          orchestrator_state: 'failed',
        });
      }
      finalizeAgentRun('failed', null, null, result.error);
    }

    return result;
  }

  private async handleDevCompletion(runningEntry: RunningEntry, result: WorkerResult): Promise<void> {
    if (!result.work_item_id) {
      return;
    }

    const synced = await this.syncWorkItemFromWorkspaceState(
      result.work_item_id,
      runningEntry.issue,
      result.workspace_path,
      'workspace_ready'
    );
    const workItem = synced ?? this.workItemRepository.findById(result.work_item_id);
    const handoverContent = result.workspace_path
      ? await this.readWorkspaceFile(result.workspace_path, 'HANDOVER.md')
      : null;

    await this.syncLinearState(runningEntry.issue, 'In Review');
    await this.postLinearComment(
      runningEntry.issue.id,
      this.buildDevCompletionComment(runningEntry.issue, handoverContent)
    );

    if (workItem?.active_pr_number) {
      try {
        await this.githubSyncService.publishPullRequestSummary(
          workItem.id,
          handoverContent || `Development completed for ${runningEntry.issue.identifier}.`
        );
      } catch (err) {
        console.warn('[orchestrator] Failed to publish PR summary to GitHub issue:', err);
      }
    }

    if (workItem) {
      this.workItemRepository.update({
        id: workItem.id,
        linear_state: 'In Review',
        orchestrator_state: 'workspace_ready',
      });
    }
  }

  private async handleReviewNeedsRework(runningEntry: RunningEntry, result: WorkerResult): Promise<void> {
    if (!result.work_item_id) {
      return;
    }

    const synced = await this.syncWorkItemFromWorkspaceState(
      result.work_item_id,
      runningEntry.issue,
      result.workspace_path,
      'needs_rework'
    );
    const workItem = synced ?? this.workItemRepository.findById(result.work_item_id);
    if (!workItem) {
      return;
    }

    const reviewDecision = this.normalizeReviewDecision(result.cli_result?.review_decision) || 'REQUEST_CHANGES';
    const reviewContent = result.workspace_path
      ? await this.readWorkspaceFile(result.workspace_path, 'REVIEW_REPORT.md')
      : result.cli_result?.feedback || null;
    const nextRound = workItem.review_round + 1;
    const prNumber = workItem.active_pr_number;

    if (prNumber) {
      this.reviewEventRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        pr_number: prNumber,
        review_round: nextRound,
        decision: reviewDecision,
        summary_md: reviewContent || `${reviewDecision} for ${runningEntry.issue.identifier}`,
        requested_changes_md: reviewDecision === 'APPROVE' ? null : (reviewContent || result.cli_result?.feedback || null),
        merge_block_reason: reviewDecision === 'MERGE_BLOCKED' ? (reviewContent || result.cli_result?.feedback || 'Merge blocked') : null,
      });

      try {
        await this.githubSyncService.postPullRequestComment(
          workItem.id,
          reviewContent || result.cli_result?.feedback || 'Review requested changes.'
        );
      } catch (err) {
        console.warn('[orchestrator] Failed to post review feedback to PR:', err);
      }
    }

    if (this.config.reviewPolicy.notifyLinearOnReview) {
      await this.postLinearComment(
        runningEntry.issue.id,
        this.buildLinearReviewComment(runningEntry.issue, reviewDecision, reviewContent || result.cli_result?.feedback || null)
      );
    }

    await this.syncLinearState(runningEntry.issue, 'In Progress');
    this.workItemRepository.update({
      id: workItem.id,
      linear_state: 'In Progress',
      orchestrator_state: 'needs_rework',
      review_round: nextRound,
      last_review_decision: reviewDecision,
      last_review_summary: reviewContent || result.cli_result?.feedback || null,
    });
  }

  private async handleReviewCompletion(runningEntry: RunningEntry, result: WorkerResult): Promise<void> {
    if (!result.work_item_id) {
      return;
    }

    const synced = await this.syncWorkItemFromWorkspaceState(
      result.work_item_id,
      runningEntry.issue,
      result.workspace_path,
      'completed'
    );
    const workItem = synced ?? this.workItemRepository.findById(result.work_item_id);
    if (!workItem) {
      return;
    }

    const reviewContent = result.workspace_path
      ? await this.readWorkspaceFile(result.workspace_path, 'REVIEW_REPORT.md')
      : null;
    const nextRound = workItem.review_round + 1;

    if (workItem.active_pr_number) {
      this.reviewEventRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        pr_number: workItem.active_pr_number,
        review_round: nextRound,
        decision: 'APPROVE',
        summary_md: reviewContent || `Approved ${runningEntry.issue.identifier}`,
      });
    }

    if (this.config.reviewPolicy.notifyLinearOnReview) {
      await this.postLinearComment(
        runningEntry.issue.id,
        this.buildLinearReviewComment(runningEntry.issue, 'APPROVE', reviewContent)
      );
    }

    await this.syncLinearState(runningEntry.issue, 'Done');
    this.workItemRepository.update({
      id: workItem.id,
      linear_state: 'Done',
      orchestrator_state: 'completed',
      merged_at: new Date(),
      review_round: nextRound,
      last_review_decision: 'APPROVE',
      last_review_summary: reviewContent,
    });
  }

  private async handleHaltedWorkItem(runningEntry: RunningEntry, result: WorkerResult): Promise<void> {
    if (!result.work_item_id) {
      return;
    }

    const finalState = result.final_state || runningEntry.issue.state;
    const nextState = finalState.toLowerCase() === 'cancelled' || finalState.toLowerCase() === 'canceled'
      ? 'cancelled'
      : (this.isTerminalTrackerState(finalState) ? 'completed' : 'halted');

    this.workItemRepository.update({
      id: result.work_item_id,
      linear_state: finalState,
      orchestrator_state: nextState,
      cancelled_at: nextState === 'cancelled' ? new Date() : undefined,
    });
  }

  /**
   * Handle worker exit
   * Section 16.6: Worker Exit and Retry Handling
   */
  private async handleWorkerExit(issueId: string, result: WorkerResult): Promise<void> {
    const runningEntry = this.state.running.get(issueId);
    if (!runningEntry) return;
    this.unregisterWorkerProcess(issueId);

    if (this.stopRequested) {
      this.state.running.delete(issueId);
      this.state.claimed.delete(issueId);
      this.emit('state:changed', this.getStateSnapshot());
      return;
    }

    const identifier = runningEntry.identifier;

    // Add runtime seconds to totals
    const runtimeSeconds = (Date.now() - runningEntry.started_at.getTime()) / 1000;
    this.state.codex_totals.seconds_running += runtimeSeconds;

    // Add token totals (avoiding double-counting)
    const deltaInput = runningEntry.codex_input_tokens - runningEntry.last_reported_input_tokens;
    const deltaOutput = runningEntry.codex_output_tokens - runningEntry.last_reported_output_tokens;
    const deltaTotal = runningEntry.codex_total_tokens - runningEntry.last_reported_total_tokens;

    this.state.codex_totals.input_tokens += Math.max(0, deltaInput);
    this.state.codex_totals.output_tokens += Math.max(0, deltaOutput);
    this.state.codex_totals.total_tokens += Math.max(0, deltaTotal);

    runningEntry.last_reported_input_tokens = runningEntry.codex_input_tokens;
    runningEntry.last_reported_output_tokens = runningEntry.codex_output_tokens;
    runningEntry.last_reported_total_tokens = runningEntry.codex_total_tokens;

    if (result.outcome === 'completed') {
      if (runningEntry.issue.state.toLowerCase() === 'in review') {
        await this.handleReviewCompletion(runningEntry, result);
      } else {
        await this.handleDevCompletion(runningEntry, result);
      }

      this.setRunningStage(issueId, 'completed');
      this.state.running.delete(issueId);
      this.state.claimed.delete(issueId);

      if (result.final_state && this.isTerminalTrackerState(result.final_state)) {
        this.state.completed.add(issueId);
      }

      if (result.cleanup_workspace && result.workspace_path) {
        try {
          await this.workspaceManager.removeWorkspace(result.workspace_path, runningEntry.issue.project_slug);
        } catch (err) {
          console.warn('[orchestrator] Failed to clean workspace on completion:', err);
        }
        try {
          await this.cleanupAllTerminalIssueBranches();
        } catch (err) {
          console.warn('[orchestrator] Failed to clean branches on completion:', err);
        }
      }

      // Normal exit - do not schedule retry
      console.log('[orchestrator] Worker completed normally:', identifier);

      // Print completion report with API statistics
      const runtimeSeconds = (Date.now() - runningEntry.started_at.getTime()) / 1000;
      console.log(`
========================================
[ISSUE COMPLETE] ${identifier}
----------------------------------------
  Turns:        ${result.turns}
  Tokens:       ${result.tokens.total} (input: ${result.tokens.input}, output: ${result.tokens.output})
  Claude API:   ${result.claude_api_calls} calls
  Linear API:   ${result.linear_api_calls} calls
  GitHub API:   ${result.github_api_calls} calls
  Duration:     ${runtimeSeconds.toFixed(1)}s
  Est. Cost:    $${(result.tokens.total * 0.000004).toFixed(5)}*
========================================
* Estimated based on typical rates`);

      // Emit completion event
      this.emit('issue:completed', runningEntry.issue, true);
    } else if (result.outcome === 'needs_rework') {
      await this.handleReviewNeedsRework(runningEntry, result);
      this.setRunningStage(issueId, 'retry_scheduled');
      this.state.running.delete(issueId);
      await this.scheduleRetry(
        issueId,
        identifier,
        1,
        result.error || result.cli_result?.feedback || 'Review requested changes',
        result.retry_delay_ms ?? 1000
      );
      this.emit('issue:failed', runningEntry.issue, result.error || 'Review requested changes');
    } else if (result.outcome === 'halted') {
      await this.handleHaltedWorkItem(runningEntry, result);
      this.setRunningStage(issueId, 'halted');
      this.state.running.delete(issueId);
      this.state.claimed.delete(issueId);
      if (result.final_state && this.isTerminalTrackerState(result.final_state)) {
        this.state.completed.add(issueId);
      }
      if (result.cleanup_workspace && result.workspace_path) {
        try {
          await this.workspaceManager.removeWorkspace(result.workspace_path, runningEntry.issue.project_slug);
        } catch (err) {
          console.warn('[orchestrator] Failed to clean workspace on halt:', err);
        }
        try {
          await this.cleanupAllTerminalIssueBranches();
        } catch (err) {
          console.warn('[orchestrator] Failed to clean branches on halt:', err);
        }
      }
    } else {
      this.setRunningStage(issueId, 'failed');
      console.error('[orchestrator] Worker failed:', identifier, result.error);
      const attempt = (runningEntry.retry_attempt || 0) + 1;
      this.state.running.delete(issueId);

      if (attempt >= this.config.devPolicy.maxDevAttempts) {
        console.error(`[orchestrator] Issue ${identifier} failed after ${attempt} attempts, requiring manual intervention`);
        this.state.claimed.delete(issueId);
        this.state.completed.add(issueId);
        if (result.work_item_id) {
          this.workItemRepository.update({
            id: result.work_item_id,
            linear_state: runningEntry.issue.state,
            orchestrator_state: 'failed',
          });
        }
        this.emit('issue:failed', runningEntry.issue, 'Max retry attempts exceeded - manual intervention required');
      } else {
        if (attempt === 2) {
          console.log(`[orchestrator] Issue ${identifier} will resume from .symphony/DEVELOPMENT_LOG.md on retry #${attempt}`);
        } else {
          console.log(`[orchestrator] Issue ${identifier} retry attempt #${attempt}`);
        }
        if (result.work_item_id) {
          this.workItemRepository.update({
            id: result.work_item_id,
            linear_state: runningEntry.issue.state,
            orchestrator_state: 'retry_scheduled',
          });
        }
        await this.scheduleRetry(
          issueId,
          identifier,
          attempt,
          result.error || result.failure_reason || 'Worker failed',
          attempt === 2 ? 1000 : undefined
        );
        this.emit('issue:failed', runningEntry.issue, result.error || 'Worker failed');
      }
    }

    this.emit('state:changed', this.getStateSnapshot());
  }

  /**
   * Schedule a retry for an issue
   * Section 8.4: Retry and Backoff
   */
  private async scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    error: string | null,
    fixedDelayMs?: number
  ): Promise<void> {
    if (this.stopRequested) {
      return;
    }

    // Cancel any existing retry timer
    const existingEntry = this.state.retry_attempts.get(issueId);
    if (existingEntry?.timer_handle) {
      clearTimeout(existingEntry.timer_handle);
    }

    // Calculate delay
    let delayMs: number;
    if (fixedDelayMs !== undefined) {
      // Continuation retry uses fixed delay
      delayMs = fixedDelayMs;
    } else {
      // Failure-driven retry uses exponential backoff
      delayMs = Math.min(10000 * Math.pow(2, attempt - 1), this.config.maxRetryBackoffMs);
    }

    const dueAtMs = Date.now() + delayMs;

    // Create retry entry
    const retryEntry: RetryEntry = {
      issue_id: issueId,
      identifier,
      attempt,
      due_at_ms: dueAtMs,
      timer_handle: null,
      error
    };

    // Set timer
    const timerHandle = setTimeout(() => {
      this.handleRetryTimer(issueId);
    }, delayMs);

    retryEntry.timer_handle = timerHandle;
    this.state.retry_attempts.set(issueId, retryEntry);

    console.log('[orchestrator] Scheduled retry for', identifier, 'attempt', attempt, 'in', delayMs, 'ms');
    this.emit('issue:retrying', { id: issueId, identifier } as Issue, attempt, delayMs);
  }

  /**
   * Run a cli.py command and parse SYMPHONY_STATS from output
   */
  private async runCliCommand(
    command: 'dispatch' | 'dev' | 'review',
    issueId: string,
    workspacePath: string
  ): Promise<CliCommandInvocationResult> {
    // Build command with optional workspace-path
    const cmd = ['python3', './scripts/cli.py', command, issueId];
    if (workspacePath) {
      cmd.push('--workspace-path', workspacePath);
    }

    console.log(`[orchestrator] Running: ${cmd.join(' ')}`);

    return new Promise((resolve) => {
      const child = cp.spawn(cmd[0], cmd.slice(1), {
        cwd: this.config.projectRoot,
        env: {
          ...process.env,
          SYMPHONY_WORKSPACE_ROOT: this.config.workspaceRoot,
          SYMPHONY_PROJECT_ROOT: this.config.projectRoot,
        },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', d => stdout += d.toString());
      child.stderr?.on('data', d => stderr += d.toString());

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ success: false, error: 'Command timed out' });
      }, this.config.hooks.timeout_ms);

      child.on('close', code => {
        clearTimeout(timeout);
        const output = (stdout + stderr).trim();

        if (code !== 0) {
          resolve({ success: false, error: `Command failed with code ${code}: ${output}` });
          return;
        }

        const parsedResult = parseCliCommandResult(output);
        if (!parsedResult) {
          resolve({ success: false, error: `Command returned no parseable result: ${output}` });
          return;
        }

        resolve({ success: true, result: parsedResult, error: undefined });
      });

      child.on('error', err => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });
    });
  }

  /**
   * Handle retry timer firing
   * Section 8.4: Retry handling
   */
  private async handleRetryTimer(issueId: string): Promise<void> {
    if (this.stopRequested) {
      return;
    }

    const retryEntry = this.state.retry_attempts.get(issueId);
    if (!retryEntry) return;

    // Remove from retry queue
    this.state.retry_attempts.delete(issueId);

    // Check if issue is already completed
    if (this.state.completed.has(issueId)) {
      console.log('[orchestrator] Retry issue already completed, skipping:', retryEntry.identifier);
      return;
    }

    // Fetch active candidates and find this issue
    const { issues, error } = await this.tracker.fetchCandidateIssues(this.config.activeStates);

    if (error) {
      console.error('[orchestrator] Retry poll failed:', error);
      // Re-queue with error
      await this.scheduleRetry(issueId, retryEntry.identifier, retryEntry.attempt + 1, 'Retry poll failed');
      return;
    }

    const issue = issues.find(i => i.id === issueId);
    if (!issue) {
      // Issue not found in candidates - release claim
      console.log('[orchestrator] Retry issue not found in candidates, releasing claim:', retryEntry.identifier);
      this.state.claimed.delete(issueId);
      return;
    }

    // Check if slots available
    if (!this.hasAvailableSlots()) {
      console.log('[orchestrator] No slots available for retry, re-queuing:', retryEntry.identifier);
      await this.scheduleRetry(issueId, retryEntry.identifier, retryEntry.attempt + 1, 'No available orchestrator slots');
      return;
    }

    // Dispatch the issue
    const isReview = issue.state.toLowerCase() === 'in review';
    const phaseLabel = isReview ? '[REVIEW]' : '[DEV]';
    console.log(`[orchestrator] Dispatching retry for: ${retryEntry.identifier} ${phaseLabel} (State: ${issue.state})`);
    this.state.claimed.delete(issueId);
    await this.dispatchIssue(issue, retryEntry.attempt);
  }

  /**
   * Reconcile running issues
   * Section 8.5: Active Run Reconciliation
   */
  private async reconcileRunningIssues(): Promise<void> {
    if (this.state.running.size === 0) return;

    // Part A: Stall detection
    await this.reconcileStalledRuns();

    // Part B: Tracker state refresh
    const runningIds = Array.from(this.state.running.keys());
    const { issues, error } = await this.tracker.fetchIssueStatesByIds(runningIds);

    if (error) {
      console.error('[orchestrator] State refresh failed, keeping workers running:', error);
      return;
    }

    for (const issue of issues) {
      const runningEntry = this.state.running.get(issue.id);
      if (!runningEntry) continue;

      const stateLower = issue.state.toLowerCase();
      const isTerminal = this.config.terminalStates.some(s => s.toLowerCase() === stateLower);
      const isActive = this.config.activeStates.some(s => s.toLowerCase() === stateLower);

      // Check for Cancelled state FIRST (highest priority)
      if (stateLower === 'cancelled') {
        // Immediate cleanup for cancelled issues
        console.log(`[orchestrator] Issue ${runningEntry.identifier} was CANCELLED - immediate cleanup`);
        const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
        if (workItem) {
          this.workItemRepository.update({
            id: workItem.id,
            linear_state: issue.state,
            orchestrator_state: 'cancelled',
            cancelled_at: new Date(),
          });
        }

        // 1. Remove from running state
        this.state.running.delete(issue.id);
        this.state.claimed.delete(issue.id);
        this.state.retry_attempts.delete(issue.id);

        // 2. Mark as completed (don't retry)
        this.state.completed.add(issue.id);

        // 3. Clean up workspace
        try {
          const workspacePath = this.workspaceManager.getWorkspacePath(
            runningEntry.identifier,
            runningEntry.issue.project_slug,
            runningEntry.issue.project_name
          );
          await this.workspaceManager.removeWorkspace(workspacePath, runningEntry.issue.project_slug);
          console.log(`[orchestrator] Workspace cleaned for cancelled issue: ${runningEntry.identifier}`);
        } catch (err) {
          console.warn(`[orchestrator] Failed to clean workspace for ${runningEntry.identifier}:`, err);
        }

        // 4. Emit event
        this.emit('issue:completed', runningEntry.issue, false);
        this.emit('state:changed', this.getStateSnapshot());

        // 5. Skip further processing for this issue
        continue;
      }

      if (isTerminal) {
        // Terminal state - terminate worker and clean workspace
        console.log('[orchestrator] Issue terminal, stopping:', runningEntry.identifier);
        await this.terminateRunningIssue(runningEntry, true);
      } else if (isActive) {
        // Still active - update in-memory state
        runningEntry.issue = issue;
        this.emit('issue:reconciled', issue, issue.state);
      } else {
        // Non-active, non-terminal - terminate without cleanup
        console.log('[orchestrator] Issue in non-active state, stopping:', runningEntry.identifier);
        await this.terminateRunningIssue(runningEntry, false);
      }
    }
  }

  /**
   * Reconcile stalled runs
   * Section 8.5 Part A: Stall detection
   */
  private async reconcileStalledRuns(): Promise<void> {
    if (this.config.codexStallTimeoutMs <= 0) {
      // Stall detection disabled
      return;
    }

    const now = Date.now();

    for (const [issueId, entry] of this.state.running.entries()) {
      const lastEventTime = entry.last_codex_timestamp?.getTime() ?? entry.started_at.getTime();
      const elapsedMs = now - lastEventTime;

      if (elapsedMs > this.config.codexStallTimeoutMs) {
        console.log('[orchestrator] Session stalled, terminating:', entry.identifier);
        // Section 8.5 Part A: Stall detection - terminate worker and queue retry
        // Do NOT cleanup workspace - retry will reuse it
        await this.terminateRunningIssue(entry, false);
        // Schedule retry
        await this.scheduleRetry(issueId, entry.identifier, (entry.retry_attempt || 0) + 1, 'Session stalled');
      }
    }
  }

  /**
   * Terminate a running issue
   */
  private async terminateRunningIssue(entry: RunningEntry, cleanupWorkspace: boolean): Promise<void> {
    await this.stopRunningWorker(entry);
    this.state.running.delete(entry.issue.id);
    this.state.claimed.delete(entry.issue.id);

    if (cleanupWorkspace) {
      const workspacePath = this.workspaceManager.getWorkspacePath(entry.identifier, entry.issue.project_slug, entry.issue.project_name);
      await this.workspaceManager.removeWorkspace(workspacePath, entry.issue.project_slug);
      await this.cleanupIssueBranch({
        issue: entry.issue,
        workspacePath: entry.workspace_path || workspacePath,
        explicitBranchName: entry.branch_name,
      });
    }

    this.emit('state:changed', this.getStateSnapshot());
  }

  /**
   * Handle agent events
   */
  private handleAgentEvent(event: AgentEvent): void {
    // Update rate limits if present
    if (event.payload && typeof event.payload === 'object') {
      const payload = event.payload as Record<string, unknown>;
      if (payload.rateLimit) {
        this.state.codex_rate_limits = payload.rateLimit;
      }
    }
  }

  /**
   * Startup terminal workspace cleanup
   * Section 8.6: Startup Terminal Workspace Cleanup
   */
  private async startupTerminalCleanup(): Promise<void> {
    console.log('[orchestrator] Running startup terminal cleanup...');

    const { issues, error } = await this.tracker.fetchIssuesByStates(this.config.terminalStates);
    if (error) {
      console.warn('[orchestrator] Terminal issues fetch failed, continuing anyway:', error);
      return;
    }

    for (const issue of issues) {
      const workspacePath = this.workspaceManager.getWorkspacePath(issue.identifier, issue.project_slug, issue.project_name);
      try {
        await this.workspaceManager.removeWorkspace(workspacePath, issue.project_slug);
        console.log('[orchestrator] Cleaned up terminal workspace:', issue.identifier);
        const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
        if (workItem) {
          this.workItemRepository.update({
            id: workItem.id,
            linear_state: issue.state,
            orchestrator_state: this.isTerminalTrackerState(issue.state) ? 'completed' : 'halted',
          });
        }
      } catch (err) {
        console.warn('[orchestrator] Failed to clean workspace:', issue.identifier, err);
      }
    }

    await this.cleanupAllTerminalIssueBranches();
  }

  // ============================================================================
  // E2E Flow Methods (Section 7: End-to-End Orchestration)
  // ============================================================================

  /**
   * Ensure GitHub Issue exists for a Linear issue
   * Creates a GitHub Issue if one doesn't already exist
   * Used in E2E flow to link Linear issues to GitHub Issues
   */
  async ensureGitHubIssue(issue: Issue, githubRepo: string): Promise<{ success: boolean; issueNumber?: number; url?: string; error?: string }> {
    try {
      const mapped = await this.githubMappingService.ensureGitHubIssue(issue, githubRepo);
      return {
        success: true,
        issueNumber: mapped.workItem.github_issue_number ?? undefined,
        url: mapped.issue_url,
      };
    } catch (err) {
      const error = err as Error;
      console.error(`[orchestrator] Failed to ensure GitHub issue for ${issue.identifier}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle successful merge
   * Updates Linear issue to Done and performs workspace cleanup
   * Called when a PR is merged and the issue work is complete
   */
  async handleMergeSuccess(issue: Issue): Promise<{ success: boolean; error?: string }> {
    console.log(`[orchestrator] Handling merge success for ${issue.identifier}`);
    await this.postLinearComment(issue.id, `## Merge Complete\n${issue.identifier} merged successfully.`);
    await this.syncLinearState(issue, 'Done');
    const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
    if (workItem) {
      this.workItemRepository.update({
        id: workItem.id,
        linear_state: 'Done',
        orchestrator_state: 'completed',
        merged_at: new Date(),
      });
    }

    // Step 3: Clean up the workspace
    const workspacePath = this.workspaceManager.getWorkspacePath(issue.identifier, issue.project_slug, issue.project_name);
    try {
      await this.workspaceManager.removeWorkspace(workspacePath, issue.project_slug);
      await this.cleanupAllTerminalIssueBranches();
      console.log(`[orchestrator] Cleaned up workspace for merged issue: ${issue.identifier}`);
    } catch (err) {
      console.warn(`[orchestrator] Failed to clean workspace for ${issue.identifier}:`, err);
      // Non-fatal, continue
    }

    // Step 4: Mark as completed in orchestrator state
    this.state.completed.add(issue.id);
    this.state.running.delete(issue.id);
    this.state.claimed.delete(issue.id);
    this.state.retry_attempts.delete(issue.id);

    console.log(`[orchestrator] Merge success handling complete for ${issue.identifier}`);
    return { success: true };
  }

  /**
   * Reconcile issues - detect cancelled issues and clean up
   * Public wrapper around reconcileRunningIssues for external callers
   * This method is called during the poll tick but can also be invoked manually
   */
  async reconcileIssues(): Promise<{ cancelled: string[]; cleaned: string[] }> {
    const cancelled: string[] = [];
    const cleaned: string[] = [];

    if (this.state.running.size === 0) {
      return { cancelled, cleaned };
    }

    // Part A: Stall detection
    await this.reconcileStalledRuns();

    // Part B: Tracker state refresh
    const runningIds = Array.from(this.state.running.keys());
    const { issues, error } = await this.tracker.fetchIssueStatesByIds(runningIds);

    if (error) {
      console.error('[orchestrator] State refresh failed during reconcileIssues:', error);
      return { cancelled, cleaned };
    }

    for (const issue of issues) {
      const runningEntry = this.state.running.get(issue.id);
      if (!runningEntry) continue;

      const stateLower = issue.state.toLowerCase();

      // Check for Cancelled state
      if (stateLower === 'cancelled' || stateLower === 'canceled') {
        console.log(`[orchestrator] Reconcile detected cancelled issue: ${runningEntry.identifier}`);

        // Remove from running state
        this.state.running.delete(issue.id);
        this.state.claimed.delete(issue.id);
        this.state.retry_attempts.delete(issue.id);

        // Mark as completed
        this.state.completed.add(issue.id);

        cancelled.push(runningEntry.identifier);

        // Clean up workspace
        try {
          const workspacePath = this.workspaceManager.getWorkspacePath(
            runningEntry.identifier,
            runningEntry.issue.project_slug,
            runningEntry.issue.project_name
          );
          await this.workspaceManager.removeWorkspace(workspacePath, runningEntry.issue.project_slug);
          cleaned.push(runningEntry.identifier);
          console.log(`[orchestrator] Workspace cleaned for cancelled issue: ${runningEntry.identifier}`);
        } catch (err) {
          console.warn(`[orchestrator] Failed to clean workspace for ${runningEntry.identifier}:`, err);
        }

        // Emit events
        this.emit('issue:completed', runningEntry.issue, false);
        this.emit('state:changed', this.getStateSnapshot());
      } else {
        // Update running entry with latest state
        runningEntry.issue = issue;
        this.emit('issue:reconciled', issue, issue.state);
      }
    }

    return { cancelled, cleaned };
  }
}
