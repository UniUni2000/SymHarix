import type { Database } from 'bun:sqlite';
import type {
  CreateSupervisorRunRecord,
  SupervisorRunConversationKey,
  SupervisorRunRecord,
  SupervisorRunState,
  UpdateSupervisorRunRecord,
} from '../types';

const ACTIVE_RUN_STATES: SupervisorRunState[] = ['running', 'waiting_confirmation'];

export class SupervisorRunRepository {
  constructor(private readonly db: Database) {}

  create(record: CreateSupervisorRunRecord): SupervisorRunRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO supervisor_runs (
        id, transport, conversation_id, user_id, state, repo_ref, active_issue_id,
        user_message, final_message, step_count, last_progress_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.transport,
      record.conversation_id,
      record.user_id ?? null,
      record.state ?? 'running',
      record.repo_ref ?? null,
      record.active_issue_id ?? null,
      record.user_message,
      record.final_message ?? null,
      record.step_count ?? 0,
      record.last_progress_at?.toISOString() ?? null,
      now,
      now,
    );

    return this.findById(record.id)!;
  }

  findById(id: string): SupervisorRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM supervisor_runs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  findLatestByConversation(key: SupervisorRunConversationKey): SupervisorRunRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM supervisor_runs
      WHERE transport = ? AND conversation_id = ?
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
      LIMIT 1
    `).get(key.transport, key.conversation_id) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  listByConversation(key: SupervisorRunConversationKey): SupervisorRunRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM supervisor_runs
      WHERE transport = ? AND conversation_id = ?
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
    `).all(key.transport, key.conversation_id) as Record<string, unknown>[];
    return rows.map((row) => this.map(row)).filter((row): row is SupervisorRunRecord => row !== null);
  }

  findActiveByConversation(key: SupervisorRunConversationKey): SupervisorRunRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM supervisor_runs
      WHERE transport = ? AND conversation_id = ? AND state IN (${ACTIVE_RUN_STATES.map(() => '?').join(', ')})
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
      LIMIT 1
    `).get(key.transport, key.conversation_id, ...ACTIVE_RUN_STATES) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  listActive(): SupervisorRunRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM supervisor_runs
      WHERE state IN (${ACTIVE_RUN_STATES.map(() => '?').join(', ')})
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
    `).all(...ACTIVE_RUN_STATES) as Record<string, unknown>[];
    return rows.map((row) => this.map(row)).filter((row): row is SupervisorRunRecord => row !== null);
  }

  update(record: UpdateSupervisorRunRecord): SupervisorRunRecord | null {
    const fields: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];
    const assign = (field: string, value: unknown): void => {
      fields.push(`${field} = ?`);
      params.push(value);
    };

    if (record.user_id !== undefined) assign('user_id', record.user_id ?? null);
    if (record.state !== undefined) assign('state', record.state);
    if (record.repo_ref !== undefined) assign('repo_ref', record.repo_ref ?? null);
    if (record.active_issue_id !== undefined) assign('active_issue_id', record.active_issue_id ?? null);
    if (record.user_message !== undefined) assign('user_message', record.user_message);
    if (record.final_message !== undefined) assign('final_message', record.final_message ?? null);
    if (record.step_count !== undefined) assign('step_count', record.step_count);
    if (record.last_progress_at !== undefined) {
      assign('last_progress_at', record.last_progress_at?.toISOString() ?? null);
    }

    params.push(record.id);
    this.db.prepare(`
      UPDATE supervisor_runs
      SET ${fields.join(', ')}
      WHERE id = ?
    `).run(...params);
    return this.findById(record.id);
  }

  recoverStaleRunning(now: Date = new Date()): number {
    const timestamp = now.toISOString();
    const result = this.db.prepare(`
      UPDATE supervisor_runs
      SET state = 'failed',
        final_message = COALESCE(final_message, 'Supervisor run was recovered after restart before it completed.'),
        updated_at = ?
      WHERE state = 'running'
    `).run(timestamp);
    return (result as { changes: number }).changes;
  }

  private map(row: Record<string, unknown> | undefined): SupervisorRunRecord | null {
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      transport: row.transport as SupervisorRunRecord['transport'],
      conversation_id: String(row.conversation_id),
      user_id: row.user_id as string | null,
      state: row.state as SupervisorRunRecord['state'],
      repo_ref: row.repo_ref as string | null,
      active_issue_id: row.active_issue_id as string | null,
      user_message: String(row.user_message ?? ''),
      final_message: row.final_message as string | null,
      step_count: Number(row.step_count ?? 0),
      last_progress_at: row.last_progress_at ? new Date(String(row.last_progress_at)) : null,
      created_at: new Date(String(row.created_at)),
      updated_at: new Date(String(row.updated_at)),
    };
  }
}
