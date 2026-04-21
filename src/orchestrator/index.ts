/**
 * Orchestrator - Core scheduling and state management
 * Section 7: Orchestration State Machine
 * Section 8: Polling, Scheduling, and Reconciliation
 */

import { EventEmitter } from 'events';
import * as cp from 'child_process';
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
import { GitHubIssueClient } from '../github/issue-client';
import { WorkspaceManager } from '../workspace/manager';
import { AgentRunner, TurnResult } from '../agent/runner';
import { buildReviewPrompt } from '../hooks/review-prompt';
import { buildDevPrompt, buildDevContinuationPrompt } from '../hooks/dev-prompt';
import { updateHandoverNextSteps } from '../hooks/handover';

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
  // API call statistics
  claude_api_calls: number;
  linear_api_calls: number;
  github_api_calls: number;
}

interface CliStats {
  linear_api_calls?: number;
  github_api_calls?: number;
  final_state?: string;
  review_decision?: string;
  feedback?: string;
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

    // Initialize tracker client (projectSlugs empty = auto-detect from Linear)
    this.tracker = new LinearClient({
      endpoint: config.trackerEndpoint,
      apiKey: config.trackerApiKey,
      projectSlugs: []
    });

    // Initialize workspace manager
    this.workspaceManager = new WorkspaceManager({
      workspaceRoot: config.workspaceRoot,
      githubOwner: config.githubOwner,
      githubToken: config.githubToken,
      hooks: config.hooks,
      projectRoot: config.projectRoot
    });

