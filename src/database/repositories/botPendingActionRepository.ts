import type { Database } from 'bun:sqlite';
import type {
  BotPendingActionRecord,
  CreateBotPendingActionRecord,
  DeleteBotPendingActionRecord,
} from '../types';

export class BotPendingActionRepository {
  constructor(private db: Database) {}

  private normalizeIssueId(issueId?: string | null): string {
    return issueId?.trim() || '';
  }

  upsert(action: CreateBotPendingActionRecord): BotPendingActionRecord {
    const issueId = this.normalizeIssueId(action.issue_id);
    const existing = this.findByConversationIssue({
      transport: action.transport,
      conversation_id: action.conversation_id,
      issue_id: issueId,
    });
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO bot_pending_actions (
        transport, conversation_id, issue_id, user_id, intent_kind, normalized_payload_json,
        summary_message, expires_at, status, message_id, card_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport, conversation_id, issue_id) DO UPDATE SET
        user_id = excluded.user_id,
        intent_kind = excluded.intent_kind,
        normalized_payload_json = excluded.normalized_payload_json,
        summary_message = excluded.summary_message,
        expires_at = excluded.expires_at,
        status = excluded.status,
        message_id = excluded.message_id,
        card_key = excluded.card_key,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      action.transport,
      action.conversation_id,
      issueId,
      action.user_id ?? null,
      action.intent_kind,
      JSON.stringify(action.normalized_payload),
      action.summary_message,
      action.expires_at.toISOString(),
      action.status ?? 'pending_confirm',
      action.message_id ?? null,
      action.card_key ?? null,
      existing?.created_at.toISOString() ?? now,
      now,
    );

    return this.findByConversationIssue({
      transport: action.transport,
      conversation_id: action.conversation_id,
      issue_id: issueId,
    })!;
  }

  findByConversation(key: DeleteBotPendingActionRecord): BotPendingActionRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_pending_actions
      WHERE transport = ? AND conversation_id = ? AND issue_id = ''
    `);
    return this.mapRow(
      stmt.get(key.transport, key.conversation_id) as Record<string, unknown> | undefined,
    );
  }

  findByConversationIssue(key: DeleteBotPendingActionRecord): BotPendingActionRecord | null {
    const issueId = this.normalizeIssueId(key.issue_id);
    const stmt = this.db.prepare(`
      SELECT * FROM bot_pending_actions
      WHERE transport = ? AND conversation_id = ? AND issue_id = ?
    `);
    return this.mapRow(
      stmt.get(key.transport, key.conversation_id, issueId) as Record<string, unknown> | undefined,
    );
  }

  findOpenByConversation(key: DeleteBotPendingActionRecord): BotPendingActionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_pending_actions
      WHERE transport = ? AND conversation_id = ? AND issue_id <> '' AND status IN ('pending_confirm', 'executing')
      ORDER BY updated_at DESC, issue_id DESC
    `);
    const rows = stmt.all(key.transport, key.conversation_id) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is BotPendingActionRecord => row !== null);
  }

  findLatestByConversation(key: DeleteBotPendingActionRecord): BotPendingActionRecord | null {
    const generic = this.findByConversation(key);
    if (generic) {
      return generic;
    }

    const open = this.findOpenByConversation(key);
    return open.length === 1 ? open[0] ?? null : null;
  }

  findAll(): BotPendingActionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_pending_actions
      ORDER BY updated_at DESC, transport ASC, conversation_id ASC, issue_id ASC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is BotPendingActionRecord => row !== null);
  }

  delete(key: DeleteBotPendingActionRecord): boolean {
    const issueId = this.normalizeIssueId(key.issue_id);
    const stmt = this.db.prepare(`
      DELETE FROM bot_pending_actions
      WHERE transport = ? AND conversation_id = ? AND issue_id = ?
    `);
    const result = stmt.run(key.transport, key.conversation_id, issueId);
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
      issue_id: String(row.issue_id || '') || null,
      user_id: row.user_id as string | null,
      intent_kind: row.intent_kind as BotPendingActionRecord['intent_kind'],
      normalized_payload: normalizedPayload,
      summary_message: row.summary_message as string,
      expires_at: new Date(row.expires_at as string),
      status: (row.status as BotPendingActionRecord['status']) ?? 'pending_confirm',
      message_id: row.message_id as string | null,
      card_key: row.card_key as string | null,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
