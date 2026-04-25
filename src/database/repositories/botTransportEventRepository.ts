import type { Database } from 'bun:sqlite';
import type {
  BotTransportEventRecord,
  CreateBotTransportEventRecord,
} from '../types';

export class BotTransportEventRepository {
  constructor(private readonly db: Database) {}

  create(record: CreateBotTransportEventRecord): BotTransportEventRecord {
    const stmt = this.db.prepare(`
      INSERT INTO bot_transport_events (
        transport, conversation_id, issue_id, root_issue_id, source, message_id,
        action, result, material_key, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const createdAt = new Date().toISOString();
    const result = stmt.run(
      record.transport,
      record.conversation_id,
      record.issue_id ?? null,
      record.root_issue_id ?? null,
      record.source,
      record.message_id ?? null,
      record.action,
      record.result,
      record.material_key ?? null,
      record.error_message ?? null,
      createdAt,
    ) as { lastInsertRowid: number };

    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): BotTransportEventRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_transport_events WHERE id = ?
    `);
    return this.mapRow(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findByRootIssue(key: {
    transport: BotTransportEventRecord['transport'];
    conversation_id: string;
    root_issue_id: string;
  }): BotTransportEventRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_transport_events
      WHERE transport = ? AND conversation_id = ? AND root_issue_id = ?
      ORDER BY created_at DESC, id DESC
    `);
    const rows = stmt.all(
      key.transport,
      key.conversation_id,
      key.root_issue_id,
    ) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is BotTransportEventRecord => row !== null);
  }

  findAll(): BotTransportEventRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_transport_events ORDER BY created_at DESC, id DESC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is BotTransportEventRecord => row !== null);
  }

  private mapRow(row: Record<string, unknown> | undefined): BotTransportEventRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      transport: row.transport as BotTransportEventRecord['transport'],
      conversation_id: row.conversation_id as string,
      issue_id: row.issue_id as string | null,
      root_issue_id: row.root_issue_id as string | null,
      source: row.source as BotTransportEventRecord['source'],
      message_id: row.message_id as string | null,
      action: row.action as BotTransportEventRecord['action'],
      result: row.result as BotTransportEventRecord['result'],
      material_key: row.material_key as string | null,
      error_message: row.error_message as string | null,
      created_at: new Date(row.created_at as string),
    };
  }
}
