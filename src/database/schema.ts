/**
 * Database Schema Definitions for Symphony Enterprise Agent Platform
 * Defines table structures and initialization logic
 */

import type { Database } from 'bun:sqlite';

/**
 * SQL schema for work_items table
 * Control-plane source of truth for issue -> GitHub -> PR -> workspace mapping
 */
export const WORK_ITEMS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    linear_issue_id TEXT NOT NULL UNIQUE,
    linear_identifier TEXT NOT NULL UNIQUE,
    linear_title TEXT NOT NULL,
    linear_state TEXT NOT NULL,
    github_repo TEXT NOT NULL,
    github_issue_number INTEGER,
    active_pr_number INTEGER,
    branch_name TEXT,
    workspace_path TEXT,
    workspace_key TEXT,
    orchestrator_state TEXT NOT NULL DEFAULT 'discovering',
    dev_attempt_count INTEGER NOT NULL DEFAULT 0,
    review_round INTEGER NOT NULL DEFAULT 0,
    last_review_decision TEXT,
    last_review_summary TEXT,
    delivery_code TEXT,
    delivery_summary TEXT,
    repo_harness_status TEXT,
    constitution_status TEXT,
    governance_status TEXT,
    governance_decision TEXT,
    governance_summary TEXT,
    governance_root_issue_id TEXT,
    governance_parent_issue_id TEXT,
    governance_generation INTEGER NOT NULL DEFAULT 0,
    governance_source_updated_at TEXT,
    governance_override_at TEXT,
    governance_override_reason TEXT,
    supervisor_root_session_id TEXT,
    supervisor_plan_summary TEXT,
    supervisor_acceptance_summary TEXT,
    supervisor_execution_mode TEXT,
    change_pack_summary_json TEXT,
    task_status_json TEXT,
    evidence_summary_json TEXT,
    missing_requirements_json TEXT,
    constitution_hits_json TEXT,
    touched_paths_json TEXT,
    touched_areas_json TEXT,
    path_families_json TEXT,
    boundary_edges_json TEXT,
    import_edges_json TEXT,
    architectural_target TEXT,
    fitness_signals_json TEXT,
    cancelled_at TEXT,
    merged_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * SQL schema for repo_caches table
 * Tracks shared per-repo source caches used to create issue worktrees
 */
export const REPO_CACHES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS repo_caches (
    id TEXT PRIMARY KEY,
    github_repo TEXT NOT NULL UNIQUE,
    local_source_path TEXT NOT NULL UNIQUE,
    default_branch TEXT NOT NULL DEFAULT 'main',
    last_fetched_at TEXT,
    last_fetch_commit TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * SQL schema for agent_runs table
 * Stores every dev/review agent execution for audit and recovery
 */
export const AGENT_RUNS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    phase TEXT NOT NULL,
    run_status TEXT NOT NULL DEFAULT 'running',
    input_summary TEXT,
    output_summary TEXT,
    decision TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
  );
`;

/**
 * SQL schema for review_events table
 * Stores structured review outcomes by round
 */
export const REVIEW_EVENTS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS review_events (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    review_round INTEGER NOT NULL,
    decision TEXT NOT NULL,
    summary_md TEXT NOT NULL,
    requested_changes_md TEXT,
    merge_block_reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
  );
`;

/**
 * SQL schema for sync_events table
 * Tracks all Linear/GitHub synchronization attempts and outcomes
 */
export const SYNC_EVENTS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sync_events (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL,
    target_system TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'success',
    error TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
  );
`;

/**
 * SQL schema for bot_watch_subscriptions table
 * Persists chat watch preferences so bot subscriptions survive restarts
 */
export const BOT_WATCH_SUBSCRIPTIONS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_watch_subscriptions (
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    issue_identifier TEXT,
    user_id TEXT,
    preset TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (transport, conversation_id, issue_id)
  );
`;

/**
 * SQL schema for bot_conversation_preferences table
 * Persists chat-scoped defaults such as the default Linear project slug
 */
