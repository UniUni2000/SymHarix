import type { Database } from 'bun:sqlite';
import type {
  CreateSupervisorPendingActionRecord,
  SupervisorPendingActionRecord,
  SupervisorRunConversationKey,
  UpdateSupervisorPendingActionRecord,
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

export class SupervisorPendingActionRepository {
  constructor(private readonly db: Database) {}

  create(record: CreateSupervisorPendingActionRecord): SupervisorPendingActionRecord {
    const id = record.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO supervisor_pending_actions (
        id, run_id, transport, conversation_id, user_id, tool_name, tool_args_json,
        policy_decision_json, reason, summary_message, telegram_message_id, status,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.run_id,
      record.transport,
      record.conversation_id,
      record.user_id ?? null,
      record.tool_name,
      JSON.stringify(record.tool_args),
      JSON.stringify(record.policy_decision),
      record.reason,
      record.summary_message,
      record.telegram_message_id ?? null,
      record.status ?? 'pending_confirm',
      record.expires_at.toISOString(),
      now,
      now,
    );
    return this.findById(id)!;
  }

  findById(id: string): SupervisorPendingActionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM supervisor_pending_actions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  findOpenByConversation(key: SupervisorRunConversationKey, now: Date = new Date()): SupervisorPendingActionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM supervisor_pending_actions
      WHERE transport = ? AND conversation_id = ? AND status = 'pending_confirm' AND expires_at > ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(key.transport, key.conversation_id, now.toISOString()) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  findByRun(runId: string): SupervisorPendingActionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM supervisor_pending_actions
      WHERE run_id = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
    `).all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.map(row)).filter((row): row is SupervisorPendingActionRecord => row !== null);
  }

  update(record: UpdateSupervisorPendingActionRecord): SupervisorPendingActionRecord | null {
    const fields: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];
    const assign = (field: string, value: unknown): void => {
      fields.push(`${field} = ?`);
      params.push(value);
    };

    if (record.telegram_message_id !== undefined) {
      assign('telegram_message_id', record.telegram_message_id ?? null);
    }
    if (record.status !== undefined) assign('status', record.status);

    params.push(record.id);
    this.db.prepare(`
      UPDATE supervisor_pending_actions
      SET ${fields.join(', ')}
      WHERE id = ?
    `).run(...params);
    return this.findById(record.id);
  }

  deleteExpired(now: Date = new Date()): number {
    const result = this.db.prepare(`
      UPDATE supervisor_pending_actions
      SET status = 'expired', updated_at = ?
      WHERE status = 'pending_confirm' AND expires_at <= ?
    `).run(now.toISOString(), now.toISOString());
    return (result as { changes: number }).changes;
  }

  private map(row: Record<string, unknown> | undefined): SupervisorPendingActionRecord | null {
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      run_id: String(row.run_id),
      transport: row.transport as SupervisorPendingActionRecord['transport'],
      conversation_id: String(row.conversation_id),
      user_id: row.user_id as string | null,
      tool_name: String(row.tool_name),
      tool_args: parseJsonObject(row.tool_args_json),
      policy_decision: parseJsonObject(row.policy_decision_json),
      reason: String(row.reason ?? ''),
      summary_message: String(row.summary_message ?? ''),
      telegram_message_id: row.telegram_message_id as string | null,
      status: row.status as SupervisorPendingActionRecord['status'],
      expires_at: new Date(String(row.expires_at)),
      created_at: new Date(String(row.created_at)),
      updated_at: new Date(String(row.updated_at)),
    };
  }
}
