import type { WorkItemOrchestratorState } from '../database/types';
import type { AgentTimelinePayload, RunningStage } from '../types';

export type RuntimePhase = 'DEV' | 'REVIEW';
export type RuntimeStreamEventType = 'snapshot' | 'overview' | 'issue' | 'timeline';
export type RuntimeCommandStatus =
  | 'accepted'
  | 'queued'
  | 'completed'
  | 'rejected'
  | 'not_found';

export interface RuntimeActionState {
  can_stop: boolean;
  can_retry: boolean;
  can_open_pr: boolean;
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
  project_id?: string | null;
  state_id?: string | null;
}

export interface RuntimeActionResult {
  accepted: boolean;
  status: RuntimeCommandStatus;
  message: string;
  issue_id: string | null;
  issue_identifier: string | null;
}

export interface CreateIssueResult extends RuntimeActionResult {
  issue: RuntimeIssueView | null;
}

export interface RuntimeStreamEvent {
  type: RuntimeStreamEventType;
  data: RuntimeOverview | RuntimeIssueView | RuntimeTimelineEvent;
}

export interface RuntimeControlPlane {
  getOverview(): RuntimeOverview;
  getIssue(id: string): RuntimeIssueView | null;
  getTimeline(id: string, limit?: number): RuntimeTimelineEvent[];
  createIssue(input: CreateIssueRequest): Promise<CreateIssueResult>;
  stopIssue(id: string): Promise<RuntimeActionResult>;
  retryIssue(id: string): Promise<RuntimeActionResult>;
  createStream(): ReadableStream<Uint8Array>;
}
