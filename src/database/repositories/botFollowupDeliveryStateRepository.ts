import type { Database } from 'bun:sqlite';
import type {
  BotFollowupDeliveryStateRecord,
  CreateBotFollowupDeliveryStateRecord,
  DeleteBotFollowupDeliveryStateRecord,
} from '../types';

export class BotFollowupDeliveryStateRepository {
  constructor(private readonly db: Database) {}

  upsert(record: CreateBotFollowupDeliveryStateRecord): BotFollowupDeliveryStateRecord {
    const existing = this.findByKey({
      transport: record.transport,
      conversation_id: record.conversation_id,
      root_issue_id: record.root_issue_id,
      delivery_kind: record.delivery_kind,
    });
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO bot_followup_delivery_states (
        transport, conversation_id, root_issue_id, root_issue_identifier,
        delivery_kind, last_material_key, last_notification_class, last_message_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport, conversation_id, root_issue_id, delivery_kind) DO UPDATE SET
        root_issue_identifier = excluded.root_issue_identifier,
        last_material_key = excluded.last_material_key,
        last_notification_class = excluded.last_notification_class,
        last_message_id = excluded.last_message_id,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.transport,
      record.conversation_id,
      record.root_issue_id,
      record.root_issue_identifier ?? null,
      record.delivery_kind,
      record.last_material_key ?? null,
      record.last_notification_class ?? null,
      record.last_message_id ?? null,
      existing?.created_at.toISOString() ?? now,
      now,
    );

    return this.findByKey({
      transport: record.transport,
      conversation_id: record.conversation_id,
      root_issue_id: record.root_issue_id,
      delivery_kind: record.delivery_kind,
    })!;
  }

  findByKey(key: DeleteBotFollowupDeliveryStateRecord): BotFollowupDeliveryStateRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_followup_delivery_states
      WHERE transport = ? AND conversation_id = ? AND root_issue_id = ? AND delivery_kind = ?
    `);
    return this.mapRow(
      stmt.get(
        key.transport,
        key.conversation_id,
        key.root_issue_id,
        key.delivery_kind,
      ) as Record<string, unknown> | undefined,
    );
  }

  findByConversation(key: {
    transport: DeleteBotFollowupDeliveryStateRecord['transport'];
    conversation_id: string;
  }): BotFollowupDeliveryStateRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_followup_delivery_states
      WHERE transport = ? AND conversation_id = ?
      ORDER BY updated_at DESC, root_issue_id ASC, delivery_kind ASC
    `);
    const rows = stmt.all(key.transport, key.conversation_id) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is BotFollowupDeliveryStateRecord => row !== null);
  }

  findAll(): BotFollowupDeliveryStateRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_followup_delivery_states
      ORDER BY updated_at DESC, transport ASC, conversation_id ASC, root_issue_id ASC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is BotFollowupDeliveryStateRecord => row !== null);
  }

  delete(key: DeleteBotFollowupDeliveryStateRecord): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM bot_followup_delivery_states
      WHERE transport = ? AND conversation_id = ? AND root_issue_id = ? AND delivery_kind = ?
    `);
    const result = stmt.run(
      key.transport,
      key.conversation_id,
      key.root_issue_id,
      key.delivery_kind,
    );
    return (result as { changes: number }).changes > 0;
  }

  private mapRow(row: Record<string, unknown> | undefined): BotFollowupDeliveryStateRecord | null {
    if (!row) {
      return null;
    }

    return {
      transport: row.transport as BotFollowupDeliveryStateRecord['transport'],
      conversation_id: row.conversation_id as string,
      root_issue_id: row.root_issue_id as string,
      root_issue_identifier: row.root_issue_identifier as string | null,
      delivery_kind: row.delivery_kind as BotFollowupDeliveryStateRecord['delivery_kind'],
      last_material_key: row.last_material_key as string | null,
      last_notification_class: row.last_notification_class as BotFollowupDeliveryStateRecord['last_notification_class'],
      last_message_id: row.last_message_id as string | null,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
