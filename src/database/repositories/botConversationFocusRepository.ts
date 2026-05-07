import type { Database } from 'bun:sqlite';
import type {
  BotConversationFocusRecord,
  CreateBotConversationFocusRecord,
  DeleteBotConversationFocusRecord,
} from '../types';

export class BotConversationFocusRepository {
  constructor(private readonly db: Database) {}

  upsert(record: CreateBotConversationFocusRecord): BotConversationFocusRecord {
    const existing = this.findByConversation(record);
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO bot_conversation_focuses (
        transport, conversation_id, issue_id, issue_identifier, repo_ref,
        supervisor_session_id, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport, conversation_id) DO UPDATE SET
        issue_id = excluded.issue_id,
        issue_identifier = excluded.issue_identifier,
        repo_ref = excluded.repo_ref,
        supervisor_session_id = excluded.supervisor_session_id,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.transport,
      record.conversation_id,
      record.issue_id ?? null,
      record.issue_identifier ?? null,
      record.repo_ref ?? null,
      record.supervisor_session_id ?? null,
      record.source,
      existing?.created_at.toISOString() ?? now,
      now,
    );

    return this.findByConversation(record)!;
  }

  findByConversation(key: DeleteBotConversationFocusRecord): BotConversationFocusRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_conversation_focuses
      WHERE transport = ? AND conversation_id = ?
    `);
    return this.mapRow(
      stmt.get(key.transport, key.conversation_id) as Record<string, unknown> | undefined,
    );
  }

  findAll(): BotConversationFocusRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM bot_conversation_focuses
      ORDER BY updated_at DESC, transport ASC, conversation_id ASC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is BotConversationFocusRecord => row !== null);
  }

  delete(key: DeleteBotConversationFocusRecord): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM bot_conversation_focuses
      WHERE transport = ? AND conversation_id = ?
    `);
    const result = stmt.run(key.transport, key.conversation_id);
    return (result as { changes: number }).changes > 0;
  }

  private mapRow(row: Record<string, unknown> | undefined): BotConversationFocusRecord | null {
    if (!row) {
      return null;
    }
    return {
      transport: row.transport as BotConversationFocusRecord['transport'],
      conversation_id: String(row.conversation_id),
      issue_id: row.issue_id ? String(row.issue_id) : null,
      issue_identifier: row.issue_identifier ? String(row.issue_identifier) : null,
      repo_ref: row.repo_ref ? String(row.repo_ref) : null,
      supervisor_session_id: row.supervisor_session_id ? String(row.supervisor_session_id) : null,
      source: row.source as BotConversationFocusRecord['source'],
      created_at: new Date(String(row.created_at)),
      updated_at: new Date(String(row.updated_at)),
    };
  }
}
