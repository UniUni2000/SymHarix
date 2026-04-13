/**
 * Task Repository - CRUD operations for tasks table
 */

import type { Database } from 'bun:sqlite';
import type { Task, TaskStatus } from './types';

/**
 * Task Repository for database operations
 */
export class TaskRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Create a new task
   */
  create(task: Omit<Task, 'created_at' | 'updated_at'>): Task {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, identifier, title, description, priority, state,
        branch_name, url, labels, blocked_by, workspace_key,
        retry_count, max_retries, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      task.id,
      task.identifier,
      task.title,
      task.description ?? null,
      task.priority ?? null,
      task.state,
      task.branch_name ?? null,
      task.url ?? null,
      JSON.stringify(task.labels ?? []),
      JSON.stringify(task.blocked_by ?? []),
      task.workspace_key ?? null,
      task.retry_count ?? 0,
      task.max_retries ?? 3,
      now,
      now
    );

    return this.findById(task.id);
  }

  /**
   * Find a task by ID
   */
  findById(id: string): Task | null {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL
    `);
    return this.mapToTask(stmt.get(id) as Record<string, unknown>);
  }

  /**
   * Find a task by issue identifier (e.g., "ABC-123")
   */
  findByIssueId(identifier: string): Task | null {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE identifier = ? AND deleted_at IS NULL
    `);
    return this.mapToTask(stmt.get(identifier) as Record<string, unknown>);
  }

  /**
   * Find all non-deleted tasks
   */
  findAll(): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at DESC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapToTask(row));
  }

  /**
   * Find tasks by state
   */
  findByState(state: string): Task[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE state = ? AND deleted_at IS NULL
    `);
    const rows = stmt.all(state) as Record<string, unknown>[];
    return rows.map((row) => this.mapToTask(row));
  }

  /**
   * Update task status
   */
  updateStatus(id: string, state: string): Task | null {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL
    `);
    stmt.run(state, now, id);
    return this.findById(id);
  }

  /**
   * Increment retry count for a task
   */
  incrementRetryCount(id: string): Task | null {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks SET retry_count = retry_count + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL
    `);
    stmt.run(now, id);
    return this.findById(id);
  }

  /**
   * Update task workspace key
   */
  updateWorkspaceKey(id: string, workspaceKey: string): Task | null {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks SET workspace_key = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL
    `);
    stmt.run(workspaceKey, now, id);
    return this.findById(id);
  }

  /**
   * Soft delete a task
   */
  delete(id: string): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?
    `);
    const result = stmt.run(now, now, id);
    return (result as { changes: number }).changes > 0;
  }

  /**
   * Hard delete a task (permanently remove)
   */
  hardDelete(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);
    const result = stmt.run(id);
    return (result as { changes: number }).changes > 0;
  }

  /**
   * Update task with full fields
   */
  update(task: Partial<Task> & { id: string }): Task | null {
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now];

    if (task.title !== undefined) {
      fields.push('title = ?');
      params.push(task.title);
    }
    if (task.description !== undefined) {
      fields.push('description = ?');
      params.push(task.description);
    }
    if (task.priority !== undefined) {
      fields.push('priority = ?');
      params.push(task.priority);
    }
    if (task.state !== undefined) {
      fields.push('state = ?');
      params.push(task.state);
    }
    if (task.branch_name !== undefined) {
      fields.push('branch_name = ?');
      params.push(task.branch_name);
    }
    if (task.url !== undefined) {
      fields.push('url = ?');
      params.push(task.url);
    }
    if (task.labels !== undefined) {
      fields.push('labels = ?');
      params.push(JSON.stringify(task.labels));
    }
    if (task.blocked_by !== undefined) {
      fields.push('blocked_by = ?');
      params.push(JSON.stringify(task.blocked_by));
    }

    params.push(task.id);

    const stmt = this.db.prepare(`
      UPDATE tasks SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL
    `);
    stmt.run(...params);

    return this.findById(task.id);
  }

  /**
   * Helper to map database row to Task object
   */
  private mapToTask(row: Record<string, unknown> | undefined): Task | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      identifier: row.identifier as string,
      title: row.title as string,
      description: row.description as string | null,
      priority: row.priority as number | null,
      state: row.state as string,
      branch_name: row.branch_name as string | null,
      url: row.url as string | null,
      labels: JSON.parse((row.labels as string) ?? '[]') as string[],
      blocked_by: JSON.parse((row.blocked_by as string) ?? '[]') as string[],
      workspace_key: row.workspace_key as string | null,
      retry_count: (row.retry_count as number) ?? 0,
      max_retries: (row.max_retries as number) ?? 3,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
