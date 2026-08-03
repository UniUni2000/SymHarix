import type { Database } from 'bun:sqlite';
import type {
  CreateSupervisorPlanVersionRecord,
  SupervisorPlanCard,
  SupervisorPlanVersionRecord,
} from '../types';

function parsePlanCard(value: unknown): SupervisorPlanCard | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value) as SupervisorPlanCard;
  } catch {
    return null;
  }
}

export class SupervisorPlanVersionRepository {
  constructor(private readonly db: Database) {}

  create(record: CreateSupervisorPlanVersionRecord): SupervisorPlanVersionRecord {
    const id = record.id ?? crypto.randomUUID();
    const createdAt = (record.created_at ?? new Date()).toISOString();
    this.db.prepare(`
      INSERT INTO supervisor_plan_versions (
        id, session_id, plan_version, plan_card_json, change_kind,
        change_summary, actor_id, actor_channel, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, plan_version) DO NOTHING
    `).run(
      id,
      record.session_id,
      record.plan_version,
      JSON.stringify(record.plan_card),
      record.change_kind,
      record.change_summary ?? null,
      record.actor_id ?? null,
      record.actor_channel,
      createdAt,
    );
    return this.findBySessionVersion(record.session_id, record.plan_version)!;
  }

  findBySessionVersion(sessionId: string, planVersion: number): SupervisorPlanVersionRecord | null {
    return this.mapRow(this.db.prepare(`
      SELECT * FROM supervisor_plan_versions
      WHERE session_id = ? AND plan_version = ?
    `).get(sessionId, planVersion) as Record<string, unknown> | undefined);
  }

  listBySession(sessionId: string): SupervisorPlanVersionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM supervisor_plan_versions
      WHERE session_id = ?
      ORDER BY plan_version DESC, created_at DESC
    `).all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is SupervisorPlanVersionRecord => Boolean(row));
  }

  private mapRow(row: Record<string, unknown> | undefined): SupervisorPlanVersionRecord | null {
    if (!row) {
      return null;
    }
    const planCard = parsePlanCard(row.plan_card_json);
    if (!planCard) {
      return null;
    }
    return {
      id: String(row.id),
      session_id: String(row.session_id),
      plan_version: Number(row.plan_version),
      plan_card: planCard,
      change_kind: row.change_kind as SupervisorPlanVersionRecord['change_kind'],
      change_summary: row.change_summary as string | null,
      actor_id: row.actor_id as string | null,
      actor_channel: String(row.actor_channel),
      created_at: new Date(String(row.created_at)),
    };
  }
}
