/**
 * Event Repository - Storage and streaming for execution events
 */

import type { Database } from 'bun:sqlite';
import type { ExecutionEvent, CreateExecutionEvent, EventSeverity, StreamOptions } from './types';

/**
 * Global sequence counter for unique, ordered event IDs
 */
let eventSequenceCounter = 0;

/**
 * Reset the sequence counter (for testing)
 */
export function resetEventSequence(): void {
  eventSequenceCounter = 0;
}

/**
 * Severity level ordering for filtering
 */
const SEVERITY_ORDER: Record<EventSeverity, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/**
 * Event Repository for database operations
 */
export class EventRepository {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Create a new execution event
   */
  create(event: CreateExecutionEvent): ExecutionEvent {
    const id = this.generateEventId();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO execution_events (
        id, task_id, event_type, event_data, severity, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      event.task_id,
      event.event_type,
      JSON.stringify(event.event_data),
      event.severity ?? 'info',
      event.source ?? null,
      now
    );

    return this.findById(id);
  }

  /**
   * Find an event by ID
   */
  findById(id: string): ExecutionEvent | null {
    const stmt = this.db.prepare(`
      SELECT * FROM execution_events WHERE id = ?
    `);
    return this.mapToEvent(stmt.get(id) as Record<string, unknown>);
  }

  /**
   * Find all events for a specific task
   */
  findByTaskId(taskId: string, options?: { limit?: number; offset?: number }): ExecutionEvent[] {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const stmt = this.db.prepare(`
      SELECT * FROM execution_events
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(taskId, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapToEvent(row));
  }

  /**
   * Stream events for a task (returns events in creation order)
   * Useful for real-time event streaming to clients
   */
  streamByTaskId(taskId: string, options?: StreamOptions): ExecutionEvent[] {
    let query = `
      SELECT * FROM execution_events
      WHERE task_id = ?
    `;
    const params: (string | number)[] = [taskId];

    // Filter by event ID (for pagination) - use created_at + id for proper cursor pagination
    if (options?.afterId) {
      // Get the created_at of the reference event
      const refStmt = this.db.prepare(`SELECT created_at FROM execution_events WHERE id = ?`);
      const refRow = refStmt.get(options.afterId) as { created_at: string } | undefined;
      if (refRow) {
        // Use (created_at, id) tuple comparison for proper pagination
        // Events with same timestamp but higher id will be included
        query += ` AND (created_at > ? OR (created_at = ? AND id > ?))`;
        params.push(refRow.created_at, refRow.created_at, options.afterId);
      } else {
        // If reference event not found, return empty
        return [];
      }
    }

    // Filter by event type
    if (options?.eventType) {
      query += ` AND event_type = ?`;
      params.push(options.eventType);
    }

    query += ` ORDER BY created_at ASC, id ASC`;

    // Apply limit
    if (options?.limit) {
      query += ` LIMIT ?`;
      params.push(options.limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    // Filter by severity in code
    let events = rows.map((row) => this.mapToEvent(row));
    if (options?.minSeverity) {
      const minLevel = SEVERITY_ORDER[options.minSeverity];
      events = events.filter((e) => SEVERITY_ORDER[e.severity] >= minLevel);
    }

    return events;
  }

  /**
   * Count events for a task
   */
  countByTaskId(taskId: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM execution_events WHERE task_id = ?
    `);
    const result = stmt.get(taskId) as { count: number };
    return result.count;
  }

  /**
   * Find events by type across all tasks
   */
  findByType(eventType: string, limit: number = 100): ExecutionEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM execution_events
      WHERE event_type = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(eventType, limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapToEvent(row));
  }

  /**
   * Delete all events for a task (cleanup)
   */
  deleteByTaskId(taskId: string): number {
    const stmt = this.db.prepare(`DELETE FROM execution_events WHERE task_id = ?`);
    const result = stmt.run(taskId);
    return (result as { changes: number }).changes;
  }

  /**
   * Delete events older than a specific date (cleanup/retention)
   */
  deleteOlderThan(taskId: string, beforeDate: Date): number {
    const stmt = this.db.prepare(`
      DELETE FROM execution_events
      WHERE task_id = ? AND created_at < ?
    `);
    const result = stmt.run(taskId, beforeDate.toISOString());
    return (result as { changes: number }).changes;
  }

  /**
   * Clear all events (for testing)
   */
  clearAll(): number {
    const stmt = this.db.prepare(`DELETE FROM execution_events`);
    const result = stmt.run();
    return (result as { changes: number }).changes;
  }

  /**
   * Helper to generate unique event ID with sequence for ordering
   */
  private generateEventId(): string {
    eventSequenceCounter++;
    return `evt_${Date.now()}_${eventSequenceCounter.toString().padStart(6, '0')}`;
  }

  /**
   * Helper to map database row to ExecutionEvent object
   */
  private mapToEvent(row: Record<string, unknown> | undefined): ExecutionEvent | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      task_id: row.task_id as string,
      event_type: row.event_type as string,
      event_data: JSON.parse(row.event_data as string) as Record<string, unknown>,
      severity: row.severity as EventSeverity,
      source: row.source as string | null,
      created_at: new Date(row.created_at as string),
    };
  }
}
