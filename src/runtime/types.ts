import type { WorkItemOrchestratorState } from '../database/types';
import type {
  AgentTimelinePayload,
  ChangePackSummary,
  ChangePackTaskStatus,
  CompletionRequirement,
  ConstitutionHit,
  ConstitutionStatus,
  EvidenceSummary,
  HarnessLearningConfidence,
  GovernanceDecision,
  GovernanceStatus,
  GovernanceSuggestion,
  RepositoryHarnessStatus,
  RunningStage,
} from '../types';

export type RuntimePhase = 'DEV' | 'REVIEW';
export type RuntimeStreamEventType = 'snapshot' | 'overview' | 'issue' | 'timeline';
export type RuntimeCommandStatus =
  | 'accepted'
  | 'queued'
  | 'completed'
  | 'rejected'
  | 'not_found';
export type RuntimeAccessMode = 'open' | 'token';
export type RuntimeViewerRole = 'operator' | 'viewer';
export type RuntimeHistoryEntrySource = 'agent_run' | 'review' | 'work_item' | 'sync_event' | 'governance';

export interface RuntimeActionState {
  can_stop: boolean;
  can_retry: boolean;
  can_override_governance?: boolean;
  can_rewrite_governance?: boolean;
  can_split_governance?: boolean;
  can_open_pr: boolean;
}

export interface RuntimeGovernanceOverrideView {
  active: boolean;
  approved_at: string | null;
  reason: string | null;
}

export interface RuntimeHarnessStatusView {
  status: RepositoryHarnessStatus;
  adoption_suggested: boolean;
  learning_confidence?: HarnessLearningConfidence | null;
  learned_command_count?: number;
  learned_artifact_count?: number;
  learned_runtime_hint_count?: number;
}

export interface RuntimeGovernanceChildIssueView {
  issue_id: string;
  issue_identifier: string;
  title: string;
  tracker_state: string;
  orchestrator_state: WorkItemOrchestratorState | null;
  governance_decision: GovernanceDecision | null;
  governance_summary: string | null;
  queue_state?: RuntimeGovernanceChildQueueState;
  delivery_state?: RuntimeDeliveryState | null;
  delivery_code?: RuntimeDeliveryCode | null;
  delivery_summary?: string | null;
}

export type RuntimeGovernanceChildQueueState =
  | 'current'
  | 'queued'
  | 'blocked'
  | 'failed'
  | 'completed';

export type RuntimeGovernanceThreadState =
  | 'blocked'
  | 'confirming'
  | 'executing'
  | 'waiting_on_child'
  | 'child_failed'
  | 'resolved'
  | 'failed';

export type RuntimeDeliveryState =
  | 'proof_satisfied'
  | 'delivery_failed'
  | 'completed';

export type RuntimeDeliveryCode =
  | 'review_submit_failed'
  | 'dirty_workspace_no_commit'
  | 'tracker_state_conflict'
  | 'no_actionable_diff';

export interface RuntimeGovernanceActionView {
  outcome_kind: 'unblocked' | 'waiting_on_child' | 'child_still_blocked' | 'failed';
  root_issue_identifier: string | null;
  created_issue_identifiers: string[];
  next_recommended_action: string | null;
  user_summary: string | null;
}

export interface RuntimeToolActivity {
  tool_name: string;
  status: 'started' | 'completed' | 'failed';
  message: string;
  summary: string | null;
  path: string | null;
  timestamp: string;
}

export interface RuntimeFileActivity {
  path: string;
  operation: 'read' | 'write' | 'edit' | 'other';
  status: 'started' | 'completed' | 'failed';
  timestamp: string;
}

export interface RuntimeSessionView {
  session_id: string | null;
  turn_count: number;
  stage: RunningStage | null;
  last_event: string | null;
  last_message: string | null;
  started_at: string | null;
  last_event_at: string | null;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  recent_tools: RuntimeToolActivity[];
  recent_files: RuntimeFileActivity[];
}

