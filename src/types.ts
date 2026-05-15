/**
 * SymHarix Service - Core Domain Types
 * Based on SymHarix Specification v1
 */

// ============================================================================
// Issue Domain Model (Section 4.1.1)
// ============================================================================

export interface Issue {
  id: string;
  identifier: string;  // Human-readable key like "ABC-123"
  title: string;
  description: string | null;
  priority: number | null;  // Lower numbers = higher priority
  state: string;  // Current tracker state name
  project_slug: string | null;
  project_name: string | null;
  branch_name: string | null;
  url: string | null;
  labels: string[];  // Normalized to lowercase
  blocked_by: BlockerRef[];
  created_at: Date | null;
  updated_at: Date | null;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

// ============================================================================
// Workflow Definition (Section 4.1.2)
// ============================================================================

export interface WorkflowDefinition {
  config: Record<string, unknown>;  // YAML front matter root object
  prompt_template: string;  // Markdown body after front matter
}

// ============================================================================
// Service Config - Typed View (Section 4.1.3)
// ============================================================================

export interface ProjectConfig {
  github_repo: string;
  local_path: string;
}

export interface RepositoryRouteConfig {
  github_owner: string;
  github_repo: string;
  local_path: string | null;
  require_repo_harness?: boolean;
}

export interface ResolvedRepositoryRoute {
  project_slug: string;
  project_name: string | null;
  github_owner: string;
  github_repo: string;
  github_repo_full: string;
  local_path: string | null;
  cache_key: string;
  require_repo_harness: boolean;
}

export type RepositoryHarnessStatus = 'formal' | 'shadow' | 'missing';
export type ConstitutionStatus = 'present' | 'missing';
export type RepositoryHarnessCommandKey =
  | 'setup'
  | 'dev'
  | 'test'
  | 'lint'
  | 'build'
  | 'review_checks';
export type GovernanceDecision =
  | 'accept'
  | 'accept_with_rewrite'
  | 'split_before_implement'
  | 'defer'
  | 'reject_conflicting';
export type GovernanceStatus = 'clear' | 'advisory' | 'blocked' | 'degraded';
export type CompletionRequirementKind =
  | 'artifact'
  | 'verification'
  | 'governance'
  | 'review';

export interface RepositoryHarnessConfig {
  profiles?: Array<'coding' | 'research' | 'ui' | 'review'>;
  commands?: Partial<Record<RepositoryHarnessCommandKey, string>>;
  artifacts?: string[];
  verification?: {
    required_commands?: string[];
    required_artifacts?: string[];
  };
  runtime_hints?: Record<string, string | string[]>;
}

export interface EffectiveRepositoryHarness {
  source: RepositoryHarnessStatus;
  config: RepositoryHarnessConfig;
  has_verification_requirements: boolean;
}

export interface ResolvedRepositoryHarness {
  status: RepositoryHarnessStatus;
  path: string | null;
  config: RepositoryHarnessConfig | null;
  inferred_from: string[];
  adoption_suggested: boolean;
}

export interface ResolvedRepositoryConstitution {
  status: ConstitutionStatus;
  path: string | null;
  sections: Record<string, string[]>;
}

export interface ConstitutionHit {
  section: string;
  phrase: string;
}

export interface ChangePackSummary {
  profile: 'coding' | 'research' | 'ui' | 'review' | null;
  complexity: 'small' | 'medium' | 'large' | null;
  files: string[];
  overview: string | null;
}

export interface ChangePackTaskStatus {
  total: number;
  completed: number;
  open: number;
}

export interface CompletionRequirement {
  key: string;
  label: string;
  reason: string;
  kind: CompletionRequirementKind;
}

export interface EvidenceRuntimeCheckSummary {
  hint_key: 'url' | 'ready_signal';
  status: 'satisfied' | 'failed';
  value: string;
}

export interface EvidenceSummary {
  total_requirements: number;
  satisfied: number;
  missing: number;
  successful_commands: string[];
  failed_commands: string[];
  observed_artifacts: string[];
  runtime_checks: EvidenceRuntimeCheckSummary[];
  notes: string[];
}

export type HarnessLearningConfidence = 'low' | 'medium' | 'high';

export interface ShadowHarnessObservedCommand {
  command: string;
  success_count: number;
  failure_count: number;
  last_status: 'satisfied' | 'failed' | null;
  last_work_item_id: string | null;
}

export interface ShadowHarnessObservedArtifact {
  success_count: number;
  last_work_item_id: string | null;
}

export interface ShadowHarnessObservedRuntimeHint {
  value: string;
  success_count: number;
  failure_count: number;
  last_status: 'satisfied' | 'failed' | null;
  last_work_item_id: string | null;
}

export interface ShadowHarnessInferenceDetails {
  inferred_from: string[];
  observed_commands: Record<string, ShadowHarnessObservedCommand>;
  observed_artifacts: Record<string, ShadowHarnessObservedArtifact>;
  observed_runtime_hints: Record<string, ShadowHarnessObservedRuntimeHint>;
  learning_confidence: HarnessLearningConfidence;
  successful_work_item_ids?: string[];
  failed_work_item_ids?: string[];
}

export interface GovernanceAssessment {
  decision: GovernanceDecision;
  status: GovernanceStatus;
  summary: string;
  constitution_hits: ConstitutionHit[];
}

export interface IntakeCriticAssessment extends GovernanceAssessment {
  repo_harness_status: RepositoryHarnessStatus;
  constitution_status: ConstitutionStatus;
  blocks_dispatch: boolean;
  requires_override: boolean;
  rewrite_title: string | null;
  rewrite_description: string | null;
  split_suggestions: string[];
  repo_key: string | null;
  target_area: string | null;
  active_fitness_signals: string[];
  related_conflict_count: number;
  related_debt_signal_count: number;
  repeated_constitution_phrase: string | null;
}

export interface FitnessSignal {
  code: string;
  summary: string;
  severity: 'low' | 'medium' | 'high';
}

export interface GovernanceRepoSnapshot {
  repo_key: string;
  recent_work_items: Array<{
    work_item_id: string;
    issue_identifier: string;
    linear_state: string;
    last_review_decision: string | null;
    touched_paths: string[];
    touched_areas: string[];
    path_families: string[];
    boundary_edges: string[];
    import_edges: string[];
    architectural_target: string | null;
    updated_at: string;
  }>;
  recent_review_events: Array<{
    work_item_id: string;
    decision: string;
    created_at: string;
  }>;
  latest_assessments: Array<{
    work_item_id: string | null;
    decision: string;
    summary: string;
    detail_json: Record<string, unknown> | null;
    created_at: string;
  }>;
  decision_memories: Array<{
    summary: string;
    detail_json: Record<string, unknown> | null;
    created_at: string;
  }>;
  conflict_memories: Array<{
    summary: string;
    detail_json: Record<string, unknown> | null;
    created_at: string;
  }>;
  debt_signals: Array<{
    signal_code: string;
    summary: string;
    severity: 'low' | 'medium' | 'high';
    detail_json: Record<string, unknown> | null;
    created_at: string;
  }>;
  active_fitness_signals: FitnessSignal[];
}

export interface GovernanceSuggestion {
  id: string;
  suggestion_type:
    | 'cleanup'
    | 'consolidation'
    | 'architecture_alignment'
    | 'constitution_update'
    | 'harness_adoption';
  status: 'pending' | 'accepted' | 'dismissed';
  title: string;
  summary: string;
  can_execute?: boolean;
  can_dismiss?: boolean;
}

export interface ResolvedTrackerProject {
  project_id: string;
  project_slug: string;
  project_name: string;
}

export interface LiveLifecycleScenarioConfig {
  title: string;
  description: string;
}

export interface RuntimeDiagnosticsSnapshot {
  running_issue_count: number;
  retry_count: number;
  worker_process_count: number;
  active_session_count: number;
  claimed_issue_count: number;
  leadership_lease_held: boolean;
}

export interface ServiceConfig {
  // Tracker
  trackerKind: string;
  trackerEndpoint: string;
  trackerApiKey: string;
  githubOwner: string;
  githubToken: string;
  activeStates: string[];
  terminalStates: string[];