    // Initialize agent runner
    this.agentRunner = new AgentRunner({
      codexCommand: config.codexCommand,
      approvalPolicy: config.codexApprovalPolicy,
      threadSandbox: config.codexThreadSandbox,
      turnSandboxPolicy: config.codexTurnSandboxPolicy,
      turnTimeoutMs: config.codexTurnTimeoutMs,
      readTimeoutMs: config.codexReadTimeoutMs,
      stallTimeoutMs: config.codexStallTimeoutMs,
      projectRoot: config.projectRoot
    });

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
      tokens: { input: 0, output: 0, total: 0 },
      claude_api_calls: 0,
      linear_api_calls: 0,
      github_api_calls: 0
    };

    try {
      // Step 1: Create/reuse workspace
      const workspaceResult = await this.workspaceManager.createForIssue(issue);
      if (!workspaceResult.success || !workspaceResult.workspace) {
        result.error = `Workspace creation failed: ${workspaceResult.error}`;
        return result;
      }

      const workspace = workspaceResult.workspace;

      // Step 2: Initialize state via dispatch command
      const dispatchResult = await this.runCliCommand('dispatch', issue.identifier, workspace.path);
      if (!dispatchResult.success) {
        result.error = `dispatch failed: ${dispatchResult.error}`;
        return result;
      }

      // Step 3: Build prompt - use review-specific prompt for "In Review" state
      const isReview = issue.state.toLowerCase() === 'in review';
      let currentPrompt: string;

      if (isReview) {
        // Review-specific prompt using structured review prompt builder
        currentPrompt = buildReviewPrompt(issue);
      } else {
        // Development prompt - use DEV agent prompt builder with complexity judgment
        currentPrompt = buildDevPrompt(issue);
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
      // This sends initialize + thread/start and returns threadId
      const { threadId } = await this.agentRunner.initializeSession(child, workspace.path);
      if (runningEntry) {
        runningEntry.session_id = `${threadId}-turn-1`;
      }

      // Step 5: Run turns (up to max_turns)
      let turnNumber = 1;
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
        result.claude_api_calls += turnResult.claude_api_calls || 0;

        if (!turnResult.success) {
          result.error = turnResult.error;
          sessionActive = false;
        } else if (turnResult.completed) {
          // Turn completed successfully - prepare for next turn
          turnNumber++;
          // Continuation turns send only continuation guidance, not full prompt
          if (isReview) {
            currentPrompt = `Continue your code review for ${issue.identifier}. Check if you've completed the review and provided clear feedback.`;
          } else {
            // DEV continuation: guide towards completion
            currentPrompt = `Continue working on issue ${issue.identifier}. Check DEVELOPMENT_LOG.md for progress. If implementation is complete with passing tests, commit and push.`;
          }
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

      // Run appropriate CLI command based on state
      const cliCommand = isReview ? 'review' : 'dev';
      const cliResult = await this.runCliCommand(cliCommand, issue.identifier, workspace.path);
      console.log(`[orchestrator] CLI ${cliCommand} result: success=${cliResult.success}`);

      if (cliResult.success && cliResult.stats) {
        result.linear_api_calls = cliResult.stats.linear_api_calls || 0;
        result.github_api_calls = cliResult.stats.github_api_calls || 0;

        const finalState = cliResult.stats.final_state || '';
        const isTerminalState = ['done', 'canceled', 'duplicate'].some(
          s => finalState.toLowerCase() === s
        );

        if (isTerminalState) {
          this.state.completed.add(issue.id);
        }
      } else if (!cliResult.success) {
        console.warn(`[orchestrator] CLI ${cliCommand} failed: ${cliResult.error}`);
      }

      // After review completion, update HANDOVER.md if REQUEST_CHANGES
      if (isReview && cliResult.success && cliResult.stats) {
        const reviewDecision = cliResult.stats.review_decision || '';

        if (reviewDecision === 'REQUEST_CHANGES' && cliResult.stats.feedback) {
          // Read existing HANDOVER.md and update "下次继续" section
          const handoverPath = path.join(workspace.path, 'HANDOVER.md');
          try {
            const fs = await import('fs/promises');
            const handoverContent = await fs.readFile(handoverPath, 'utf-8');
            const updatedHandover = updateHandoverNextSteps(handoverContent, cliResult.stats.feedback);
            await fs.writeFile(handoverPath, updatedHandover, 'utf-8');
            console.log('[orchestrator] Updated HANDOVER.md with review feedback');
          } catch (err) {
            console.warn('[orchestrator] Failed to update HANDOVER.md:', err);
          }
        }
      }

      // Clean up running/claimed state AFTER after_run completes.
      // This is done here (synchronously in runAgentAttempt, before the
      // handleWorkerExit microtask fires) to ensure cleanup happens before
      // the next poll tick's shouldDispatch runs.
      this.state.running.delete(issue.id);
      this.state.claimed.delete(issue.id);

      // Update the runningEntry issue state if still accessible (for state tracking)
      if (cliResult.success && cliResult.stats) {
        const finalState = cliResult.stats.final_state || '';
        console.log(`[orchestrator] Issue ${issue.identifier} final state after CLI: "${finalState}"`);
      }

      // If CLI moved the issue to "In Progress" (e.g., merge conflict),
      // immediately schedule a retry to DEV instead of waiting for next poll.
      if (cliResult.success && cliResult.stats) {
        const finalState = cliResult.stats.final_state || '';
        if (finalState.toLowerCase() === 'in progress') {
          console.log(`[orchestrator] Issue ${issue.identifier} needs rework, scheduling DEV retry...`);
          await this.scheduleRetry(issue.id, issue.identifier, 1, 'needs_rework', 1000);
        }
      }

    } catch (err) {
      result.error = `Agent attempt failed: ${(err as Error).message}`;
      // Run after_run hook on failure
      try {
        await this.workspaceManager.afterRun(
          this.workspaceManager.getWorkspacePath(issue.identifier, issue.project_slug, issue.project_name),
          issue
        );
      } catch {}

      // Clean up even on failure
      this.state.running.delete(issue.id);
      this.state.claimed.delete(issue.id);
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

    // NOTE: We do NOT remove from running/claimed here.
    // That is done in runAgentAttempt after after_run hook completes.
    // This prevents the issue from being re-dispatched during after_run execution.

    // Clean up running/claimed AFTER after_run completes (in runAgentAttempt).
    // handleWorkerExit is called after runAgentAttempt returns (via .then()),
    // so by the time this runs, after_run has already completed and the
    // next poll tick will see the issue properly cleaned up.

    if (result.success && result.completed) {
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

      // Don't add to completed set yet - wait for state reconciliation
      // This allows "In Review" state to be re-dispatched for review agent
      // The issue will be added to completed set when reconciliation confirms terminal/active state
    } else {
      // Abnormal exit - 3-tier crash recovery
      console.error('[orchestrator] Worker failed:', identifier, result.error);
      const attempt = (runningEntry.retry_attempt || 0) + 1;

      if (attempt >= 3) {
        // Tier 3: Mark as failed, requires manual intervention
        console.error(`[orchestrator] Issue ${identifier} failed after 3 attempts, requiring manual intervention`);
        this.state.completed.add(issueId);
        this.emit('issue:failed', runningEntry.issue, 'Max retry attempts exceeded - manual intervention required');
      } else if (attempt === 2) {
        // Tier 2: Log that we'll resume from DEVELOPMENT_LOG.md
        console.log(`[orchestrator] Issue ${identifier} will resume from DEVELOPMENT_LOG.md on retry #${attempt}`);
        await this.scheduleRetry(issueId, identifier, attempt, result.error || 'Worker failed', 1000);
        this.emit('issue:failed', runningEntry.issue, 'Worker failed, will retry with log recovery');
      } else {
        // Tier 1: Simple retry
        console.log(`[orchestrator] Issue ${identifier} retry attempt #${attempt}`);
        await this.scheduleRetry(issueId, identifier, attempt, result.error || 'Worker failed');
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
  ): Promise<{ success: boolean; stats?: CliStats; error?: string }> {
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

        // Parse SYMPHONY_STATS
        const statsMatch = output.match(/SYMPHONY_STATS:(\{.*\})/);
        let stats: CliStats | undefined;
        if (statsMatch) {
          try {
            stats = JSON.parse(statsMatch[1]);
          } catch {}
        }

        resolve({ success: true, stats, error: undefined });
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

      // Check for Cancelled state FIRST (highest priority)
      if (stateLower === 'cancelled') {
        // Immediate cleanup for cancelled issues
        console.log(`[orchestrator] Issue ${runningEntry.identifier} was CANCELLED - immediate cleanup`);

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
    // In a full implementation, we'd signal the worker to terminate
    // For now, just remove from running state
    this.state.running.delete(entry.issue.id);
    this.state.claimed.delete(entry.issue.id);

    if (cleanupWorkspace) {
      const workspacePath = this.workspaceManager.getWorkspacePath(entry.identifier, entry.issue.project_slug, entry.issue.project_name);
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
      const workspacePath = this.workspaceManager.getWorkspacePath(issue.identifier, issue.project_slug, issue.project_name);
      try {
        await this.workspaceManager.removeWorkspace(workspacePath, issue.project_slug);
        console.log('[orchestrator] Cleaned up terminal workspace:', issue.identifier);
      } catch (err) {
        console.warn('[orchestrator] Failed to clean workspace:', issue.identifier, err);
      }
    }
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
    if (!githubIssueClient) {
      return { success: false, error: 'GitHub Issue client not initialized' };
    }

    // Initialize a new GitHub Issue client with the specific repo
    const client = new GitHubIssueClient({
      token: this.config.githubToken,
      owner: this.config.githubOwner,
      repo: githubRepo
    });

    // Extract issue number from Linear identifier (e.g., "ABC-123" -> 123)
    const issueNumberMatch = issue.identifier.match(/(\d+)$/);
    if (!issueNumberMatch) {
      return { success: false, error: `Invalid Linear issue identifier format: ${issue.identifier}` };
    }

    const issueNumber = parseInt(issueNumberMatch[1], 10);

    try {
      // Check if GitHub issue already exists
      const exists = await client.issueExists(issueNumber);
      if (exists) {
        console.log(`[orchestrator] GitHub issue #${issueNumber} already exists for ${issue.identifier}`);
        return { success: true, issueNumber, url: `https://github.com/${this.config.githubOwner}/${githubRepo}/issues/${issueNumber}` };
      }

      // Create the GitHub issue
      const body = [
        `## Linear Issue`,
        `[${issue.identifier}](${issue.url || '#'})`,
        '',
        `## Description`,
        issue.description || '_No description provided_',
        '',
        `## Labels`,
        issue.labels.length > 0 ? issue.labels.join(', ') : 'None',
        '',
        `## Priority`,
        issue.priority !== null ? `P${issue.priority}` : 'Not set',
      ].join('\n');

      const result = await client.createIssue({
        title: `[${issue.identifier}] ${issue.title}`,
        body,
        labels: issue.labels
      });

      console.log(`[orchestrator] Created GitHub issue #${result.number} for ${issue.identifier}: ${result.url}`);
      return { success: true, issueNumber: result.number, url: result.url };
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

    // Step 1: Post a comment to the Linear issue noting the merge
    try {
      const commentBody = [
        `## Merge Complete`,
        `PR has been merged. Issue marked as complete.`,
        new Date().toISOString()
      ].join('\n');

      await this.tracker.postComment(issue.id, commentBody);
      console.log(`[orchestrator] Posted merge comment to Linear issue ${issue.identifier}`);
    } catch (err) {
      console.warn(`[orchestrator] Failed to post merge comment to Linear:`, err);
      // Non-fatal, continue with cleanup
    }

    // Step 2: Update Linear issue state to Done
    try {
      const stateResult = await this.tracker.updateIssueState(issue.id, 'Done');
      if (stateResult.success) {
        console.log(`[orchestrator] Updated Linear issue ${issue.identifier} to Done`);
      } else {
        console.warn(`[orchestrator] Failed to update issue state to Done: ${stateResult.error}`);
      }
    } catch (err) {
      console.warn(`[orchestrator] Exception updating issue state:`, err);
      // Non-fatal, continue with cleanup
    }

    // Step 3: Clean up the workspace
    const workspacePath = this.workspaceManager.getWorkspacePath(issue.identifier, issue.project_slug, issue.project_name);
    try {
      await this.workspaceManager.removeWorkspace(workspacePath, issue.project_slug);
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
