/**
 * Orchestrator - Core scheduling and state management
 * Section 7: Orchestration State Machine
 * Section 8: Polling, Scheduling, and Reconciliation
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import {
  Issue,
  ServiceConfig,
  WorkflowDefinition,
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  OrchestrationState as IssueOrchestrationState,
  AgentEvent,
  CodexTotals
} from '../types';
import { LinearClient } from '../tracker/linear-client';
import { WorkspaceManager } from '../workspace/manager';
import { AgentRunner, TurnResult } from '../agent/runner';

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
export interface WorkerResult {
  issueId: string;
  success: boolean;
  completed: boolean;  // Normal completion (not failed/cancelled)
  error?: string;
  turns: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
}

/**
 * Orchestrator - manages issue dispatch, retries, and reconciliation
 */
export class Orchestrator extends EventEmitter {
  private config: ServiceConfig;
  private workflow: WorkflowDefinition;
  private tracker: LinearClient;
  private workspaceManager: WorkspaceManager;
  private agentRunner: AgentRunner;

  // Section 4.1.8: Orchestrator Runtime State
  private state: OrchestratorState;

  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private currentTickPromise: Promise<void> | null = null;

  constructor(
    config: ServiceConfig,
    workflow: WorkflowDefinition
  ) {
    super();
    this.config = config;
    this.workflow = workflow;

    // Initialize tracker client
    this.tracker = new LinearClient({
      endpoint: config.trackerEndpoint,
      apiKey: config.trackerApiKey,
      projectSlugs: Object.keys(config.projects)
    });

    // Initialize workspace manager
    this.workspaceManager = new WorkspaceManager({
      workspaceRoot: config.workspaceRoot,
      projects: config.projects,
      hooks: config.hooks
    });

    // Initialize agent runner
    this.agentRunner = new AgentRunner({
      codexCommand: config.codexCommand,
      approvalPolicy: config.codexApprovalPolicy,
      threadSandbox: config.codexThreadSandbox,
      turnSandboxPolicy: config.codexTurnSandboxPolicy,
      turnTimeoutMs: config.codexTurnTimeoutMs,
      readTimeoutMs: config.codexReadTimeoutMs,
      stallTimeoutMs: config.codexStallTimeoutMs
    });

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

    this.running = true;
    console.log('[orchestrator] Starting...');

    // Startup terminal workspace cleanup (Section 8.6)
    await this.startupTerminalCleanup();

    // Schedule immediate first tick
    this.scheduleTick(0);

    console.log('[orchestrator] Started');
  }

  /**
   * Stop the orchestrator
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Stop all running workers
    console.log('[orchestrator] Stopping, terminating workers...');
    // Note: In a full implementation, we'd gracefully terminate workers here

    console.log('[orchestrator] Stopped');
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
        for (const issue of sortedIssues) {
          if (!this.hasAvailableSlots()) {
            break;
          }

          if (this.shouldDispatch(issue)) {
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

    // tracker.api_key must be present
    if (!this.config.trackerApiKey) {
      errors.push('Missing tracker API key');
    }

    // tracker.projects must be present and not empty
    if (!this.config.projects || Object.keys(this.config.projects).length === 0) {
      errors.push('Missing tracker projects mapping');
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

    // Must not already be completed
    if (this.state.completed.has(issue.id)) {
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
        turn_count: 0
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

  /**
   * Run a single agent attempt
   * Section 16.5: Worker Attempt
   */
  private async runAgentAttempt(issue: Issue, attempt: number | null): Promise<WorkerResult> {
    const result: WorkerResult = {
      issueId: issue.id,
      success: false,
      completed: false,
      turns: 0,
      tokens: { input: 0, output: 0, total: 0 }
    };

    try {
      // Step 1: Create/reuse workspace
      const workspaceResult = await this.workspaceManager.createForIssue(issue);
      if (!workspaceResult.success || !workspaceResult.workspace) {
        result.error = `Workspace creation failed: ${workspaceResult.error}`;
        return result;
      }

      const workspace = workspaceResult.workspace;

      // Step 2: Run before_run hook
      const beforeRunResult = await this.workspaceManager.beforeRun(workspace.path, issue);
      if (!beforeRunResult.success) {
        result.error = `before_run hook failed: ${beforeRunResult.error}`;
        return result;
      }

      // Step 3: Build prompt
      const renderedPrompt = this.agentRunner.renderPrompt(this.workflow, issue, attempt);
      if (renderedPrompt.error) {
        result.error = `Prompt rendering failed: ${renderedPrompt.error}`;
        return result;
      }

      // Step 4: Launch agent session
      const child = this.agentRunner.launch(workspace.path);
      const pid = String(child.pid || '');

      // Update running entry with session info
      const runningEntry = this.state.running.get(issue.id);
      if (runningEntry) {
        runningEntry.codex_app_server_pid = pid;
      }

      // Initialize session (Section 10.2: Session Startup Handshake)
      const { threadId } = await this.agentRunner.initializeSession(child, workspace.path);
      if (runningEntry) {
        runningEntry.session_id = `${threadId}-turn-1`;
      }

      // Send thread/start request (Section 10.2)
      await this.agentRunner.sendThreadStart(
        child,
        workspace.path,
        this.config.codexApprovalPolicy,
        this.config.codexThreadSandbox
      );

      // Step 5: Run turns (up to max_turns)
      let turnNumber = 1;
      let currentPrompt = renderedPrompt.prompt;
      let sessionActive = true;

      while (sessionActive && turnNumber <= this.config.maxTurns) {
        // Refresh issue state before each turn
        // Section 16.5: refresh failure should fail the worker
        const { issues, error } = await this.tracker.fetchIssueStatesByIds([issue.id]);
        if (error) {
          console.error('[orchestrator] Issue state refresh failed, failing attempt:', issue.identifier);
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
            break;
          }
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
          `${issue.identifier}: ${issue.title}`,
          workspace.path,
          (event) => {
            // Update running entry with event info
            if (runningEntry) {
              runningEntry.last_codex_event = event.event;
              runningEntry.last_codex_timestamp = event.timestamp;
              runningEntry.last_codex_message = event.payload ? JSON.stringify(event.payload) : null;
              runningEntry.turn_count = turnNumber;

              // Update token counts
              if (event.usage) {
                runningEntry.codex_input_tokens = event.usage.input_tokens || 0;
                runningEntry.codex_output_tokens = event.usage.output_tokens || 0;
                runningEntry.codex_total_tokens = event.usage.total_tokens || 0;
              }
            }

            this.emit('session:event', issue.id, event);
          }
        );

        result.turns = turnNumber;
        result.tokens = turnResult.tokens;

        if (!turnResult.success) {
          result.error = turnResult.error;
          sessionActive = false;
        } else if (turnResult.completed) {
          // Turn completed successfully - prepare for next turn
          turnNumber++;
          // Continuation turns send only continuation guidance, not full prompt
          currentPrompt = `Continue working on ${issue.identifier}. Check if the task is complete.`;
        } else {
          sessionActive = false;
        }
      }

      // Stop session
      this.agentRunner.stopSession(child);

      // Wait for process to fully exit
      await new Promise(resolve => setTimeout(resolve, 500));

      result.success = true;
      result.completed = true;

      // Run after_run hook
      await this.workspaceManager.afterRun(workspace.path, issue);

    } catch (err) {
      result.error = `Agent attempt failed: ${(err as Error).message}`;
      // Run after_run hook on failure
      try {
        await this.workspaceManager.afterRun(
          this.workspaceManager.getWorkspacePath(issue.identifier, issue.project_slug),
          issue
        );
      } catch {}
    }