  // Polling
  pollIntervalMs: number;

  // Workspace
  workspaceRoot: string;
  projectRoot: string;
  repositories: {
    routing: Record<string, RepositoryRouteConfig>;
  };

  // Hooks
  hooks: {
    after_create: string | null;
    timeout_ms: number;
  };

  // Agent
  maxConcurrentAgents: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Map<string, number>;
  maxTurns: number;

  // Codex
  codexCommand: string;
  codexApprovalPolicy: string | null;
  codexThreadSandbox: string | null;
  codexTurnSandboxPolicy: string | null;
  codexTurnTimeoutMs: number;
  codexReadTimeoutMs: number;
  codexStallTimeoutMs: number;

  // Dev Policy
  devPolicy: {
    maxDevAttempts: number;
  };

  // Review Policy
  reviewPolicy: {
    notifyLinearOnReview: boolean;
  };

  // Internal verification tooling
  verification: {
    lifecycle: {
      timeoutMs: number;
      pollIntervalMs: number;
      projects: Record<string, LiveLifecycleScenarioConfig>;
    };
  };

  // Server (extension)
  serverPort: number | null;
}

// ============================================================================
// Workspace (Section 4.1.4)
// ============================================================================

export interface Workspace {
  path: string;
  workspace_key: string;  // Sanitized issue identifier
  created_now: boolean;  // True if directory created during this call
  git_branch?: string;
}

// ============================================================================
// Run Attempt (Section 4.1.5)
// ============================================================================

export type RunAttemptStatus =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'InitializingSession'
  | 'StreamingTurn'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation';

export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  attempt: number | null;  // null for first run, >=1 for retries
  workspace_path: string;
  started_at: Date;
  status: RunAttemptStatus;
  error?: string;
}

