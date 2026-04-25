import type { Database } from 'bun:sqlite';
import type {
  CreateSupervisorSessionEventRecord,
  SupervisorSessionEventRecord,
} from '../types';

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class SupervisorSessionEventRepository {
  constructor(private readonly db: Database) {}

  create(record: CreateSupervisorSessionEventRecord): SupervisorSessionEventRecord {
    const createdAt = (record.created_at ?? new Date()).toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO supervisor_session_events (
        id, session_id, event_kind, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.session_id,
      record.event_kind,
      record.payload_json ? JSON.stringify(record.payload_json) : null,
      createdAt,
    );

    return this.findById(record.id)!;
  }

  findById(id: string): SupervisorSessionEventRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM supervisor_session_events WHERE id = ?`);
    return this.mapRow(stmt.get(id) as Record<string, unknown> | undefined);
  }

  listBySession(sessionId: string): SupervisorSessionEventRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM supervisor_session_events
      WHERE session_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is SupervisorSessionEventRecord => row !== null);
  }

  private mapRow(row: Record<string, unknown> | undefined): SupervisorSessionEventRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      session_id: String(row.session_id),
      event_kind: String(row.event_kind),
      payload_json: parseJsonObject(row.payload_json),
      created_at: new Date(String(row.created_at)),
    };
  }
}
