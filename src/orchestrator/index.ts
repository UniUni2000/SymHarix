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
  ChangePackSummary,
  ChangePackTaskStatus,
  CompletionRequirement,
  ConstitutionHit,
  EvidenceSummary,
  FitnessSignal,
  IntakeCriticAssessment,
  Issue,
  PendingRuntimeRequest,
  ResolvedRepositoryRoute,
  ResolvedRepositoryHarness,
  RuntimeDiagnosticsSnapshot,
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
import type {
  RuntimeActionResult,
  CreateIssueResult,
  CreateIssueRequest,
} from '../runtime/types';
import { LinearClient } from '../tracker/linear-client';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { GitHubIssueClient } from '../github/issue-client';
import { WorkspaceManager } from '../workspace/manager';
import { sanitizeWorkspaceKey } from '../workspace/shared';
import { AgentRunner } from '../agent/runner';
import { createDatabase } from '../database';
import {
  AgentRunRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  ServiceLeaseRepository,
  ShadowHarnessRepository,
  SyncEventRepository,
  WorkItemRepository
} from '../database';
import type { ReviewDecision } from '../database/types';
import type { WorkItem } from '../database/types';
import { buildReviewPrompt, parseCanonicalReviewReport } from '../hooks/review-prompt';
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
import {
  RepositoryRoutingError,
  RepositoryRoutingService,
} from '../routing/repositoryRouting';
import {
  inferShadowHarness,
  loadRepositoryConstitution,
  loadRepositoryHarness,
  suggestHarnessAdoption,
} from '../contracts/repositoryContracts';
import { assessIntakeCritic } from '../governance/intakeCritic';
import {
  evaluateChangePackState,
  initializeChangePack,
} from '../change-pack/service';

function splitGitHubRepoFull(
  githubRepoFull: string,
  fallbackOwner: string,
): { owner: string; repo: string } {
  const trimmed = githubRepoFull.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex === -1) {
    return {
      owner: fallbackOwner,
      repo: trimmed,
    };
  }

  return {
    owner: trimmed.slice(0, slashIndex),
    repo: trimmed.slice(slashIndex + 1),
  };
}

function createGitHubIssueClient(token: string, githubRepoFull: string, fallbackOwner: string): GitHubIssueClient {
  const { owner, repo } = splitGitHubRepoFull(githubRepoFull, fallbackOwner);
  return new GitHubIssueClient({
    token,
    owner,
    repo,
  });
}

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

interface GovernedExecutionState {
  harness: ResolvedRepositoryHarness;
  constitutionStatus: 'present' | 'missing';
  governance: IntakeCriticAssessment;
  changePackSummary: ChangePackSummary | null;
  taskStatus: ChangePackTaskStatus | null;
  evidenceSummary: EvidenceSummary | null;
  missingRequirements: CompletionRequirement[];
  constitutionHits: ConstitutionHit[];
  fitnessSignals: FitnessSignal[];
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
  shadowHarnessRepository?: ShadowHarnessRepository;
  governanceAssessmentRepository?: GovernanceAssessmentRepository;
  governanceSuggestionRepository?: GovernanceSuggestionRepository;
  githubMappingService?: GitHubMappingService;
  githubContextService?: GitHubContextService;
  githubSyncService?: GitHubSyncService;
  supervisor?: SupervisorService;
  projectResolutionService?: TrackerProjectResolutionService;
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
  private shadowHarnessRepository: ShadowHarnessRepository;
  private governanceAssessmentRepository: GovernanceAssessmentRepository;
  private governanceSuggestionRepository: GovernanceSuggestionRepository;
  private githubMappingService: GitHubMappingService;
  private githubContextService: GitHubContextService;
  private githubSyncService: GitHubSyncService;
  private supervisor: SupervisorService;
  private repositoryRoutingService: RepositoryRoutingService;
  private projectResolutionService: TrackerProjectResolutionService;

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
  private manualStopIssueIds = new Set<string>();
  private repositoryRouteFailureByIssueId = new Map<string, string>();

