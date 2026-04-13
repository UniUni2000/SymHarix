/**
 * Database Schema Definitions for Symphony Enterprise Agent Platform
 * Defines table structures and initialization logic
 */

import type { Database } from 'bun:sqlite';

/**
 * SQL schema for the tasks table
 * Stores task/work item information synced from tracker
 */
export const TASKS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    priority INTEGER,
    state TEXT NOT NULL,
    branch_name TEXT,
    url TEXT,
    labels TEXT DEFAULT '[]',
    blocked_by TEXT DEFAULT '[]',
    workspace_key TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
`;

/**
 * SQL schema for the workspaces table
 * Tracks workspace directories for each task
 */
export const WORKSPACES_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    workspace_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    cleaned_at TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
`;

/**
 * SQL schema for the execution_events table
 * Stores all runtime events for auditing and streaming
 */
export const EXECUTION_EVENTS_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS execution_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT NOT NULL,
    severity TEXT DEFAULT 'info',
    source TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
`;

/**
 * Create indexes for common query patterns
 */
export const INDEXES_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_tasks_identifier ON tasks(identifier) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_workspaces_task_id ON workspaces(task_id);
  CREATE INDEX IF NOT EXISTS idx_execution_events_task_id ON execution_events(task_id);
  CREATE INDEX IF NOT EXISTS idx_execution_events_created_at ON execution_events(created_at);
`;

/**
 * Initialize the database schema
 * Creates all tables and indexes if they don't exist
 */
export function initializeSchema(db: Database): void {
  db.exec(TASKS_TABLE_SCHEMA);
  db.exec(WORKSPACES_TABLE_SCHEMA);
  db.exec(EXECUTION_EVENTS_TABLE_SCHEMA);
  db.exec(INDEXES_SCHEMA);
}

/**
 * Drop all tables (useful for testing)
 */
export function dropAllTables(db: Database): void {
  db.exec('DROP TABLE IF EXISTS execution_events;');
  db.exec('DROP TABLE IF EXISTS workspaces;');
  db.exec('DROP TABLE IF EXISTS tasks;');
}
