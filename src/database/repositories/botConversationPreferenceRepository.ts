import type { Database } from 'bun:sqlite';
import type {
  BotConversationPreferenceRecord,
  CreateBotConversationPreferenceRecord,
  DeleteBotConversationPreferenceRecord,
} from '../types';

export class BotConversationPreferenceRepository {
  constructor(private db: Database) {}

  upsert(preference: CreateBotConversationPreferenceRecord): BotConversationPreferenceRecord {
    const existing = this.findByConversation(preference);
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO bot_conversation_preferences (
        transport, conversation_id, default_project_slug, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(transport, conversation_id) DO UPDATE SET
        default_project_slug = excluded.default_project_slug,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      preference.transport,
      preference.conversation_id,
      preference.default_project_slug ?? null,
      existing?.created_at.toISOString() ?? now,
      now,
    );

    return this.findByConversation(preference)!;
  }

  findByConversation(
    key: DeleteBotConversationPreferenceRecord,
  ): BotConversationPreferenceRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_conversation_preferences
      WHERE transport = ? AND conversation_id = ?
    `);
    return this.mapRow(
      stmt.get(key.transport, key.conversation_id) as Record<string, unknown> | undefined,
    );
  }

  delete(key: DeleteBotConversationPreferenceRecord): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM bot_conversation_preferences
      WHERE transport = ? AND conversation_id = ?
    `);
    const result = stmt.run(key.transport, key.conversation_id);
    return (result as { changes: number }).changes > 0;
  }

  private mapRow(row: Record<string, unknown> | undefined): BotConversationPreferenceRecord | null {
    if (!row) {
      return null;
    }

    return {
      transport: row.transport as BotConversationPreferenceRecord['transport'],
      conversation_id: row.conversation_id as string,
      default_project_slug: row.default_project_slug as string | null,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
