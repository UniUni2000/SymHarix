import type { SupervisorPlanCard, SupervisorSessionState } from '../database/types';

export type SupervisorMilestoneKind =
  | 'materialized'
  | 'dispatch_started'
  | 'child_started'
  | 'child_completed'
  | 'waiting_on_child'
  | 'child_failed'
  | 'delivery_failed'
  | 'retrying'
  | 'requires_user_decision'
  | 'completed'
  | 'cancelled';

export interface SupervisorMilestone {
  kind: SupervisorMilestoneKind;
  key: string;
  issue_id: string;
  issue_identifier: string | null;
  summary: string | null;
  delivery_state?: string | null;
  delivery_code?: string | null;
  governance_thread_state?: string | null;
  current_child_issue_id?: string | null;
}

export interface SupervisorExecutionIntent {
  root_session_id: string;
  repo_ref: string;
  plan_summary: string;
  acceptance_summary: string;
  approved_execution_mode: 'root_only' | 'root_with_split_queue';
  plan_card: SupervisorPlanCard;
}

export interface SupervisorMaterializedPlan extends SupervisorExecutionIntent {
  root_issue_id: string;
  root_issue_identifier: string | null;
  current_child_issue_id: string | null;
  child_queue: Array<{
    issue_id: string;
    issue_identifier: string;
    title: string;
    queue_state: string | null;
  }>;
}

export interface SupervisorThreadProjection {
  session_id: string;
  state: SupervisorSessionState;
  plan_version: number;
  root_issue_id: string | null;
  current_child_issue_id: string | null;
  next_recommended_action: string | null;
  delivery_state: string | null;
  delivery_summary: string | null;
}