export const BOT_CONVERSATION_PREFERENCES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_conversation_preferences (
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    default_project_slug TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (transport, conversation_id)
  );
`;

/**
 * SQL schema for bot_conversation_focuses table
 * Persists the supervisor-owned focus for a chat so legacy cards cannot guess it.
 */
export const BOT_CONVERSATION_FOCUSES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_conversation_focuses (
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    issue_id TEXT,
    issue_identifier TEXT,
    repo_ref TEXT,
    supervisor_session_id TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (transport, conversation_id)
  );
`;

/**
 * SQL schema for bot_pending_actions table
 * Persists confirmation-gated bot actions so they survive restarts
 */
export const BOT_PENDING_ACTIONS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_pending_actions (
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    issue_id TEXT NOT NULL DEFAULT '',
    user_id TEXT,
    intent_kind TEXT NOT NULL,
    normalized_payload_json TEXT NOT NULL,
    summary_message TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_confirm',
    message_id TEXT,
    card_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (transport, conversation_id, issue_id)
  );
`;

/**
 * SQL schema for supervisor_runs table
 * Persists Telegram supervisor agent runtime runs and final state.
 */
export const SUPERVISOR_RUNS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_runs (
    id TEXT PRIMARY KEY,
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    user_id TEXT,
    state TEXT NOT NULL,
    repo_ref TEXT,
    active_issue_id TEXT,
    user_message TEXT NOT NULL,
    final_message TEXT,
    step_count INTEGER NOT NULL DEFAULT 0,
    last_progress_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * SQL schema for supervisor_run_events table
 * Records user messages, model turns, tool transitions, confirmations, and final answers.
 */
export const SUPERVISOR_RUN_EVENTS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    message TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES supervisor_runs(id) ON DELETE CASCADE
  );
`;

/**
 * SQL schema for supervisor_tool_calls table
 * Stores structured tool transcripts and duplicate-call idempotency keys.
 */
export const SUPERVISOR_TOOL_CALLS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_tool_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    args_json TEXT NOT NULL,
    result_summary TEXT,
    risk TEXT NOT NULL,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES supervisor_runs(id) ON DELETE CASCADE
  );
`;

/**
 * SQL schema for supervisor_pending_actions table
 * Confirmation-gated supervisor runtime actions that survive restarts.
 */
export const SUPERVISOR_PENDING_ACTIONS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_pending_actions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    user_id TEXT,
    tool_name TEXT NOT NULL,
    tool_args_json TEXT NOT NULL,
    policy_decision_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    summary_message TEXT NOT NULL,
    telegram_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending_confirm',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES supervisor_runs(id) ON DELETE CASCADE
  );
`;

/**
 * SQL schema for repo_claude_conversations table
 * Tracks read-only Claude Code continuity per transport, conversation, and repository.
 */
export const REPO_CLAUDE_CONVERSATIONS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS repo_claude_conversations (
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    repo_ref TEXT NOT NULL,
    backend_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    clear_generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (transport, conversation_id, repo_ref)
  );
`;

/**
 * SQL schema for bot_issue_followups table
 * Persists Telegram-originated issue follow-up bindings separately from manual watches
 */
export const BOT_ISSUE_FOLLOWUPS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_issue_followups (
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    issue_identifier TEXT,
    user_id TEXT,
    role TEXT NOT NULL DEFAULT 'origin',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (transport, conversation_id, issue_id, role)
  );
`;

/**
 * SQL schema for bot_followup_message_states table
 * Persists the current proactive Telegram card per conversation and issue
 */
export const BOT_FOLLOWUP_MESSAGE_STATES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_followup_message_states (
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    issue_id TEXT NOT NULL,
    issue_identifier TEXT,
    message_id TEXT NOT NULL,
    card_kind TEXT NOT NULL,
    card_key TEXT NOT NULL,
    card_state TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (transport, conversation_id, issue_id)
  );