  constructor(
    config: ServiceConfig,
    workflow: WorkflowDefinition,
    dependencies: OrchestratorDependencies = {}
  ) {
    super();
    this.config = config;
    this.workflow = workflow;
    this.repositoryRoutingService = new RepositoryRoutingService(config.repositories.routing);

    // Initialize tracker client (projectSlugs empty = auto-detect from Linear)
    this.tracker = dependencies.tracker ?? new LinearClient({
      endpoint: config.trackerEndpoint,
      apiKey: config.trackerApiKey,
      projectSlugs: []
    });

    // Initialize workspace manager
    this.workspaceManager = dependencies.workspaceManager ?? new WorkspaceManager({
      workspaceRoot: config.workspaceRoot,
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
    this.shadowHarnessRepository = dependencies.shadowHarnessRepository ?? new ShadowHarnessRepository(this.db);
    this.governanceAssessmentRepository =
      dependencies.governanceAssessmentRepository ?? new GovernanceAssessmentRepository(this.db);
    this.governanceSuggestionRepository =
      dependencies.governanceSuggestionRepository ?? new GovernanceSuggestionRepository(this.db);
    this.githubMappingService = dependencies.githubMappingService ?? new GitHubMappingService({
      workItemRepository: this.workItemRepository,
      syncEventRepository: this.syncEventRepository,
      githubClientFactory: (githubRepoFull: string) => createGitHubIssueClient(
        config.githubToken,
        githubRepoFull,
        config.githubOwner,
      ),
    });
    this.githubContextService = dependencies.githubContextService ?? new GitHubContextService({
      workItemRepository: this.workItemRepository,
      reviewEventRepository: this.reviewEventRepository,
      agentRunRepository: this.agentRunRepository,
      githubClientFactory: (githubRepoFull: string) => createGitHubIssueClient(
        config.githubToken,
        githubRepoFull,
        config.githubOwner,
      ),
    });
    this.githubSyncService = dependencies.githubSyncService ?? new GitHubSyncService({
      workItemRepository: this.workItemRepository,
      syncEventRepository: this.syncEventRepository,
      githubClientFactory: (githubRepoFull: string) => createGitHubIssueClient(
        config.githubToken,
        githubRepoFull,
        config.githubOwner,
      ),
    });
    this.supervisor = dependencies.supervisor ?? new AnthropicSupervisorService();
    this.projectResolutionService =
      dependencies.projectResolutionService ??
      new TrackerProjectResolutionService(this.tracker, config.repositories.routing);
    this.leaseTtlMs = Math.max(this.config.pollIntervalMs * 3, 30_000);

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

  getDiagnosticsSnapshot(): RuntimeDiagnosticsSnapshot {
    let activeSessionCount = 0;
    for (const entry of this.state.running.values()) {
      if (entry.session_id) {
        activeSessionCount += 1;
      }
    }

    return {
      running_issue_count: this.state.running.size,
      retry_count: this.state.retry_attempts.size,
      worker_process_count: this.workerRegistry.size,
      active_session_count: activeSessionCount,
      claimed_issue_count: this.state.claimed.size,
      leadership_lease_held: this.hasLeadershipLease,
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
    this.manualStopIssueIds.clear();
    this.emit('state:changed', this.getStateSnapshot());
    await this.releaseLeadershipLease();

    console.log('[orchestrator] Stopped');
  }

  async createIssue(input: CreateIssueRequest): Promise<CreateIssueResult> {
    let resolvedProjectId = input.project_id ?? null;
    let resolvedRoute: ResolvedRepositoryRoute | null = null;
    if (input.project_slug?.trim()) {
      const resolved = await this.projectResolutionService.resolveProjectSlug(input.project_slug.trim());
      if (!resolved.project) {
        return {
          accepted: false,
          status: 'rejected',
          message: resolved.error || `Project slug "${input.project_slug.trim()}" could not be resolved`,
          issue_id: null,
          issue_identifier: null,
          issue: null,
        };
      }
      resolvedProjectId = resolved.project.project_id;
      resolvedRoute = resolved.route;
    }

    const created = await this.tracker.createIssue({
      title: input.title,
      description: input.description ?? null,
      teamId: input.team_id ?? null,
      projectId: resolvedProjectId,
      stateId: input.state_id ?? null,
    });

    if (!created.success || !created.issue) {
      return {
        accepted: false,
        status: 'rejected',
        message: created.error || 'Linear issue creation failed',
        issue_id: null,
        issue_identifier: null,
        issue: null,
      };
    }

    const issue = created.issue;
    const route = resolvedRoute ?? this.tryResolveRepositoryRoute(issue);
    let governance: IntakeCriticAssessment | null = null;
    if (route) {
      const workItem = this.githubMappingService.ensureWorkItem(issue, route.github_repo_full, 'discovering');
      governance = await assessIntakeCritic({
        issue,
        route,
        repositoryRoot: route.local_path,
      });
      this.workItemRepository.update({
        id: workItem.id,
        repo_harness_status: governance.repo_harness_status,
        constitution_status: governance.constitution_status,
        governance_status: governance.status,
        governance_decision: governance.decision,
        governance_summary: governance.summary,
        constitution_hits: governance.constitution_hits,
        orchestrator_state:
          governance.blocks_dispatch && !this.hasGovernanceOverride(issue)
            ? 'halted'
            : workItem.orchestrator_state,
      });
      this.governanceAssessmentRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        issue_id: issue.id,
        decision: governance.decision,
        status: governance.status,
        summary: governance.summary,
        constitution_hits_json: governance.constitution_hits,
        detail_json: {
          phase: 'intake',
          repo_harness_status: governance.repo_harness_status,
          constitution_status: governance.constitution_status,
          rewrite_title: governance.rewrite_title,
          rewrite_description: governance.rewrite_description,
          split_suggestions: governance.split_suggestions,
          blocks_dispatch: governance.blocks_dispatch,
        },
      });
      this.ensureGovernanceSuggestions(issue, workItem.id, route, governance);
      this.emitTimelineEvent(issue, {
        level: governance.blocks_dispatch ? 'warn' : 'info',
        category: 'diagnostic',
        code: governance.blocks_dispatch ? 'governance_blocked' : 'governance_assessed',
        message: governance.summary,
        turn: null,
        tool_name: null,
        detail: {
          decision: governance.decision,
          status: governance.status,
          constitution_hits: governance.constitution_hits,
          split_suggestions: governance.split_suggestions,
          rewrite_title: governance.rewrite_title,
        },
      });
    }

    let message = `Created ${issue.identifier}`;
    if (this.running) {
      if (route && governance?.blocks_dispatch && !this.hasGovernanceOverride(issue)) {
        message = `Created ${issue.identifier}, but dispatch is blocked: ${governance.summary}`;
        this.scheduleTick(0);
      } else if (route && this.hasAvailableSlots() && this.shouldDispatch(issue)) {
        await this.dispatchIssue(issue, null);
        message = `Created ${issue.identifier} and dispatched it`;
      } else if (!route) {
        message = `Created ${issue.identifier}, but dispatch is blocked: repository route is not configured`;
      } else {
        this.scheduleTick(0);
      }
    } else if (!route) {
      message = `Created ${issue.identifier}, but dispatch is blocked: repository route is not configured`;
    } else if (governance?.blocks_dispatch && !this.hasGovernanceOverride(issue)) {
      message = `Created ${issue.identifier}, but dispatch is blocked: ${governance.summary}`;
    }

    return {
      accepted: true,
      status: 'accepted',
      message,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue: null,
    };
  }

  async stopIssue(issueId: string): Promise<RuntimeActionResult> {
    const runningEntry = this.state.running.get(issueId);
    if (runningEntry) {
      this.manualStopIssueIds.add(issueId);
      void this.stopRunningWorker(runningEntry).catch((error) => {
        console.warn(`[orchestrator] Failed to stop ${runningEntry.identifier}:`, error);
      });

      return {
        accepted: true,
        status: 'accepted',
        message: `Stopping ${runningEntry.identifier}`,
        issue_id: runningEntry.issue.id,
        issue_identifier: runningEntry.identifier,
      };
    }

    const retryEntry = this.state.retry_attempts.get(issueId);
    if (retryEntry) {
      if (retryEntry.timer_handle) {
        clearTimeout(retryEntry.timer_handle);
      }
      this.state.retry_attempts.delete(issueId);
      this.state.claimed.delete(issueId);

      const workItem = this.workItemRepository.findByLinearIssueId(issueId);
      if (workItem) {
        this.workItemRepository.update({
          id: workItem.id,
          orchestrator_state: 'halted',
        });
      }

      this.emit('state:changed', this.getStateSnapshot());
      return {
        accepted: true,
        status: 'completed',
        message: `Stopped queued retry for ${retryEntry.identifier}`,
        issue_id: issueId,
        issue_identifier: retryEntry.identifier,
      };
    }

    const workItem = this.workItemRepository.findByLinearIssueId(issueId);
    if (!workItem) {
      return {
        accepted: false,
        status: 'not_found',
        message: `Issue ${issueId} was not found`,
        issue_id: null,
        issue_identifier: null,
      };
    }

    return {
      accepted: false,
      status: 'rejected',
      message: `${workItem.linear_identifier} is not currently running`,
      issue_id: workItem.linear_issue_id,
      issue_identifier: workItem.linear_identifier,
    };
  }

  async retryIssue(issueId: string): Promise<RuntimeActionResult> {
    if (this.state.running.has(issueId)) {
      const runningEntry = this.state.running.get(issueId)!;
      return {
        accepted: false,
        status: 'rejected',
        message: `${runningEntry.identifier} is already running`,
        issue_id: runningEntry.issue.id,
        issue_identifier: runningEntry.identifier,
      };
    }

    const retryEntry = this.state.retry_attempts.get(issueId);
    if (retryEntry) {
      return {
        accepted: true,
        status: 'queued',
        message: `${retryEntry.identifier} is already queued for retry`,
        issue_id: issueId,
        issue_identifier: retryEntry.identifier,
      };
    }

    const fetched = await this.tracker.fetchIssueById(issueId);
    if (fetched.error) {
      return {
        accepted: false,
        status: 'rejected',
        message: fetched.errorMessage || 'Failed to load current issue state from Linear',
        issue_id: issueId,
        issue_identifier: this.workItemRepository.findByLinearIssueId(issueId)?.linear_identifier ?? null,
      };
    }

    const issue = fetched.issue;
    if (!issue) {
      return {
        accepted: false,
        status: 'not_found',
        message: `Issue ${issueId} was not found in Linear`,
        issue_id: null,
        issue_identifier: null,
      };
    }

    if (!this.isActiveTrackerState(issue.state)) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${issue.identifier} is in tracker state "${issue.state}" and cannot be retried`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    this.state.completed.delete(issue.id);
    const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
    const route = this.tryResolveRepositoryRoute(issue);
    if (!route) {
      return {
        accepted: false,
        status: 'rejected',
        message: `Retry blocked for ${issue.identifier}: repository route is not configured`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    if (this.hasAvailableSlots() && this.shouldDispatch(issue)) {
      if (workItem) {
        this.workItemRepository.update({
          id: workItem.id,
          linear_state: issue.state,
          orchestrator_state: 'discovering',
        });
      }
      await this.dispatchIssue(issue, null);
      return {
        accepted: true,
        status: 'accepted',
        message: `Retrying ${issue.identifier}`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    if (workItem) {
      this.workItemRepository.update({
        id: workItem.id,
        linear_state: issue.state,
        orchestrator_state: 'retry_scheduled',
      });
    }
    await this.scheduleRetry(issue.id, issue.identifier, 1, 'Manual retry requested', 250);
    this.emit('state:changed', this.getStateSnapshot());

    return {
      accepted: true,
      status: 'queued',
      message: `Queued ${issue.identifier} for retry`,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    };
  }

  async overrideGovernance(issueId: string): Promise<RuntimeActionResult> {
    const workItem =
      this.workItemRepository.findByLinearIssueId(issueId) ??
      this.workItemRepository.findByIdentifier(issueId);
    if (!workItem) {
      return {
        accepted: false,
        status: 'not_found',
        message: `Issue ${issueId} was not found`,
        issue_id: null,
        issue_identifier: null,
      };
    }

    if (workItem.governance_override_at) {
      return {
        accepted: true,
        status: 'completed',
        message: `Override already approved for ${workItem.linear_identifier}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
      };
    }

    const requiresOverride =
      workItem.orchestrator_state === 'halted' &&
      Boolean(workItem.governance_decision && workItem.governance_decision !== 'accept');
    if (!requiresOverride) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${workItem.linear_identifier} does not currently require a governance override`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
      };
    }

    const fetched = await this.tracker.fetchIssueById(workItem.linear_issue_id);
    if (fetched.error && !fetched.issue) {
      return {
        accepted: false,
        status: 'rejected',
        message: fetched.errorMessage || `Failed to load current issue state for ${workItem.linear_identifier}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
      };
    }

    const issue = fetched.issue ?? this.buildSyntheticIssueFromWorkItem(workItem);
    if (!this.isActiveTrackerState(issue.state)) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${issue.identifier} is in tracker state "${issue.state}" and cannot be overridden`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    const overrideAt = new Date();
    const overrideReason = 'Manual operator override';
    this.workItemRepository.update({
      id: workItem.id,
      linear_state: issue.state,
      governance_override_at: overrideAt,
      governance_override_reason: overrideReason,
      orchestrator_state: 'discovering',
    });
    this.governanceAssessmentRepository.create({
      id: crypto.randomUUID(),
      work_item_id: workItem.id,
      issue_id: issue.id,
      decision: workItem.governance_decision ?? 'accept',
      status: 'advisory',
      summary: `Governance override approved for ${issue.identifier}; dispatch may continue despite the ${workItem.governance_decision ?? 'previous'} intake gate.`,
      constitution_hits_json: workItem.constitution_hits,
      detail_json: {
        event: 'override_approved',
        reason: overrideReason,
        previous_decision: workItem.governance_decision,
        previous_status: workItem.governance_status,
      },
    });
    this.emitTimelineEvent(issue, {
      level: 'warn',
      category: 'diagnostic',
      code: 'governance_override_approved',
      message: `Governance override approved for ${issue.identifier}; continuing despite the ${workItem.governance_decision ?? 'previous'} intake gate.`,
      turn: null,
      tool_name: null,
      detail: {
        issue_identifier: issue.identifier,
        governance_decision: workItem.governance_decision,
        reason: overrideReason,
      },
    });

    const route = this.tryResolveRepositoryRoute(issue);
    if (!route) {
      this.emit('state:changed', this.getStateSnapshot());
      return {
        accepted: true,
        status: 'accepted',
        message: `Override approved for ${issue.identifier}, but dispatch is still blocked: repository route is not configured`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    if (this.running && this.hasAvailableSlots() && this.shouldDispatch(issue)) {
      await this.dispatchIssue(issue, null);
      return {
        accepted: true,
        status: 'accepted',
        message: `Override approved for ${issue.identifier} and dispatched it`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    this.emit('state:changed', this.getStateSnapshot());
    if (this.running) {
      this.scheduleTick(0);
    }

    return {
      accepted: true,
      status: 'accepted',
      message: `Override approved for ${issue.identifier}`,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    };
  }

  async rewriteGovernance(issueId: string): Promise<RuntimeActionResult> {
    const workItem =
      this.workItemRepository.findByLinearIssueId(issueId) ??
      this.workItemRepository.findByIdentifier(issueId);
    if (!workItem) {
      return {
        accepted: false,
        status: 'not_found',
        message: `Issue ${issueId} was not found`,
        issue_id: null,
        issue_identifier: null,
      };
    }

    if (
      workItem.orchestrator_state !== 'halted' ||
      workItem.governance_decision !== 'accept_with_rewrite'
    ) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${workItem.linear_identifier} is not currently waiting on a governance rewrite`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
      };
    }

    const issueResult = await this.loadGovernanceActionIssue(workItem);
    if ('accepted' in issueResult) {
      return issueResult;
    }
    const issue = issueResult.issue;
    const route = this.tryResolveRepositoryRoute(issue);
    if (!route) {
      return {
        accepted: false,
        status: 'rejected',
        message: `Rewrite is blocked because ${issue.identifier} does not have a configured repository route`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    const governance = await this.reassessIntakeGovernance(issue, route);
    if (governance.decision !== 'accept_with_rewrite') {
      return {
        accepted: false,
        status: 'rejected',
        message: `${issue.identifier} no longer requires a governance rewrite`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    const title = governance.rewrite_title?.trim() || issue.title;
    const description = governance.rewrite_description?.trim() || issue.description;
    const updated = await this.tracker.updateIssueContent(issue.id, {
      title,
      description,
    });
    if (!updated.success) {
      return {
        accepted: false,
        status: 'rejected',
        message: updated.error || `Failed to update ${issue.identifier} in Linear`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    const refreshedIssueResult = await this.tracker.fetchIssueById(issue.id);
    const refreshedIssue = refreshedIssueResult.issue ?? {
      ...issue,
      title,
      description,
    };
    const refreshedGovernance = await this.reassessIntakeGovernance(refreshedIssue, route);

    this.acceptGovernanceSuggestions(issue.id, 'accept_with_rewrite');
    this.refreshWorkItemGovernanceState(workItem.id, refreshedIssue, refreshedGovernance);
    this.recordGovernanceAssessment(workItem.id, refreshedIssue.id, refreshedGovernance, {
      event: 'rewrite_applied',
      previous_decision: workItem.governance_decision,
      previous_summary: workItem.governance_summary,
      rewrite_title: title,
      rewrite_description: description,
    });
    this.ensureGovernanceSuggestions(refreshedIssue, workItem.id, route, refreshedGovernance);
    this.emitTimelineEvent(refreshedIssue, {
      level: refreshedGovernance.blocks_dispatch ? 'warn' : 'info',
      category: 'diagnostic',
      code: 'governance_rewrite_applied',
      message: `Governance rewrite applied to ${refreshedIssue.identifier}.`,
      turn: null,
      tool_name: null,
      detail: {
        previous_decision: workItem.governance_decision,
        governance_decision: refreshedGovernance.decision,
        rewrite_title: title,
      },
    });

    if (!refreshedGovernance.blocks_dispatch && this.running && this.hasAvailableSlots() && this.shouldDispatch(refreshedIssue)) {
      await this.dispatchIssue(refreshedIssue, null);
      return {
        accepted: true,
        status: 'accepted',
        message: `Rewrite applied for ${refreshedIssue.identifier} and dispatched it`,
        issue_id: refreshedIssue.id,
        issue_identifier: refreshedIssue.identifier,
      };
    }

    this.emit('state:changed', this.getStateSnapshot());
    if (this.running) {
      this.scheduleTick(0);
    }

    return {
      accepted: true,
      status: 'accepted',
      message: refreshedGovernance.blocks_dispatch
        ? `Rewrite applied for ${refreshedIssue.identifier}, but dispatch is still blocked: ${refreshedGovernance.summary}`
        : `Rewrite applied for ${refreshedIssue.identifier}`,
      issue_id: refreshedIssue.id,
      issue_identifier: refreshedIssue.identifier,
    };
  }

  async splitGovernance(issueId: string): Promise<RuntimeActionResult> {
    const workItem =
      this.workItemRepository.findByLinearIssueId(issueId) ??
      this.workItemRepository.findByIdentifier(issueId);
    if (!workItem) {
      return {
        accepted: false,
        status: 'not_found',
        message: `Issue ${issueId} was not found`,
        issue_id: null,
        issue_identifier: null,
      };
    }

    if (
      workItem.orchestrator_state !== 'halted' ||
      workItem.governance_decision !== 'split_before_implement'
    ) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${workItem.linear_identifier} is not currently waiting on a governance split`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
      };
    }

    const issueResult = await this.loadGovernanceActionIssue(workItem);
    if ('accepted' in issueResult) {
      return issueResult;
    }
    const issue = issueResult.issue;
    const route = this.tryResolveRepositoryRoute(issue);
    if (!route) {
      return {
        accepted: false,
        status: 'rejected',
        message: `Split is blocked because ${issue.identifier} does not have a configured repository route`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    const governance = await this.reassessIntakeGovernance(issue, route);
    if (governance.decision !== 'split_before_implement') {
      return {
        accepted: false,
        status: 'rejected',
        message: `${issue.identifier} no longer requires a governance split`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    if (!issue.project_slug?.trim()) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${issue.identifier} does not have a project_slug, so Symphony cannot create split follow-up issues`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    const splitSuggestions = governance.split_suggestions.filter((suggestion) => suggestion.trim());
    if (splitSuggestions.length < 2) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${issue.identifier} does not yet have enough concrete split suggestions to execute safely`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    const createdIdentifiers: string[] = [];
    for (let index = 1; index < splitSuggestions.length; index += 1) {
      const childDraft = this.buildGovernanceSplitDraft(issue, splitSuggestions[index]!, index, splitSuggestions.length);
      const created = await this.createIssue({
        title: childDraft.title,
        description: childDraft.description,
        project_slug: issue.project_slug,
      });
      if (!created.accepted || !created.issue_identifier) {
        return {
          accepted: false,
          status: 'rejected',
          message: created.message || `Failed to create a split follow-up issue for ${issue.identifier}`,
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        };
      }
      createdIdentifiers.push(created.issue_identifier);
    }

    const primaryDraft = this.buildGovernanceSplitDraft(issue, splitSuggestions[0]!, 0, splitSuggestions.length);
    const updated = await this.tracker.updateIssueContent(issue.id, {
      title: primaryDraft.title,
      description: primaryDraft.description,
    });
    if (!updated.success) {
      return {
        accepted: false,
        status: 'rejected',
        message: updated.error || `Failed to update ${issue.identifier} in Linear`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    const refreshedIssueResult = await this.tracker.fetchIssueById(issue.id);
    const refreshedIssue = refreshedIssueResult.issue ?? {
      ...issue,
      title: primaryDraft.title,
      description: primaryDraft.description,
    };
    const refreshedGovernance = await this.reassessIntakeGovernance(refreshedIssue, route);

    this.acceptGovernanceSuggestions(issue.id, 'split_before_implement');
    this.refreshWorkItemGovernanceState(workItem.id, refreshedIssue, refreshedGovernance);
    this.recordGovernanceAssessment(workItem.id, refreshedIssue.id, refreshedGovernance, {
      event: 'split_applied',
      previous_decision: workItem.governance_decision,
      previous_summary: workItem.governance_summary,
      created_issue_identifiers: createdIdentifiers,
      rewritten_title: primaryDraft.title,
    });
    this.ensureGovernanceSuggestions(refreshedIssue, workItem.id, route, refreshedGovernance);
    this.emitTimelineEvent(refreshedIssue, {
      level: refreshedGovernance.blocks_dispatch ? 'warn' : 'info',
      category: 'diagnostic',
      code: 'governance_split_applied',
      message: `Governance split applied to ${refreshedIssue.identifier}.`,
      turn: null,
      tool_name: null,
      detail: {
        previous_decision: workItem.governance_decision,
        governance_decision: refreshedGovernance.decision,
        created_issue_identifiers: createdIdentifiers,
      },
    });

    if (!refreshedGovernance.blocks_dispatch && this.running && this.hasAvailableSlots() && this.shouldDispatch(refreshedIssue)) {
      await this.dispatchIssue(refreshedIssue, null);
      return {
        accepted: true,
        status: 'accepted',
        message: `Split applied for ${refreshedIssue.identifier}, created ${createdIdentifiers.join(', ')}, and dispatched the rewritten issue`,
        issue_id: refreshedIssue.id,
        issue_identifier: refreshedIssue.identifier,
      };
    }

    this.emit('state:changed', this.getStateSnapshot());
    if (this.running) {
      this.scheduleTick(0);
    }

    return {
      accepted: true,
      status: 'accepted',
      message: refreshedGovernance.blocks_dispatch
        ? `Split applied for ${refreshedIssue.identifier}, created ${createdIdentifiers.join(', ')}, but dispatch is still blocked: ${refreshedGovernance.summary}`
        : `Split applied for ${refreshedIssue.identifier}${createdIdentifiers.length ? `; created ${createdIdentifiers.join(', ')}` : ''}`,
      issue_id: refreshedIssue.id,
      issue_identifier: refreshedIssue.identifier,
    };
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

    const route = this.tryResolveRepositoryRoute(issue);
    if (!route) {
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
      const workerPromise = this.runAgentAttempt(issue, attempt, route).then(result => this.handleWorkerExit(issue.id, result));

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

    const sourcePath = this.getRouteSourcePath(params.issue);
    if (!sourcePath) {
      return;
    }
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

  private resolveRepositoryRoute(issue: Issue): ResolvedRepositoryRoute {
    return this.repositoryRoutingService.resolveIssue(issue);
  }

  private emitRepositoryRouteFailure(issue: Issue, error: RepositoryRoutingError): void {
    const payload: AgentTimelinePayload = {
      level: 'error',
      category: 'diagnostic',
      code: error.code === 'missing_tracker_project_slug'
        ? 'missing_tracker_project_slug'
        : 'missing_repository_route',
      message: error.message,
      turn: null,
      tool_name: null,
      detail: {
        error_code: error.code,
        issue_identifier: issue.identifier,
        project_slug: issue.project_slug,
        project_name: issue.project_name,
      },
    };

    this.emit('session:event', issue.id, {
      event: 'timeline',
      timestamp: new Date(),
      codex_app_server_pid: null,
      payload,
    });

    const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
    if (workItem) {
      this.workItemRepository.update({
        id: workItem.id,
        linear_state: issue.state,
        orchestrator_state: 'failed',
      });

      this.syncEventRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        target_system: 'linear',
        action: 'repository_route_failure',
        payload_json: {
          issue_identifier: issue.identifier,
          project_slug: issue.project_slug,
          project_name: issue.project_name,
          error_code: error.code,
        },
        result: 'failed',
        error: error.message,
      });
    }
  }

  private emitTimelineEvent(issue: Issue, payload: AgentTimelinePayload): void {
    this.emit('session:event', issue.id, {
      event: 'timeline',
      timestamp: new Date(),
      codex_app_server_pid: null,
      payload,
    });
  }

  private buildSyntheticIssueFromWorkItem(workItem: WorkItem): Issue {
    return {
      id: workItem.linear_issue_id,
      identifier: workItem.linear_identifier,
      title: workItem.linear_title,
      description: null,
      priority: null,
      state: workItem.linear_state,
      project_slug: null,
      project_name: null,
      branch_name: workItem.branch_name,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: workItem.created_at,
      updated_at: workItem.updated_at,
    };
  }

  private hasGovernanceOverride(issue: Issue): boolean {
    const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
    if (workItem?.governance_override_at) {
      return true;
    }
    return issue.labels.some((label) => {
      const normalized = label.toLowerCase();
      return normalized.includes('governance-override') || normalized.includes('symphony-override');
    });
  }

  private async loadGovernanceActionIssue(
    workItem: WorkItem,
  ): Promise<{ issue: Issue } | RuntimeActionResult> {
    const fetched = await this.tracker.fetchIssueById(workItem.linear_issue_id);
    if (fetched.error && !fetched.issue) {
      return {
        accepted: false,
        status: 'rejected',
        message: fetched.errorMessage || `Failed to load current issue state for ${workItem.linear_identifier}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
      };
    }

    const issue = fetched.issue ?? this.buildSyntheticIssueFromWorkItem(workItem);
    if (!this.isActiveTrackerState(issue.state)) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${issue.identifier} is in tracker state "${issue.state}" and cannot accept governance actions`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      };
    }

    return { issue };
  }

  private async reassessIntakeGovernance(
    issue: Issue,
    route: ResolvedRepositoryRoute,
  ): Promise<IntakeCriticAssessment> {
    return assessIntakeCritic({
      issue,
      route,
      repositoryRoot: route.local_path,
    });
  }

  private refreshWorkItemGovernanceState(
    workItemId: string,
    issue: Issue,
    governance: IntakeCriticAssessment,
  ): void {
    this.workItemRepository.update({
      id: workItemId,
      linear_title: issue.title,
      linear_state: issue.state,
      repo_harness_status: governance.repo_harness_status,
      constitution_status: governance.constitution_status,
      governance_status: governance.status,
      governance_decision: governance.decision,
      governance_summary: governance.summary,
      constitution_hits: governance.constitution_hits,
      orchestrator_state:
        governance.blocks_dispatch && !this.hasGovernanceOverride(issue)
          ? 'halted'
          : 'discovering',
    });
  }

  private recordGovernanceAssessment(
    workItemId: string,
    issueId: string,
    governance: IntakeCriticAssessment,
    detail_json: Record<string, unknown>,
  ): void {
    this.governanceAssessmentRepository.create({
      id: crypto.randomUUID(),
      work_item_id: workItemId,
      issue_id: issueId,
      decision: governance.decision,
      status: governance.status,
      summary: governance.summary,
      constitution_hits_json: governance.constitution_hits,
      detail_json,
    });
  }

  private acceptGovernanceSuggestions(issueId: string, decision: IntakeCriticAssessment['decision']): void {
    const suggestions = this.governanceSuggestionRepository.findPendingByIssueId(issueId);
    for (const suggestion of suggestions) {
      const suggestionDecision = typeof suggestion.detail_json?.decision === 'string'
        ? suggestion.detail_json.decision
        : null;
      const title = suggestion.title.toLowerCase();
      const matchesDecision =
        suggestionDecision === decision ||
        (decision === 'accept_with_rewrite' && title.includes('rewrite')) ||
        (decision === 'split_before_implement' && title.includes('split'));
      if (matchesDecision) {
        this.governanceSuggestionRepository.updateStatus(suggestion.id, 'accepted');
      }
    }
  }

  private buildGovernanceSplitDraft(
    issue: Issue,
    suggestion: string,
    index: number,
    total: number,
  ): { title: string; description: string } {
    const normalizedSuggestion = suggestion.replace(/\s+/g, ' ').trim();
    const shortTitle = normalizedSuggestion
      .replace(/^(先|将|把)\s*/u, '')
      .replace(/^先拆出\s*/u, '')
      .replace(/[，,。.!].*$/u, '')
      .trim();
    const title = shortTitle && shortTitle.length <= 120
      ? shortTitle
      : `${issue.title} · Slice ${index + 1}`;

    const description = [
      `Split from ${issue.identifier}.`,
      `Focused slice ${index + 1} of ${total}: ${normalizedSuggestion}`,
      'Keep this issue limited to one concrete, verifiable task.',
    ].join('\n');

    return {
      title,
      description,
    };
  }

  private ensureGovernanceSuggestions(
    issue: Issue,
    workItemId: string,
    route: ResolvedRepositoryRoute,
    governance: IntakeCriticAssessment,
  ): void {
    const existing = this.governanceSuggestionRepository.findPendingByIssueId(issue.id);
    const suggestions: Array<{
      suggestion_type: 'architecture_alignment' | 'harness_adoption';
      title: string;
      summary: string;
      detail_json: Record<string, unknown>;
    }> = [];

    if (governance.decision === 'split_before_implement') {
      suggestions.push({
        suggestion_type: 'architecture_alignment',
        title: `[GOVERNANCE] Split ${issue.identifier} before implementation`,
        summary: governance.split_suggestions[0] || governance.summary,
        detail_json: {
          decision: governance.decision,
          summary: governance.summary,
          split_suggestions: governance.split_suggestions,
          github_repo: route.github_repo_full,
        },
      });
    } else if (governance.decision === 'accept_with_rewrite') {
      suggestions.push({
        suggestion_type: 'architecture_alignment',
        title: `[GOVERNANCE] Rewrite ${issue.identifier} into one concrete task`,
        summary: governance.rewrite_description || governance.summary,
        detail_json: {
          decision: governance.decision,
          summary: governance.summary,
          rewrite_title: governance.rewrite_title,
          rewrite_description: governance.rewrite_description,
          github_repo: route.github_repo_full,
        },
      });
    } else if (governance.decision === 'defer' && route.require_repo_harness) {
      suggestions.push({
        suggestion_type: 'harness_adoption',
        title: `[GOVERNANCE] Adopt formal repo harness for ${route.github_repo_full}`,
        summary: governance.summary,
        detail_json: {
          decision: governance.decision,
          summary: governance.summary,
          github_repo: route.github_repo_full,
        },
      });
    } else if (governance.decision === 'reject_conflicting') {
      suggestions.push({
        suggestion_type: 'architecture_alignment',
        title: `[GOVERNANCE] Realign ${issue.identifier} with the project constitution`,
        summary: governance.summary,
        detail_json: {
          decision: governance.decision,
          summary: governance.summary,
          constitution_hits: governance.constitution_hits,
          github_repo: route.github_repo_full,
        },
      });
    }

    for (const suggestion of suggestions) {
      const duplicate = existing.some((record) => (
        record.suggestion_type === suggestion.suggestion_type &&
        record.title === suggestion.title
      ));
      if (duplicate) {
        continue;
      }

      this.governanceSuggestionRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItemId,
        issue_id: issue.id,
        suggestion_type: suggestion.suggestion_type,
        title: suggestion.title,
        summary: suggestion.summary,
        detail_json: suggestion.detail_json,
      });
      this.emitTimelineEvent(issue, {
        level: 'info',
        category: 'diagnostic',
        code: 'governance_suggestion_created',
        message: suggestion.title,
        turn: null,
        tool_name: null,
        detail: {
          suggestion_type: suggestion.suggestion_type,
          summary: suggestion.summary,
        },
      });
    }
  }

  private async prepareGovernedExecutionState(
    issue: Issue,
    workItemId: string,
    workspacePath: string,
    route: ResolvedRepositoryRoute,
    mode: 'dev' | 'review',
  ): Promise<GovernedExecutionState> {
    let harness = await loadRepositoryHarness(workspacePath);
    const shouldEmitMissingHarness = harness.status === 'missing';

    if (harness.status === 'missing') {
      harness = await inferShadowHarness({
        workspacePath,
        repoKey: route.github_repo_full,
        repository: this.shadowHarnessRepository,
      });
    }

    const constitution = await loadRepositoryConstitution(workspacePath);
    const governance = await assessIntakeCritic({
      issue,
      route,
      repositoryRoot: workspacePath,
      resolvedHarness: harness,
      resolvedConstitution: constitution,
    });

    await initializeChangePack({
      workspacePath,
      issue,
      mode,
      profile: mode === 'review' ? 'review' : undefined,
      harness: harness.config,
      governanceSummary: governance.summary,
    });

    const changePackState = await evaluateChangePackState({
      workspacePath,
      issue,
      mode,
    });

    const fitnessSignals: FitnessSignal[] = [];
    if (governance.status === 'blocked') {
      fitnessSignals.push({
        code: 'constitution_violation',
        summary: governance.summary,
        severity: 'high',
      });
    }

    this.workItemRepository.update({
      id: workItemId,
      repo_harness_status: harness.status,
      constitution_status: constitution.status,
      governance_status: governance.status,
      governance_decision: governance.decision,
      governance_summary: governance.summary,
      change_pack_summary: changePackState.summary,
      task_status: changePackState.task_status,
      evidence_summary: changePackState.evidence_summary,
      missing_requirements: changePackState.missing_requirements,
      constitution_hits: governance.constitution_hits,
      fitness_signals: fitnessSignals,
    });

    this.governanceAssessmentRepository.create({
      id: crypto.randomUUID(),
      work_item_id: workItemId,
      issue_id: issue.id,
      decision: governance.decision,
      status: governance.status,
      summary: governance.summary,
      constitution_hits_json: governance.constitution_hits,
      detail_json: {
        mode,
        repo_harness_status: harness.status,
        constitution_status: constitution.status,
        missing_requirements: changePackState.missing_requirements,
      },
    });
    this.ensureGovernanceSuggestions(issue, workItemId, route, governance);

    if (shouldEmitMissingHarness) {
      this.emitTimelineEvent(issue, {
        level: 'warn',
        category: 'diagnostic',
        code: 'repo_harness_missing',
        message: `No .symphony-repo.yaml found for ${route.github_repo_full}; using a shadow harness.`,
        turn: null,
        tool_name: null,
        detail: {
          github_repo: route.github_repo_full,
          repo_harness_status: harness.status,
        },
      });
      this.emitTimelineEvent(issue, {
        level: 'info',
        category: 'diagnostic',
        code: 'shadow_harness_updated',
        message: `Shadow harness prepared for ${route.github_repo_full}.`,
        turn: null,
        tool_name: null,
        detail: {
          github_repo: route.github_repo_full,
          inferred_from: harness.inferred_from,
        },
      });
    }

    if (constitution.status === 'missing') {
      this.emitTimelineEvent(issue, {
        level: 'warn',
        category: 'diagnostic',
        code: 'constitution_missing',
        message: `No .symphony-constitution.md found for ${route.github_repo_full}; governance is degraded.`,
        turn: null,
        tool_name: null,
        detail: {
          github_repo: route.github_repo_full,
        },
      });
    }

    this.emitTimelineEvent(issue, {
      level: 'info',
      category: 'diagnostic',
      code: 'change_pack_initialized',
      message: `Initialized change pack for ${issue.identifier}.`,
      turn: null,
      tool_name: null,
      detail: {
        profile: changePackState.summary.profile,
        complexity: changePackState.summary.complexity,
      },
    });

    this.emitTimelineEvent(issue, {
      level: governance.blocks_dispatch ? 'warn' : 'info',
      category: 'diagnostic',
      code: governance.blocks_dispatch ? 'governance_blocked' : 'governance_assessed',
      message: governance.summary,
      turn: null,
      tool_name: null,
      detail: {
        decision: governance.decision,
        status: governance.status,
        constitution_hits: governance.constitution_hits,
        split_suggestions: governance.split_suggestions,
        rewrite_title: governance.rewrite_title,
      },
    });

    if (changePackState.missing_requirements.length > 0) {
      this.emitTimelineEvent(issue, {
        level: 'info',
        category: 'diagnostic',
        code: 'completion_blocked',
        message: `${issue.identifier} still needs ${changePackState.missing_requirements.length} completion requirement(s).`,
        turn: null,
        tool_name: null,
        detail: {
          missing_requirements: changePackState.missing_requirements,
        },
      });
    }

    if (route.require_repo_harness && harness.status !== 'formal') {
      this.emitTimelineEvent(issue, {
        level: 'error',
        category: 'diagnostic',
        code: 'repo_harness_missing',
        message: `${issue.identifier} requires a formal .symphony-repo.yaml before dispatch can continue.`,
        turn: null,
        tool_name: null,
        detail: {
          github_repo: route.github_repo_full,
          required: true,
        },
      });
    }

    return {
      harness,
      constitutionStatus: constitution.status,
      governance,
      changePackSummary: changePackState.summary,
      taskStatus: changePackState.task_status,
      evidenceSummary: changePackState.evidence_summary,
      missingRequirements: changePackState.missing_requirements,
      constitutionHits: governance.constitution_hits,
      fitnessSignals,
    };
  }

  private tryResolveRepositoryRoute(issue: Issue): ResolvedRepositoryRoute | null {
    try {
      const route = this.resolveRepositoryRoute(issue);
      this.repositoryRouteFailureByIssueId.delete(issue.id);
      return route;
    } catch (error) {
      if (error instanceof RepositoryRoutingError) {
        if (this.repositoryRouteFailureByIssueId.get(issue.id) !== error.message) {
          this.repositoryRouteFailureByIssueId.set(issue.id, error.message);
          console.error(`[orchestrator] Repository routing failed for ${issue.identifier}: ${error.message}`);
          this.emitRepositoryRouteFailure(issue, error);
          this.emit('issue:failed', issue, error.message);
          this.emit('state:changed', this.getStateSnapshot());
        }
        return null;
      }

      throw error;
    }
  }

  private getRouteWorkspacePath(issue: Issue, identifier: string = issue.identifier): string | null {
    try {
      const route = this.resolveRepositoryRoute(issue);
      return this.workspaceManager.getWorkspacePath(identifier, route);
    } catch {
      return null;
    }
  }

  private getRouteSourcePath(issue: Issue): string | null {
    try {
      const route = this.resolveRepositoryRoute(issue);
      return this.workspaceManager.getRepoSourcePath(route);
    } catch {
      return null;
    }
  }

  private normalizeReviewDecision(value: string | null | undefined): ReviewDecision | null {
    if (!value) {
      return null;
    }

    const normalized = value.toUpperCase();
    if (normalized === 'APPROVED' || normalized === 'APPROVE') {
      return 'APPROVE';
    }
    if (normalized === 'APPROVE_MINOR') {
      return 'APPROVE_MINOR';
    }
    if (normalized === 'MERGE_BLOCKED') {
      return 'MERGE_BLOCKED';
    }
    if (normalized === 'REQUEST_CHANGES') {
      return 'REQUEST_CHANGES';
    }
    if (normalized === 'REQUEST_TESTS') {
      return 'REQUEST_TESTS';
    }
    if (normalized === 'REJECT') {
      return 'REJECT';
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
      return parseCanonicalReviewReport(reviewText) !== null;
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
    missingRequirements: CompletionRequirement[],
  ): boolean {
    const complexity = judgeComplexity(issue).complexity;
    const artifactCompletion = this.artifactSuggestsCompletion(mode, workspaceArtifacts);
    const onlyLightweightFallbackRequirements =
      missingRequirements.length > 0 &&
      missingRequirements.every((requirement) => ['handover', 'verification'].includes(requirement.key));
    const hasCompletionEvidence =
      artifactCompletion &&
      (missingRequirements.length === 0 || (mode === 'dev' && onlyLightweightFallbackRequirements));

    if (!hasCompletionEvidence) {
      return false;
    }

    if (complexity === 'small' && turnNumber >= 1) {
      return true;
    }

    return turnNumber >= turnBudget;
  }

  private reconcileMissingRequirementsWithArtifacts(
    mode: 'dev' | 'review',
    missingRequirements: CompletionRequirement[],
    workspaceArtifacts: {
      handover: string | null;
      developmentLog: string | null;
      reviewReport: string | null;
    },
  ): CompletionRequirement[] {
    return missingRequirements.filter((requirement) => {
      if (requirement.key === 'handover' && workspaceArtifacts.handover) {
        return false;
      }

      if (
        requirement.key === 'review_report' &&
        mode === 'review' &&
        workspaceArtifacts.reviewReport &&
        parseCanonicalReviewReport(workspaceArtifacts.reviewReport)
      ) {
        return false;
      }

      if (
        requirement.key === 'verification' &&
        mode === 'dev' &&
        this.artifactSuggestsCompletion(mode, workspaceArtifacts)
      ) {
        return false;
      }

      return true;
    });
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
    completionContext: {
      missing_requirements: CompletionRequirement[];
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
    decision: ReviewDecision,
    content: string | null
  ): string {
    const label = {
      APPROVE: 'Approved',
      APPROVE_MINOR: 'Approved With Minor Suggestions',
      REQUEST_CHANGES: 'Changes Requested',
      REQUEST_TESTS: 'Tests Requested',
      REJECT: 'Rejected',
      MERGE_BLOCKED: 'Merge Blocked',
    }[decision];

    const mergeBlockedContext =
      decision === 'MERGE_BLOCKED'
        ? [
            'Review passed, but the merge failed, so the issue is being sent back to development.',
            '',
          ].join('\n')
        : '';

    return [
      `## Review Result: ${label}`,
      `Issue: ${issue.identifier}`,
      '',
      `${mergeBlockedContext}${content?.trim() || '(No detailed review summary found)'}`,
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
    const reviewDecision = this.normalizeReviewDecision(cliResult.review_decision);
    if (!reviewDecision || reviewDecision === 'APPROVE' || reviewDecision === 'APPROVE_MINOR') {
      return;
    }

    const feedback = cliResult.feedback || await this.readWorkspaceFile(workspacePath, 'REVIEW_REPORT.md');
    if (!feedback) {
      return;
    }

    const handoverPath = this.getWorkflowArtifactPath(workspacePath, 'HANDOVER.md');
    try {
      const fs = await import('fs/promises');
      const handoverContent = await fs.readFile(handoverPath, 'utf-8');
      const updatedHandover = updateHandoverNextSteps(
        handoverContent,
        [
          '### Review Follow-up',
          `- Decision: ${reviewDecision}`,
          '',
          '### Required Next Steps',
          feedback.trim(),
        ].join('\n'),
      );
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

    const normalizedReviewDecision =
      command === 'review' ? this.normalizeReviewDecision(cliResult.review_decision) : null;

    if (
      command === 'review' &&
      normalizedReviewDecision &&
      ['REQUEST_CHANGES', 'REQUEST_TESTS', 'REJECT', 'MERGE_BLOCKED'].includes(normalizedReviewDecision)
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
  private async runAgentAttempt(
    issue: Issue,
    attempt: number | null,
    route: ResolvedRepositoryRoute,
  ): Promise<WorkerResult> {
    const result = this.createWorkerResult(issue.id);
    const isReview = issue.state.toLowerCase() === 'in review';
    let workItem = this.githubMappingService.ensureWorkItem(issue, route.github_repo_full);
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
      const mappingResult = await this.githubMappingService.ensureGitHubIssue(issue, route.github_repo_full);
      workItem = mappingResult.workItem;
      result.work_item_id = workItem.id;

      // Step 1: Create/reuse workspace
      const workspaceResult = await this.workspaceManager.createForIssue(issue, route);
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
      const dispatchResult = await this.runCliCommand('dispatch', issue.identifier, workspace.path, {
        SYMPHONY_GITHUB_OWNER: route.github_owner,
        SYMPHONY_GITHUB_REPO: route.github_repo,
        SYMPHONY_GITHUB_REPO_FULL: route.github_repo_full,
      });
      if (!dispatchResult.success) {
        result.failure_reason = 'dispatch_setup';
        result.error = `dispatch failed: ${dispatchResult.error}`;
        this.workItemRepository.update({
          id: workItem.id,
          orchestrator_state: 'failed',
        });
        return result;
      }

      let governedState = await this.prepareGovernedExecutionState(
        issue,
        workItem.id,
        workspace.path,
        route,
        isReview ? 'review' : 'dev',
      );

      if (route.require_repo_harness && governedState.harness.status !== 'formal') {
        result.failure_reason = 'dispatch_setup';
        result.outcome = 'halted';
        result.next_action = 'stop';
        result.final_state = issue.state;
        result.error = `Formal repo harness required before dispatch for ${route.github_repo_full}.`;
        this.workItemRepository.update({
          id: workItem.id,
          orchestrator_state: 'halted',
        });
        return result;
      }

      if (
        governedState.governance.blocks_dispatch &&
        !this.hasGovernanceOverride(issue)
      ) {
        result.failure_reason = 'dispatch_setup';
        result.outcome = 'halted';
        result.next_action = 'stop';
        result.final_state = issue.state;
        result.error = governedState.governance.summary;
        this.workItemRepository.update({
          id: workItem.id,
          orchestrator_state: 'halted',
        });
        return result;
      }
      if (
        governedState.governance.blocks_dispatch &&
        this.hasGovernanceOverride(issue)
      ) {
        this.emitTimelineEvent(issue, {
          level: 'warn',
          category: 'diagnostic',
          code: 'governance_override_approved',
          message: `Governance override detected for ${issue.identifier}; continuing despite the ${governedState.governance.decision} intake gate.`,
          turn: null,
          tool_name: null,
          detail: {
            issue_identifier: issue.identifier,
            governance_decision: governedState.governance.decision,
          },
        });
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
          governedState = await this.prepareGovernedExecutionState(
            activeIssue,
            workItem.id,
            workspace.path,
            route,
            isReview ? 'review' : 'dev',
          );
          const hasExplicitHarnessRequirements = Boolean(
            governedState.harness.config?.verification?.required_commands?.length ||
            governedState.harness.config?.verification?.required_artifacts?.length,
          );
          const simpleArtifactCompleteWithoutFormalHarness =
            !isReview &&
            (
              judgeComplexity(activeIssue).complexity === 'small' ||
              turnNumber >= turnBudget
            ) &&
            this.artifactSuggestsCompletion('dev', workspaceArtifacts) &&
            !hasExplicitHarnessRequirements;
          const effectiveMissingRequirements = this.reconcileMissingRequirementsWithArtifacts(
            isReview ? 'review' : 'dev',
            governedState.missingRequirements,
            workspaceArtifacts,
          );
          if (simpleArtifactCompleteWithoutFormalHarness) {
            console.log(
              `[orchestrator] Finishing ${activeIssue.identifier} after turn ${turnNumber} because a simple task already has sufficient completion evidence.`,
            );
            sessionActive = false;
            continue;
          }
          if (
            this.shouldAutoFinishAfterTurn(
              isReview ? 'review' : 'dev',
              activeIssue,
              turnNumber,
              turnBudget,
              workspaceArtifacts,
              effectiveMissingRequirements,
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
            completionContext: {
              missing_requirements: effectiveMissingRequirements,
            },
            transcript: turnResult.transcript,
            timeline: turnResult.timeline,
          });

          if (nextAction.kind === 'continue') {
            if (turnNumber >= turnBudget) {
              if (
                effectiveMissingRequirements.length === 0
              ) {
                console.log(
                  `[orchestrator] Forcing finish for ${activeIssue.identifier} at max turns because workspace artifacts indicate completion.`,
                );
                sessionActive = false;
              } else {
                result.next_action = isReview ? 'retry_review' : 'none';
                result.retry_delay_ms = isReview ? 1000 : undefined;
                result.failure_reason = 'agent_turn';
                result.error = isReview
                  ? `Review turn budget exhausted without a canonical .symphony/REVIEW_REPORT.md for ${activeIssue.identifier}.`
                  : `Supervisor requested another turn after reaching max turns (${turnBudget}).`;
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
    const reviewContentFromArtifact = result.workspace_path
      ? await this.readWorkspaceFile(result.workspace_path, 'REVIEW_REPORT.md')
      : null;
    const reviewContent =
      reviewDecision === 'MERGE_BLOCKED'
        ? (result.cli_result?.feedback || reviewContentFromArtifact)
        : (reviewContentFromArtifact || result.cli_result?.feedback || null);
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
        requested_changes_md:
          reviewDecision === 'APPROVE' || reviewDecision === 'APPROVE_MINOR'
            ? null
            : (reviewContent || result.cli_result?.feedback || null),
        merge_block_reason: reviewDecision === 'MERGE_BLOCKED'
          ? (result.cli_result?.feedback || reviewContent || 'Review passed, but merge failed.')
          : null,
      });
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
    const reviewDecision = this.normalizeReviewDecision(result.cli_result?.review_decision) || 'APPROVE';
    const nextRound = workItem.review_round + 1;

    if (workItem.active_pr_number) {
      this.reviewEventRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        pr_number: workItem.active_pr_number,
        review_round: nextRound,
        decision: reviewDecision,
        summary_md: reviewContent || `Approved ${runningEntry.issue.identifier}`,
      });
    }

    if (this.config.reviewPolicy.notifyLinearOnReview) {
      await this.postLinearComment(
        runningEntry.issue.id,
        this.buildLinearReviewComment(runningEntry.issue, reviewDecision, reviewContent)
      );
    }

    await this.syncLinearState(runningEntry.issue, 'Done');
    this.workItemRepository.update({
      id: workItem.id,
      linear_state: 'Done',
      orchestrator_state: 'completed',
      merged_at: new Date(),
      review_round: nextRound,
      last_review_decision: reviewDecision,
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

    if (this.manualStopIssueIds.delete(issueId)) {
      const workItemId =
        result.work_item_id ??
        this.workItemRepository.findByLinearIssueId(issueId)?.id;
      if (workItemId) {
        await this.handleHaltedWorkItem(runningEntry, {
          ...result,
          work_item_id: workItemId,
          final_state: runningEntry.issue.state,
        });
      }

      this.setRunningStage(issueId, 'halted');
      this.state.running.delete(issueId);
      this.state.claimed.delete(issueId);
      this.emit('issue:failed', runningEntry.issue, 'Stopped by user');
      this.emit('state:changed', this.getStateSnapshot());
      return;
    }

    if (result.outcome === 'completed') {
      const workItemForCompletion =
        result.work_item_id ? this.workItemRepository.findById(result.work_item_id) : null;
      if (workItemForCompletion?.repo_harness_status === 'shadow') {
        const shadowRecord = this.shadowHarnessRepository.markRunOutcome(
          workItemForCompletion.github_repo,
          true,
        );
        if (
          shadowRecord &&
          !shadowRecord.adoption_suggested_at &&
          suggestHarnessAdoption({
            successfulRuns: shadowRecord.successful_runs,
            failedRuns: shadowRecord.failed_runs,
          })
        ) {
          this.shadowHarnessRepository.markAdoptionSuggested(workItemForCompletion.github_repo);
          this.governanceSuggestionRepository.create({
            id: crypto.randomUUID(),
            work_item_id: workItemForCompletion.id,
            issue_id: workItemForCompletion.linear_issue_id,
            suggestion_type: 'harness_adoption',
            title: `[GOVERNANCE] Adopt formal repo harness for ${workItemForCompletion.github_repo}`,
            summary: 'This repository has completed several successful runs with the shadow harness. Consider promoting it to a formal .symphony-repo.yaml.',
            detail_json: {
              github_repo: workItemForCompletion.github_repo,
            },
          });
          this.emitTimelineEvent(runningEntry.issue, {
            level: 'info',
            category: 'diagnostic',
            code: 'repo_harness_adoption_suggested',
            message: `Shadow harness for ${workItemForCompletion.github_repo} is stable enough to promote.`,
            turn: null,
            tool_name: null,
            detail: {
              github_repo: workItemForCompletion.github_repo,
            },
          });
        }
      }

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
          await this.workspaceManager.removeWorkspace(result.workspace_path);
        } catch (err) {
          console.warn('[orchestrator] Failed to clean workspace on completion:', err);
        }
      }
      if (result.cleanup_workspace) {
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
          await this.workspaceManager.removeWorkspace(result.workspace_path);
        } catch (err) {
          console.warn('[orchestrator] Failed to clean workspace on halt:', err);
        }
      }
      if (result.cleanup_workspace) {
        try {
          await this.cleanupAllTerminalIssueBranches();
        } catch (err) {
          console.warn('[orchestrator] Failed to clean branches on halt:', err);
        }
      }
    } else {
      const workItemForFailure =
        result.work_item_id ? this.workItemRepository.findById(result.work_item_id) : null;
      if (workItemForFailure?.repo_harness_status === 'shadow') {
        this.shadowHarnessRepository.markRunOutcome(workItemForFailure.github_repo, false);
      }
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
          result.next_action === 'retry_review' ? (result.retry_delay_ms ?? 1000) : (attempt === 2 ? 1000 : undefined)
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
    workspacePath: string,
    envOverrides: Record<string, string> = {},
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
          ...envOverrides,
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
          const workspacePath = runningEntry.workspace_path ?? this.getRouteWorkspacePath(runningEntry.issue, runningEntry.identifier);
          if (workspacePath) {
            await this.workspaceManager.removeWorkspace(workspacePath);
            console.log(`[orchestrator] Workspace cleaned for cancelled issue: ${runningEntry.identifier}`);
          }
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
      const workspacePath = entry.workspace_path ?? this.getRouteWorkspacePath(entry.issue, entry.identifier);
      if (workspacePath) {
        await this.workspaceManager.removeWorkspace(workspacePath);
      }
      await this.cleanupIssueBranch({
        issue: entry.issue,
        workspacePath: entry.workspace_path ?? workspacePath ?? undefined,
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
      const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
      const workspacePath = workItem?.workspace_path ?? this.getRouteWorkspacePath(issue);
      if (!workspacePath) {
        continue;
      }
      try {
        await this.workspaceManager.removeWorkspace(workspacePath);
        console.log('[orchestrator] Cleaned up terminal workspace:', issue.identifier);
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
    const workspacePath = workItem?.workspace_path ?? this.getRouteWorkspacePath(issue);
    try {
      if (workspacePath) {
        await this.workspaceManager.removeWorkspace(workspacePath);
        console.log(`[orchestrator] Cleaned up workspace for merged issue: ${issue.identifier}`);
      }
      await this.cleanupAllTerminalIssueBranches();
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
          const workspacePath = runningEntry.workspace_path ?? this.getRouteWorkspacePath(runningEntry.issue, runningEntry.identifier);
          if (workspacePath) {
            await this.workspaceManager.removeWorkspace(workspacePath);
            cleaned.push(runningEntry.identifier);
            console.log(`[orchestrator] Workspace cleaned for cancelled issue: ${runningEntry.identifier}`);
          }
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
