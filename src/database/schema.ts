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
    repo_harness_status TEXT,
    constitution_status TEXT,
    governance_status TEXT,
    governance_decision TEXT,
    governance_summary TEXT,
    governance_override_at TEXT,
    governance_override_reason TEXT,
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
 * SQL schema for bot_pending_actions table
 * Persists confirmation-gated bot actions so they survive restarts
 */
export const BOT_PENDING_ACTIONS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS bot_pending_actions (
    transport TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    user_id TEXT,
    intent_kind TEXT NOT NULL,
    normalized_payload_json TEXT NOT NULL,
    summary_message TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (transport, conversation_id)
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
  CREATE INDEX IF NOT EXISTS idx_bot_pending_actions_expires_at ON bot_pending_actions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_bot_pending_actions_transport_conversation ON bot_pending_actions(transport, conversation_id);
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
  db.exec(BOT_PENDING_ACTIONS_TABLE_SCHEMA);
  db.exec(SERVICE_LEASES_TABLE_SCHEMA);
  db.exec(SHADOW_HARNESSES_TABLE_SCHEMA);
  db.exec(GOVERNANCE_ASSESSMENTS_TABLE_SCHEMA);
  db.exec(DECISION_MEMORIES_TABLE_SCHEMA);
  db.exec(CONFLICT_MEMORIES_TABLE_SCHEMA);
  db.exec(DEBT_SIGNALS_TABLE_SCHEMA);
  db.exec(GOVERNANCE_SUGGESTIONS_TABLE_SCHEMA);
  ensureColumn(db, 'work_items', 'repo_harness_status', 'TEXT');
  ensureColumn(db, 'work_items', 'constitution_status', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_status', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_decision', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_summary', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_override_at', 'TEXT');
  ensureColumn(db, 'work_items', 'governance_override_reason', 'TEXT');
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
  db.exec('DROP TABLE IF EXISTS bot_pending_actions;');
  db.exec('DROP TABLE IF EXISTS bot_conversation_preferences;');
  db.exec('DROP TABLE IF EXISTS bot_watch_subscriptions;');
  db.exec('DROP TABLE IF EXISTS sync_events;');
  db.exec('DROP TABLE IF EXISTS review_events;');
  db.exec('DROP TABLE IF EXISTS agent_runs;');
  db.exec('DROP TABLE IF EXISTS repo_caches;');
  db.exec('DROP TABLE IF EXISTS work_items;');
}