`;

/**
 * SQL schema for bot_followup_delivery_states table
 * Persists per-thread delivery baselines so Telegram dedupe survives restarts
 */
export const BOT_FOLLOWUP_DELIVERY_STATES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_followup_delivery_states (
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    root_issue_id TEXT NOT NULL,
    root_issue_identifier TEXT,
    delivery_kind TEXT NOT NULL,
    last_material_key TEXT,
    last_notification_class TEXT,
    last_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (transport, conversation_id, root_issue_id, delivery_kind)
  );
`;

/**
 * SQL schema for bot_transport_events table
 * Persists outbound bot delivery audit records for replay and debugging
 */
export const BOT_TRANSPORT_EVENTS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_transport_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    issue_id TEXT,
    root_issue_id TEXT,
    source TEXT NOT NULL,
    message_id TEXT,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    material_key TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL
  );
`;

export const SUPERVISOR_SESSIONS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_sessions (
    id TEXT PRIMARY KEY,
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    user_id TEXT,
    state TEXT NOT NULL,
    repo_ref TEXT,
    intake_mode TEXT,
    approval_mode TEXT,
    plan_card_json TEXT,
    plan_version INTEGER NOT NULL DEFAULT 1,
    root_issue_id TEXT,
    root_work_item_id TEXT,
    current_child_issue_id TEXT,
    active_decision_kind TEXT,
    delivery_state TEXT,
    delivery_summary TEXT,
    last_material_outcome_json TEXT,
    last_message_id TEXT,
    last_card_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const SUPERVISOR_SESSION_EVENTS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES supervisor_sessions(id) ON DELETE CASCADE
  );
`;

export const SUPERVISOR_JOBS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    root_issue_id TEXT,
    job_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT,
    result_json TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    run_after TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES supervisor_sessions(id) ON DELETE CASCADE
  );
`;

export const SUPERVISOR_MEMORIES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_memories (
    id TEXT PRIMARY KEY,
    repo_ref TEXT NOT NULL,
    memory_kind TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_json TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repo_ref, memory_kind, subject_key)
  );
`;

export const SUPERVISOR_REPO_UNDERSTANDINGS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervisor_repo_understandings (
    id TEXT PRIMARY KEY,
    repo_ref TEXT NOT NULL,
    local_path TEXT,
    commit_sha TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT,
    understanding_json TEXT NOT NULL,
    evidence_paths_json TEXT NOT NULL,
    generated_by TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repo_ref, commit_sha)
  );
`;

/**
 * SQL schema for service_leases table
 * Stores short-lived singleton leadership leases for control-plane services
 */
export const SERVICE_LEASES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS service_leases (
    lease_key TEXT PRIMARY KEY,
    holder_id TEXT NOT NULL,
    holder_pid INTEGER,
    holder_host TEXT,
    metadata_json TEXT,
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`;

/**
 * SQL schema for shadow_harnesses table
 * Persists provisional repo harnesses inferred from successful runs
 */
