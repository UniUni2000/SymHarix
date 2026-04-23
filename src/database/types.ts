import type {
  ChangePackSummary,
  ChangePackTaskStatus,
  CompletionRequirement,
  ConstitutionHit,
  ConstitutionStatus,
  EvidenceSummary,
  ShadowHarnessInferenceDetails,
  GovernanceDecision,
  GovernanceStatus,
  RepositoryHarnessConfig,
  RepositoryHarnessStatus,
} from '../types';

/**
 * Database Types for Symphony Enterprise Agent Platform
 */

/**
 * Control-plane work item states
 */
export type WorkItemOrchestratorState =
  | 'discovering'
  | 'mapping'
  | 'workspace_ready'
  | 'dev_running'
  | 'dev_post_processing'
  | 'review_running'
  | 'review_post_processing'
  | 'needs_rework'
  | 'retry_scheduled'
  | 'halted'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type AgentType = 'dev' | 'review';
export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ReviewDecision =
  | 'APPROVE'
  | 'APPROVE_MINOR'
  | 'REQUEST_CHANGES'
  | 'REQUEST_TESTS'
  | 'REJECT'
  | 'MERGE_BLOCKED';
export type SyncTargetSystem = 'linear' | 'github';
export type SyncResult = 'success' | 'failed';
export type BotWatchTransport = 'telegram' | 'discord';
export type BotWatchPresetValue = 'default' | 'verbose' | 'failures' | 'status';
export type BotPendingIntentKind =
  | 'create_issue'
  | 'watch'
  | 'unwatch'
  | 'stop'
  | 'retry'
  | 'override'
  | 'rewrite'
  | 'split'
  | 'execute_governance_suggestion'
  | 'dismiss_governance_suggestion'
  | 'set_default_project';
export type GovernanceSuggestionType =
  | 'cleanup'
  | 'consolidation'
  | 'architecture_alignment'
  | 'constitution_update'
  | 'harness_adoption';
export type GovernanceSuggestionStatus = 'pending' | 'accepted' | 'dismissed';

export interface ServiceLease {
  lease_key: string;
  holder_id: string;
  holder_pid: number | null;
  holder_host: string | null;
  metadata_json: Record<string, unknown> | null;
  acquired_at: Date;
  heartbeat_at: Date;
  expires_at: Date;
}

export interface AcquireServiceLeaseResult {
  acquired: boolean;
  lease: ServiceLease | null;
}

/**
 * Work item entity
 */
