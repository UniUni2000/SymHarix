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
import * as yaml from 'yaml';
import {
  AgentTimelinePayload,
  ChangePackSummary,
  ChangePackTaskStatus,
  CompletionRequirement,
  ConstitutionHit,
  EffectiveRepositoryHarness,
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
  CloseIssueRequest,
} from '../runtime/types';
import { LinearClient } from '../tracker/linear-client';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { GitHubIssueClient } from '../github/issue-client';
import { WorkspaceManager } from '../workspace/manager';
import { RepoCacheManager } from '../workspace/repoCacheManager';
import { sanitizeWorkspaceKey } from '../workspace/shared';
import { AgentRunner } from '../agent/runner';
import { createDatabase } from '../database';
import {
  AgentRunRepository,
  ConflictMemoryRepository,
  DecisionMemoryRepository,
  DebtSignalRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  ServiceLeaseRepository,
  ShadowHarnessRepository,
  SupervisorMemoryRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
  SyncEventRepository,
  WorkItemRepository
} from '../database';
import type { ReviewDecision, SupervisorSessionRecord } from '../database/types';
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
  buildEffectiveRepositoryHarness,
  inferShadowHarness,
  loadRepositoryConstitution,
  loadRepositoryHarness,
  suggestHarnessAdoption,
  strengthenShadowHarnessFromWorkspace,
} from '../contracts/repositoryContracts';
import { assessIntakeCritic } from '../governance/intakeCritic';
import { analyzeTouchedPathsArchitecture } from '../governance/architectureIntelligence';
import { GlobalRepairService } from '../maintenance/globalRepair';
import {
  deriveArchitectureTarget,
  deriveTouchedPathsFromTimeline,
  FitnessSignalService,
  GovernanceMemoryService,
  GovernanceSuggestionEngine,
} from '../governance/repoIntelligence';
import {
  collectTimelineCommandRuns,
  collectRuntimeObservations,
  collectWorkspaceArtifactObservations,
  evaluateChangePackState,
  initializeChangePack,
  recordChangePackEvidence,
} from '../change-pack/service';
import {
  inferRuntimeLocaleFromText,
  normalizeRuntimeLocale,
  runtimeLocaleInstruction,
} from '../i18n/locale';

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
  delivery_code?: string | null;
  delivery_summary?: string | null;
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
  effectiveHarness: EffectiveRepositoryHarness;
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
  githubIssueClientFactory?: (
    githubRepoFull: string
  ) => Pick<GitHubIssueClient, 'closeIssue' | 'listOpenIssues' | 'listOpenPullRequests' | 'updatePullRequest'>;
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
      delivery_code: parsed.delivery_code ? String(parsed.delivery_code) : null,
      delivery_summary: parsed.delivery_summary ? String(parsed.delivery_summary) : null,
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
  private supervisorSessionRepository: SupervisorSessionRepository;
  private supervisorSessionEventRepository: SupervisorSessionEventRepository;
  private supervisorMemoryRepository: SupervisorMemoryRepository;
  private shadowHarnessRepository: ShadowHarnessRepository;
  private governanceAssessmentRepository: GovernanceAssessmentRepository;
  private governanceSuggestionRepository: GovernanceSuggestionRepository;
  private decisionMemoryRepository: DecisionMemoryRepository;
  private conflictMemoryRepository: ConflictMemoryRepository;
  private debtSignalRepository: DebtSignalRepository;
  private githubMappingService: GitHubMappingService;
  private githubContextService: GitHubContextService;
  private githubSyncService: GitHubSyncService;
  private githubIssueClientFactory: (
    githubRepoFull: string
  ) => Pick<GitHubIssueClient, 'closeIssue' | 'listOpenIssues' | 'listOpenPullRequests' | 'updatePullRequest'>;
  private supervisor: SupervisorService;
  private repositoryRoutingService: RepositoryRoutingService;
  private projectResolutionService: TrackerProjectResolutionService;
  private governanceMemoryService: GovernanceMemoryService;
  private fitnessSignalService: FitnessSignalService;
  private governanceSuggestionEngine: GovernanceSuggestionEngine;

  // Section 4.1.8: Orchestrator Runtime State
  private state: OrchestratorState;

  private pollTimer: NodeJS.Timeout | null = null;
  private leaseRenewTimer: NodeJS.Timeout | null = null;
  private startupCleanupTimer: NodeJS.Timeout | null = null;
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
    this.supervisorSessionRepository = new SupervisorSessionRepository(this.db);
    this.supervisorSessionEventRepository = new SupervisorSessionEventRepository(this.db);
    this.supervisorMemoryRepository = new SupervisorMemoryRepository(this.db);
    this.shadowHarnessRepository = dependencies.shadowHarnessRepository ?? new ShadowHarnessRepository(this.db);
    this.governanceAssessmentRepository =
      dependencies.governanceAssessmentRepository ?? new GovernanceAssessmentRepository(this.db);
    this.governanceSuggestionRepository =
      dependencies.governanceSuggestionRepository ?? new GovernanceSuggestionRepository(this.db);
    this.decisionMemoryRepository = new DecisionMemoryRepository(this.db);
    this.conflictMemoryRepository = new ConflictMemoryRepository(this.db);
    this.debtSignalRepository = new DebtSignalRepository(this.db);
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
    this.githubIssueClientFactory = dependencies.githubIssueClientFactory ?? ((githubRepoFull: string) => createGitHubIssueClient(
      config.githubToken,
      githubRepoFull,
      config.githubOwner,
    ));
    this.supervisor = dependencies.supervisor ?? new AnthropicSupervisorService();
    this.projectResolutionService =
      dependencies.projectResolutionService ??
      new TrackerProjectResolutionService(this.tracker, config.repositories.routing);
    this.governanceMemoryService = new GovernanceMemoryService({
      workItemRepository: this.workItemRepository,
      reviewEventRepository: this.reviewEventRepository,
      governanceAssessmentRepository: this.governanceAssessmentRepository,
      governanceSuggestionRepository: this.governanceSuggestionRepository,
      decisionMemoryRepository: this.decisionMemoryRepository,
      conflictMemoryRepository: this.conflictMemoryRepository,
      debtSignalRepository: this.debtSignalRepository,
    });
    this.fitnessSignalService = new FitnessSignalService({
      workItemRepository: this.workItemRepository,
      reviewEventRepository: this.reviewEventRepository,
      governanceAssessmentRepository: this.governanceAssessmentRepository,
    });
    this.governanceSuggestionEngine = new GovernanceSuggestionEngine();
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

  private createGitHubWriteClient(githubRepoFull: string): GitHubIssueClient {
    return createGitHubIssueClient(
      this.config.githubToken,
      githubRepoFull,
      this.config.githubOwner,
    );
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
      // Delay and run in the background so first-turn HTTP/webhook traffic is
      // not competing with historical workspace and orphan repair.
      const startupCleanupDelayMs = Number.parseInt(process.env.SYMPHONY_STARTUP_CLEANUP_DELAY_MS || '', 10);
      this.startupCleanupTimer = setTimeout(() => {
        this.startupCleanupTimer = null;
        if (!this.running || this.stopRequested) {
          return;
        }
        void this.startupTerminalCleanup().catch((error) => {
          console.warn('[orchestrator] Startup terminal cleanup failed, continuing:', error);
        });
      }, Number.isFinite(startupCleanupDelayMs) && startupCleanupDelayMs >= 0 ? startupCleanupDelayMs : 900_000);

      // Give Telegram/session repair a short startup window to preempt stale
      // active threads before the orchestrator resumes polling old tracker work.
      const firstTickDelayMs = Number.parseInt(process.env.SYMPHONY_FIRST_TICK_DELAY_MS || '', 10);
      this.scheduleTick(Number.isFinite(firstTickDelayMs) && firstTickDelayMs >= 0 ? firstTickDelayMs : 10_000);

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
    if (this.startupCleanupTimer) {
      clearTimeout(this.startupCleanupTimer);
      this.startupCleanupTimer = null;
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
    return this.createIssueInternal(input, {
      defer_dispatch: input.defer_dispatch ?? undefined,
      governance_lineage: input.governance_lineage ?? undefined,
    });
  }

  private async createIssueInternal(
    input: CreateIssueRequest,
    options: {
      defer_dispatch?: boolean;
      schedule_tick?: boolean;
      governance_lineage?: {
        root_issue_id: string;
        parent_issue_id: string | null;
        generation: number;
      } | null;
    } = {},
  ): Promise<CreateIssueResult> {
    const deferDispatch = options.defer_dispatch ?? false;
    const scheduleTickWhenRunning = options.schedule_tick ?? true;
    const inheritedLocale = options.governance_lineage?.root_issue_id
      ? this.workItemRepository.findByLinearIssueId(options.governance_lineage.root_issue_id)?.supervisor_locale ?? null
      : null;
    const supervisorLocale = normalizeRuntimeLocale(input.supervisor_locale)
      ?? inheritedLocale
      ?? inferRuntimeLocaleFromText(`${input.title}\n${input.description ?? ''}`);
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
      const lineage = options.governance_lineage ?? null;
      const normalizedWorkItem = this.workItemRepository.update({
        id: workItem.id,
        governance_root_issue_id: lineage?.root_issue_id ?? issue.id,
        governance_parent_issue_id: lineage?.parent_issue_id ?? null,
        governance_generation: lineage?.generation ?? 0,
        supervisor_root_session_id: input.supervisor_execution_intent?.root_session_id ?? workItem.supervisor_root_session_id,
        supervisor_locale: supervisorLocale,
        supervisor_plan_summary: input.supervisor_execution_intent?.plan_summary ?? workItem.supervisor_plan_summary,
        supervisor_acceptance_summary: input.supervisor_execution_intent?.acceptance_summary ?? workItem.supervisor_acceptance_summary,
        supervisor_execution_mode: input.supervisor_execution_intent?.approved_execution_mode ?? workItem.supervisor_execution_mode,
      }) ?? workItem;
      const targetArea = this.inferGovernanceTargetArea(issue, normalizedWorkItem);
      const repoIntelligence = this.buildRepoIntelligenceContext(route.github_repo_full);
      governance = await assessIntakeCritic({
        issue,
        route,
        repositoryRoot: route.local_path,
        repoSnapshot: repoIntelligence.repoSnapshot,
        activeFitnessSignals: repoIntelligence.activeSignals,
      });
      this.workItemRepository.update({
        id: normalizedWorkItem.id,
        repo_harness_status: governance.repo_harness_status,
        constitution_status: governance.constitution_status,
        governance_status: governance.status,
        governance_decision: governance.decision,
        governance_summary: governance.summary,
        governance_source_updated_at: governance.blocks_dispatch ? issue.updated_at ?? null : null,
        constitution_hits: governance.constitution_hits,
        orchestrator_state:
          governance.blocks_dispatch && !this.hasGovernanceOverride(issue)
            ? 'halted'
            : normalizedWorkItem.orchestrator_state,
      });
      this.governanceAssessmentRepository.create({
        id: crypto.randomUUID(),
        work_item_id: normalizedWorkItem.id,
        issue_id: issue.id,
        decision: governance.decision,
        status: governance.status,
        summary: governance.summary,
        constitution_hits_json: governance.constitution_hits,
        detail_json: {
          phase: 'intake',
          repo_harness_status: governance.repo_harness_status,
          constitution_status: governance.constitution_status,
          target_area: targetArea,
          architectural_target: normalizedWorkItem.architectural_target ?? targetArea,
          path_families: normalizedWorkItem.path_families,
          boundary_edges: normalizedWorkItem.boundary_edges,
          import_edges: normalizedWorkItem.import_edges,
          repo_key: governance.repo_key,
          active_fitness_signals: governance.active_fitness_signals,
          related_conflict_count: governance.related_conflict_count,
          related_debt_signal_count: governance.related_debt_signal_count,
          repeated_constitution_phrase: governance.repeated_constitution_phrase,
          rewrite_title: governance.rewrite_title,
          rewrite_description: governance.rewrite_description,
          split_suggestions: governance.split_suggestions,
          blocks_dispatch: governance.blocks_dispatch,
        },
      });
      this.ensureGovernanceSuggestions(issue, normalizedWorkItem.id, route, governance);
      this.recordGovernanceMemoryOutcome(normalizedWorkItem.id, issue, governance);
      this.refreshRepoGovernanceIntelligence(issue, normalizedWorkItem.id, route.github_repo_full);
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
        if (scheduleTickWhenRunning) {
          this.scheduleTick(0);
        }
      } else if (!deferDispatch && route && this.hasAvailableSlots() && this.shouldDispatch(issue)) {
        await this.dispatchIssue(issue, null);
        message = `Created ${issue.identifier} and dispatched it`;
      } else if (!route) {
        message = `Created ${issue.identifier}, but dispatch is blocked: repository route is not configured`;
      } else {
        if (deferDispatch && this.shouldDispatch(issue)) {
          message = `Created ${issue.identifier} and queued it for dispatch`;
        }
        if (scheduleTickWhenRunning && !deferDispatch) {
          this.scheduleTick(0);
        }
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

    if (this.isActiveTrackerState(workItem.linear_state)) {
      this.state.claimed.delete(workItem.linear_issue_id);
      this.state.completed.delete(workItem.linear_issue_id);
      this.workItemRepository.update({
        id: workItem.id,
        orchestrator_state: 'halted',
        delivery_code: 'manual_stop',
        delivery_summary: '这张单已被手动停止；除非用户显式 retry 或更新 tracker 内容，否则不会自动重启。',
      });
      this.emit('state:changed', this.getStateSnapshot());
      return {
        accepted: true,
        status: 'completed',
        message: `Stopped ${workItem.linear_identifier}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
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

  async closeIssue(issueId: string, request: CloseIssueRequest = {}): Promise<RuntimeActionResult> {
    const workItem = this.resolveWorkItemRef(issueId);
    if (!workItem) {
      return {
        accepted: false,
        status: 'not_found',
        message: `Issue ${issueId} was not found`,
        issue_id: null,
        issue_identifier: null,
      };
    }

    const runningEntry = this.state.running.get(workItem.linear_issue_id);
    if (runningEntry) {
      await this.terminateRunningIssue(runningEntry, false);
    }

    const retryEntry = this.state.retry_attempts.get(workItem.linear_issue_id);
    if (retryEntry?.timer_handle) {
      clearTimeout(retryEntry.timer_handle);
    }
    this.state.retry_attempts.delete(workItem.linear_issue_id);
    this.state.claimed.delete(workItem.linear_issue_id);
    this.state.completed.add(workItem.linear_issue_id);

    const successor = request.successor_issue_id ? this.resolveWorkItemRef(request.successor_issue_id) : null;
    const successorIdentifier =
      successor?.linear_identifier ?? request.successor_issue_id?.trim() ?? null;
    const cancellationState = this.resolveCancellationStateName();
    const issue = this.buildSyntheticIssueFromWorkItem(workItem);
    const deliveryCode = successorIdentifier ? 'superseded' : 'manual_close';
    const deliverySummary = successorIdentifier
      ? `这张单已关闭；后续由 ${successorIdentifier} 承接。`
      : '这张单已按用户要求关闭，不会继续自动推进。';

    const trackerSync = await this.syncLinearState(issue, cancellationState);
    this.recordSyncEvent({
      workItemId: workItem.id,
      targetSystem: 'linear',
      action: 'update_state',
      payload: {
        issue_identifier: workItem.linear_identifier,
        from_state: workItem.linear_state,
        to_state: trackerSync.currentState ?? cancellationState,
        successor_issue_identifier: successorIdentifier,
      },
      success: trackerSync.success,
      error: trackerSync.error,
    });

    const commentResult = await this.tracker.postComment(
      workItem.linear_issue_id,
      this.buildManualCloseComment({
        workItem,
        successorIdentifier,
        reason: request.reason ?? null,
        deliverySummary,
      }),
    );
    this.recordSyncEvent({
      workItemId: workItem.id,
      targetSystem: 'linear',
      action: 'post_comment',
      payload: {
        issue_identifier: workItem.linear_identifier,
        successor_issue_identifier: successorIdentifier,
      },
      success: commentResult.success,
      error: commentResult.error ?? null,
    });

    const updatedWorkItem = this.workItemRepository.update({
      id: workItem.id,
      linear_state: trackerSync.currentState ?? cancellationState,
      orchestrator_state: 'cancelled',
      delivery_code: deliveryCode,
      delivery_summary: deliverySummary,
      cancelled_at: new Date(),
    }) ?? workItem;

    await this.cleanupTerminalWorkItemResidue(
      updatedWorkItem,
      issue,
      successorIdentifier
        ? `${workItem.linear_identifier} superseded by ${successorIdentifier}`
        : `${workItem.linear_identifier} manual close`,
      { successorIdentifier },
    );

    this.emit('issue:completed', issue, false);
    this.emit('state:changed', this.getStateSnapshot());

    return {
      accepted: true,
      status: 'completed',
      message: successorIdentifier
        ? `Closed ${workItem.linear_identifier}; successor ${successorIdentifier}`
        : `Closed ${workItem.linear_identifier}`,
      issue_id: workItem.linear_issue_id,
      issue_identifier: workItem.linear_identifier,
      delivery_code: deliveryCode,
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

    const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
    if (this.isTerminalTrackerState(issue.state) && !this.isCancelledTrackerState(issue.state)) {
      if (!workItem) {
        return {
          accepted: true,
          status: 'completed',
          message: `${issue.identifier} is already ${issue.state}; no retry is needed`,
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          delivery_code: 'tracker_terminal_reconciled',
        };
      }
      await this.reconcileTerminalCompletedWorkItem(issue, workItem, 'manual retry');
      return {
        accepted: true,
        status: 'completed',
        message: `${issue.identifier} is already ${issue.state}; reconciled local runtime state instead of retrying DEV`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        delivery_code: 'tracker_terminal_reconciled',
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

    const workspaceReviewReconcile = await this.reconcileWorkspaceAlreadyInReview(issue, workItem);
    if (workspaceReviewReconcile) {
      return workspaceReviewReconcile;
    }

    if (this.hasAvailableSlots() && this.shouldDispatch(issue)) {
      if (workItem) {
        this.workItemRepository.update({
          id: workItem.id,
          linear_state: issue.state,
          orchestrator_state: 'discovering',
          delivery_code: null,
          delivery_summary: null,
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
        delivery_code: null,
        delivery_summary: null,
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
    this.governanceMemoryService.recordConflictOutcome(workItem.id, {
      kind: 'governance_override',
      summary: `Governance override approved for ${issue.identifier}: ${workItem.governance_decision ?? 'previous gate'}`,
      constitution_phrase: workItem.constitution_hits[0]?.phrase ?? null,
      target_area: this.inferGovernanceTargetArea(issue, workItem),
    });
    this.refreshRepoGovernanceIntelligence(issue, workItem.id, workItem.github_repo);

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
    this.recordGovernanceMemoryOutcome(workItem.id, refreshedIssue, refreshedGovernance);
    this.refreshRepoGovernanceIntelligence(refreshedIssue, workItem.id, route.github_repo_full);
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

    this.workItemRepository.update({
      id: workItem.id,
      governance_root_issue_id: workItem.governance_root_issue_id ?? issue.id,
      governance_parent_issue_id: workItem.governance_parent_issue_id ?? null,
      governance_generation: workItem.governance_generation ?? 0,
    });

    const createdIdentifiers: string[] = [];
    for (let index = 1; index < splitSuggestions.length; index += 1) {
      const childDraft = this.buildGovernanceSplitDraft(issue, splitSuggestions[index]!, index, splitSuggestions.length);
      const existingChild = this.findEquivalentOpenGovernanceChild({
        rootIssueId: workItem.governance_root_issue_id ?? issue.id,
        githubRepo: workItem.github_repo,
        architecturalTarget: childDraft.architectural_target,
      });
      if (existingChild) {
        createdIdentifiers.push(existingChild.linear_identifier);
        continue;
      }
      const created = await this.createIssueInternal({
        title: childDraft.title,
        description: childDraft.description,
        project_slug: issue.project_slug,
      }, {
        defer_dispatch: true,
        schedule_tick: false,
        governance_lineage: {
          root_issue_id: workItem.governance_root_issue_id ?? issue.id,
          parent_issue_id: issue.id,
          generation: (workItem.governance_generation ?? 0) + 1,
        },
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
      if (created.issue_id) {
        const childWorkItem = this.workItemRepository.findByLinearIssueId(created.issue_id);
        if (childWorkItem) {
          this.inheritSupervisorContext(workItem, childWorkItem.id);
          this.workItemRepository.update({
            id: childWorkItem.id,
            orchestrator_state: index > 1 ? 'halted' : childWorkItem.orchestrator_state,
            architectural_target: childDraft.architectural_target,
          });
        }
      }
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
    this.recordGovernanceMemoryOutcome(workItem.id, refreshedIssue, refreshedGovernance);
    this.refreshRepoGovernanceIntelligence(refreshedIssue, workItem.id, route.github_repo_full);
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

    if (createdIdentifiers.length > 0) {
      this.workItemRepository.update({
        id: workItem.id,
        orchestrator_state: 'halted',
      });
    }

    if (
      createdIdentifiers.length === 0 &&
      !refreshedGovernance.blocks_dispatch &&
      this.running &&
      this.hasAvailableSlots() &&
      this.shouldDispatch(refreshedIssue)
    ) {
      await this.dispatchIssue(refreshedIssue, null);
      return {
        accepted: true,
        status: 'accepted',
        message: `Split applied for ${refreshedIssue.identifier}, created ${createdIdentifiers.join(', ')}, and dispatched the rewritten issue`,
        issue_id: refreshedIssue.id,
        issue_identifier: refreshedIssue.identifier,
        governance_action: {
          outcome_kind: 'unblocked',
          root_issue_identifier: refreshedIssue.identifier,
          created_issue_identifiers: createdIdentifiers,
          next_recommended_action: null,
          user_summary: `已按拆分方案处理 ${refreshedIssue.identifier}，并重新启动源单开发。`,
        },
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
      governance_action: {
        outcome_kind: createdIdentifiers.length > 0 ? 'waiting_on_child' : (refreshedGovernance.blocks_dispatch ? 'child_still_blocked' : 'unblocked'),
        root_issue_identifier: refreshedIssue.identifier,
        created_issue_identifiers: createdIdentifiers,
        next_recommended_action: createdIdentifiers[0] ? `先处理治理子任务 ${createdIdentifiers[0]}；其余子任务会按顺序自动接力。` : null,
        user_summary: createdIdentifiers.length > 0
          ? `已为 ${refreshedIssue.identifier} 创建治理子任务 ${createdIdentifiers.join('、')}，当前先处理 ${createdIdentifiers[0]}，其余子任务会按顺序自动接力，源单仍保持暂停。`
          : refreshedGovernance.summary,
      },
    };
  }

  async executeGovernanceSuggestion(issueId: string, suggestionId: string): Promise<RuntimeActionResult> {
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

    const suggestion = this.governanceSuggestionRepository.findById(suggestionId);
    if (!suggestion || suggestion.issue_id !== workItem.linear_issue_id) {
      return {
        accepted: false,
        status: 'not_found',
        message: `Governance suggestion ${suggestionId} was not found for ${workItem.linear_identifier}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
      };
    }

    if (suggestion.status !== 'pending') {
      return {
        accepted: false,
        status: 'rejected',
        message: `Governance suggestion ${suggestion.title} is already ${suggestion.status}`,
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

    const sourceIssue = fetched.issue ?? this.buildSyntheticIssueFromWorkItem(workItem);
    if (!sourceIssue.project_slug?.trim()) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${sourceIssue.identifier} does not have a project_slug, so Symphony cannot create a governance follow-up issue`,
        issue_id: sourceIssue.id,
        issue_identifier: sourceIssue.identifier,
      };
    }

    const route = this.tryResolveRepositoryRoute(sourceIssue);
    if (!route) {
      return {
        accepted: false,
        status: 'rejected',
        message: `Repository route is not configured for ${sourceIssue.identifier}`,
        issue_id: sourceIssue.id,
        issue_identifier: sourceIssue.identifier,
      };
    }

    if (
      (workItem.governance_generation ?? 0) > 0 &&
      suggestion.suggestion_type !== 'harness_adoption' &&
      suggestion.suggestion_type !== 'constitution_update'
    ) {
      return {
        accepted: false,
        status: 'rejected',
        message: `${sourceIssue.identifier} 已经是治理子任务，Symphony 不会继续自动创建下一层治理 issue。请直接 rewrite/split/override 这张子任务。`,
        issue_id: sourceIssue.id,
        issue_identifier: sourceIssue.identifier,
        governance_action: {
          outcome_kind: 'child_still_blocked',
          root_issue_identifier: this.workItemRepository.findByLinearIssueId(workItem.governance_root_issue_id ?? sourceIssue.id)?.linear_identifier ?? sourceIssue.identifier,
          created_issue_identifiers: [],
          next_recommended_action: `直接处理子任务 ${sourceIssue.identifier}`,
          user_summary: `${sourceIssue.identifier} 仍需人工处理，系统已停止继续向下递归创建治理 issue。`,
        },
      };
    }

    if (suggestion.suggestion_type === 'harness_adoption' || suggestion.suggestion_type === 'constitution_update') {
      try {
        const pr = await this.executeGovernancePullRequestSuggestion({
          issue: sourceIssue,
          route,
          workItem,
          suggestion,
        });
        this.governanceSuggestionRepository.updateStatus(suggestion.id, 'accepted');
        this.governanceAssessmentRepository.create({
          id: crypto.randomUUID(),
          work_item_id: workItem.id,
          issue_id: sourceIssue.id,
          decision: workItem.governance_decision ?? 'accept',
          status: workItem.governance_status ?? 'advisory',
          summary: `Accepted governance suggestion: ${suggestion.title}`,
          constitution_hits_json: workItem.constitution_hits,
          detail_json: {
            event: 'suggestion_executed',
            suggestion_id: suggestion.id,
            suggestion_type: suggestion.suggestion_type,
            branch_name: pr.branch_name,
            pr_number: pr.pr_number,
            pr_url: pr.pr_url,
            target_area: suggestion.detail_json?.target_area ?? null,
          },
        });
        this.syncEventRepository.create({
          id: crypto.randomUUID(),
          work_item_id: workItem.id,
          target_system: 'github',
          action: 'execute_governance_suggestion',
          payload_json: {
            suggestion_id: suggestion.id,
            suggestion_type: suggestion.suggestion_type,
            branch_name: pr.branch_name,
            pr_number: pr.pr_number,
            pr_url: pr.pr_url,
          },
        });
        this.emitTimelineEvent(sourceIssue, {
          level: 'info',
          category: 'diagnostic',
          code: 'governance_suggestion_executed',
          message: `Executed governance suggestion ${suggestion.title}.`,
          turn: null,
          tool_name: null,
          detail: {
            suggestion_id: suggestion.id,
            suggestion_type: suggestion.suggestion_type,
            branch_name: pr.branch_name,
            pr_number: pr.pr_number,
            pr_url: pr.pr_url,
          },
        });
        this.refreshRepoGovernanceIntelligence(sourceIssue, workItem.id, workItem.github_repo);
        this.emit('state:changed', this.getStateSnapshot());

        return {
          accepted: true,
          status: 'accepted',
          message: `Executed ${suggestion.title} and opened draft PR #${pr.pr_number}`,
          issue_id: sourceIssue.id,
          issue_identifier: sourceIssue.identifier,
          governance_action: {
            outcome_kind: 'unblocked',
            root_issue_identifier: sourceIssue.identifier,
            created_issue_identifiers: [],
            next_recommended_action: null,
            user_summary: `已为 ${sourceIssue.identifier} 创建治理 PR 草稿 #${pr.pr_number}。`,
          },
        };
      } catch (error) {
        return {
          accepted: false,
          status: 'rejected',
          message: error instanceof Error ? error.message : String(error),
          issue_id: sourceIssue.id,
          issue_identifier: sourceIssue.identifier,
          governance_action: {
            outcome_kind: 'failed',
            root_issue_identifier: sourceIssue.identifier,
            created_issue_identifiers: [],
            next_recommended_action: null,
            user_summary: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    const recommendedTitle =
      typeof suggestion.detail_json?.recommended_issue_title === 'string' &&
      suggestion.detail_json.recommended_issue_title.trim()
        ? suggestion.detail_json.recommended_issue_title.trim()
        : suggestion.title;
    const title = recommendedTitle.startsWith('[GOVERNANCE FOLLOW-UP')
      ? recommendedTitle
      : `[GOVERNANCE FOLLOW-UP for ${sourceIssue.identifier}] ${recommendedTitle}`;
    const architecturalTarget = this.normalizeGovernanceArchitecturalTarget(
      typeof suggestion.detail_json?.architectural_target === 'string'
        ? suggestion.detail_json.architectural_target
        : (typeof suggestion.detail_json?.target_area === 'string'
          ? suggestion.detail_json.target_area
          : null),
    );
    const description = [
      `来源 issue: ${sourceIssue.identifier}`,
      `创建原因: ${suggestion.summary}`,
      `目标仓库: ${workItem.github_repo}`,
      typeof suggestion.detail_json?.target_area === 'string' && suggestion.detail_json.target_area.trim()
        ? `目标 area: ${suggestion.detail_json.target_area.trim()}`
        : null,
      `建议类型: ${suggestion.suggestion_type}`,
      '完成这个治理子任务后，可以帮助源 issue 回到更清晰的主路径。',
      typeof suggestion.detail_json?.recommended_issue_description === 'string' &&
      suggestion.detail_json.recommended_issue_description.trim()
        ? suggestion.detail_json.recommended_issue_description.trim()
        : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n');

    const existingChild = this.findEquivalentOpenGovernanceChild({
      rootIssueId: workItem.governance_root_issue_id ?? sourceIssue.id,
      githubRepo: workItem.github_repo,
      architecturalTarget,
    });
    if (existingChild) {
      this.governanceSuggestionRepository.updateStatus(suggestion.id, 'accepted');
      this.governanceAssessmentRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        issue_id: sourceIssue.id,
        decision: workItem.governance_decision ?? 'accept',
        status: workItem.governance_status ?? 'advisory',
        summary: `Accepted governance suggestion: ${suggestion.title}`,
        constitution_hits_json: workItem.constitution_hits,
        detail_json: {
          event: 'suggestion_reused_existing_child',
          suggestion_id: suggestion.id,
          suggestion_type: suggestion.suggestion_type,
          reused_issue_id: existingChild.linear_issue_id,
          reused_issue_identifier: existingChild.linear_identifier,
          target_area: suggestion.detail_json?.target_area ?? null,
          architectural_target: architecturalTarget,
        },
      });
      this.emitTimelineEvent(sourceIssue, {
        level: 'info',
        category: 'diagnostic',
        code: 'governance_suggestion_reused_child',
        message: `Reused existing governance child ${existingChild.linear_identifier} for ${suggestion.title}.`,
        turn: null,
        tool_name: null,
        detail: {
          suggestion_id: suggestion.id,
          suggestion_type: suggestion.suggestion_type,
          reused_issue_identifier: existingChild.linear_identifier,
          architectural_target: architecturalTarget,
        },
      });
      this.refreshRepoGovernanceIntelligence(sourceIssue, workItem.id, workItem.github_repo);
      this.emit('state:changed', this.getStateSnapshot());

      return {
        accepted: true,
        status: 'accepted',
        message: `Reused existing governance child ${existingChild.linear_identifier} for ${suggestion.title}`,
        issue_id: sourceIssue.id,
        issue_identifier: sourceIssue.identifier,
        governance_action: {
          outcome_kind: 'waiting_on_child',
          root_issue_identifier: sourceIssue.identifier,
          created_issue_identifiers: [existingChild.linear_identifier],
          next_recommended_action: `先处理治理子任务 ${existingChild.linear_identifier}`,
          user_summary: `${sourceIssue.identifier} 已关联到现有治理子任务 ${existingChild.linear_identifier}，不会重复创建等价子单。`,
        },
      };
    }

    const created = await this.createIssueInternal({
      title,
      description,
      project_slug: sourceIssue.project_slug,
    }, {
      defer_dispatch: true,
      schedule_tick: false,
      governance_lineage: {
        root_issue_id: workItem.governance_root_issue_id ?? sourceIssue.id,
        parent_issue_id: sourceIssue.id,
        generation: (workItem.governance_generation ?? 0) + 1,
      },
    });
    if (!created.accepted) {
      return {
        accepted: false,
        status: created.status,
        message: created.message || `Failed to create governance follow-up issue for ${sourceIssue.identifier}`,
        issue_id: sourceIssue.id,
        issue_identifier: sourceIssue.identifier,
        governance_action: {
          outcome_kind: 'failed',
          root_issue_identifier: sourceIssue.identifier,
          created_issue_identifiers: [],
          next_recommended_action: null,
          user_summary: created.message || `Failed to create governance follow-up issue for ${sourceIssue.identifier}`,
        },
      };
    }

    if (created.issue_id) {
      const createdWorkItem = this.workItemRepository.findByLinearIssueId(created.issue_id);
      if (createdWorkItem) {
        this.inheritSupervisorContext(workItem, createdWorkItem.id);
        if (architecturalTarget) {
          this.workItemRepository.update({
            id: createdWorkItem.id,
            architectural_target: architecturalTarget,
          });
        }
      }
    }

    this.governanceSuggestionRepository.updateStatus(suggestion.id, 'accepted');
    this.governanceAssessmentRepository.create({
      id: crypto.randomUUID(),
      work_item_id: workItem.id,
      issue_id: sourceIssue.id,
      decision: workItem.governance_decision ?? 'accept',
      status: workItem.governance_status ?? 'advisory',
      summary: `Accepted governance suggestion: ${suggestion.title}`,
      constitution_hits_json: workItem.constitution_hits,
      detail_json: {
        event: 'suggestion_executed',
        suggestion_id: suggestion.id,
        suggestion_type: suggestion.suggestion_type,
        created_issue_id: created.issue_id,
        created_issue_identifier: created.issue_identifier,
        target_area: suggestion.detail_json?.target_area ?? null,
      },
    });
    this.syncEventRepository.create({
      id: crypto.randomUUID(),
      work_item_id: workItem.id,
      target_system: 'linear',
      action: 'execute_governance_suggestion',
      payload_json: {
        suggestion_id: suggestion.id,
        suggestion_type: suggestion.suggestion_type,
        created_issue_id: created.issue_id,
        created_issue_identifier: created.issue_identifier,
      },
    });
    this.emitTimelineEvent(sourceIssue, {
      level: 'info',
      category: 'diagnostic',
      code: 'governance_suggestion_executed',
      message: `Executed governance suggestion ${suggestion.title}.`,
      turn: null,
      tool_name: null,
      detail: {
        suggestion_id: suggestion.id,
        suggestion_type: suggestion.suggestion_type,
        created_issue_identifier: created.issue_identifier,
        target_area: suggestion.detail_json?.target_area ?? null,
      },
    });
    this.refreshRepoGovernanceIntelligence(sourceIssue, workItem.id, workItem.github_repo);
    this.workItemRepository.update({
      id: workItem.id,
      orchestrator_state: 'halted',
    });
    this.emit('state:changed', this.getStateSnapshot());

    return {
      accepted: true,
      status: 'accepted',
      message: `Executed ${suggestion.title} and created ${created.issue_identifier ?? 'a governance issue'}`,
      issue_id: sourceIssue.id,
      issue_identifier: sourceIssue.identifier,
      governance_action: {
        outcome_kind: 'waiting_on_child',
        root_issue_identifier: sourceIssue.identifier,
        created_issue_identifiers: created.issue_identifier ? [created.issue_identifier] : [],
        next_recommended_action: created.issue_identifier ? `先处理治理子任务 ${created.issue_identifier}` : null,
        user_summary: created.issue_identifier
          ? `已为 ${sourceIssue.identifier} 创建治理子任务 ${created.issue_identifier}，源单仍在等待这个子任务先被处理。`
          : `已为 ${sourceIssue.identifier} 创建治理子任务。`,
      },
    };
  }

  async dismissGovernanceSuggestion(issueId: string, suggestionId: string): Promise<RuntimeActionResult> {
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

    const suggestion = this.governanceSuggestionRepository.findById(suggestionId);
    if (!suggestion || suggestion.issue_id !== workItem.linear_issue_id) {
      return {
        accepted: false,
        status: 'not_found',
        message: `Governance suggestion ${suggestionId} was not found for ${workItem.linear_identifier}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
      };
    }

    if (suggestion.status === 'dismissed') {
      return {
        accepted: true,
        status: 'completed',
        message: `Dismissed ${suggestion.title}`,
        issue_id: workItem.linear_issue_id,
        issue_identifier: workItem.linear_identifier,
      };
    }

    this.governanceSuggestionRepository.updateStatus(suggestion.id, 'dismissed');
    this.governanceAssessmentRepository.create({
      id: crypto.randomUUID(),
      work_item_id: workItem.id,
      issue_id: workItem.linear_issue_id,
      decision: workItem.governance_decision ?? 'accept',
      status: workItem.governance_status ?? 'advisory',
      summary: `Dismissed governance suggestion: ${suggestion.title}`,
      constitution_hits_json: workItem.constitution_hits,
      detail_json: {
        event: 'suggestion_dismissed',
        suggestion_id: suggestion.id,
        suggestion_type: suggestion.suggestion_type,
      },
    });
    this.syncEventRepository.create({
      id: crypto.randomUUID(),
      work_item_id: workItem.id,
      target_system: 'linear',
      action: 'dismiss_governance_suggestion',
      payload_json: {
        suggestion_id: suggestion.id,
        suggestion_type: suggestion.suggestion_type,
      },
    });
    this.emitTimelineEvent(this.buildSyntheticIssueFromWorkItem(workItem), {
      level: 'info',
      category: 'diagnostic',
      code: 'governance_suggestion_dismissed',
      message: `Dismissed governance suggestion ${suggestion.title}.`,
      turn: null,
      tool_name: null,
      detail: {
        suggestion_id: suggestion.id,
        suggestion_type: suggestion.suggestion_type,
      },
    });
    this.refreshRepoGovernanceIntelligence(this.buildSyntheticIssueFromWorkItem(workItem), workItem.id, workItem.github_repo);
    this.emit('state:changed', this.getStateSnapshot());

    return {
      accepted: true,
      status: 'accepted',
      message: `Dismissed ${suggestion.title}`,
      issue_id: workItem.linear_issue_id,
      issue_identifier: workItem.linear_identifier,
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
        await this.reconcileTrackedTerminalStates();

        // Step 2: Run dispatch preflight validation (Section 6.3)
        const validation = this.validateDispatchConfig();
        if (!validation.valid) {
          console.error('[orchestrator] Dispatch validation failed:', validation.errors);
          this.emit('error', new Error(validation.errors.join(', ')));
          this.scheduleTick(this.state.poll_interval_ms);
          return;
        }

        // Step 3: Dispatch locally known review handoffs before relying on the
        // tracker poll. Linear can lag immediately after DEV moves a task to
        // In Review, but the work item already contains the source of truth.
        const dispatchedThisTick = new Set<string>();
        await this.dispatchLocalReviewReadyWorkItems(dispatchedThisTick);

        // Step 4: Fetch candidate issues
        const { issues, error: fetchError } = await this.tracker.fetchCandidateIssues(
          this.config.activeStates
        );

        if (fetchError) {
          console.error('[orchestrator] Failed to fetch candidate issues:', fetchError);
          this.scheduleTick(this.state.poll_interval_ms);
          return;
        }

        // Step 5: Sort issues by dispatch priority (Section 8.2)
        const sortedIssues = this.sortForDispatch(issues);

        // Step 6: Dispatch eligible issues while slots remain
        // Use a local set to track issues dispatched in THIS tick, preventing
        // the same issue from being dispatched multiple times in one loop.
        for (const issue of sortedIssues) {
          if (!this.hasAvailableSlots()) {
            break;
          }

          // Skip if already dispatched in this tick (e.g., re-dispatched after cleanup)
          if (dispatchedThisTick.has(issue.id)) {
            continue;
          }

          if (await this.finalizeCompletedSupervisorRootIfNeeded(issue)) {
            continue;
          }

          await this.reassessGovernanceBlockedIssueIfNeeded(issue);

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

  private findTrackedWorkItem(issue: Issue): WorkItem | null {
    return this.workItemRepository.findByLinearIssueId(issue.id)
      ?? this.workItemRepository.findByIdentifier(issue.identifier);
  }

  private resolveWorkItemRef(issueRef: string): WorkItem | null {
    const normalized = issueRef.trim();
    if (!normalized) {
      return null;
    }
    return this.workItemRepository.findById(normalized)
      ?? this.workItemRepository.findByLinearIssueId(normalized)
      ?? this.workItemRepository.findByIdentifier(normalized);
  }

  private resolveCancellationStateName(): string {
    const terminalStates = this.config.terminalStates;
    return terminalStates.find((state) => /^canceled$/i.test(state))
      ?? terminalStates.find((state) => /^cancelled$/i.test(state))
      ?? terminalStates.find((state) => /cancell?ed/i.test(state))
      ?? 'Canceled';
  }

  private buildManualCloseComment(params: {
    workItem: WorkItem;
    successorIdentifier: string | null;
    reason: string | null;
    deliverySummary: string;
  }): string {
    return [
      params.successorIdentifier ? '## Superseded by another issue' : '## Issue closed by supervisor',
      `Issue: ${params.workItem.linear_identifier}`,
      params.successorIdentifier ? `Successor: ${params.successorIdentifier}` : null,
      params.reason ? `Reason: ${params.reason}` : null,
      '',
      params.deliverySummary,
    ].filter((line): line is string => line !== null).join('\n');
  }

  private recordSyncEvent(params: {
    workItemId: string;
    targetSystem: 'linear' | 'github';
    action: string;
    payload: Record<string, unknown>;
    success: boolean;
    error?: string | null;
  }): void {
    this.syncEventRepository.create({
      id: crypto.randomUUID(),
      work_item_id: params.workItemId,
      target_system: params.targetSystem,
      action: params.action,
      payload_json: params.payload,
      result: params.success ? 'success' : 'failed',
      error: params.success ? null : params.error ?? 'Unknown sync error',
    });
  }

  private usesGovernanceDispatchBlock(workItem: WorkItem | null, issue: Issue): boolean {
    return Boolean(
      workItem &&
      workItem.orchestrator_state === 'halted' &&
      workItem.governance_decision &&
      workItem.governance_decision !== 'accept' &&
      !this.hasGovernanceOverride(issue),
    );
  }

  private usesFailureDispatchBlock(workItem: WorkItem | null, issue: Issue): boolean {
    if (!workItem || workItem.orchestrator_state !== 'failed') {
      return false;
    }

    if ((workItem.linear_state || '').trim().toLowerCase() !== issue.state.trim().toLowerCase()) {
      return false;
    }

    if (!issue.updated_at) {
      return true;
    }

    return issue.updated_at.getTime() <= workItem.updated_at.getTime();
  }

  private usesManualStopDispatchBlock(workItem: WorkItem | null, issue: Issue): boolean {
    if (
      !workItem ||
      workItem.orchestrator_state !== 'halted' ||
      workItem.delivery_code !== 'manual_stop'
    ) {
      return false;
    }

    if ((workItem.linear_state || '').trim().toLowerCase() !== issue.state.trim().toLowerCase()) {
      return false;
    }

    if (!issue.updated_at) {
      return true;
    }

    return issue.updated_at.getTime() <= workItem.updated_at.getTime();
  }

  private usesDeliveryHaltDispatchBlock(workItem: WorkItem | null, issue: Issue): boolean {
    if (
      !workItem ||
      workItem.orchestrator_state !== 'halted' ||
      !workItem.delivery_code ||
      workItem.delivery_code === 'manual_stop'
    ) {
      return false;
    }

    if ((workItem.linear_state || '').trim().toLowerCase() !== issue.state.trim().toLowerCase()) {
      return false;
    }

    if (!issue.updated_at) {
      return true;
    }

    return issue.updated_at.getTime() <= workItem.updated_at.getTime();
  }

  private usesSupervisorSessionDispatchBlock(workItem: WorkItem | null): boolean {
    const session = this.findSupervisorSessionForWorkItem(workItem);
    return session?.state === 'cancelled' || session?.state === 'completed';
  }

  private usesPostDevReviewTransitionBlock(workItem: WorkItem | null, issue: Issue): boolean {
    if (!workItem || workItem.orchestrator_state !== 'workspace_ready') {
      return false;
    }
    if ((workItem.linear_state || '').trim().toLowerCase() !== 'in review') {
      return false;
    }
    return issue.state.trim().toLowerCase() !== 'in review';
  }

  private governanceSourceTimestamp(workItem: WorkItem): Date | null {
    return workItem.governance_source_updated_at ?? workItem.updated_at ?? null;
  }

  private shouldReassessGovernanceBlockedIssue(issue: Issue, workItem: WorkItem | null): boolean {
    if (!this.usesGovernanceDispatchBlock(workItem, issue) || !issue.updated_at) {
      return false;
    }

    if (!workItem) {
      return false;
    }

    const baseline = this.governanceSourceTimestamp(workItem);
    if (!baseline) {
      return true;
    }

    return issue.updated_at.getTime() > baseline.getTime();
  }

  private hasActiveGovernanceChildren(workItem: WorkItem | null): boolean {
    if (!workItem) {
      return false;
    }

    return this.workItemRepository
      .findByGovernanceParentIssueId(workItem.linear_issue_id)
      .some((child) => (
        child.linear_issue_id !== workItem.linear_issue_id &&
        !this.isTerminalTrackerState(child.linear_state)
      ));
  }

  private isSupervisorRootCoordinator(workItem: WorkItem | null): boolean {
    if (!workItem || workItem.governance_parent_issue_id) {
      return false;
    }

    return workItem.supervisor_execution_mode === 'root_with_split_queue';
  }

  private hasGovernanceChildren(workItem: WorkItem | null): boolean {
    if (!workItem) {
      return false;
    }

    return this.workItemRepository
      .findByGovernanceParentIssueId(workItem.linear_issue_id)
      .some((child) => child.linear_issue_id !== workItem.linear_issue_id);
  }

  private governanceChildren(workItem: WorkItem | null): WorkItem[] {
    if (!workItem) {
      return [];
    }

    return this.workItemRepository
      .findByGovernanceParentIssueId(workItem.linear_issue_id)
      .filter((child) => child.linear_issue_id !== workItem.linear_issue_id);
  }

  private allGovernanceChildrenTerminal(workItem: WorkItem | null): boolean {
    const children = this.governanceChildren(workItem);
    return children.length > 0 && children.every((child) => this.isTerminalTrackerState(child.linear_state));
  }

  private shouldBlockSupervisorRootCoordinatorDispatch(workItem: WorkItem | null): boolean {
    return this.isSupervisorRootCoordinator(workItem) && this.hasGovernanceChildren(workItem);
  }

  private async finalizeCompletedSupervisorRootIfNeeded(issue: Issue): Promise<boolean> {
    const workItem = this.findTrackedWorkItem(issue);
    if (!this.isSupervisorRootCoordinator(workItem) || !this.allGovernanceChildrenTerminal(workItem)) {
      return false;
    }

    if (
      this.isTerminalTrackerState(workItem!.linear_state) ||
      workItem!.orchestrator_state === 'completed' ||
      issue.state.toLowerCase() === 'done'
    ) {
      return true;
    }

    const childIdentifiers = this.governanceChildren(workItem)
      .map((child) => child.linear_identifier)
      .join('、');
    const summary = childIdentifiers
      ? `所有顺序子任务已完成（${childIdentifiers}），root 线程已自动收尾。`
      : '所有顺序子任务已完成，root 线程已自动收尾。';
    const trackerSync = await this.syncLinearState(issue, 'Done');
    const nextLinearState = trackerSync.success
      ? (trackerSync.currentState ?? 'Done')
      : workItem!.linear_state;

    if (!trackerSync.success) {
      this.workItemRepository.update({
        id: workItem!.id,
        orchestrator_state: 'halted',
        delivery_code: 'tracker_state_conflict',
        delivery_summary: trackerSync.error ?? summary,
      });
      this.emitTimelineEvent(issue, {
        level: 'error',
        category: 'diagnostic',
        code: 'supervisor_root_finalize_failed',
        message: trackerSync.error ?? `Failed to finalize supervisor root ${issue.identifier}.`,
        turn: null,
        tool_name: null,
        detail: {
          issue_identifier: issue.identifier,
          child_identifiers: childIdentifiers,
        },
      });
      return true;
    }

    this.workItemRepository.update({
      id: workItem!.id,
      linear_state: nextLinearState,
      orchestrator_state: 'completed',
      delivery_code: null,
      delivery_summary: summary,
      merged_at: new Date(),
    });
    await this.closeMappedGitHubIssue(workItem, `${issue.identifier} supervisor root completion`);
    this.emitTimelineEvent(
      { ...issue, state: nextLinearState },
      {
        level: 'info',
        category: 'diagnostic',
        code: 'supervisor_root_completed',
        message: summary,
        turn: null,
        tool_name: null,
        detail: {
          issue_identifier: issue.identifier,
          child_identifiers: childIdentifiers,
        },
      },
    );
    return true;
  }

  private hasBlockingGovernanceSibling(workItem: WorkItem | null): boolean {
    if (!workItem?.governance_parent_issue_id) {
      return false;
    }

    const siblings = this.workItemRepository
      .findByGovernanceParentIssueId(workItem.governance_parent_issue_id)
      .sort((left, right) => (
        left.created_at.getTime() - right.created_at.getTime()
        || left.linear_identifier.localeCompare(right.linear_identifier)
      ));
    const currentIndex = siblings.findIndex((candidate) => candidate.linear_issue_id === workItem.linear_issue_id);
    if (currentIndex <= 0) {
      return false;
    }

    return siblings
      .slice(0, currentIndex)
      .some((candidate) => !this.isTerminalTrackerState(candidate.linear_state));
  }

  private lastGovernanceRewriteTitle(workItemId: string): string | null {
    const latest = this.governanceAssessmentRepository
      .findByWorkItemId(workItemId)
      .find((entry) => typeof entry.detail_json?.rewrite_title === 'string');
    return typeof latest?.detail_json?.rewrite_title === 'string'
      ? latest.detail_json.rewrite_title
      : null;
  }

  private lastGovernanceSplitSuggestions(workItemId: string): string[] {
    const latest = this.governanceAssessmentRepository
      .findByWorkItemId(workItemId)
      .find((entry) => Array.isArray(entry.detail_json?.split_suggestions));
    return Array.isArray(latest?.detail_json?.split_suggestions)
      ? latest.detail_json.split_suggestions.filter((value): value is string => typeof value === 'string')
      : [];
  }

  private async reassessGovernanceBlockedIssueIfNeeded(issue: Issue): Promise<void> {
    const workItem = this.findTrackedWorkItem(issue);
    if (!this.shouldReassessGovernanceBlockedIssue(issue, workItem) || !workItem) {
      return;
    }

    const route = this.tryResolveRepositoryRoute(issue);
    if (!route) {
      return;
    }

    const previousDecision = workItem.governance_decision;
    const previousSummary = workItem.governance_summary;
    const previousRewriteTitle = this.lastGovernanceRewriteTitle(workItem.id);
    const previousSplitSuggestions = this.lastGovernanceSplitSuggestions(workItem.id);

    const repoIntelligence = this.buildRepoIntelligenceContext(route.github_repo_full);
    const governance = await assessIntakeCritic({
      issue,
      route,
      repositoryRoot: route.local_path,
      repoSnapshot: repoIntelligence.repoSnapshot,
      activeFitnessSignals: repoIntelligence.activeSignals,
    });

    this.refreshWorkItemGovernanceState(workItem.id, issue, governance);
    const governanceChanged =
      previousDecision !== governance.decision ||
      previousSummary !== governance.summary ||
      previousRewriteTitle !== (governance.rewrite_title ?? null) ||
      JSON.stringify(previousSplitSuggestions) !== JSON.stringify(governance.split_suggestions);

    if (governanceChanged && previousDecision && previousDecision !== 'accept') {
      this.acceptGovernanceSuggestions(issue.id, previousDecision);
    }

    if (governanceChanged && governance.blocks_dispatch) {
      this.ensureGovernanceSuggestions(issue, workItem.id, route, governance);
    }

    this.recordGovernanceAssessment(workItem.id, issue.id, governance, {
      event: 'tracker_issue_updated',
      previous_decision: previousDecision,
      previous_summary: previousSummary,
      issue_updated_at: issue.updated_at?.toISOString() ?? null,
      rewrite_title: governance.rewrite_title,
      split_suggestions: governance.split_suggestions,
      blocks_dispatch: governance.blocks_dispatch,
    });
    this.recordGovernanceMemoryOutcome(workItem.id, issue, governance);
    this.refreshRepoGovernanceIntelligence(issue, workItem.id, route.github_repo_full);

    if (governanceChanged) {
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
          rewrite_title: governance.rewrite_title,
          split_suggestions: governance.split_suggestions,
          source: 'tracker_update',
        },
      });
    }
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

    const trackedWorkItem = this.findTrackedWorkItem(issue);
    if (this.usesSupervisorSessionDispatchBlock(trackedWorkItem)) {
      return false;
    }

    if (this.usesFailureDispatchBlock(trackedWorkItem, issue)) {
      return false;
    }

    if (this.usesManualStopDispatchBlock(trackedWorkItem, issue)) {
      return false;
    }

    if (this.usesDeliveryHaltDispatchBlock(trackedWorkItem, issue)) {
      return false;
    }

    if (this.usesPostDevReviewTransitionBlock(trackedWorkItem, issue)) {
      return false;
    }

    if (this.shouldBlockSupervisorRootCoordinatorDispatch(trackedWorkItem)) {
      return false;
    }

    if (this.usesGovernanceDispatchBlock(trackedWorkItem, issue)) {
      const baseline = trackedWorkItem ? this.governanceSourceTimestamp(trackedWorkItem) : null;
      if (!issue.updated_at || !baseline || issue.updated_at.getTime() <= baseline.getTime()) {
        return false;
      }
    }

    if (this.hasActiveGovernanceChildren(trackedWorkItem)) {
      return false;
    }

    if (this.hasBlockingGovernanceSibling(trackedWorkItem)) {
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
      const workerPromise = Promise.resolve()
        .then(() => this.runAgentAttempt(issue, attempt, route))
        .then(result => this.handleWorkerExit(issue.id, result));

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
    if (this.hasActiveExecutionWork()) {
      console.log('[orchestrator] Skipping global terminal branch cleanup because active execution is in flight.');
      return;
    }

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
      project_slug: this.findProjectSlugForGithubRepo(workItem.github_repo),
      project_name: null,
      branch_name: workItem.branch_name,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: workItem.created_at,
      updated_at: workItem.updated_at,
    };
  }

  private findProjectSlugForGithubRepo(githubRepo: string): string | null {
    for (const [projectSlug, route] of Object.entries(this.config.repositories.routing)) {
      if (`${route.github_owner}/${route.github_repo}` === githubRepo) {
        return projectSlug;
      }
    }
    return null;
  }

  private async dispatchLocalReviewReadyWorkItems(dispatchedThisTick: Set<string>): Promise<void> {
    for (const workItem of this.workItemRepository.findAll()) {
      if (!this.hasAvailableSlots()) {
        return;
      }
      if (
        workItem.orchestrator_state !== 'workspace_ready' ||
        workItem.linear_state.trim().toLowerCase() !== 'in review'
      ) {
        continue;
      }
      if (this.state.running.has(workItem.linear_issue_id) || this.state.claimed.has(workItem.linear_issue_id)) {
        continue;
      }
      if (this.state.retry_attempts.has(workItem.linear_issue_id)) {
        continue;
      }
      if (dispatchedThisTick.has(workItem.linear_issue_id)) {
        continue;
      }
      const issue = this.buildSyntheticIssueFromWorkItem(workItem);
      if (!issue.project_slug) {
        continue;
      }
      if (this.shouldDispatch(issue)) {
        dispatchedThisTick.add(issue.id);
        await this.dispatchIssue(issue, null);
      }
    }
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
    const repoIntelligence = this.buildRepoIntelligenceContext(route.github_repo_full);
    return assessIntakeCritic({
      issue,
      route,
      repositoryRoot: route.local_path,
      repoSnapshot: repoIntelligence.repoSnapshot,
      activeFitnessSignals: repoIntelligence.activeSignals,
    });
  }

  private buildRepoIntelligenceContext(repoKey: string): {
    activeSignals: FitnessSignal[];
    repoSnapshot: ReturnType<GovernanceMemoryService['buildRepoSnapshot']>;
  } {
    const activeSignals = this.fitnessSignalService.evaluate(repoKey);
    return {
      activeSignals,
      repoSnapshot: this.governanceMemoryService.buildRepoSnapshot(repoKey, activeSignals),
    };
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
      governance_source_updated_at: governance.blocks_dispatch ? issue.updated_at ?? null : null,
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

  private inferGovernanceTargetArea(issue: Issue, workItem: WorkItem | null = null): string | null {
    const derivedTarget = workItem?.architectural_target ?? (workItem ? deriveArchitectureTarget(workItem.touched_paths) : null);
    if (derivedTarget) {
      return derivedTarget;
    }

    const areas = new Set<string>(workItem?.touched_areas ?? []);
    const normalized = `${issue.title}\n${issue.description ?? ''}`.toLowerCase();

    if (/\bruntime\b|control plane|hub|sse|stream|session/i.test(normalized)) {
      areas.add('runtime');
    }
    if (/\bserver\b|route|http|webhook|api\/v1/i.test(normalized)) {
      areas.add('server');
    }
    if (/telegram|discord|bot|chat/i.test(normalized)) {
      areas.add('bots');
    }
    if (/orchestrator|dispatch|worker|lease|scheduler/i.test(normalized)) {
      areas.add('orchestrator');
    }
    if (/scripts\/|python|cli\.py|hook/i.test(normalized)) {
      areas.add('python-bridge');
    }

    if (areas.size === 0) {
      return null;
    }

    return [...areas].sort().join('+');
  }

  private collectGovernanceSuggestionsForRepo(repoKey: string): Array<{
    suggestion_type: string;
    detail_json: Record<string, unknown> | null;
    title: string;
  }> {
    const workItems = this.workItemRepository.findAll().filter((item) => item.github_repo === repoKey);
    const suggestions = workItems.flatMap((item) => this.governanceSuggestionRepository.findByIssueId(item.linear_issue_id));
    return suggestions.map((suggestion) => ({
      suggestion_type: suggestion.suggestion_type,
      detail_json: suggestion.detail_json,
      title: suggestion.title,
    }));
  }

  private recordGovernanceMemoryOutcome(
    workItemId: string,
    issue: Issue,
    governance: IntakeCriticAssessment,
  ): void {
    const workItem = this.workItemRepository.findById(workItemId);
    if (!workItem) {
      return;
    }

    const targetArea = this.inferGovernanceTargetArea(issue, workItem);
    const constitutionPhrase = governance.constitution_hits[0]?.phrase ?? null;

    if (
      governance.decision === 'accept_with_rewrite' ||
      governance.decision === 'split_before_implement' ||
      governance.decision === 'reject_conflicting'
    ) {
      this.governanceMemoryService.recordConflictOutcome(workItemId, {
        kind: governance.decision,
        summary: governance.summary,
        constitution_phrase: constitutionPhrase,
        target_area: targetArea,
      });
    }

    if (governance.status === 'blocked') {
      this.governanceMemoryService.recordDebtOutcome(workItemId, {
        signal_code: 'governance_blocked',
        summary: governance.summary,
        severity: 'high',
      });
    }
  }

  private refreshRepoGovernanceIntelligence(
    issue: Issue,
    workItemId: string,
    repoKey: string,
  ): FitnessSignal[] {
    const currentWorkItem = this.workItemRepository.findById(workItemId);
    if (!currentWorkItem) {
      return [];
    }

    const previousCodes = new Set(currentWorkItem.fitness_signals.map((signal) => signal.code));
    const signals = this.fitnessSignalService.evaluate(repoKey);

    for (const repoWorkItem of this.workItemRepository.findAll().filter((item) => item.github_repo === repoKey)) {
      this.workItemRepository.update({
        id: repoWorkItem.id,
        fitness_signals: signals,
      });
    }

    for (const signal of signals) {
      if (previousCodes.has(signal.code)) {
        continue;
      }
      this.emitTimelineEvent(issue, {
        level: signal.severity === 'high' ? 'warn' : 'info',
        category: 'diagnostic',
        code: 'fitness_signal_recorded',
        message: signal.summary,
        turn: null,
        tool_name: null,
        detail: {
          repo_key: repoKey,
          signal_code: signal.code,
          severity: signal.severity,
        },
      });
    }

    const snapshot = this.governanceMemoryService.buildRepoSnapshot(repoKey, signals);
    const drafts = this.governanceSuggestionEngine.generate({
      repo_key: repoKey,
      active_signals: signals,
      recent_conflicts: this.conflictMemoryRepository.findByRepoKey(repoKey),
      latest_assessments: snapshot.latest_assessments,
      existing_suggestions: this.collectGovernanceSuggestionsForRepo(repoKey),
    });

    for (const draft of drafts) {
      this.governanceSuggestionRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItemId,
        issue_id: issue.id,
        suggestion_type: draft.suggestion_type,
        title: draft.title,
        summary: draft.summary,
        detail_json: draft.detail_json,
      });
      this.emitTimelineEvent(issue, {
        level: 'info',
        category: 'diagnostic',
        code: 'governance_suggestion_created',
        message: draft.title,
        turn: null,
        tool_name: null,
        detail: {
          suggestion_type: draft.suggestion_type,
          summary: draft.summary,
          target_area: draft.detail_json.target_area ?? null,
        },
      });
    }

    return signals;
  }

  private buildGovernanceRepoSlug(repoKey: string): string {
    return repoKey
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private buildGovernanceBranchName(
    suggestionType: 'harness_adoption' | 'constitution_update',
    repoKey: string,
  ): string {
    const repoSlug = this.buildGovernanceRepoSlug(repoKey);
    if (suggestionType === 'harness_adoption') {
      return `governance/harness-adoption/${repoSlug}`;
    }
    return `governance/constitution-update/${repoSlug}`;
  }

  private getGovernanceWorktreePath(route: ResolvedRepositoryRoute, branchName: string): string {
    return path.join(
      this.config.workspaceRoot,
      route.cache_key,
      'worktrees',
      sanitizeWorkspaceKey(branchName),
    );
  }

  private resolveGovernanceStartPoint(sourcePath: string): string | null {
    try {
      const remoteDefaultRef = cp.execFileSync('git', [
        '-C',
        sourcePath,
        'symbolic-ref',
        '--quiet',
        'refs/remotes/origin/HEAD',
      ], {
        encoding: 'utf8',
      }).trim();
      if (remoteDefaultRef) {
        return remoteDefaultRef;
      }
    } catch {
      // Fall back to the current branch below.
    }

    try {
      const currentBranch = cp.execFileSync('git', [
        '-C',
        sourcePath,
        'branch',
        '--show-current',
      ], {
        encoding: 'utf8',
      }).trim();
      return currentBranch || null;
    } catch {
      return null;
    }
  }

  private renderHarnessAdoptionContent(
    route: ResolvedRepositoryRoute,
    suggestionDetail: Record<string, unknown> | null,
  ): string {
    if (typeof suggestionDetail?.harness_yaml === 'string' && suggestionDetail.harness_yaml.trim()) {
      return suggestionDetail.harness_yaml.trimEnd() + '\n';
    }

    const payload = (
      suggestionDetail?.harness_payload &&
      typeof suggestionDetail.harness_payload === 'object'
        ? suggestionDetail.harness_payload
        : this.shadowHarnessRepository.findByRepoKey(route.github_repo_full)?.config_json
    ) ?? {};

    return yaml.stringify(payload).trimEnd() + '\n';
  }

  private renderConstitutionUpdateContent(
    existingContent: string | null,
    suggestionDetail: Record<string, unknown> | null,
  ): string {
    const section = typeof suggestionDetail?.section === 'string' && suggestionDetail.section.trim()
      ? suggestionDetail.section.trim()
      : 'Preferred Directions';
    const proposedBullet = typeof suggestionDetail?.proposed_bullet === 'string' && suggestionDetail.proposed_bullet.trim()
      ? suggestionDetail.proposed_bullet.trim()
      : 'Clarify the repeated governance exception in this repository.';
    const bulletLine = proposedBullet.startsWith('- ') ? proposedBullet : `- ${proposedBullet}`;

    const content = existingContent?.trim()
      ? existingContent.trimEnd()
      : [
          '## Main Path',
          '',
          '## Stable Boundaries',
          '',
          '## Preferred Directions',
          '',
          '## Forbidden Directions',
          '',
          '## Current Focus',
          '',
          '## Cleanup Triggers',
          '',
        ].join('\n');

    const sectionHeader = `## ${section}`;
    if (!content.includes(sectionHeader)) {
      return `${content}\n\n${sectionHeader}\n${bulletLine}\n`;
    }

    const sectionPattern = new RegExp(`(^## ${section.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\n)([\\s\\S]*?)(?=\\n## |$)`, 'm');
    return `${content.replace(sectionPattern, (_match, header, body) => {
      const normalizedBody = String(body).trimEnd();
      if (normalizedBody.split('\n').some((line) => line.trim() === bulletLine)) {
        return `${header}${normalizedBody}\n`;
      }
      const spacer = normalizedBody ? '\n' : '';
      return `${header}${normalizedBody}${spacer}${bulletLine}\n`;
    })}\n`;
  }

  private async executeGovernancePullRequestSuggestion(params: {
    issue: Issue;
    route: ResolvedRepositoryRoute;
    workItem: WorkItem;
    suggestion: NonNullable<ReturnType<GovernanceSuggestionRepository['findById']>>;
  }): Promise<{ branch_name: string; pr_number: number; pr_url: string }> {
    const fs = await import('fs/promises');
    const repoCacheManager = new RepoCacheManager({
      workspaceRoot: this.config.workspaceRoot,
      githubToken: this.config.githubToken,
    });
    const repoResult = await repoCacheManager.ensureRepoSource(params.route);
    if (!repoResult.success || !repoResult.sourcePath) {
      throw new Error(repoResult.error || `Failed to prepare repo source for ${params.route.github_repo_full}`);
    }

    const sourcePath = repoResult.sourcePath;
    const branchName = this.buildGovernanceBranchName(params.suggestion.suggestion_type, params.route.github_repo_full);
    const worktreePath = this.getGovernanceWorktreePath(params.route, branchName);
    const startPoint = this.resolveGovernanceStartPoint(sourcePath);
    const worktreeArgs = ['-C', sourcePath, 'worktree', 'add', '--force', '-B', branchName, worktreePath];
    if (startPoint) {
      worktreeArgs.push(startPoint);
    }

    let preparedWorktree = false;
    try {
      cp.execFileSync('git', ['-C', sourcePath, 'worktree', 'prune'], { stdio: 'pipe' });
      await fs.rm(worktreePath, { recursive: true, force: true });
      cp.execFileSync('git', worktreeArgs, { stdio: 'pipe' });
      preparedWorktree = true;

      let targetRelativePath: string;
      let targetContent: string;
      if (params.suggestion.suggestion_type === 'harness_adoption') {
        targetRelativePath = '.symphony-repo.yaml';
        targetContent = this.renderHarnessAdoptionContent(params.route, params.suggestion.detail_json);
      } else {
        targetRelativePath = '.symphony-constitution.md';
        const targetPath = path.join(worktreePath, targetRelativePath);
        const existingContent = await fs.readFile(targetPath, 'utf8').catch(() => null);
        targetContent = this.renderConstitutionUpdateContent(existingContent, params.suggestion.detail_json);
      }

      await fs.writeFile(path.join(worktreePath, targetRelativePath), targetContent, 'utf8');
      cp.execFileSync('git', ['-C', worktreePath, 'add', targetRelativePath], { stdio: 'pipe' });

      let hasDiff = false;
      try {
        cp.execFileSync('git', ['-C', worktreePath, 'diff', '--cached', '--quiet'], { stdio: 'pipe' });
      } catch (error) {
        if ((error as { status?: number }).status === 1) {
          hasDiff = true;
        } else {
          throw error;
        }
      }
      if (!hasDiff) {
        throw new Error(`No contract changes were produced for ${params.suggestion.title}`);
      }

      const commitMessage = params.suggestion.suggestion_type === 'harness_adoption'
        ? 'chore(governance): adopt repo harness'
        : 'docs(governance): update constitution';
      cp.execFileSync('git', ['-C', worktreePath, 'commit', '-m', commitMessage], {
        stdio: 'pipe',
      });
      cp.execFileSync('git', ['-C', worktreePath, 'push', '-u', 'origin', branchName, '--force-with-lease'], {
        stdio: 'pipe',
      });

      const githubClient = this.createGitHubWriteClient(params.route.github_repo_full) as unknown as {
        findOpenPullRequestByBranch?(branch: string): Promise<{ number: number; url: string } | null>;
        createPullRequest(params: { title: string; body?: string; head: string; base?: string; draft?: boolean }): Promise<{ number: number; url: string }>;
      };
      const existingPr = await githubClient.findOpenPullRequestByBranch?.(branchName) ?? null;
      const pr = existingPr ?? await githubClient.createPullRequest({
        title: params.suggestion.title,
        body: [
          params.suggestion.summary,
          '',
          `Source issue: ${params.issue.identifier}`,
          `Repo: ${params.route.github_repo_full}`,
          `Suggestion: ${params.suggestion.suggestion_type}`,
        ].join('\n'),
        head: branchName,
        base: 'main',
        draft: true,
      });

      return {
        branch_name: branchName,
        pr_number: pr.number,
        pr_url: pr.url,
      };
    } finally {
      if (preparedWorktree) {
        try {
          await this.workspaceManager.removeWorkspace(worktreePath);
        } catch {
          // Best-effort cleanup for governance worktrees.
        }
      }
    }
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
  ): { title: string; description: string; architectural_target: string | null } {
    const normalizedSuggestion = suggestion.replace(/\s+/g, ' ').trim();
    const shortTitle = normalizedSuggestion
      .replace(/^(先|将|把)\s*/u, '')
      .replace(/^先拆出\s*/u, '')
      .replace(/[，,。.!].*$/u, '')
      .trim();
    const baseTitle = shortTitle && shortTitle.length <= 120
      ? shortTitle
      : `${issue.title} · Slice ${index + 1}`;
    const title = index === 0
      ? baseTitle
      : `[GOVERNANCE FOLLOW-UP for ${issue.identifier}] ${baseTitle}`;

    const description = [
      `来源 issue: ${issue.identifier}`,
      `创建原因: 治理层要求先拆分原任务，再继续主线开发。`,
      `目标切片 ${index + 1}/${total}: ${normalizedSuggestion}`,
      '完成这个子任务后，可以帮助源 issue 继续推进。',
      '保持这个任务只做一件可验证的具体工作。',
    ].join('\n');

    return {
      title,
      description,
      architectural_target: this.normalizeGovernanceArchitecturalTarget(shortTitle || normalizedSuggestion),
    };
  }

  private normalizeGovernanceArchitecturalTarget(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
    return normalized || null;
  }

  private findEquivalentOpenGovernanceChild(params: {
    rootIssueId: string;
    githubRepo: string;
    architecturalTarget: string | null;
  }): WorkItem | null {
    const normalizedTarget = this.normalizeGovernanceArchitecturalTarget(params.architecturalTarget);
    if (!normalizedTarget) {
      return null;
    }

    return this.workItemRepository
      .findByGovernanceRootIssueId(params.rootIssueId)
      .find((candidate) => (
        candidate.linear_issue_id !== params.rootIssueId &&
        candidate.governance_generation > 0 &&
        candidate.github_repo === params.githubRepo &&
        !this.isTerminalTrackerState(candidate.linear_state) &&
        this.normalizeGovernanceArchitecturalTarget(candidate.architectural_target) === normalizedTarget
      )) ?? null;
  }

  private ensureGovernanceSuggestions(
    issue: Issue,
    workItemId: string,
    route: ResolvedRepositoryRoute,
    governance: IntakeCriticAssessment,
  ): void {
    const existing = this.governanceSuggestionRepository.findPendingByIssueId(issue.id);
    const currentWorkItem = this.workItemRepository.findById(workItemId);
    if ((currentWorkItem?.governance_generation ?? 0) > 0) {
      return;
    }
    const targetArea = governance.target_area ?? this.inferGovernanceTargetArea(issue, currentWorkItem);
    const architectureDetail = {
      architectural_target: currentWorkItem?.architectural_target ?? targetArea,
      path_families: currentWorkItem?.path_families ?? [],
      boundary_edges: currentWorkItem?.boundary_edges ?? [],
      import_edges: currentWorkItem?.import_edges ?? [],
    };
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
          target_area: targetArea,
          ...architectureDetail,
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
          target_area: targetArea,
          ...architectureDetail,
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
          target_area: targetArea,
          ...architectureDetail,
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
          target_area: targetArea,
          ...architectureDetail,
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
    harnessResolution?: {
      harness: ResolvedRepositoryHarness;
      effectiveHarness: EffectiveRepositoryHarness;
      shouldEmitMissingHarness: boolean;
    },
  ): Promise<GovernedExecutionState> {
    const resolvedHarness = harnessResolution ?? await this.resolveEffectiveHarness(workspacePath, route);
    const harness = resolvedHarness.harness;
    const effectiveHarness = resolvedHarness.effectiveHarness;
    const shouldEmitMissingHarness = resolvedHarness.shouldEmitMissingHarness;

    const constitution = await loadRepositoryConstitution(workspacePath);
    const repoIntelligence = this.buildRepoIntelligenceContext(route.github_repo_full);
    const governance = await assessIntakeCritic({
      issue,
      route,
      repositoryRoot: workspacePath,
      resolvedHarness: harness,
      resolvedConstitution: constitution,
      repoSnapshot: repoIntelligence.repoSnapshot,
      activeFitnessSignals: repoIntelligence.activeSignals,
    });

    await initializeChangePack({
      workspacePath,
      issue,
      mode,
      profile: mode === 'review' ? 'review' : undefined,
      harness: effectiveHarness.config,
      governanceSummary: governance.summary,
    });

    const changePackState = await evaluateChangePackState({
      workspacePath,
      issue,
      mode,
    });

    this.workItemRepository.update({
      id: workItemId,
      repo_harness_status: harness.status,
      constitution_status: constitution.status,
      governance_status: governance.status,
      governance_decision: governance.decision,
      governance_summary: governance.summary,
      governance_source_updated_at: governance.blocks_dispatch ? issue.updated_at ?? null : null,
      change_pack_summary: changePackState.summary,
      task_status: changePackState.task_status,
      evidence_summary: changePackState.evidence_summary,
      missing_requirements: changePackState.missing_requirements,
      constitution_hits: governance.constitution_hits,
      fitness_signals: repoIntelligence.activeSignals,
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
        target_area: this.inferGovernanceTargetArea(issue, this.workItemRepository.findById(workItemId)),
        architectural_target: this.workItemRepository.findById(workItemId)?.architectural_target ?? null,
        path_families: this.workItemRepository.findById(workItemId)?.path_families ?? [],
        boundary_edges: this.workItemRepository.findById(workItemId)?.boundary_edges ?? [],
        import_edges: this.workItemRepository.findById(workItemId)?.import_edges ?? [],
        missing_requirements: changePackState.missing_requirements,
        repo_key: governance.repo_key,
        active_fitness_signals: governance.active_fitness_signals,
        related_conflict_count: governance.related_conflict_count,
        related_debt_signal_count: governance.related_debt_signal_count,
        repeated_constitution_phrase: governance.repeated_constitution_phrase,
      },
    });
    this.ensureGovernanceSuggestions(issue, workItemId, route, governance);
    this.recordGovernanceMemoryOutcome(workItemId, issue, governance);
    const fitnessSignals = this.refreshRepoGovernanceIntelligence(issue, workItemId, route.github_repo_full);

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
      effectiveHarness,
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

  private getWorkspaceLifecycleState(state: Record<string, unknown> | null): string | null {
    const currentState = state?.current_state;
    return typeof currentState === 'string' ? currentState.trim().toUpperCase() : null;
  }

  private async reconcileWorkspaceAlreadyInReview(
    issue: Issue,
    workItem: WorkItem | null | undefined,
  ): Promise<RuntimeActionResult | null> {
    if (issue.state.trim().toLowerCase() === 'in review') {
      return null;
    }
    if (!workItem?.workspace_path) {
      return null;
    }

    const workspaceState = await this.readWorkspaceStateFile(workItem.workspace_path);
    if (this.getWorkspaceLifecycleState(workspaceState) !== 'IN_REVIEW') {
      return null;
    }

    await this.syncWorkItemFromWorkspaceState(
      workItem.id,
      issue,
      workItem.workspace_path,
      'workspace_ready',
    );
    const trackerSync = await this.syncLinearState(issue, 'In Review');
    if (!trackerSync.success) {
      this.workItemRepository.update({
        id: workItem.id,
        linear_state: issue.state,
        orchestrator_state: 'failed',
        delivery_code: 'tracker_state_conflict',
        delivery_summary: trackerSync.error || `${issue.identifier} 已经在本地进入 In Review，但同步 Linear 状态失败。`,
      });
      this.emit('state:changed', this.getStateSnapshot());
      return {
        accepted: false,
        status: 'rejected',
        message: `Retry blocked for ${issue.identifier}: workspace already reached In Review, but Linear could not be synced`,
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        delivery_code: 'tracker_state_conflict',
      };
    }

    this.workItemRepository.update({
      id: workItem.id,
      linear_state: trackerSync.currentState ?? 'In Review',
      orchestrator_state: 'workspace_ready',
      delivery_code: null,
      delivery_summary: null,
    });
    this.state.completed.delete(issue.id);
    this.emit('state:changed', this.getStateSnapshot());
    this.scheduleTick(0);

    return {
      accepted: true,
      status: 'completed',
      message: `${issue.identifier} already reached In Review locally; reconciled tracker/runtime state instead of retrying DEV`,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    };
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

  private buildHarnessBridgeEnv(
    effectiveHarness: EffectiveRepositoryHarness | null | undefined,
  ): Record<string, string> {
    if (!effectiveHarness) {
      return {};
    }

    return {
      SYMPHONY_EFFECTIVE_HARNESS_JSON: JSON.stringify({
        source: effectiveHarness.source,
        commands: effectiveHarness.config.commands ?? {},
        verification: effectiveHarness.config.verification ?? {},
        runtime_hints: effectiveHarness.config.runtime_hints ?? {},
      }),
    };
  }

  private buildHarnessPromptSection(
    effectiveHarness: EffectiveRepositoryHarness | null | undefined,
  ): string | undefined {
    if (!effectiveHarness) {
      return undefined;
    }

    const commandEntries = Object.entries(effectiveHarness.config.commands ?? {});
    const verificationCommands = effectiveHarness.config.verification?.required_commands ?? [];
    const verificationArtifacts = effectiveHarness.config.verification?.required_artifacts ?? [];
    const runtimeHints = effectiveHarness.config.runtime_hints ?? {};

    return [
      '## Repository Harness Contract',
      `- Harness Source: ${effectiveHarness.source}`,
      commandEntries.length > 0
        ? `- Commands: ${commandEntries.map(([key, value]) => `${key}=${value}`).join(' | ')}`
        : '- Commands: (none declared)',
      verificationCommands.length > 0
        ? `- Required Verification Commands: ${verificationCommands.join(', ')}`
        : null,
      verificationArtifacts.length > 0
        ? `- Required Verification Artifacts: ${verificationArtifacts.join(', ')}`
        : null,
      Object.keys(runtimeHints).length > 0
        ? `- Runtime Hints: ${Object.entries(runtimeHints).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(', ') : value}`).join(' | ')}`
        : null,
    ].filter(Boolean).join('\n');
  }

  private buildSupervisorPromptSection(workItem: WorkItem | null | undefined): string | undefined {
    const session = this.findSupervisorSessionForWorkItem(workItem);
    if (
      !workItem?.supervisor_locale &&
      !workItem?.supervisor_plan_summary &&
      !workItem?.supervisor_acceptance_summary &&
      !session
    ) {
      return undefined;
    }

    const recentEvents = session
      ? this.supervisorSessionEventRepository.listBySession(session.id).slice(-4)
      : [];
    const planCard = session?.plan_card ?? null;
    const lastOutcome = this.buildSupervisorOutcomePromptSummary(session?.last_material_outcome ?? null);
    const latestSupervisorInstruction = typeof session?.last_material_outcome?.latest_dev_instruction === 'string'
      ? session.last_material_outcome.latest_dev_instruction
      : typeof session?.last_material_outcome?.dev_instruction === 'string'
      ? session.last_material_outcome.dev_instruction
      : null;
    const latestDirectiveKind = typeof session?.last_material_outcome?.latest_dev_directive_kind === 'string'
      ? session.last_material_outcome.latest_dev_directive_kind
      : null;
    const latestSupervisorDecision = typeof session?.last_material_outcome?.supervisor_decision === 'string'
      ? session.last_material_outcome.supervisor_decision
      : null;
    const latestSupervisorReason = typeof session?.last_material_outcome?.supervisor_reason === 'string'
      ? session.last_material_outcome.supervisor_reason
      : null;
    const repoRef = workItem?.github_repo ?? planCard?.repo_ref ?? session?.repo_ref ?? null;
    const supervisorMemories = repoRef
      ? this.supervisorMemoryRepository.searchRelevant({
          repo_ref: repoRef,
          query: [
            workItem?.linear_title,
            workItem?.supervisor_plan_summary,
            planCard?.title,
            planCard?.user_goal,
            latestSupervisorInstruction,
          ].filter(Boolean).join(' '),
          limit: 3,
        })
      : [];

    const section = [
      workItem?.supervisor_locale ? runtimeLocaleInstruction(workItem.supervisor_locale) : null,
      '## Supervisor-Approved Plan',
      session
        ? `- Session: ${session.id} (${session.state}, plan v${session.plan_version})`
        : null,
      workItem?.supervisor_plan_summary || planCard?.title
        ? `- Plan Summary: ${this.compactSupervisorPromptValue(workItem?.supervisor_plan_summary ?? planCard?.title, 260)}`
        : null,
      planCard?.user_goal
        ? `- User Goal: ${this.compactSupervisorPromptValue(planCard.user_goal, 260)}`
        : null,
      workItem?.supervisor_acceptance_summary || planCard?.acceptance?.length
        ? `- Acceptance Summary: ${this.compactSupervisorPromptValue(workItem?.supervisor_acceptance_summary ?? planCard?.acceptance.join('；'), 360)}`
        : null,
      planCard?.in_scope?.length
        ? `- In Scope: ${this.compactSupervisorPromptValue(planCard.in_scope.join('；'), 360)}`
        : null,
      planCard?.out_of_scope?.length
        ? `- Out of Scope: ${this.compactSupervisorPromptValue(planCard.out_of_scope.join('；'), 320)}`
        : null,
      workItem?.supervisor_execution_mode || planCard?.materialization_mode
        ? `- Execution Mode: ${(workItem?.supervisor_execution_mode ?? planCard?.materialization_mode)?.toUpperCase()}`
        : null,
      session?.current_child_issue_id
        ? `- Current Child Issue ID: ${session.current_child_issue_id}`
        : null,
      session?.active_decision_kind
        ? `- Waiting Decision: ${session.active_decision_kind}`
        : null,
      session?.delivery_state || session?.delivery_summary
        ? `- Delivery State: ${this.compactSupervisorPromptValue(`${session.delivery_state ?? 'unknown'}${session.delivery_summary ? ` - ${session.delivery_summary}` : ''}`, 320)}`
        : null,
      lastOutcome
        ? `- Last Material Outcome: ${this.compactSupervisorPromptValue(lastOutcome, 260)}`
        : null,
      latestSupervisorInstruction || latestSupervisorDecision || latestSupervisorReason
        ? [
            '## Supervisor Oversight',
            latestDirectiveKind ? `- Directive: ${latestDirectiveKind}` : null,
            latestSupervisorDecision ? `- Decision: ${latestSupervisorDecision}` : null,
            latestSupervisorReason ? `- Reason: ${this.compactSupervisorPromptValue(latestSupervisorReason, 220)}` : null,
            latestSupervisorInstruction ? `- Next Instruction: ${this.compactSupervisorPromptValue(latestSupervisorInstruction, 260)}` : null,
          ].filter(Boolean).join('\n')
        : null,
      recentEvents.length > 0
        ? [
            '## Supervisor Session Memory',
            ...recentEvents.map((event) => {
              const payload = event.payload_json ? JSON.stringify(event.payload_json) : '{}';
              return `- ${event.event_kind}: ${this.compactSupervisorPromptValue(payload, 90)}`;
            }),
          ].join('\n')
        : null,
      supervisorMemories.length > 0
        ? [
            '## Supervisor Long-Term Memory',
            ...supervisorMemories.map((memory) => (
              `- ${memory.memory_kind}/${memory.subject_key}: ${this.compactSupervisorPromptValue(memory.summary, 180)}`
            )),
          ].join('\n')
        : null,
      '- Treat this as the approved execution contract unless a later runtime milestone explicitly pauses for a new decision.',
    ].filter(Boolean).join('\n');

    return this.clampSupervisorPromptSection(section, 4200);
  }

  private compactSupervisorPromptValue(value: string | null | undefined, maxLength: number): string {
    if (!value) {
      return '';
    }
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  private buildSupervisorOutcomePromptSummary(outcome: Record<string, unknown> | null): string | null {
    if (!outcome) {
      return null;
    }

    const keys = [
      'milestone_kind',
      'latest_dev_directive_kind',
      'latest_dev_instruction',
      'dev_instruction',
      'supervisor_decision',
      'supervisor_reason',
      'active_decision_kind',
      'delivery_code',
      'message',
    ];
    const compactOutcome: Record<string, unknown> = {};
    for (const key of keys) {
      if (outcome[key] !== undefined && outcome[key] !== null) {
        compactOutcome[key] = outcome[key];
      }
    }

    return Object.keys(compactOutcome).length > 0
      ? JSON.stringify(compactOutcome)
      : null;
  }

  private clampSupervisorPromptSection(section: string, maxLength: number): string {
    if (section.length <= maxLength) {
      return section;
    }
    return `${section.slice(0, Math.max(0, maxLength - 56)).trimEnd()}\n[Supervisor context truncated for first-turn budget]`;
  }

  private findSupervisorSessionForWorkItem(
    workItem: WorkItem | null | undefined,
  ): SupervisorSessionRecord | null {
    if (!workItem) {
      return null;
    }

    if (workItem.supervisor_root_session_id) {
      const byId = this.supervisorSessionRepository.findById(workItem.supervisor_root_session_id);
      if (byId) {
        return byId;
      }
    }

    const rootIssueId = workItem.governance_root_issue_id ?? workItem.linear_issue_id;
    return this.supervisorSessionRepository.findByRootIssueId(rootIssueId);
  }

  private pauseSupervisorSessionForTurnBudget(params: {
    workItem: WorkItem | null | undefined;
    issue: Issue;
    turnBudget: number;
    missingRequirements: CompletionRequirement[];
    supervisorMessage: string | null;
  }): string {
    const missingSummary = params.missingRequirements
      .map((requirement) => requirement.label || requirement.key)
      .filter(Boolean)
      .slice(0, 3)
      .join('；');
    const summary = [
      `开发 agent 已用完本轮 ${params.turnBudget} 个 turn，但 supervisor 认为还需要继续。`,
      missingSummary ? `仍缺少：${missingSummary}。` : null,
      '我已暂停自动重试，需要你确认继续、调整范围，或停止这条任务。',
    ].filter(Boolean).join('\n');
    const session = this.findSupervisorSessionForWorkItem(params.workItem);
    if (!session) {
      return summary;
    }

    this.supervisorSessionRepository.update({
      id: session.id,
      state: 'awaiting_user_decision',
      active_decision_kind: 'execution_decision',
      delivery_state: 'delivery_failed',
      delivery_summary: summary,
      last_material_outcome: {
        ...(session.last_material_outcome ?? {}),
        supervisor_decision: 'ask_user',
        supervisor_reason: 'turn_budget_exhausted',
        user_summary: summary,
        dev_instruction: null,
        turn_budget: params.turnBudget,
        supervisor_continue_message: params.supervisorMessage,
        missing_requirements: params.missingRequirements,
      },
    });
    this.supervisorSessionEventRepository.create({
      id: crypto.randomUUID(),
      session_id: session.id,
      event_kind: 'supervisor_turn_budget_exhausted',
      payload_json: {
        issue_id: params.issue.id,
        issue_identifier: params.issue.identifier,
        turn_budget: params.turnBudget,
        missing_requirements: params.missingRequirements,
        supervisor_continue_message: params.supervisorMessage,
      },
    });
    return summary;
  }

  private inheritSupervisorContext(
    sourceWorkItem: WorkItem,
    targetWorkItemId: string,
  ): void {
    if (
      !sourceWorkItem.supervisor_root_session_id &&
      !sourceWorkItem.supervisor_locale &&
      !sourceWorkItem.supervisor_plan_summary &&
      !sourceWorkItem.supervisor_acceptance_summary &&
      !sourceWorkItem.supervisor_execution_mode
    ) {
      return;
    }

    this.workItemRepository.update({
      id: targetWorkItemId,
      supervisor_root_session_id: sourceWorkItem.supervisor_root_session_id,
      supervisor_locale: sourceWorkItem.supervisor_locale,
      supervisor_plan_summary: sourceWorkItem.supervisor_plan_summary,
      supervisor_acceptance_summary: sourceWorkItem.supervisor_acceptance_summary,
      supervisor_execution_mode: sourceWorkItem.supervisor_execution_mode,
    });
  }

  private async updateWorkspaceStateMetadata(
    workspacePath: string,
    updater: (metadata: Record<string, unknown>) => void,
  ): Promise<void> {
    const fs = await import('fs/promises');
    const statePath = path.join(workspacePath, '.symphony', 'state.json');
    const current = await this.readWorkspaceStateFile(workspacePath);
    if (!current) {
      return;
    }

    const metadata = (
      current.metadata &&
      typeof current.metadata === 'object' &&
      !Array.isArray(current.metadata)
    ) ? current.metadata as Record<string, unknown> : {};
    updater(metadata);
    current.metadata = metadata;
    await fs.writeFile(statePath, JSON.stringify(current, null, 2), 'utf-8');
  }

  private async runHarnessSetupOnce(
    issue: Issue,
    workspacePath: string,
    effectiveHarness: EffectiveRepositoryHarness | null | undefined,
  ): Promise<void> {
    const setupCommand = effectiveHarness?.config.commands?.setup?.trim();
    if (!setupCommand) {
      return;
    }

    const state = await this.readWorkspaceStateFile(workspacePath);
    const metadata = (
      state?.metadata &&
      typeof state.metadata === 'object' &&
      !Array.isArray(state.metadata)
    ) ? state.metadata as Record<string, unknown> : {};
    const harnessSetup = (
      metadata.harness_setup &&
      typeof metadata.harness_setup === 'object' &&
      !Array.isArray(metadata.harness_setup)
    ) ? metadata.harness_setup as Record<string, unknown> : null;

    if (
      harnessSetup &&
      typeof harnessSetup.command === 'string' &&
      harnessSetup.command === setupCommand &&
      typeof harnessSetup.completed_at === 'string' &&
      harnessSetup.completed_at.trim()
    ) {
      return;
    }

    cp.execFileSync('/bin/sh', ['-lc', setupCommand], {
      cwd: workspacePath,
      env: {
        ...process.env,
        ...this.buildHarnessBridgeEnv(effectiveHarness),
      },
      encoding: 'utf-8',
      timeout: this.config.hooks.timeout_ms,
      stdio: 'pipe',
    });

    await this.updateWorkspaceStateMetadata(workspacePath, (workspaceMetadata) => {
      workspaceMetadata.harness_setup = {
        command: setupCommand,
        completed_at: new Date().toISOString(),
      };
    });

    await recordChangePackEvidence({
      workspacePath,
      harness: effectiveHarness?.config,
      commandRuns: [
        {
          command: setupCommand,
          command_key: 'setup',
          status: 'satisfied',
          source: 'harness_setup',
          turn: null,
        },
      ],
      artifactObservations: await collectWorkspaceArtifactObservations({
        workspacePath,
        harness: effectiveHarness?.config,
      }),
    });

    this.emitTimelineEvent(issue, {
      level: 'info',
      category: 'diagnostic',
      code: 'evidence_collected',
      message: `Executed workspace setup for ${issue.identifier}.`,
      turn: null,
      tool_name: null,
      detail: {
        command: setupCommand,
        harness_source: effectiveHarness?.source ?? null,
      },
    });
  }

  private async recordTurnEvidence(
    issue: Issue,
    workspacePath: string,
    effectiveHarness: EffectiveRepositoryHarness | null | undefined,
    timeline: AgentTimelinePayload[],
  ): Promise<void> {
    const commandRuns = collectTimelineCommandRuns({
      timeline,
      harness: effectiveHarness?.config,
    });
    const artifactObservations = await collectWorkspaceArtifactObservations({
      workspacePath,
      harness: effectiveHarness?.config,
    });
    const runtimeObservations = await collectRuntimeObservations({
      workspacePath,
      harness: effectiveHarness?.config,
      turn: timeline[timeline.length - 1]?.turn ?? null,
      timeline,
    });

    if (commandRuns.length === 0 && artifactObservations.length === 0 && runtimeObservations.length === 0) {
      return;
    }

    const recorded = await recordChangePackEvidence({
      workspacePath,
      harness: effectiveHarness?.config,
      commandRuns,
      artifactObservations,
      runtimeObservations,
    });

    if (
      recorded.commandRunsAdded === 0 &&
      recorded.artifactObservationsAdded === 0 &&
      recorded.runtimeObservationsAdded === 0
    ) {
      return;
    }

    this.emitTimelineEvent(issue, {
      level: 'info',
      category: 'diagnostic',
      code: 'change_pack_updated',
      message: `Updated change-pack evidence for ${issue.identifier}.`,
      turn: null,
      tool_name: null,
      detail: {
        command_runs_added: recorded.commandRunsAdded,
        artifact_observations_added: recorded.artifactObservationsAdded,
        runtime_observations_added: recorded.runtimeObservationsAdded,
      },
    });

    this.emitTimelineEvent(issue, {
      level: 'info',
      category: 'diagnostic',
      code: 'evidence_collected',
      message: `Collected runtime evidence for ${issue.identifier}.`,
      turn: null,
      tool_name: null,
      detail: {
        command_runs_added: recorded.commandRunsAdded,
        artifact_observations_added: recorded.artifactObservationsAdded,
        runtime_observations_added: recorded.runtimeObservationsAdded,
      },
    });
  }

  private async recordPostProcessEvidence(
    issue: Issue,
    workItemId: string,
    workspacePath: string,
    mode: 'dev' | 'review',
    effectiveHarness: EffectiveRepositoryHarness | null | undefined,
    cliResult: CliCommandInvocationResult,
  ): Promise<void> {
    const commandRuns = [
      {
        phase: mode,
        command: `python3 ./scripts/cli.py ${mode} ${issue.identifier}`,
        command_key: mode,
        status: cliResult.success && cliResult.result?.ok ? 'satisfied' : 'failed',
        source: 'cli_postprocess',
        turn: null,
        exit_code: cliResult.success ? 0 : 1,
        summary: cliResult.success && cliResult.result?.ok
          ? `CLI ${mode} post-process completed with final state ${cliResult.result.final_state || issue.state}.`
          : (cliResult.error || `CLI ${mode} post-process failed.`),
      },
    ] as const;
    const artifactObservations = await collectWorkspaceArtifactObservations({
      workspacePath,
      harness: effectiveHarness?.config,
    });
    const runtimeObservations = await collectRuntimeObservations({
      workspacePath,
      harness: effectiveHarness?.config,
      turn: null,
      timeline: [],
    });

    const recorded = await recordChangePackEvidence({
      workspacePath,
      harness: effectiveHarness?.config,
      commandRuns: [...commandRuns],
      artifactObservations,
      runtimeObservations,
    });
    const changePackState = await evaluateChangePackState({
      workspacePath,
      issue,
      mode,
    });

    this.workItemRepository.update({
      id: workItemId,
      change_pack_summary: changePackState.summary,
      task_status: changePackState.task_status,
      evidence_summary: changePackState.evidence_summary,
      missing_requirements: changePackState.missing_requirements,
    });

    if (
      recorded.commandRunsAdded === 0 &&
      recorded.artifactObservationsAdded === 0 &&
      recorded.runtimeObservationsAdded === 0
    ) {
      return;
    }

    this.emitTimelineEvent(issue, {
      level: 'info',
      category: 'diagnostic',
      code: 'change_pack_updated',
      message: `Captured final ${mode} post-process evidence for ${issue.identifier}.`,
      turn: null,
      tool_name: null,
      detail: {
        source: 'cli_postprocess',
        command_runs_added: recorded.commandRunsAdded,
        artifact_observations_added: recorded.artifactObservationsAdded,
        runtime_observations_added: recorded.runtimeObservationsAdded,
      },
    });

    this.emitTimelineEvent(issue, {
      level: 'info',
      category: 'diagnostic',
      code: 'evidence_collected',
      message: `Collected final ${mode} post-process evidence for ${issue.identifier}.`,
      turn: null,
      tool_name: null,
      detail: {
        source: 'cli_postprocess',
        command_runs_added: recorded.commandRunsAdded,
        artifact_observations_added: recorded.artifactObservationsAdded,
        runtime_observations_added: recorded.runtimeObservationsAdded,
      },
    });
  }

  private async resolveEffectiveHarness(
    workspacePath: string,
    route: ResolvedRepositoryRoute,
  ): Promise<{
    harness: ResolvedRepositoryHarness;
    effectiveHarness: EffectiveRepositoryHarness;
    shouldEmitMissingHarness: boolean;
  }> {
    let harness = await loadRepositoryHarness(workspacePath);
    const shouldEmitMissingHarness = harness.status === 'missing';

    if (harness.status === 'missing') {
      harness = await inferShadowHarness({
        workspacePath,
        repoKey: route.github_repo_full,
        repository: this.shadowHarnessRepository,
      });
    }

    return {
      harness,
      effectiveHarness: buildEffectiveRepositoryHarness(harness),
      shouldEmitMissingHarness,
    };
  }

  private async buildWorkspaceHint(
    workspacePath: string,
    effectiveHarness?: EffectiveRepositoryHarness | null,
  ): Promise<string> {
    const harnessLines = effectiveHarness ? [
      `Harness source: ${effectiveHarness.source}`,
      Object.keys(effectiveHarness.config.commands ?? {}).length > 0
        ? `Harness commands: ${Object.entries(effectiveHarness.config.commands ?? {}).map(([key, value]) => `${key}=${value}`).join(' | ')}`
        : 'Harness commands: (none declared)',
      effectiveHarness.config.verification?.required_commands?.length
        ? `Required commands: ${effectiveHarness.config.verification.required_commands.join(', ')}`
        : null,
      effectiveHarness.config.verification?.required_artifacts?.length
        ? `Required artifacts: ${effectiveHarness.config.verification.required_artifacts.join(', ')}`
        : null,
      Object.keys(effectiveHarness.config.runtime_hints ?? {}).length > 0
        ? `Runtime hints: ${Object.entries(effectiveHarness.config.runtime_hints ?? {}).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(', ') : value}`).join(' | ')}`
        : null,
    ].filter(Boolean) as string[] : [];

    try {
      const output = cp.execFileSync('git', ['status', '--short', '--branch'], {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 5000,
      });
      const trimmed = output.trim();
      return [...harnessLines, trimmed ? trimmed.slice(0, 4000) : 'git status clean']
        .filter(Boolean)
        .join('\n');
    } catch {
      return [...harnessLines, 'workspace hint unavailable'].filter(Boolean).join('\n');
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
    if (mode === 'dev' && this.isLiveLifecycleVerificationIssue(issue)) {
      return Math.max(2, Math.min(this.config.maxTurns, 2));
    }

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

  private isLiveLifecycleVerificationIssue(issue: Issue): boolean {
    const title = issue.title.toLowerCase();
    const description = (issue.description || '').toLowerCase();
    const combinedText = `${title}\n${description}`;

    return (
      combinedText.includes('live-lifecycle')
      || combinedText.includes('verification nonce:')
      || combinedText.includes('supervisor live e2e')
      || combinedText.includes('supervisor-live-')
      || (combinedText.includes('smoke-test') && combinedText.includes('full lifecycle'))
      || (combinedText.includes('smoke test') && combinedText.includes('full lifecycle'))
    );
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

    if (
      mode === 'dev' &&
      artifactCompletion &&
      this.isLiveLifecycleVerificationIssue(issue) &&
      turnNumber >= turnBudget
    ) {
      return true;
    }

    if (
      mode === 'review' &&
      artifactCompletion &&
      turnNumber >= turnBudget
    ) {
      return true;
    }

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
    effectiveHarness?: EffectiveRepositoryHarness | null;
    transcript: TurnTranscriptEntry[];
    timeline: AgentTimelinePayload[];
  }): Promise<SupervisorNextAction> {
    const workspaceHint = await this.buildWorkspaceHint(params.workspacePath, params.effectiveHarness);
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
    effectiveHarness?: EffectiveRepositoryHarness | null;
    transcript: TurnTranscriptEntry[];
    timeline: AgentTimelinePayload[];
  }) {
    const workspaceHint = await this.buildWorkspaceHint(params.workspacePath, params.effectiveHarness);
    return this.supervisor.respondToRuntimeRequest({
      ...params,
      workspaceHint,
    });
  }

  private getWorkflowArtifactPath(workspacePath: string, filename: string): string {
    return path.join(workspacePath, '.symphony', filename);
  }

  private async syncLinearState(issue: Issue, stateName: string): Promise<{
    success: boolean;
    recovered: boolean;
    currentState: string | null;
    error: string | null;
  }> {
    if (issue.state.toLowerCase() === stateName.toLowerCase()) {
      return {
        success: true,
        recovered: false,
        currentState: issue.state,
        error: null,
      };
    }

    const recoverFromTrackerState = async (error: string | null): Promise<{
      success: boolean;
      recovered: boolean;
      currentState: string | null;
      error: string | null;
    }> => {
      try {
        const fetched = await this.tracker.fetchIssueById(issue.id);
        const currentState = fetched.issue?.state ?? null;
        if (currentState && currentState.toLowerCase() === stateName.toLowerCase()) {
          console.log(
            `[orchestrator] Recovered Linear state transition for ${issue.identifier}; tracker is already at ${currentState}.`,
          );
          return {
            success: true,
            recovered: true,
            currentState,
            error: null,
          };
        }

        return {
          success: false,
          recovered: false,
          currentState,
          error: error ?? fetched.errorMessage ?? (typeof fetched.error === 'string' ? fetched.error : null),
        };
      } catch (fetchError) {
        return {
          success: false,
          recovered: false,
          currentState: null,
          error: error ?? (fetchError instanceof Error ? fetchError.message : String(fetchError)),
        };
      }
    };

    try {
      const result = await this.tracker.updateIssueState(issue.id, stateName);
      if (!result.success) {
        console.warn(`[orchestrator] Failed to update Linear issue ${issue.identifier} to ${stateName}: ${result.error}`);
        return recoverFromTrackerState(result.error ?? null);
      }
      return {
        success: true,
        recovered: false,
        currentState: stateName,
        error: null,
      };
    } catch (err) {
      console.warn(`[orchestrator] Exception updating Linear issue ${issue.identifier} to ${stateName}:`, err);
      return recoverFromTrackerState(err instanceof Error ? err.message : String(err));
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

  private async closeMappedGitHubIssue(workItem: WorkItem | null, context: string): Promise<boolean> {
    const result = await this.closeMappedGitHubIssueWithResult(workItem, context);
    return result.success;
  }

  private async closeMappedGitHubIssueWithResult(
    workItem: WorkItem | null,
    context: string,
  ): Promise<{ attempted: boolean; success: boolean; error: string | null }> {
    if (!workItem?.github_issue_number) {
      return { attempted: false, success: false, error: null };
    }

    try {
      const client = this.githubIssueClientFactory(workItem.github_repo);
      await client.closeIssue(workItem.github_issue_number);
      console.log(`[orchestrator] Closed GitHub issue #${workItem.github_issue_number} for ${context}`);
      return { attempted: true, success: true, error: null };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(
        `[orchestrator] Failed to close GitHub issue #${workItem.github_issue_number} for ${context}:`,
        err,
      );
      return { attempted: true, success: false, error };
    }
  }

  private recordGitHubIssueCloseSyncEvent(
    workItem: WorkItem | null,
    result: { attempted: boolean; success: boolean; error: string | null },
    context: string,
    options: { successorIdentifier?: string | null } = {},
  ): void {
    if (!workItem || !result.attempted) {
      return;
    }

    this.recordSyncEvent({
      workItemId: workItem.id,
      targetSystem: 'github',
      action: 'close_issue',
      payload: {
        repo: workItem.github_repo,
        github_issue_number: workItem.github_issue_number,
        cleanup_context: context,
        successor_issue_identifier: options.successorIdentifier ?? null,
      },
      success: result.success,
      error: result.error,
    });
  }

  private async closeMappedGitHubIssueWithSyncEvent(
    workItem: WorkItem | null,
    context: string,
    options: { successorIdentifier?: string | null } = {},
  ): Promise<{ attempted: boolean; success: boolean; error: string | null }> {
    const result = await this.closeMappedGitHubIssueWithResult(workItem, context);
    this.recordGitHubIssueCloseSyncEvent(workItem, result, context, options);
    return result;
  }

  private githubPullRequestMatchesWorkItem(
    pullRequest: { title?: string | null; body?: string | null; head_branch?: string | null },
    workItem: WorkItem,
  ): boolean {
    const identifier = workItem.linear_identifier?.trim().toUpperCase();
    const branchName = workItem.branch_name?.trim();
    if (branchName && pullRequest.head_branch === branchName) {
      return true;
    }
    if (!identifier) {
      return false;
    }
    return [
      pullRequest.title,
      pullRequest.body,
      pullRequest.head_branch,
    ].some((value) => value?.toUpperCase().includes(identifier));
  }

  private async closeMappedGitHubPullRequestsWithResult(
    workItem: WorkItem | null,
    context: string,
  ): Promise<{ attempted: boolean; success: boolean; error: string | null; pr_numbers: number[] }> {
    if (!workItem?.github_repo) {
      return { attempted: false, success: false, error: null, pr_numbers: [] };
    }

    const client = this.githubIssueClientFactory(workItem.github_repo);
    const prNumbers = new Set<number>();
    if (workItem.active_pr_number) {
      prNumbers.add(workItem.active_pr_number);
    }

    let listError: string | null = null;
    if (workItem.branch_name || workItem.linear_identifier) {
      try {
        const openPullRequests = await client.listOpenPullRequests();
        for (const pullRequest of openPullRequests) {
          if (this.githubPullRequestMatchesWorkItem(pullRequest, workItem)) {
            prNumbers.add(pullRequest.number);
          }
        }
      } catch (err) {
        listError = err instanceof Error ? err.message : String(err);
        console.warn(`[orchestrator] Failed to list open GitHub pull requests for ${context}:`, err);
      }
    }

    if (prNumbers.size === 0) {
      return {
        attempted: Boolean(listError),
        success: !listError,
        error: listError,
        pr_numbers: [],
      };
    }

    const errors: string[] = [];
    const closed: number[] = [];
    for (const prNumber of prNumbers) {
      try {
        await client.updatePullRequest(prNumber, { state: 'closed' });
        closed.push(prNumber);
        console.log(`[orchestrator] Closed GitHub pull request #${prNumber} for ${context}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        errors.push(`#${prNumber}: ${error}`);
        console.warn(`[orchestrator] Failed to close GitHub pull request #${prNumber} for ${context}:`, err);
      }
    }
    if (listError) {
      errors.push(`list_open_pull_requests: ${listError}`);
    }

    return {
      attempted: true,
      success: errors.length === 0,
      error: errors.length > 0 ? errors.join('; ') : null,
      pr_numbers: closed.length > 0 ? closed : Array.from(prNumbers),
    };
  }

  private recordGitHubPullRequestCloseSyncEvent(
    workItem: WorkItem | null,
    result: { attempted: boolean; success: boolean; error: string | null; pr_numbers: number[] },
    context: string,
    options: { successorIdentifier?: string | null } = {},
  ): void {
    if (!workItem || !result.attempted) {
      return;
    }

    this.recordSyncEvent({
      workItemId: workItem.id,
      targetSystem: 'github',
      action: 'close_pull_request',
      payload: {
        repo: workItem.github_repo,
        pr_numbers: result.pr_numbers,
        branch_name: workItem.branch_name,
        cleanup_context: context,
        successor_issue_identifier: options.successorIdentifier ?? null,
      },
      success: result.success,
      error: result.error,
    });
  }

  private async closeMappedGitHubPullRequestsWithSyncEvent(
    workItem: WorkItem | null,
    context: string,
    options: { successorIdentifier?: string | null } = {},
  ): Promise<{ attempted: boolean; success: boolean; error: string | null; pr_numbers: number[] }> {
    const result = await this.closeMappedGitHubPullRequestsWithResult(workItem, context);
    this.recordGitHubPullRequestCloseSyncEvent(workItem, result, context, options);
    return result;
  }

  private async cleanupTerminalWorkItemResidue(
    workItem: WorkItem | null,
    issue: Issue,
    context: string,
    options: { successorIdentifier?: string | null } = {},
  ): Promise<void> {
    if (!workItem) {
      return;
    }

    await this.closeMappedGitHubIssueWithSyncEvent(workItem, context, options);
    await this.closeMappedGitHubPullRequestsWithSyncEvent(workItem, context, options);
    await this.cleanupClosedWorkItemWorkspace(workItem, issue);
  }

  private async cleanupClosedWorkItemWorkspace(workItem: WorkItem, issue: Issue): Promise<void> {
    if (workItem.workspace_path) {
      try {
        await this.workspaceManager.removeWorkspace(workItem.workspace_path);
        console.log(`[orchestrator] Workspace cleaned for closed issue: ${workItem.linear_identifier}`);
      } catch (err) {
        console.warn(`[orchestrator] Failed to clean workspace for closed issue ${workItem.linear_identifier}:`, err);
      }
    }

    try {
      await this.cleanupIssueBranch({
        issue,
        workItemId: workItem.id,
        workspacePath: workItem.workspace_path ?? undefined,
        explicitBranchName: workItem.branch_name,
      });
    } catch (err) {
      console.warn(`[orchestrator] Failed to clean branches for closed issue ${workItem.linear_identifier}:`, err);
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
            'Review passed, but the merge failed. The orchestrator stopped this task for manual conflict resolution.',
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

  private buildNoOpGovernanceChildComment(issue: Issue, summary: string | null): string {
    return [
      '## Governance Child no-op Complete',
      `Issue: ${issue.identifier}`,
      '',
      'This governance child finished without a PR because no actionable code diff remained after workflow artifact cleanup.',
      '',
      summary?.trim() || 'No actionable diff remained, so Symphony closed this child as a no-op completion.',
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
    if (
      !reviewDecision ||
      reviewDecision === 'APPROVE' ||
      reviewDecision === 'APPROVE_MINOR' ||
      reviewDecision === 'MERGE_BLOCKED'
    ) {
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
      ['REQUEST_CHANGES', 'REQUEST_TESTS', 'REJECT'].includes(normalizedReviewDecision)
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

    if (command === 'review' && normalizedReviewDecision === 'MERGE_BLOCKED') {
      return {
        ...baseResult,
        outcome: 'halted',
        next_action: 'stop',
        completed: false,
        cleanup_workspace: false,
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

  private isNonRetryableDeliveryCode(code: string | null | undefined): boolean {
    return [
      'review_submit_failed',
      'dirty_workspace_no_commit',
      'product_staging_failed',
      'tracker_state_conflict',
      'no_actionable_diff',
      'merge_blocked',
    ].includes((code ?? '').trim());
  }

  private persistDeliveryResult(workItemId: string, cliResult: CliCommandResult | null | undefined): void {
    if (!cliResult) {
      return;
    }

    this.workItemRepository.update({
      id: workItemId,
      delivery_code: cliResult.delivery_code ?? null,
      delivery_summary: cliResult.delivery_summary ?? cliResult.feedback ?? null,
    });
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

      const harnessResolution = await this.resolveEffectiveHarness(workspace.path, route);

      // Step 2: Initialize state via dispatch command
      const dispatchResult = await this.runCliCommand('dispatch', issue.identifier, workspace.path, {
        SYMPHONY_GITHUB_OWNER: route.github_owner,
        SYMPHONY_GITHUB_REPO: route.github_repo,
        SYMPHONY_GITHUB_REPO_FULL: route.github_repo_full,
        ...this.buildHarnessBridgeEnv(harnessResolution.effectiveHarness),
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
        harnessResolution,
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

      await this.runHarnessSetupOnce(issue, workspace.path, governedState.effectiveHarness);

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
          buildReviewAgentContextMarkdown(reviewContext),
          this.buildHarnessPromptSection(governedState.effectiveHarness),
          this.buildSupervisorPromptSection(workItem),
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
          buildDevAgentContextMarkdown(devContext),
          this.buildHarnessPromptSection(governedState.effectiveHarness),
          this.buildSupervisorPromptSection(workItem),
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
      let reviewArtifactRepairBudget = 0;
      const touchedPathSet = new Set(workItem.touched_paths);

      while (sessionActive && turnNumber <= turnBudget + reviewArtifactRepairBudget) {
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
            effectiveHarness: governedState.effectiveHarness,
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

        const turnTouchedPaths = deriveTouchedPathsFromTimeline(turnResult.timeline);
        for (const touchedPath of turnTouchedPaths) {
          touchedPathSet.add(touchedPath);
        }
        const touchedPaths = [...touchedPathSet];
        const architecture = await analyzeTouchedPathsArchitecture({
          workspacePath: workspace.path,
          touchedPaths,
        });
        workItem = this.workItemRepository.update({
          id: workItem.id,
          touched_paths: touchedPaths,
          touched_areas: architecture.touched_areas,
          path_families: architecture.path_families,
          boundary_edges: architecture.boundary_edges,
          import_edges: architecture.import_edges,
          architectural_target: architecture.architectural_target,
        }) ?? workItem;
        await this.recordTurnEvidence(
          activeIssue,
          workspace.path,
          governedState.effectiveHarness,
          turnResult.timeline,
        );

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
          const hasExplicitHarnessRequirements = governedState.effectiveHarness.has_verification_requirements;
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
            effectiveHarness: governedState.effectiveHarness,
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
                if (isReview) {
                  const missingReviewReport = effectiveMissingRequirements.some((requirement) => requirement.key === 'review_report');
                  if (missingReviewReport && reviewArtifactRepairBudget < 1) {
                    reviewArtifactRepairBudget = 1;
                    turnNumber++;
                    currentPrompt = nextAction.message || `Review ${activeIssue.identifier} is missing .symphony/REVIEW_REPORT.md. Do only the minimum remaining review work, overwrite .symphony/REVIEW_REPORT.md with a canonical ## Review Decision line and a non-empty ## Review Summary section, then stop.`;
                    console.log(
                      `[orchestrator] Granting ${activeIssue.identifier} one review artifact repair turn because .symphony/REVIEW_REPORT.md is missing.`,
                    );
                    continue;
                  }
                  result.next_action = 'retry_review';
                  result.retry_delay_ms = 1000;
                  result.failure_reason = 'agent_turn';
                  result.error = `Review turn budget exhausted without a canonical .symphony/REVIEW_REPORT.md for ${activeIssue.identifier}.`;
                } else {
                  const deliverySummary = this.pauseSupervisorSessionForTurnBudget({
                    workItem,
                    issue: activeIssue,
                    turnBudget,
                    missingRequirements: effectiveMissingRequirements,
                    supervisorMessage: nextAction.message ?? null,
                  });
                  result.outcome = 'halted';
                  result.next_action = 'stop';
                  result.final_state = activeIssue.state;
                  result.cleanup_workspace = false;
                  result.cli_result = {
                    ok: false,
                    final_state: activeIssue.state,
                    review_decision: null,
                    feedback: deliverySummary,
                    delivery_code: 'supervisor_turn_budget_exhausted',
                    delivery_summary: deliverySummary,
                    retry_hint: 'stop',
                    linear_api_calls: 0,
                    github_api_calls: 0,
                  };
                }
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

      const latestBeforePostProcess = await this.tracker.fetchIssueById(issue.id);
      const latestIssueState = latestBeforePostProcess.issue?.state ?? null;
      if (!isReview && latestIssueState && this.isTerminalTrackerState(latestIssueState)) {
        console.log(
          `[orchestrator] ${issue.identifier} reached terminal tracker state ${latestIssueState} during dev turn; skipping dev post-processing.`,
        );
        const outputSummary = await this.readWorkspaceFile(workspace.path, 'HANDOVER.md');
        this.workItemRepository.update({
          id: workItem.id,
          linear_state: latestIssueState,
          orchestrator_state: 'completed',
          workspace_path: workspace.path,
          workspace_key: issue.identifier,
          branch_name: workspace.git_branch || issue.branch_name || workItem.branch_name,
        });
        finalizeAgentRun('completed', outputSummary, null, null);
        return {
          ...result,
          success: true,
          completed: true,
          outcome: 'completed',
          next_action: 'none',
          final_state: latestIssueState,
          workspace_path: workspace.path,
          cleanup_workspace: true,
          work_item_id: workItem.id,
          agent_run_id: agentRun.id,
        };
      }

      // Run appropriate CLI command based on state
      this.setRunningStage(issue.id, isReview ? 'post_process_review' : 'post_process_dev');
      workItem = this.workItemRepository.update({
        id: workItem.id,
        orchestrator_state: isReview ? 'review_post_processing' : 'dev_post_processing',
      }) ?? workItem;
      await this.ensureWorkspaceStateForPostProcess({
        command: cliCommand,
        issue: activeIssue,
        workspacePath: workspace.path,
        workItem,
        route,
      });
      const cliResult = await this.runCliCommand(
        cliCommand,
        issue.identifier,
        workspace.path,
        this.buildHarnessBridgeEnv(governedState.effectiveHarness),
      );
      console.log(`[orchestrator] CLI ${cliCommand} result: success=${cliResult.success}`);

      if (isReview) {
        if (cliResult.success && cliResult.result?.ok) {
          await this.handleReviewFeedback(workspace.path, cliResult.result);
        }
      }

      await this.recordPostProcessEvidence(
        activeIssue,
        workItem.id,
        workspace.path,
        cliCommand,
        governedState.effectiveHarness,
        cliResult,
      );
      this.persistDeliveryResult(workItem.id, cliResult.result ?? null);

      if (!cliResult.success || !cliResult.result || !cliResult.result.ok) {
        result.work_item_id = workItem.id;
        result.agent_run_id = agentRun.id;
        result.workspace_path = workspace.path;
        result.cli_result = cliResult.result;
        result.failure_reason = 'cli_business';
        result.error =
          cliResult.result?.delivery_summary
          || cliResult.result?.feedback
          || cliResult.error
          || 'CLI business executor failed';
        if (this.isNonRetryableDeliveryCode(cliResult.result?.delivery_code)) {
          result.outcome = 'halted';
          result.next_action = 'stop';
          result.completed = false;
          result.final_state = cliResult.result?.final_state || issue.state;
        }
        finalizeAgentRun('failed', null, null, result.error);
        return result;
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

  private async ensureWorkspaceStateForPostProcess(params: {
    command: 'dev' | 'review';
    issue: Issue;
    workspacePath: string;
    workItem: Pick<WorkItem, 'branch_name' | 'github_repo' | 'github_issue_number'>;
    route: Pick<ResolvedRepositoryRoute, 'github_repo_full'>;
  }): Promise<void> {
    const fs = await import('fs/promises');
    const statePath = path.join(params.workspacePath, '.symphony', 'state.json');
    try {
      await fs.access(statePath);
      return;
    } catch {
      // Continue below.
    }

    const symphonyPath = path.dirname(statePath);
    await fs.mkdir(symphonyPath, { recursive: true });
    const branch = params.workItem.branch_name
      || params.issue.branch_name
      || `feature/${params.issue.identifier.toLowerCase()}`;
    const currentState = params.command === 'review' ? 'IN_REVIEW' : 'IN_PROGRESS';
    const linearState = params.command === 'review' ? 'In Review' : 'In Progress';
    const stateData = {
      version: 1,
      issue_id: params.issue.identifier,
      current_state: currentState,
      previous_state: null,
      transition_history: [],
      metadata: {
        linear_issue_id: params.issue.id,
        linear_state: linearState,
        github_repo: params.workItem.github_repo || params.route.github_repo_full,
        github_issue_number: params.workItem.github_issue_number ?? null,
        branch,
      },
      error: null,
      retry_count: 0,
    };
    await fs.writeFile(statePath, JSON.stringify(stateData, null, 2), 'utf-8');
    console.warn(
      `[orchestrator] Recreated missing .symphony/state.json for ${params.issue.identifier} before ${params.command} post-processing.`,
    );
  }

  private async handleDevCompletion(runningEntry: RunningEntry, result: WorkerResult): Promise<boolean> {
    if (!result.work_item_id) {
      return false;
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

    const trackerSync = await this.syncLinearState(runningEntry.issue, 'In Review');
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
        delivery_code: null,
        delivery_summary: null,
      });
    }
    return trackerSync.success;
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
      delivery_code: null,
      delivery_summary: null,
    });
    const refreshedWorkItem = this.workItemRepository.findById(workItem.id) ?? workItem;
    this.governanceMemoryService.recordDebtOutcome(refreshedWorkItem.id, {
      signal_code: reviewDecision === 'MERGE_BLOCKED' ? 'merge_blocked' : 'review_requested_changes',
      summary: reviewDecision === 'MERGE_BLOCKED'
        ? `Review passed but merge blocked for ${runningEntry.issue.identifier}.`
        : `Review requested changes for ${runningEntry.issue.identifier}.`,
      severity: 'high',
    });
    this.refreshRepoGovernanceIntelligence(
      { ...runningEntry.issue, state: 'In Progress' },
      refreshedWorkItem.id,
      refreshedWorkItem.github_repo,
    );
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
      delivery_code: null,
      delivery_summary: null,
      missing_requirements: [],
    });
    await this.closeMappedGitHubIssue(workItem, `${runningEntry.issue.identifier} review completion`);
    const refreshedWorkItem = this.workItemRepository.findById(workItem.id) ?? workItem;
    this.governanceMemoryService.recordDecisionOutcome(refreshedWorkItem.id);
    this.refreshRepoGovernanceIntelligence(
      { ...runningEntry.issue, state: 'Done' },
      refreshedWorkItem.id,
      refreshedWorkItem.github_repo,
    );
  }

  private async handleHaltedWorkItem(runningEntry: RunningEntry, result: WorkerResult): Promise<void> {
    if (!result.work_item_id) {
      return;
    }

    const finalState = result.final_state || runningEntry.issue.state;
    const reviewDecision = this.normalizeReviewDecision(result.cli_result?.review_decision);
    const mergeBlocked = reviewDecision === 'MERGE_BLOCKED';
    const nextState = finalState.toLowerCase() === 'cancelled' || finalState.toLowerCase() === 'canceled'
      ? 'cancelled'
      : (this.isTerminalTrackerState(finalState) ? 'completed' : 'halted');
    const synced = await this.syncWorkItemFromWorkspaceState(
      result.work_item_id,
      runningEntry.issue,
      result.workspace_path,
      nextState
    );
    const workItem = synced ?? this.workItemRepository.findById(result.work_item_id);
    const nextRound = workItem ? workItem.review_round + 1 : 1;
    const haltedSummary = result.cli_result?.delivery_summary
      ?? result.cli_result?.feedback
      ?? result.error
      ?? null;
    const reviewSummary = result.cli_result?.feedback ?? haltedSummary;

    if (mergeBlocked && workItem?.active_pr_number) {
      this.reviewEventRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        pr_number: workItem.active_pr_number,
        review_round: nextRound,
        decision: 'MERGE_BLOCKED',
        summary_md: reviewSummary || `Merge blocked for ${runningEntry.issue.identifier}`,
        requested_changes_md: null,
        merge_block_reason: reviewSummary || 'Review passed, but merge failed.',
      });
    }

    if (mergeBlocked && this.config.reviewPolicy.notifyLinearOnReview) {
      await this.postLinearComment(
        runningEntry.issue.id,
        this.buildLinearReviewComment(runningEntry.issue, 'MERGE_BLOCKED', reviewSummary)
      );
    }

    this.workItemRepository.update({
      id: result.work_item_id,
      linear_state: mergeBlocked ? runningEntry.issue.state : finalState,
      orchestrator_state: nextState,
      delivery_code: result.cli_result?.delivery_code ?? (mergeBlocked ? 'merge_blocked' : null),
      delivery_summary: haltedSummary,
      last_review_decision: mergeBlocked ? 'MERGE_BLOCKED' : undefined,
      last_review_summary: mergeBlocked ? reviewSummary : undefined,
      review_round: mergeBlocked ? nextRound : undefined,
      cancelled_at: nextState === 'cancelled' ? new Date() : undefined,
    });
    const refreshedWorkItem = this.workItemRepository.findById(result.work_item_id);
    if (mergeBlocked && refreshedWorkItem) {
      this.governanceMemoryService.recordDebtOutcome(refreshedWorkItem.id, {
        signal_code: 'merge_blocked',
        summary: `Review passed but merge blocked for ${runningEntry.issue.identifier}.`,
        severity: 'high',
      });
      this.refreshRepoGovernanceIntelligence(
        runningEntry.issue,
        refreshedWorkItem.id,
        refreshedWorkItem.github_repo,
      );
    }
  }

  private async handleNoOpGovernanceChildCompletion(
    runningEntry: RunningEntry,
    result: WorkerResult,
  ): Promise<boolean> {
    if (result.cli_result?.delivery_code !== 'no_actionable_diff' || !result.work_item_id) {
      return false;
    }

    const workItem = this.workItemRepository.findById(result.work_item_id);
    if (!workItem?.governance_parent_issue_id) {
      return false;
    }

    const summary = result.cli_result.delivery_summary ?? result.cli_result.feedback ?? result.error ?? null;
    const trackerSync = await this.syncLinearState(runningEntry.issue, 'Done');
    if (!trackerSync.success) {
      this.workItemRepository.update({
        id: workItem.id,
        delivery_code: 'tracker_state_conflict',
        delivery_summary: trackerSync.error ?? summary,
      });
      return false;
    }

    await this.postLinearComment(
      runningEntry.issue.id,
      this.buildNoOpGovernanceChildComment(runningEntry.issue, summary),
    );
    this.workItemRepository.update({
      id: workItem.id,
      linear_state: 'Done',
      orchestrator_state: 'completed',
      merged_at: new Date(),
      delivery_code: 'no_actionable_diff',
      delivery_summary: summary,
    });
    const refreshedWorkItem = this.workItemRepository.findById(workItem.id) ?? workItem;
    this.emitTimelineEvent(
      { ...runningEntry.issue, state: 'Done' },
      {
        level: 'info',
        category: 'diagnostic',
        code: 'governance_child_noop_closed',
        message: `Closed governance child ${runningEntry.issue.identifier} as a no-op completion.`,
        turn: null,
        tool_name: null,
        detail: {
          delivery_code: 'no_actionable_diff',
          delivery_summary: summary,
        },
      },
    );
    this.governanceMemoryService.recordDecisionOutcome(refreshedWorkItem.id);
    this.refreshRepoGovernanceIntelligence(
      { ...runningEntry.issue, state: 'Done' },
      refreshedWorkItem.id,
      refreshedWorkItem.github_repo,
    );
    return true;
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
          cli_result: {
            ok: false,
            final_state: runningEntry.issue.state,
            review_decision: null,
            feedback: 'Stopped by user',
            delivery_code: 'manual_stop',
            delivery_summary: '这张单已被手动停止；除非用户显式 retry 或更新 tracker 内容，否则不会自动重启。',
            retry_hint: 'stop',
            linear_api_calls: 0,
            github_api_calls: 0,
          },
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
        const workspacePathForLearning = result.workspace_path ?? runningEntry.workspace_path ?? null;
        if (workspacePathForLearning) {
          await strengthenShadowHarnessFromWorkspace({
            workspacePath: workspacePathForLearning,
            repoKey: workItemForCompletion.github_repo,
            repository: this.shadowHarnessRepository,
            workItemId: workItemForCompletion.id,
          });
        }
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
          const harnessYaml = yaml.stringify(shadowRecord.config_json).trimEnd();
          this.governanceSuggestionRepository.create({
            id: crypto.randomUUID(),
            work_item_id: workItemForCompletion.id,
            issue_id: workItemForCompletion.linear_issue_id,
            suggestion_type: 'harness_adoption',
            title: `[GOVERNANCE] Adopt formal repo harness for ${workItemForCompletion.github_repo}`,
            summary: 'This repository has completed several successful runs with the shadow harness. Consider promoting it to a formal .symphony-repo.yaml.',
            detail_json: {
              github_repo: workItemForCompletion.github_repo,
              harness_payload: shadowRecord.config_json,
              harness_yaml: `${harnessYaml}\n`,
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

      let shouldDispatchReviewAfterDev = false;
      const completedReviewRun = runningEntry.issue.state.toLowerCase() === 'in review'
        || Boolean(result.cli_result?.review_decision);
      const completedExternallyTerminalDevRun =
        !completedReviewRun &&
        Boolean(result.final_state && this.isTerminalTrackerState(result.final_state));
      if (completedReviewRun) {
        await this.handleReviewCompletion(runningEntry, result);
      } else if (completedExternallyTerminalDevRun) {
        if (result.work_item_id) {
          this.workItemRepository.update({
            id: result.work_item_id,
            linear_state: result.final_state ?? runningEntry.issue.state,
            orchestrator_state: 'completed',
          });
        }
      } else {
        shouldDispatchReviewAfterDev = await this.handleDevCompletion(runningEntry, result);
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

      if (
        shouldDispatchReviewAfterDev &&
        this.running &&
        this.hasAvailableSlots()
      ) {
        await this.dispatchIssue({
          ...runningEntry.issue,
          state: 'In Review',
          updated_at: new Date(),
        }, null);
      }
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
      const handledNoOpCompletion = await this.handleNoOpGovernanceChildCompletion(runningEntry, result);
      if (handledNoOpCompletion) {
        this.setRunningStage(issueId, 'completed');
        this.state.running.delete(issueId);
        this.state.claimed.delete(issueId);
        this.state.completed.add(issueId);
        if (result.workspace_path) {
          try {
            await this.workspaceManager.removeWorkspace(result.workspace_path);
          } catch (err) {
            console.warn('[orchestrator] Failed to clean workspace after no-op child completion:', err);
          }
        }
        try {
          await this.cleanupAllTerminalIssueBranches();
        } catch (err) {
          console.warn('[orchestrator] Failed to clean branches after no-op child completion:', err);
        }
        if (this.running) {
          this.scheduleTick(0);
        }
        this.emit('issue:completed', runningEntry.issue, true);
        this.emit('state:changed', this.getStateSnapshot());
        return;
      }

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
      if (!(result.final_state && this.isTerminalTrackerState(result.final_state))) {
        this.emit(
          'issue:failed',
          runningEntry.issue,
          result.cli_result?.delivery_summary
            || result.cli_result?.feedback
            || result.error
            || 'Worker halted and needs user attention'
        );
      }
    } else {
      const workItemForFailure =
        result.work_item_id ? this.workItemRepository.findById(result.work_item_id) : null;
      if (workItemForFailure?.repo_harness_status === 'shadow') {
        const workspacePathForLearning = result.workspace_path ?? runningEntry.workspace_path ?? null;
        if (workspacePathForLearning) {
          await strengthenShadowHarnessFromWorkspace({
            workspacePath: workspacePathForLearning,
            repoKey: workItemForFailure.github_repo,
            repository: this.shadowHarnessRepository,
            workItemId: workItemForFailure.id,
          });
        }
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
          const refreshedWorkItem = this.workItemRepository.findById(result.work_item_id);
          if (refreshedWorkItem) {
            this.refreshRepoGovernanceIntelligence(runningEntry.issue, refreshedWorkItem.id, refreshedWorkItem.github_repo);
          }
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
          const refreshedWorkItem = this.workItemRepository.findById(result.work_item_id);
          if (refreshedWorkItem) {
            this.governanceMemoryService.recordDebtOutcome(refreshedWorkItem.id, {
              signal_code: result.next_action === 'retry_review' ? 'retry_review' : 'retry_dev',
              summary: result.error || result.failure_reason || 'Worker retry scheduled',
              severity: 'high',
            });
            this.refreshRepoGovernanceIntelligence(runningEntry.issue, refreshedWorkItem.id, refreshedWorkItem.github_repo);
          }
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
        const parsedResult = parseCliCommandResult(output);

        if (code !== 0) {
          resolve({
            success: false,
            result: parsedResult ?? undefined,
            error: `Command failed with code ${code}: ${output}`,
          });
          return;
        }

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
      if (stateLower === 'cancelled' || stateLower === 'canceled') {
        // Immediate cleanup for cancelled issues
        console.log(`[orchestrator] Issue ${runningEntry.identifier} was CANCELLED - immediate cleanup`);
        const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
        await this.terminateRunningIssue(runningEntry, false);
        if (workItem) {
          const updatedWorkItem = this.workItemRepository.update({
            id: workItem.id,
            linear_state: issue.state,
            orchestrator_state: 'cancelled',
            cancelled_at: new Date(),
          });
          const cleanupWorkItem = updatedWorkItem ?? workItem;
          await this.cleanupTerminalWorkItemResidue(cleanupWorkItem, issue, `${runningEntry.identifier} cancellation`);
        } else {
          const workspacePath = runningEntry.workspace_path ?? this.getRouteWorkspacePath(runningEntry.issue, runningEntry.identifier);
          if (workspacePath) {
            await this.workspaceManager.removeWorkspace(workspacePath);
          }
          await this.cleanupIssueBranch({
            issue: runningEntry.issue,
            workspacePath: runningEntry.workspace_path ?? workspacePath ?? undefined,
            explicitBranchName: runningEntry.branch_name,
          });
        }

        const retryEntry = this.state.retry_attempts.get(issue.id);
        if (retryEntry?.timer_handle) {
          clearTimeout(retryEntry.timer_handle);
        }
        this.state.retry_attempts.delete(issue.id);
        this.state.completed.add(issue.id);

        this.emit('issue:completed', runningEntry.issue, false);
        this.emit('state:changed', this.getStateSnapshot());

        continue;
      }

      if (isTerminal) {
        // Terminal state - terminate worker and clean workspace
        console.log('[orchestrator] Issue terminal, stopping:', runningEntry.identifier);
        const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
        if (workItem) {
          const updatedWorkItem = this.workItemRepository.update({
            id: workItem.id,
            linear_state: issue.state,
            orchestrator_state: 'completed',
          });
          await this.terminateRunningIssue(runningEntry, false);
          await this.cleanupTerminalWorkItemResidue(
            updatedWorkItem ?? workItem,
            issue,
            `${runningEntry.identifier} terminal state ${issue.state}`,
          );
        } else {
          await this.terminateRunningIssue(runningEntry, true);
        }
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

  private isCancelledTrackerState(state: string | undefined): boolean {
    return Boolean(state && /^(cancelled|canceled)$/i.test(state));
  }

  private async reconcileTrackedTerminalStates(): Promise<void> {
    const tracked = this.workItemRepository.findAll()
      .filter((workItem) => (
        Boolean(workItem.linear_issue_id) &&
        !this.isTerminalTrackerState(workItem.linear_state)
      ));
    if (tracked.length === 0) {
      return;
    }

    const ids = Array.from(new Set(
      tracked.map((workItem) => workItem.linear_issue_id).filter((id): id is string => Boolean(id)),
    ));
    const { issues, error } = await this.tracker.fetchIssueStatesByIds(ids);
    if (error) {
      console.error('[orchestrator] Tracked state refresh failed:', error);
      return;
    }

    for (const issue of issues) {
      if (!this.isTerminalTrackerState(issue.state)) {
        continue;
      }
      const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
      if (!workItem) {
        continue;
      }

      if (!this.isCancelledTrackerState(issue.state)) {
        await this.reconcileTerminalCompletedWorkItem(issue, workItem, 'tracked-state reconciliation');
        continue;
      }

      console.log(`[orchestrator] Reconcile detected cancelled tracked issue: ${workItem.linear_identifier}`);
      const updatedWorkItem = this.workItemRepository.update({
        id: workItem.id,
        linear_state: issue.state,
        orchestrator_state: 'cancelled',
        cancelled_at: new Date(),
      });
      this.state.running.delete(issue.id);
      this.state.claimed.delete(issue.id);
      this.state.retry_attempts.delete(issue.id);
      this.state.completed.add(issue.id);

      await this.cleanupTerminalWorkItemResidue(
        updatedWorkItem ?? workItem,
        issue,
        `${workItem.linear_identifier} tracked-state reconciliation`,
      );

      this.emit('issue:completed', issue, false);
      this.emit('state:changed', this.getStateSnapshot());
    }
  }

  private async reconcileTerminalCompletedWorkItem(
    issue: Issue,
    workItem: WorkItem,
    reason: string,
  ): Promise<WorkItem> {
    const updatedWorkItem = this.workItemRepository.update({
      id: workItem.id,
      linear_state: issue.state,
      orchestrator_state: 'completed',
      delivery_code: 'tracker_terminal_reconciled',
      delivery_summary: `${issue.identifier} 已在 tracker 中处于 ${issue.state}，本地运行态已对齐完成。`,
    }) ?? workItem;

    const retryEntry = this.state.retry_attempts.get(issue.id);
    if (retryEntry?.timer_handle) {
      clearTimeout(retryEntry.timer_handle);
    }
    this.state.running.delete(issue.id);
    this.state.claimed.delete(issue.id);
    this.state.retry_attempts.delete(issue.id);
    this.state.completed.add(issue.id);

    await this.cleanupTerminalWorkItemResidue(updatedWorkItem, issue, `${issue.identifier} ${reason}`);

    this.emit('issue:completed', issue, true);
    this.emit('state:changed', this.getStateSnapshot());
    return updatedWorkItem;
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
    if (this.hasActiveExecutionWork()) {
      console.log('[orchestrator] Skipping startup terminal cleanup because active execution is in flight.');
      return;
    }

    console.log('[orchestrator] Running startup terminal cleanup...');

    const { issues, error } = await this.tracker.fetchIssuesByStates(this.config.terminalStates);
    if (error) {
      console.warn('[orchestrator] Terminal issues fetch failed, continuing anyway:', error);
      return;
    }

    for (const issue of issues) {
      if (this.stopRequested) {
        break;
      }
      const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
      const workspacePath = workItem?.workspace_path ?? this.getRouteWorkspacePath(issue);
      try {
        if (workItem) {
          const updatedWorkItem = this.workItemRepository.update({
            id: workItem.id,
            linear_state: issue.state,
            orchestrator_state: this.isCancelledTrackerState(issue.state)
              ? 'cancelled'
              : this.isTerminalTrackerState(issue.state)
                ? 'completed'
                : 'halted',
            cancelled_at: this.isCancelledTrackerState(issue.state) ? new Date() : undefined,
          });
          const cleanupWorkItem = updatedWorkItem ?? workItem;
          await this.cleanupTerminalWorkItemResidue(cleanupWorkItem, issue, `${issue.identifier} during startup cleanup`);
        } else if (workspacePath) {
          await this.workspaceManager.removeWorkspace(workspacePath);
          console.log('[orchestrator] Cleaned up terminal workspace:', issue.identifier);
        }
      } catch (err) {
        console.warn('[orchestrator] Failed to clean workspace:', issue.identifier, err);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await this.cleanupAllTerminalIssueBranches();
    try {
      await new GlobalRepairService({
        config: this.config,
        tracker: this.tracker,
        workItemRepository: this.workItemRepository,
        githubClientFactory: this.githubIssueClientFactory,
      }).repairFromTerminalIssues(issues);
    } catch (error) {
      console.warn('[orchestrator] Global orphan repair failed during startup cleanup, continuing anyway:', error);
    }
  }

  private hasActiveExecutionWork(): boolean {
    return (
      this.state.running.size > 0 ||
      this.state.claimed.size > 0 ||
      this.state.retry_attempts.size > 0 ||
      this.currentTickPromise !== null
    );
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
      await this.closeMappedGitHubIssue(workItem, `${issue.identifier} merge success`);
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

        const workItem = this.workItemRepository.findByLinearIssueId(issue.id);
        if (workItem) {
          const updatedWorkItem = this.workItemRepository.update({
            id: workItem.id,
            linear_state: issue.state,
            orchestrator_state: 'cancelled',
            cancelled_at: new Date(),
          });
          await this.closeMappedGitHubIssue(updatedWorkItem ?? workItem, `${runningEntry.identifier} reconciliation`);
        }

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