export const SHADOW_HARNESSES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS shadow_harnesses (
    repo_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    config_json TEXT NOT NULL,
    inference_details_json TEXT,
    successful_runs INTEGER NOT NULL DEFAULT 0,
    failed_runs INTEGER NOT NULL DEFAULT 0,
    adoption_suggested_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * SQL schema for governance_assessments table
 * Tracks structured governance decisions made before or during dispatch
 */
export const GOVERNANCE_ASSESSMENTS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS governance_assessments (
    id TEXT PRIMARY KEY,
    work_item_id TEXT,
    issue_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    constitution_hits_json TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
  );
`;

export const DECISION_MEMORIES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS decision_memories (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const CONFLICT_MEMORIES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS conflict_memories (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const DEBT_SIGNALS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS debt_signals (
    id TEXT PRIMARY KEY,
    repo_key TEXT NOT NULL,
    signal_code TEXT NOT NULL,
    summary TEXT NOT NULL,
    severity TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL
  );
`;

export const GOVERNANCE_SUGGESTIONS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS governance_suggestions (
    id TEXT PRIMARY KEY,
    work_item_id TEXT,
    issue_id TEXT NOT NULL,
    suggestion_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
  );
`;

/**
 * Indexes for new control-plane tables
 */
export const CONTROL_PLANE_INDEXES_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_work_items_linear_state ON work_items(linear_state);
  CREATE INDEX IF NOT EXISTS idx_work_items_orchestrator_state ON work_items(orchestrator_state);
  CREATE INDEX IF NOT EXISTS idx_work_items_github_repo ON work_items(github_repo);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_work_item_id ON agent_runs(work_item_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at);
  CREATE INDEX IF NOT EXISTS idx_review_events_work_item_id ON review_events(work_item_id);
  CREATE INDEX IF NOT EXISTS idx_review_events_round ON review_events(work_item_id, review_round DESC);
  CREATE INDEX IF NOT EXISTS idx_sync_events_work_item_id ON sync_events(work_item_id);
  CREATE INDEX IF NOT EXISTS idx_sync_events_target_result ON sync_events(target_system, result);
  CREATE INDEX IF NOT EXISTS idx_bot_watch_subscriptions_issue_id ON bot_watch_subscriptions(issue_id);
  CREATE INDEX IF NOT EXISTS idx_bot_watch_subscriptions_transport_conversation ON bot_watch_subscriptions(transport, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_bot_conversation_preferences_transport_conversation ON bot_conversation_preferences(transport, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_bot_conversation_focuses_transport_conversation ON bot_conversation_focuses(transport, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_bot_conversation_focuses_issue_id ON bot_conversation_focuses(issue_id);
  CREATE INDEX IF NOT EXISTS idx_bot_conversation_focuses_repo_ref ON bot_conversation_focuses(repo_ref);
  CREATE INDEX IF NOT EXISTS idx_bot_pending_actions_expires_at ON bot_pending_actions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_bot_pending_actions_transport_conversation ON bot_pending_actions(transport, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_bot_pending_actions_transport_conversation_issue ON bot_pending_actions(transport, conversation_id, issue_id);
  CREATE INDEX IF NOT EXISTS idx_supervisor_runs_transport_conversation ON supervisor_runs(transport, conversation_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_supervisor_runs_state ON supervisor_runs(state, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_supervisor_runs_active_issue ON supervisor_runs(active_issue_id);
  CREATE INDEX IF NOT EXISTS idx_supervisor_run_events_run ON supervisor_run_events(run_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_supervisor_tool_calls_run ON supervisor_tool_calls(run_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_supervisor_tool_calls_idempotency ON supervisor_tool_calls(idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_supervisor_pending_actions_conversation ON supervisor_pending_actions(transport, conversation_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_supervisor_pending_actions_run ON supervisor_pending_actions(run_id);
  CREATE INDEX IF NOT EXISTS idx_supervisor_pending_actions_expiry ON supervisor_pending_actions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_repo_claude_conversations_last_used ON repo_claude_conversations(last_used_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bot_issue_followups_issue_id ON bot_issue_followups(issue_id);
  CREATE INDEX IF NOT EXISTS idx_bot_issue_followups_transport_conversation ON bot_issue_followups(transport, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_bot_followup_message_states_transport_conversation ON bot_followup_message_states(transport, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_bot_followup_message_states_issue_id ON bot_followup_message_states(issue_id);
  CREATE INDEX IF NOT EXISTS idx_bot_followup_delivery_states_transport_conversation ON bot_followup_delivery_states(transport, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_bot_followup_delivery_states_root_issue ON bot_followup_delivery_states(root_issue_id);
  CREATE INDEX IF NOT EXISTS idx_bot_transport_events_transport_conversation ON bot_transport_events(transport, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_bot_transport_events_root_issue ON bot_transport_events(root_issue_id);
  CREATE INDEX IF NOT EXISTS idx_bot_transport_events_created_at ON bot_transport_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_supervisor_sessions_transport_conversation ON supervisor_sessions(transport, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_supervisor_sessions_root_issue ON supervisor_sessions(root_issue_id);
  CREATE INDEX IF NOT EXISTS idx_supervisor_sessions_state ON supervisor_sessions(state);
  CREATE INDEX IF NOT EXISTS idx_supervisor_session_events_session ON supervisor_session_events(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_supervisor_jobs_ready ON supervisor_jobs(status, run_after);
  CREATE INDEX IF NOT EXISTS idx_supervisor_jobs_session ON supervisor_jobs(session_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_supervisor_jobs_root_issue ON supervisor_jobs(root_issue_id);
  CREATE INDEX IF NOT EXISTS idx_supervisor_memories_repo_updated ON supervisor_memories(repo_ref, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_supervisor_memories_kind ON supervisor_memories(memory_kind);
  CREATE INDEX IF NOT EXISTS idx_service_leases_expires_at ON service_leases(expires_at);
  CREATE INDEX IF NOT EXISTS idx_shadow_harnesses_repo_key ON shadow_harnesses(repo_key);
  CREATE INDEX IF NOT EXISTS idx_governance_assessments_issue_id ON governance_assessments(issue_id);
  CREATE INDEX IF NOT EXISTS idx_governance_assessments_work_item_id ON governance_assessments(work_item_id);
  CREATE INDEX IF NOT EXISTS idx_decision_memories_repo_key ON decision_memories(repo_key);
  CREATE INDEX IF NOT EXISTS idx_conflict_memories_repo_key ON conflict_memories(repo_key);
  CREATE INDEX IF NOT EXISTS idx_debt_signals_repo_key ON debt_signals(repo_key);
  CREATE INDEX IF NOT EXISTS idx_governance_suggestions_issue_id ON governance_suggestions(issue_id);
  CREATE INDEX IF NOT EXISTS idx_governance_suggestions_status ON governance_suggestions(status);
`;

function ensureColumn(db: Database, tableName: string, columnName: string, columnDefinition: string): void {
  const rows = db
    .query(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | null;
  return Boolean(row?.name);
}

function migrateBotPendingActionsTable(db: Database): void {
  if (!tableExists(db, 'bot_pending_actions')) {
    return;
  }

  const rows = db
    .query('PRAGMA table_info(bot_pending_actions)')
    .all() as Array<{ name?: string; pk?: number }>;
  const hasIssueId = rows.some((row) => row.name === 'issue_id');
  const pkColumns = rows
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => row.name);

  if (
    hasIssueId &&
    pkColumns.length === 3 &&
    pkColumns[0] === 'transport' &&
    pkColumns[1] === 'conversation_id' &&
    pkColumns[2] === 'issue_id'
  ) {
    return;
  }

  db.exec('DROP TABLE IF EXISTS bot_pending_actions_v2;');
  db.exec(`
    CREATE TABLE bot_pending_actions_v2 (
      transport TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      issue_id TEXT NOT NULL DEFAULT '',
      user_id TEXT,
      intent_kind TEXT NOT NULL,
      normalized_payload_json TEXT NOT NULL,
      summary_message TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_confirm',
      message_id TEXT,
      card_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (transport, conversation_id, issue_id)
    );
  `);

  const columnNames = new Set(rows.map((row) => row.name).filter((name): name is string => Boolean(name)));
  const selectClauses = [
    'transport',
    'conversation_id',
    columnNames.has('issue_id') ? "COALESCE(issue_id, '')" : "''",
    'user_id',
    'intent_kind',
    'normalized_payload_json',
    'summary_message',
    'expires_at',
    columnNames.has('status') ? "COALESCE(status, 'pending_confirm')" : "'pending_confirm'",
    columnNames.has('message_id') ? 'message_id' : 'NULL',
    columnNames.has('card_key') ? 'card_key' : 'NULL',
    'created_at',
    'updated_at',
  ];

  db.exec(`
    INSERT INTO bot_pending_actions_v2 (
      transport, conversation_id, issue_id, user_id, intent_kind, normalized_payload_json,
      summary_message, expires_at, status, message_id, card_key, created_at, updated_at
    )
    SELECT ${selectClauses.join(', ')}
    FROM bot_pending_actions;
  `);

  db.exec('DROP TABLE bot_pending_actions;');
  db.exec('ALTER TABLE bot_pending_actions_v2 RENAME TO bot_pending_actions;');
}

/**
 * Initialize the database schema
 * Creates all tables and indexes if they don't exist
 */
export function initializeSchema(db: Database): void {
  db.exec(WORK_ITEMS_TABLE_SCHEMA);
  db.exec(REPO_CACHES_TABLE_SCHEMA);
  db.exec(AGENT_RUNS_TABLE_SCHEMA);
  db.exec(REVIEW_EVENTS_TABLE_SCHEMA);
  db.exec(SYNC_EVENTS_TABLE_SCHEMA);
  db.exec(BOT_WATCH_SUBSCRIPTIONS_TABLE_SCHEMA);
  db.exec(BOT_CONVERSATION_PREFERENCES_TABLE_SCHEMA);
  db.exec(BOT_CONVERSATION_FOCUSES_TABLE_SCHEMA);
  db.exec(BOT_PENDING_ACTIONS_TABLE_SCHEMA);
  migrateBotPendingActionsTable(db);
  db.exec(SUPERVISOR_RUNS_TABLE_SCHEMA);
  db.exec(SUPERVISOR_RUN_EVENTS_TABLE_SCHEMA);
  db.exec(SUPERVISOR_TOOL_CALLS_TABLE_SCHEMA);
  db.exec(SUPERVISOR_PENDING_ACTIONS_TABLE_SCHEMA);
  db.exec(REPO_CLAUDE_CONVERSATIONS_TABLE_SCHEMA);
  db.exec(BOT_ISSUE_FOLLOWUPS_TABLE_SCHEMA);
  db.exec(BOT_FOLLOWUP_MESSAGE_STATES_TABLE_SCHEMA);
  db.exec(BOT_FOLLOWUP_DELIVERY_STATES_TABLE_SCHEMA);
  db.exec(BOT_TRANSPORT_EVENTS_TABLE_SCHEMA);
  db.exec(SUPERVISOR_SESSIONS_TABLE_SCHEMA);
  db.exec(SUPERVISOR_SESSION_EVENTS_TABLE_SCHEMA);
  db.exec(SUPERVISOR_JOBS_TABLE_SCHEMA);
  db.exec(SUPERVISOR_MEMORIES_TABLE_SCHEMA);
  db.exec(SUPERVISOR_REPO_UNDERSTANDINGS_TABLE_SCHEMA);
  db.exec(SERVICE_LEASES_TABLE_SCHEMA);
  db.exec(SHADOW_HARNESSES_TABLE_SCHEMA);
  db.exec(GOVERNANCE_ASSESSMENTS_TABLE_SCHEMA);
  db.exec(DECISION_MEMORIES_TABLE_SCHEMA);
  db.exec(CONFLICT_MEMORIES_TABLE_SCHEMA);
  db.exec(DEBT_SIGNALS_TABLE_SCHEMA);
  db.exec(GOVERNANCE_SUGGESTIONS_TABLE_SCHEMA);
  ensureColumn(db, 'work_items', 'repo_harness_status', 'TEXT');
  ensureColumn(db, 'work_items', 'delivery_code', 'TEXT');
  ensureColumn(db, 'work_items', 'delivery_summary', 'TEXT');
  ensureColumn(db, 'work_items', 'constitution_status', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_status', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_decision', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_summary', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_root_issue_id', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_parent_issue_id', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_generation', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'work_items', 'governance_source_updated_at', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_override_at', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_override_reason', 'TEXT');
  ensureColumn(db, 'work_items', 'supervisor_root_session_id', 'TEXT');
  ensureColumn(db, 'work_items', 'supervisor_plan_summary', 'TEXT');
  ensureColumn(db, 'work_items', 'supervisor_acceptance_summary', 'TEXT');
  ensureColumn(db, 'work_items', 'supervisor_execution_mode', 'TEXT');
  ensureColumn(db, 'bot_pending_actions', 'issue_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'bot_pending_actions', 'status', "TEXT NOT NULL DEFAULT 'pending_confirm'");
  ensureColumn(db, 'bot_pending_actions', 'message_id', 'TEXT');
  ensureColumn(db, 'bot_pending_actions', 'card_key', 'TEXT');
  ensureColumn(db, 'work_items', 'change_pack_summary_json', 'TEXT');
  ensureColumn(db, 'work_items', 'task_status_json', 'TEXT');
  ensureColumn(db, 'work_items', 'evidence_summary_json', 'TEXT');
  ensureColumn(db, 'work_items', 'missing_requirements_json', 'TEXT');
  ensureColumn(db, 'work_items', 'constitution_hits_json', 'TEXT');
  ensureColumn(db, 'work_items', 'touched_paths_json', 'TEXT');
  ensureColumn(db, 'work_items', 'touched_areas_json', 'TEXT');
  ensureColumn(db, 'work_items', 'path_families_json', 'TEXT');
  ensureColumn(db, 'work_items', 'boundary_edges_json', 'TEXT');
  ensureColumn(db, 'work_items', 'import_edges_json', 'TEXT');
  ensureColumn(db, 'work_items', 'architectural_target', 'TEXT');
  ensureColumn(db, 'work_items', 'fitness_signals_json', 'TEXT');
  db.exec(CONTROL_PLANE_INDEXES_SCHEMA);
}

/**
 * Drop all tables (useful for testing)
 */
export function dropAllTables(db: Database): void {
  db.exec('DROP TABLE IF EXISTS governance_suggestions;');
  db.exec('DROP TABLE IF EXISTS debt_signals;');
  db.exec('DROP TABLE IF EXISTS conflict_memories;');
  db.exec('DROP TABLE IF EXISTS decision_memories;');
  db.exec('DROP TABLE IF EXISTS governance_assessments;');
  db.exec('DROP TABLE IF EXISTS shadow_harnesses;');
  db.exec('DROP TABLE IF EXISTS service_leases;');
  db.exec('DROP TABLE IF EXISTS bot_transport_events;');
  db.exec('DROP TABLE IF EXISTS repo_claude_conversations;');
  db.exec('DROP TABLE IF EXISTS supervisor_pending_actions;');
  db.exec('DROP TABLE IF EXISTS supervisor_tool_calls;');
  db.exec('DROP TABLE IF EXISTS supervisor_run_events;');
  db.exec('DROP TABLE IF EXISTS supervisor_runs;');
  db.exec('DROP TABLE IF EXISTS supervisor_repo_understandings;');
  db.exec('DROP TABLE IF EXISTS supervisor_memories;');
  db.exec('DROP TABLE IF EXISTS supervisor_jobs;');
  db.exec('DROP TABLE IF EXISTS supervisor_session_events;');
  db.exec('DROP TABLE IF EXISTS supervisor_sessions;');
  db.exec('DROP TABLE IF EXISTS bot_followup_delivery_states;');
  db.exec('DROP TABLE IF EXISTS bot_followup_message_states;');
  db.exec('DROP TABLE IF EXISTS bot_pending_actions;');
  db.exec('DROP TABLE IF EXISTS bot_conversation_focuses;');
  db.exec('DROP TABLE IF EXISTS bot_issue_followups;');
  db.exec('DROP TABLE IF EXISTS bot_conversation_preferences;');
  db.exec('DROP TABLE IF EXISTS bot_watch_subscriptions;');
  db.exec('DROP TABLE IF EXISTS sync_events;');
  db.exec('DROP TABLE IF EXISTS review_events;');
  db.exec('DROP TABLE IF EXISTS agent_runs;');
  db.exec('DROP TABLE IF EXISTS repo_caches;');
  db.exec('DROP TABLE IF EXISTS work_items;');
}