// ============================================================================
// Live Session - Agent Session Metadata (Section 4.1.6)
// ============================================================================

export interface LiveSession {
  session_id: string;  // <thread_id>-<turn_id>
  thread_id: string;
  turn_id: string;
  codex_app_server_pid: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: Date | null;
  last_codex_message: string | null;  // Summarized payload
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  codex_uncached_input_tokens?: number;
  codex_cache_creation_input_tokens?: number;
  codex_cache_read_input_tokens?: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  turn_count: number;  // Turns started within current worker lifetime
}

// ============================================================================
// Retry Entry (Section 4.1.7)
// ============================================================================

export interface RetryEntry {
  issue_id: string;
  identifier: string;  // Best-effort human ID
  attempt: number;  // 1-based for retry queue
  due_at_ms: number;  // Monotonic clock timestamp
  timer_handle: NodeJS.Timeout | null;
  error: string | null;
}

// ============================================================================
// Orchestrator Runtime State (Section 4.1.8)
// ============================================================================

export type RunningStage =
  | 'dispatching'
  | 'coding'
  | 'post_process_dev'
  | 'post_process_review'
  | 'completed'
  | 'failed'
  | 'retry_scheduled'
  | 'halted';

export interface RunningEntry {
  worker_handle: unknown;  // Worker process reference
  identifier: string;
  issue: Issue;
  stage: RunningStage;
  agent_run_id?: string | null;
  session_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_message: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: Date | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  codex_uncached_input_tokens?: number;
  codex_cache_creation_input_tokens?: number;
  codex_cache_read_input_tokens?: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  retry_attempt: number;
  started_at: Date;
  turn_count: number;
  workspace_path?: string | null;
  branch_name?: string | null;
  codex_child_process?: unknown;
}

export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;  // issue_id -> entry
  claimed: Set<string>;  // Set of issue IDs reserved/running/retrying
  retry_attempts: Map<string, RetryEntry>;  // issue_id -> RetryEntry
  completed: Set<string>;  // Bookkeeping only
  codex_totals: CodexTotals;
  codex_rate_limits: unknown | null;  // Latest rate-limit snapshot
}

// ============================================================================
// Orchestrator Issue States (Section 7.1)
// ============================================================================

export type OrchestrationState =
  | 'Unclaimed'
  | 'Claimed'
  | 'Running'
  | 'RetryQueued'
  | 'Released';

// ============================================================================
// Agent Events (Section 10.4)
// ============================================================================

export type AgentEventType =
  | 'session_started'
  | 'timeline'
  | 'startup_failed'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_ended_with_error'
  | 'turn_input_required'
  | 'approval_auto_approved'
  | 'unsupported_tool_call'
  | 'notification'
  | 'other_message'
  | 'malformed';

