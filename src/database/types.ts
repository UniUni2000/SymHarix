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
  | 'set_default_project';

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
