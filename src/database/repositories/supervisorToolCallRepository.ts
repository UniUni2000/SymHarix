import type { Database } from 'bun:sqlite';
import type {
  CreateSupervisorToolCallRecord,
  SupervisorToolCallRecord,
  UpdateSupervisorToolCallRecord,
} from '../types';

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export class SupervisorToolCallRepository {
  constructor(private readonly db: Database) {}

  create(record: CreateSupervisorToolCallRecord): SupervisorToolCallRecord {
    const id = record.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO supervisor_tool_calls (
        id, run_id, tool_name, args_hash, args_json, result_summary, risk,
        duration_ms, status, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.run_id,
      record.tool_name,
      record.args_hash,
      JSON.stringify(record.args),
      record.result_summary ?? null,
      record.risk,
      record.duration_ms ?? null,
      record.status ?? 'started',
      record.idempotency_key ?? null,
      now,
      now,
    );
    return this.findById(id)!;
  }

  findById(id: string): SupervisorToolCallRecord | null {
    const row = this.db
      .prepare('SELECT * FROM supervisor_tool_calls WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  findByRun(runId: string): SupervisorToolCallRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM supervisor_tool_calls
      WHERE run_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.map(row)).filter((row): row is SupervisorToolCallRecord => row !== null);
  }

  findLatestByRunToolArgs(runId: string, toolName: string, argsHash: string): SupervisorToolCallRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM supervisor_tool_calls
      WHERE run_id = ? AND tool_name = ? AND args_hash = ? AND status = 'completed'
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(runId, toolName, argsHash) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  update(record: UpdateSupervisorToolCallRecord): SupervisorToolCallRecord | null {
    const fields: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];
    const assign = (field: string, value: unknown): void => {
      fields.push(`${field} = ?`);
      params.push(value);
    };

    if (record.result_summary !== undefined) assign('result_summary', record.result_summary ?? null);
    if (record.duration_ms !== undefined) assign('duration_ms', record.duration_ms ?? null);
    if (record.status !== undefined) assign('status', record.status);

    params.push(record.id);
    this.db.prepare(`
      UPDATE supervisor_tool_calls
      SET ${fields.join(', ')}
      WHERE id = ?
    `).run(...params);
    return this.findById(record.id);
  }

  private map(row: Record<string, unknown> | undefined): SupervisorToolCallRecord | null {
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      run_id: String(row.run_id),
      tool_name: String(row.tool_name),
      args_hash: String(row.args_hash),
      args: parseJsonObject(row.args_json),
      result_summary: row.result_summary as string | null,
      risk: row.risk as SupervisorToolCallRecord['risk'],
      duration_ms: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
      status: row.status as SupervisorToolCallRecord['status'],
      idempotency_key: row.idempotency_key as string | null,
      created_at: new Date(String(row.created_at)),
      updated_at: new Date(String(row.updated_at)),
    };
  }
}
