import type { Database } from 'bun:sqlite';
import type {
  BotPendingActionRecord,
  CreateBotPendingActionRecord,
  DeleteBotPendingActionRecord,
} from '../types';

export class BotPendingActionRepository {
  constructor(private db: Database) {}

  upsert(action: CreateBotPendingActionRecord): BotPendingActionRecord {
    const existing = this.findByConversation(action);
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO bot_pending_actions (
        transport, conversation_id, user_id, intent_kind, normalized_payload_json,
        summary_message, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport, conversation_id) DO UPDATE SET
        user_id = excluded.user_id,
        intent_kind = excluded.intent_kind,
        normalized_payload_json = excluded.normalized_payload_json,
        summary_message = excluded.summary_message,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      action.transport,
      action.conversation_id,
      action.user_id ?? null,
      action.intent_kind,
      JSON.stringify(action.normalized_payload),
      action.summary_message,
      action.expires_at.toISOString(),
      existing?.created_at.toISOString() ?? now,
      now,
    );

    return this.findByConversation(action)!;
  }

  findByConversation(key: DeleteBotPendingActionRecord): BotPendingActionRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_pending_actions
      WHERE transport = ? AND conversation_id = ?
    `);
    return this.mapRow(
      stmt.get(key.transport, key.conversation_id) as Record<string, unknown> | undefined,
    );
  }

  delete(key: DeleteBotPendingActionRecord): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM bot_pending_actions
      WHERE transport = ? AND conversation_id = ?
    `);
    const result = stmt.run(key.transport, key.conversation_id);
    return (result as { changes: number }).changes > 0;
  }

  deleteExpired(now: Date = new Date()): number {
    const stmt = this.db.prepare(`
      DELETE FROM bot_pending_actions
      WHERE expires_at <= ?
    `);
    const result = stmt.run(now.toISOString());
    return (result as { changes: number }).changes;
  }

  private mapRow(row: Record<string, unknown> | undefined): BotPendingActionRecord | null {
    if (!row) {
      return null;
    }

    let normalizedPayload: Record<string, unknown> = {};
    try {
      normalizedPayload = JSON.parse(String(row.normalized_payload_json || '{}')) as Record<string, unknown>;
    } catch {
      normalizedPayload = {};
    }

    return {
      transport: row.transport as BotPendingActionRecord['transport'],
      conversation_id: row.conversation_id as string,
      user_id: row.user_id as string | null,
      intent_kind: row.intent_kind as BotPendingActionRecord['intent_kind'],
      normalized_payload: normalizedPayload,
      summary_message: row.summary_message as string,
      expires_at: new Date(row.expires_at as string),
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
