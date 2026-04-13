/**
 * Symphony Service - Core Domain Types
 * Based on Symphony Specification v1
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

export interface ServiceConfig {
  // Tracker
  trackerKind: string;
  trackerEndpoint: string;
  trackerApiKey: string;
  trackerProjectSlug: string;
  activeStates: string[];
  terminalStates: string[];

  // Polling
  pollIntervalMs: number;

  // Workspace
  workspaceRoot: string;

  // Hooks
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
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

export interface RunningEntry {
  worker_handle: unknown;  // Worker process reference
  identifier: string;
  issue: Issue;
  session_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_message: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: Date | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  retry_attempt: number;
  started_at: Date;
  turn_count: number;
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

export interface AgentEvent {
  event: AgentEventType;
  timestamp: Date;
  codex_app_server_pid: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  payload?: Record<string, unknown>;
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