export interface RuntimeIssueView {
  issue_id: string;
  work_item_id: string | null;
  identifier: string;
  title: string;
  phase: RuntimePhase;
  tracker_state: string;
  orchestrator_state: WorkItemOrchestratorState | null;
  workspace_path: string | null;
  branch_name: string | null;
  github_repo: string | null;
  github_issue_number: number | null;
  active_pr_number: number | null;
  session: RuntimeSessionView | null;
  repo_harness_status?: RuntimeHarnessStatusView | null;
  constitution_status?: ConstitutionStatus | null;
  change_pack_summary?: ChangePackSummary | null;
  task_status?: ChangePackTaskStatus | null;
  evidence_summary?: EvidenceSummary | null;
  missing_requirements?: CompletionRequirement[];
  architectural_target?: string | null;
  path_families?: string[];
  boundary_edges?: string[];
  import_edges?: string[];
  governance_status?: GovernanceStatus | null;
  governance_decision?: GovernanceDecision | null;
  governance_summary?: string | null;
  governance_root_issue_id?: string | null;
  governance_root_issue_identifier?: string | null;
  governance_thread_state?: RuntimeGovernanceThreadState | null;
  governance_child_issues?: RuntimeGovernanceChildIssueView[];
  governance_current_child?: RuntimeGovernanceChildIssueView | null;
  governance_child_queue?: RuntimeGovernanceChildIssueView[];
  next_recommended_action?: string | null;
  delivery_state?: RuntimeDeliveryState | null;
  delivery_code?: RuntimeDeliveryCode | null;
  delivery_summary?: string | null;
  supervisor_session_state?: string | null;
  supervisor_plan_summary?: string | null;
  constitution_hits?: ConstitutionHit[];
  fitness_signals?: Array<{ code: string; summary: string; severity: 'low' | 'medium' | 'high' }>;
  active_governance_suggestions?: GovernanceSuggestion[];
  governance_override?: RuntimeGovernanceOverrideView | null;
  actions: RuntimeActionState;
  created_at: string | null;
  updated_at: string | null;
}

export interface RuntimeTimelineEvent extends AgentTimelinePayload {
  id: string;
  issue_id: string;
  issue_identifier: string | null;
  timestamp: string;
}

export interface RuntimeIssueDigest {
  headline: string;
  detail: string;
  history_blurb: string | null;
  updated_at: string | null;
}

export interface RuntimeHistoryEntry {
  id: string;
  issue_id: string;
  issue_identifier: string | null;
  source: RuntimeHistoryEntrySource;
  title: string;
  summary: string;
  timestamp: string;
  detail: Record<string, unknown> | null;
}

export interface RuntimeIssueHistoryView {
  issue_id: string;
  issue_identifier: string | null;
  digest: RuntimeIssueDigest;
  entries: RuntimeHistoryEntry[];
}

export interface RuntimeAccessView {
  mode: RuntimeAccessMode;
  viewer_role: RuntimeViewerRole;
  can_create_issue: boolean;
  can_control_issues: boolean;
  token_required: boolean;
}

export interface RuntimeManifest {
  access: RuntimeAccessView;
  features: {
    history_replay: boolean;
    message_summaries: boolean;
    subscription_preferences: boolean;
  };
}

export interface RuntimeOverview {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
    total: number;
  };
  issues: RuntimeIssueView[];
}

export interface CreateIssueRequest {
  title: string;
  description?: string | null;
  team_id?: string | null;
  project_slug?: string | null;
  project_id?: string | null;
  state_id?: string | null;
}

export interface RuntimeActionResult {
  accepted: boolean;
  status: RuntimeCommandStatus;
  message: string;
  issue_id: string | null;
  issue_identifier: string | null;
  delivery_code?: RuntimeDeliveryCode | null;
  governance_action?: RuntimeGovernanceActionView | null;
}

export interface CreateIssueResult extends RuntimeActionResult {
  issue: RuntimeIssueView | null;
}

export type RuntimeStreamEvent =
  | {
      type: 'snapshot' | 'overview';
      data: RuntimeOverview;
    }
  | {
      type: 'issue';
      data: RuntimeIssueView;
    }
  | {
      type: 'timeline';
      data: RuntimeTimelineEvent;
    };

export interface RuntimeControlPlane {
  getOverview(): RuntimeOverview;
  getIssue(id: string): RuntimeIssueView | null;
  getTimeline(id: string, limit?: number): RuntimeTimelineEvent[];
  getHistoryView(id: string, limit?: number): RuntimeIssueHistoryView | null;
  createIssue(input: CreateIssueRequest): Promise<CreateIssueResult>;
  stopIssue(id: string): Promise<RuntimeActionResult>;
  retryIssue(id: string): Promise<RuntimeActionResult>;
  overrideGovernance(id: string): Promise<RuntimeActionResult>;
  rewriteGovernance(id: string): Promise<RuntimeActionResult>;
  splitGovernance(id: string): Promise<RuntimeActionResult>;
  executeGovernanceSuggestion(issueId: string, suggestionId: string): Promise<RuntimeActionResult>;
  dismissGovernanceSuggestion(issueId: string, suggestionId: string): Promise<RuntimeActionResult>;
  createStream(): ReadableStream<Uint8Array>;
  subscribe(listener: (event: RuntimeStreamEvent) => void): () => void;
}
