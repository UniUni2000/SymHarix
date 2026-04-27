import type { Database } from 'bun:sqlite';
import type {
  EnqueueSupervisorJobRecord,
  SupervisorJobRecord,
  SupervisorJobStatus,
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

export class SupervisorJobRepository {
  constructor(private readonly db: Database) {}

  enqueue(record: EnqueueSupervisorJobRecord): SupervisorJobRecord {
    const now = new Date().toISOString();
    const runAfter = (record.run_after ?? new Date()).toISOString();
    const id = crypto.randomUUID();
    const existing = this.findByIdempotencyKey(record.idempotency_key);
    if (existing) {
      return existing;
    }

    this.db.prepare(`
      INSERT INTO supervisor_jobs (
        id, session_id, root_issue_id, job_kind, status, idempotency_key, payload_json,
        result_json, attempt_count, run_after, lease_owner, lease_expires_at, last_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, 0, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      id,
      record.session_id,
      record.root_issue_id ?? null,
      record.job_kind,
      record.idempotency_key,
      record.payload ? JSON.stringify(record.payload) : null,
      runAfter,
      now,
      now,
    );

    return this.findById(id)!;
  }

  findById(id: string): SupervisorJobRecord | null {
    return this.mapRow(
      this.db.prepare('SELECT * FROM supervisor_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined,
    );
  }

  findByIdempotencyKey(idempotencyKey: string): SupervisorJobRecord | null {
    return this.mapRow(
      this.db.prepare('SELECT * FROM supervisor_jobs WHERE idempotency_key = ?').get(idempotencyKey) as Record<string, unknown> | undefined,
    );
  }

  listBySession(sessionId: string): SupervisorJobRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM supervisor_jobs
      WHERE session_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is SupervisorJobRecord => row !== null);
  }

  leaseNextReady(params: {
    now: Date;
    leaseOwner: string;
    leaseMs: number;
  }): SupervisorJobRecord | null {
    const nowIso = params.now.toISOString();
    const job = this.mapRow(
      this.db.prepare(`
        SELECT * FROM supervisor_jobs
        WHERE (
          status IN ('queued', 'deferred')
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
          AND run_after <= ?
        ORDER BY run_after ASC, created_at ASC
        LIMIT 1
      `).get(nowIso, nowIso) as Record<string, unknown> | undefined,
    );
    if (!job) {
      return null;
    }

    const leaseExpiresAt = new Date(params.now.getTime() + Math.max(1_000, params.leaseMs)).toISOString();
    this.db.prepare(`
      UPDATE supervisor_jobs
      SET status = 'running',
        lease_owner = ?,
        lease_expires_at = ?,
        attempt_count = attempt_count + 1,
        updated_at = ?
      WHERE id = ?
    `).run(params.leaseOwner, leaseExpiresAt, nowIso, job.id);

    return this.findById(job.id);
  }

  complete(id: string, params: {
    result?: Record<string, unknown> | null;
    now?: Date;
  } = {}): SupervisorJobRecord | null {
    const nowIso = (params.now ?? new Date()).toISOString();
    this.db.prepare(`
      UPDATE supervisor_jobs
      SET status = 'succeeded',
        result_json = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(params.result ? JSON.stringify(params.result) : null, nowIso, id);
    return this.findById(id);
  }

  fail(id: string, params: {
    error: string;
    retryAt?: Date | null;
    now?: Date;
  }): SupervisorJobRecord | null {
    const nowIso = (params.now ?? new Date()).toISOString();
    const status: SupervisorJobStatus = params.retryAt ? 'deferred' : 'failed';
    this.db.prepare(`
      UPDATE supervisor_jobs
      SET status = ?,
        run_after = COALESCE(?, run_after),
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
    `).run(status, params.retryAt?.toISOString() ?? null, params.error, nowIso, id);
    return this.findById(id);
  }

  private mapRow(row: Record<string, unknown> | undefined): SupervisorJobRecord | null {
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      session_id: String(row.session_id),
      root_issue_id: row.root_issue_id as string | null,
      job_kind: row.job_kind as SupervisorJobRecord['job_kind'],
      status: row.status as SupervisorJobRecord['status'],
      idempotency_key: String(row.idempotency_key),
      payload: parseJsonObject(row.payload_json),
      result: parseJsonObject(row.result_json),
      attempt_count: Number(row.attempt_count ?? 0),
      run_after: new Date(String(row.run_after)),
      lease_owner: row.lease_owner as string | null,
      lease_expires_at: row.lease_expires_at ? new Date(String(row.lease_expires_at)) : null,
      last_error: row.last_error as string | null,
      created_at: new Date(String(row.created_at)),
      updated_at: new Date(String(row.updated_at)),
    };
  }
}