export type AgentTimelineLevel = 'info' | 'warn' | 'error' | 'debug';
export type AgentTimelineCategory = 'session' | 'turn' | 'tool' | 'todo' | 'rate_limit' | 'diagnostic';
export type AgentTimelineCode =
  | 'session_started'
  | 'turn_started'
  | 'assistant_thinking'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'todo_updated'
  | 'rate_limit_retry'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'missing_repository_route'
  | 'missing_tracker_project_slug'
  | 'repo_harness_missing'
  | 'shadow_harness_updated'
  | 'repo_harness_adoption_suggested'
  | 'constitution_missing'
  | 'governance_assessed'
  | 'governance_blocked'
  | 'governance_override_approved'
  | 'governance_rewrite_applied'
  | 'governance_split_applied'
  | 'change_pack_initialized'
  | 'change_pack_updated'
  | 'evidence_collected'
  | 'completion_blocked'
  | 'fitness_signal_recorded'
  | 'governance_suggestion_created'
  | 'governance_suggestion_executed'
  | 'governance_suggestion_dismissed'
  | 'governance_suggestion_reused_child'
  | 'governance_child_noop_closed'
  | 'constitution_update_suggested';

export interface AgentTimelinePayload {
  level: AgentTimelineLevel;
  category: AgentTimelineCategory;
  code: AgentTimelineCode;
  message: string;
  turn: number | null;
  tool_name: string | null;
  detail: Record<string, unknown> | null;
}

export type TurnTranscriptRole = 'assistant' | 'user';
export type TurnTranscriptKind = 'message' | 'tool_result';

export interface TurnTranscriptEntry {
  role: TurnTranscriptRole;
  kind: TurnTranscriptKind;
  text: string;
  turn: number | null;
  tool_name: string | null;
}

export interface LlmTokenUsage {
  input: number;
  output: number;
  total: number;
  uncached_input?: number;
  cache_creation_input?: number;
  cache_read_input?: number;
}

export interface SupervisorNextAction {
  kind: 'continue' | 'finish' | 'abort';
  message?: string;
  reason?: string;
  token_usage?: LlmTokenUsage[];
}

export interface PendingRuntimeRequest {
  kind: 'approval' | 'user_input';
  method: 'approval/request' | 'item/tool/requestUserInput';
  request_id: string;
  turn: number | null;
  raw: Record<string, unknown>;
  summary: {
    title: string;
    message: string;
    tool_name: string | null;
    subtype: string | null;
  };
}

export interface RuntimeRequestResponse {
  response: Record<string, unknown>;
  token_usage?: LlmTokenUsage[];
}

export interface AgentEvent {
  event: AgentEventType;
  timestamp: Date;
  codex_app_server_pid: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    uncached_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  payload?: Record<string, unknown> | AgentTimelinePayload;
}

// ============================================================================
// Error Types
// ============================================================================

export type WorkflowError =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error';

export type TrackerError =
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'missing_repository_route'
  | 'linear_project_not_found'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_unknown_payload'
  | 'linear_missing_end_cursor';

export type CodexError =
  | 'codex_not_found'
  | 'invalid_workspace_cwd'
  | 'response_timeout'
  | 'turn_timeout'
  | 'port_exit'
  | 'response_error'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required';

// ============================================================================
// Linear GraphQL Types
// ============================================================================

export interface LinearProject {
  id: string;
  name: string;
  slugId: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: {
    id: string;
    name: string;
    type: string;
  };
  project: LinearProject | null;
  labels: {
    nodes: Array<{ name: string }>;
  };
  relations: {
    nodes: Array<{
      type: string;
      relatedIssue: {
        id: string;
        identifier: string;
        state: {
          name: string;
          type: string;
        };
      };
    }>;
  };
  createdAt: string;
  updatedAt: string;
  branchName: string | null;
  url: string;
}

export interface LinearApiResponse {
  data?: {
    issues?: {
      nodes: LinearIssue[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
    issue?: LinearIssue;
    team?: {
      states: Array<{
        id: string;
        name: string;
        type: string;
      }>;
    };
  };
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: (string | number)[];
  }>;
}

// ============================================================================
// Linear Custom Fields Types (Section 3: State Machine Design)
// ============================================================================

export interface LinearCustomFields {
  dev_attempts?: number;
  review_round?: number;
  complexity?: 'small' | 'medium' | 'large';
  last_review_decision?:
    | 'approve'
    | 'approve_minor'
    | 'request_changes'
    | 'request_tests'
    | 'reject'
    | 'merge_blocked';
}

/**
 * Custom field definition for Linear
 */
export interface LinearCustomField {
  id: string;
  name: string;
  value: string | number | null;
}

/**
 * Extended LinearIssue with custom fields
 */
export interface LinearIssueExtended extends LinearIssue {
  customFields?: {
    nodes: LinearCustomField[];
  };
}