export interface WorkItem {
  id: string;
  linear_issue_id: string;
  linear_identifier: string;
  linear_title: string;
  linear_state: string;
  github_repo: string;
  github_issue_number: number | null;
  active_pr_number: number | null;
  branch_name: string | null;
  workspace_path: string | null;
  workspace_key: string | null;
  orchestrator_state: WorkItemOrchestratorState;
  dev_attempt_count: number;
  review_round: number;
  last_review_decision: ReviewDecision | null;
  last_review_summary: string | null;
  repo_harness_status: RepositoryHarnessStatus | null;
  constitution_status: ConstitutionStatus | null;
  governance_status: GovernanceStatus | null;
  governance_decision: GovernanceDecision | null;
  governance_summary: string | null;
  governance_override_at: Date | null;
  governance_override_reason: string | null;
  change_pack_summary: ChangePackSummary | null;
  task_status: ChangePackTaskStatus | null;
  evidence_summary: EvidenceSummary | null;
  missing_requirements: CompletionRequirement[];
  constitution_hits: ConstitutionHit[];
  touched_paths: string[];
  touched_areas: string[];
  path_families: string[];
  boundary_edges: string[];
  import_edges: string[];
  architectural_target: string | null;
  fitness_signals: Array<{ code: string; summary: string; severity: 'low' | 'medium' | 'high' }>;
  cancelled_at: Date | null;
  merged_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateWorkItem {
  id: string;
  linear_issue_id: string;
  linear_identifier: string;
  linear_title: string;
  linear_state: string;
  github_repo: string;
  github_issue_number?: number | null;
  active_pr_number?: number | null;
  branch_name?: string | null;
  workspace_path?: string | null;
  workspace_key?: string | null;
  orchestrator_state?: WorkItemOrchestratorState;
  dev_attempt_count?: number;
  review_round?: number;
  last_review_decision?: ReviewDecision | null;
  last_review_summary?: string | null;
  repo_harness_status?: RepositoryHarnessStatus | null;
  constitution_status?: ConstitutionStatus | null;
  governance_status?: GovernanceStatus | null;
  governance_decision?: GovernanceDecision | null;
  governance_summary?: string | null;
  governance_override_at?: Date | null;
  governance_override_reason?: string | null;
  change_pack_summary?: ChangePackSummary | null;
  task_status?: ChangePackTaskStatus | null;
  evidence_summary?: EvidenceSummary | null;
  missing_requirements?: CompletionRequirement[];
  constitution_hits?: ConstitutionHit[];
  touched_paths?: string[];
  touched_areas?: string[];
  path_families?: string[];
  boundary_edges?: string[];
  import_edges?: string[];
  architectural_target?: string | null;
  fitness_signals?: Array<{ code: string; summary: string; severity: 'low' | 'medium' | 'high' }>;
  cancelled_at?: Date | null;
  merged_at?: Date | null;
}

export interface UpdateWorkItem extends Partial<Omit<WorkItem, 'id' | 'created_at' | 'updated_at'>> {
  id: string;
}

/**
 * Repo cache entity
 */
export interface RepoCache {
  id: string;
  github_repo: string;
  local_source_path: string;
  default_branch: string;
  last_fetched_at: Date | null;
  last_fetch_commit: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateRepoCache {
  id: string;
  github_repo: string;
  local_source_path: string;
  default_branch?: string;
  last_fetched_at?: Date | null;
  last_fetch_commit?: string | null;
}

export interface UpdateRepoCache extends Partial<Omit<RepoCache, 'id' | 'created_at' | 'updated_at'>> {
  id: string;
}

/**
 * Agent run entity
 */
export interface AgentRun {
  id: string;
  work_item_id: string;
  agent_type: AgentType;
  phase: string;
  run_status: AgentRunStatus;
  input_summary: string | null;
  output_summary: string | null;
  decision: string | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export interface CreateAgentRun {
  id: string;
  work_item_id: string;
  agent_type: AgentType;
  phase: string;
  run_status?: AgentRunStatus;
  input_summary?: string | null;
  output_summary?: string | null;
  decision?: string | null;
  error?: string | null;
  started_at?: Date;
  finished_at?: Date | null;
}

export interface UpdateAgentRun extends Partial<Omit<AgentRun, 'id' | 'work_item_id'>> {
  id: string;
}

/**
 * Review event entity
 */
export interface ReviewEvent {
  id: string;
  work_item_id: string;
  pr_number: number;
  review_round: number;
  decision: ReviewDecision;
  summary_md: string;
  requested_changes_md: string | null;
  merge_block_reason: string | null;
  created_at: Date;
}

export interface CreateReviewEvent {
  id: string;
  work_item_id: string;
  pr_number: number;
  review_round: number;
  decision: ReviewDecision;
  summary_md: string;
  requested_changes_md?: string | null;
  merge_block_reason?: string | null;
}

/**
 * Sync event entity
 */
export interface SyncEvent {
  id: string;
  work_item_id: string;
  target_system: SyncTargetSystem;
  action: string;
  payload_json: Record<string, unknown>;
  result: SyncResult;
  error: string | null;
  created_at: Date;
}

export interface CreateSyncEvent {
  id: string;
  work_item_id: string;
  target_system: SyncTargetSystem;
  action: string;
  payload_json: Record<string, unknown>;
  result?: SyncResult;
  error?: string | null;
}

/**
 * Persisted bot watch subscription entity
 */
export interface BotWatchSubscriptionRecord {
  transport: BotWatchTransport;
  conversation_id: string;
  issue_id: string;
  issue_identifier: string | null;
  user_id: string | null;
  preset: BotWatchPresetValue;
  created_at: Date;
  updated_at: Date;
}

export interface CreateBotWatchSubscriptionRecord {
  transport: BotWatchTransport;
  conversation_id: string;
  issue_id: string;
  issue_identifier?: string | null;
  user_id?: string | null;
  preset?: BotWatchPresetValue;
}

export interface DeleteBotWatchSubscriptionRecord {
  transport: BotWatchTransport;
  conversation_id: string;
  issue_id: string;
}

export interface BotConversationPreferenceRecord {
  transport: BotWatchTransport;
  conversation_id: string;
  default_project_slug: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateBotConversationPreferenceRecord {
  transport: BotWatchTransport;
  conversation_id: string;
  default_project_slug?: string | null;
}

export interface DeleteBotConversationPreferenceRecord {
  transport: BotWatchTransport;
  conversation_id: string;
}

export interface BotPendingActionRecord {
  transport: BotWatchTransport;
  conversation_id: string;
  user_id: string | null;
  intent_kind: BotPendingIntentKind;
  normalized_payload: Record<string, unknown>;
  summary_message: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CreateBotPendingActionRecord {
  transport: BotWatchTransport;
  conversation_id: string;
  user_id?: string | null;
  intent_kind: BotPendingIntentKind;
  normalized_payload: Record<string, unknown>;
  summary_message: string;
  expires_at: Date;
}

export interface DeleteBotPendingActionRecord {
  transport: BotWatchTransport;
  conversation_id: string;
}

export interface ShadowHarnessRecord {
  repo_key: string;
  source: RepositoryHarnessStatus;
  config_json: RepositoryHarnessConfig;
  inference_details_json: ShadowHarnessInferenceDetails;
  successful_runs: number;
  failed_runs: number;
  adoption_suggested_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertShadowHarnessRecord {
  repo_key: string;
  source: RepositoryHarnessStatus;
  config_json: RepositoryHarnessConfig;
  inference_details_json?: ShadowHarnessInferenceDetails;
  successful_runs?: number;
  failed_runs?: number;
  adoption_suggested_at?: Date | null;
}

export interface GovernanceAssessmentRecord {
  id: string;
  work_item_id: string | null;
  issue_id: string;
  decision: GovernanceDecision;
  status: GovernanceStatus;
  summary: string;
  constitution_hits_json: ConstitutionHit[];
  detail_json: Record<string, unknown> | null;
  created_at: Date;
}

export interface CreateGovernanceAssessmentRecord {
  id: string;
  work_item_id?: string | null;
  issue_id: string;
  decision: GovernanceDecision;
  status: GovernanceStatus;
  summary: string;
  constitution_hits_json: ConstitutionHit[];
  detail_json?: Record<string, unknown> | null;
  created_at?: Date;
}

export interface GovernanceSuggestionRecord {
  id: string;
  work_item_id: string | null;
  issue_id: string;
  suggestion_type: GovernanceSuggestionType;
  status: GovernanceSuggestionStatus;
  title: string;
  summary: string;
  detail_json: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateGovernanceSuggestionRecord {
  id: string;
  work_item_id?: string | null;
  issue_id: string;
  suggestion_type: GovernanceSuggestionType;
  status?: GovernanceSuggestionStatus;
  title: string;
  summary: string;
  detail_json?: Record<string, unknown> | null;
}

export interface DecisionMemoryRecord {
  id: string;
  repo_key: string;
  summary: string;
  detail_json: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateDecisionMemoryRecord {
  id: string;
  repo_key: string;
  summary: string;
  detail_json?: Record<string, unknown> | null;
  created_at?: Date;
}

export interface ConflictMemoryRecord {
  id: string;
  repo_key: string;
  summary: string;
  detail_json: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateConflictMemoryRecord {
  id: string;
  repo_key: string;
  summary: string;
  detail_json?: Record<string, unknown> | null;
  created_at?: Date;
}

export interface DebtSignalRecord {
  id: string;
  repo_key: string;
  signal_code: string;
  summary: string;
  severity: 'low' | 'medium' | 'high';
  detail_json: Record<string, unknown> | null;
  created_at: Date;
}

export interface CreateDebtSignalRecord {
  id: string;
  repo_key: string;
  signal_code: string;
  summary: string;
  severity: 'low' | 'medium' | 'high';
  detail_json?: Record<string, unknown> | null;
  created_at?: Date;
}
