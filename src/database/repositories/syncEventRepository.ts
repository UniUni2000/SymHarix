/**
 * Sync Event Repository - CRUD for external synchronization events
 */

import type { Database } from 'bun:sqlite';
import type { CreateSyncEvent, SyncEvent } from '../types';

export class SyncEventRepository {
  constructor(private db: Database) {}

  create(event: CreateSyncEvent): SyncEvent {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sync_events (
        id, work_item_id, target_system, action, payload_json, result, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.id,
      event.work_item_id,
      event.target_system,
      event.action,
      JSON.stringify(event.payload_json),
      event.result ?? 'success',
      event.error ?? null,
      now
    );

    return this.findById(event.id)!;
  }

  findById(id: string): SyncEvent | null {
    const stmt = this.db.prepare(`SELECT * FROM sync_events WHERE id = ?`);
    return this.mapToSyncEvent(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findByWorkItemId(workItemId: string): SyncEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_events WHERE work_item_id = ? ORDER BY created_at ASC, id ASC
    `);
    const rows = stmt.all(workItemId) as Record<string, unknown>[];
    return rows.map(row => this.mapToSyncEvent(row)).filter((item): item is SyncEvent => item !== null);
  }

  findFailed(): SyncEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_events WHERE result = 'failed' ORDER BY created_at DESC, id DESC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => this.mapToSyncEvent(row)).filter((item): item is SyncEvent => item !== null);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM sync_events WHERE id = ?`);
    const result = stmt.run(id);
    return (result as { changes: number }).changes > 0;
  }

  private mapToSyncEvent(row: Record<string, unknown> | undefined): SyncEvent | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      work_item_id: row.work_item_id as string,
      target_system: row.target_system as SyncEvent['target_system'],
      action: row.action as string,
      payload_json: JSON.parse((row.payload_json as string) ?? '{}') as Record<string, unknown>,
      result: row.result as SyncEvent['result'],
      error: row.error as string | null,
      created_at: new Date(row.created_at as string),
    };
  }
}
