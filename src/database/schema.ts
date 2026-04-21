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
  CREATE INDEX IF NOT EXISTS idx_service_leases_expires_at ON service_leases(expires_at);
`;

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
  db.exec(SERVICE_LEASES_TABLE_SCHEMA);
  db.exec(CONTROL_PLANE_INDEXES_SCHEMA);
}

/**
 * Drop all tables (useful for testing)
 */
export function dropAllTables(db: Database): void {
  db.exec('DROP TABLE IF EXISTS service_leases;');
  db.exec('DROP TABLE IF EXISTS sync_events;');
  db.exec('DROP TABLE IF EXISTS review_events;');
  db.exec('DROP TABLE IF EXISTS agent_runs;');
  db.exec('DROP TABLE IF EXISTS repo_caches;');
  db.exec('DROP TABLE IF EXISTS work_items;');
}
