import type { Database } from 'bun:sqlite';
import type {
  CreateSupervisorRunEventRecord,
  SupervisorRunEventRecord,
} from '../types';

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export class SupervisorRunEventRepository {
  constructor(private readonly db: Database) {}

  create(record: CreateSupervisorRunEventRecord): SupervisorRunEventRecord {
    const id = record.id ?? crypto.randomUUID();
    const createdAt = record.created_at ?? new Date();
    this.db.prepare(`
      INSERT INTO supervisor_run_events (
        id, run_id, event_kind, message, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.run_id,
      record.event_kind,
      record.message ?? null,
      record.payload ? JSON.stringify(record.payload) : null,
      createdAt.toISOString(),
    );
    return this.findById(id)!;
  }

  findById(id: string): SupervisorRunEventRecord | null {
    const row = this.db
      .prepare('SELECT * FROM supervisor_run_events WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  listByRun(runId: string): SupervisorRunEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM supervisor_run_events
      WHERE run_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.map(row)).filter((row): row is SupervisorRunEventRecord => row !== null);
  }

  private map(row: Record<string, unknown> | undefined): SupervisorRunEventRecord | null {
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      run_id: String(row.run_id),
      event_kind: row.event_kind as SupervisorRunEventRecord['event_kind'],
      message: row.message as string | null,
      payload: parseJson(row.payload_json),
      created_at: new Date(String(row.created_at)),
    };
  }
}
