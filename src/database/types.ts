/**
 * Database Types for Symphony Enterprise Agent Platform
 */

/**
 * Task status values
 */
export type TaskStatus =
  | 'Unclaimed'
  | 'Claimed'
  | 'Running'
  | 'RetryQueued'
  | 'Released'
  | 'Completed'
  | 'Failed';

/**
 * Task entity
 */
export interface Task {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: string[];
  workspace_key: string | null;
  retry_count: number;
  max_retries: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Workspace entity
 */
export interface Workspace {
  id: string;
  task_id: string;
  path: string;
  workspace_key: string;
  created_at: Date;
  cleaned_at: Date | null;
}

/**
 * Event severity levels
 */
export type EventSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

/**
 * Execution event entity
 */
export interface ExecutionEvent {
  id: string;
  task_id: string;
  event_type: string;
  event_data: Record<string, unknown>;
  severity: EventSeverity;
  source: string | null;
  created_at: Date;
}

/**
 * Event creation input (without auto-generated fields)
 */
export interface CreateExecutionEvent {
  task_id: string;
  event_type: string;
  event_data: Record<string, unknown>;
  severity?: EventSeverity;
  source?: string;
}

/**
 * Options for streaming events
 */
export interface StreamOptions {
  /** Start from this event ID */
  afterId?: string;
  /** Filter by event type */
  eventType?: string;
  /** Filter by minimum severity */
  minSeverity?: EventSeverity;
  /** Limit number of events returned */
  limit?: number;
}