    return result;
  }

  /**
   * Handle worker exit
   * Section 16.6: Worker Exit and Retry Handling
   */
  private async handleWorkerExit(issueId: string, result: WorkerResult): Promise<void> {
    const runningEntry = this.state.running.get(issueId);
    if (!runningEntry) return;

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

    // Remove from running
    this.state.running.delete(issueId);
    // Remove from claimed set
    this.state.claimed.delete(issueId);

    if (result.success && result.completed) {
      // Normal exit - do not schedule retry
      console.log('[orchestrator] Worker completed normally:', identifier);
      this.state.completed.add(issueId);
      // Emit completion event
      this.emit('issue:completed', runningEntry.issue, true);
    } else {
      // Abnormal exit - exponential backoff retry
      console.error('[orchestrator] Worker failed:', identifier, result.error);
      const nextAttempt = (runningEntry.retry_attempt || 0) + 1;
      
      // Prevent aggressive hammering on globally exhausted API Limits
      const rawErrorStr = String(result.error).toLowerCase();
      let overrideDelayMs = undefined;
      if (rawErrorStr.includes('rate limit') || rawErrorStr.includes('over_limit') || rawErrorStr.includes('balance is too low')) {
          if (nextAttempt > 3) {
              console.error(`[orchestrator] 🛑 API Error detected 3 times. Suspending ${identifier} for 5 minutes to prevent spamming.`);
              overrideDelayMs = 300000; // Suspend for exactly 5 minutes
          } else {
              console.error(`[orchestrator] ⚠️ API Error detected (Attempt ${nextAttempt}/3). Retrying as it might be transient...`);
          }
      }

      await this.scheduleRetry(issueId, identifier, nextAttempt, result.error || 'Worker failed', overrideDelayMs);
      // Emit failure event
      this.emit('issue:failed', runningEntry.issue, result.error || 'Worker failed');
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
   * Handle retry timer firing
   * Section 8.4: Retry handling
   */
  private async handleRetryTimer(issueId: string): Promise<void> {
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
    // In a full implementation, we'd signal the worker to terminate
    // For now, just remove from running state
    this.state.running.delete(entry.issue.id);
    this.state.claimed.delete(entry.issue.id);

    if (cleanupWorkspace) {
      const workspacePath = this.workspaceManager.getWorkspacePath(entry.identifier, entry.issue.project_slug);
      await this.workspaceManager.removeWorkspace(workspacePath, entry.issue.project_slug);
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
      const workspacePath = this.workspaceManager.getWorkspacePath(issue.identifier, issue.project_slug);
      try {
        await this.workspaceManager.removeWorkspace(workspacePath, issue.project_slug);
        console.log('[orchestrator] Cleaned up terminal workspace:', issue.identifier);
      } catch (err) {
        console.warn('[orchestrator] Failed to clean workspace:', issue.identifier, err);
      }
    }
  }
}
