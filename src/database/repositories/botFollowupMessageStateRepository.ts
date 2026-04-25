import type { Database } from 'bun:sqlite';
import type {
  BotFollowupMessageStateRecord,
  CreateBotFollowupMessageStateRecord,
  DeleteBotFollowupMessageStateRecord,
  UpdateBotFollowupMessageStateRecord,
} from '../types';

export class BotFollowupMessageStateRepository {
  constructor(private readonly db: Database) {}

  upsert(record: CreateBotFollowupMessageStateRecord): BotFollowupMessageStateRecord {
    const existing = this.findByConversationIssue({
      transport: record.transport,
      conversation_id: record.conversation_id,
      issue_id: record.issue_id,
    });
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO bot_followup_message_states (
        transport, conversation_id, issue_id, issue_identifier, message_id,
        card_kind, card_key, card_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport, conversation_id, issue_id) DO UPDATE SET
        issue_identifier = excluded.issue_identifier,
        message_id = excluded.message_id,
        card_kind = excluded.card_kind,
        card_key = excluded.card_key,
        card_state = excluded.card_state,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.transport,
      record.conversation_id,
      record.issue_id,
      record.issue_identifier ?? null,
      record.message_id,
      record.card_kind,
      record.card_key,
      record.card_state ?? 'open',
      existing?.created_at.toISOString() ?? now,
      now,
    );

    return this.findByConversationIssue({
      transport: record.transport,
      conversation_id: record.conversation_id,
      issue_id: record.issue_id,
    })!;
  }

  findByConversationIssue(key: DeleteBotFollowupMessageStateRecord): BotFollowupMessageStateRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_followup_message_states
      WHERE transport = ? AND conversation_id = ? AND issue_id = ?
    `);
    return this.mapRow(
      stmt.get(key.transport, key.conversation_id, key.issue_id) as Record<string, unknown> | undefined,
    );
  }

  findOpenByConversation(key: {
    transport: DeleteBotFollowupMessageStateRecord['transport'];
    conversation_id: string;
  }): BotFollowupMessageStateRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_followup_message_states
      WHERE transport = ? AND conversation_id = ? AND card_state IN ('open', 'confirming', 'executing', 'waiting_on_child', 'failed')
      ORDER BY updated_at DESC, issue_id ASC
    `);
    const rows = stmt.all(key.transport, key.conversation_id) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is BotFollowupMessageStateRecord => row !== null);
  }

  findByConversationMessageId(key: {
    transport: DeleteBotFollowupMessageStateRecord['transport'];
    conversation_id: string;
    message_id: string;
  }): BotFollowupMessageStateRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_followup_message_states
      WHERE transport = ? AND conversation_id = ? AND message_id = ?
    `);
    return this.mapRow(
      stmt.get(key.transport, key.conversation_id, key.message_id) as Record<string, unknown> | undefined,
    );
  }

  findAll(): BotFollowupMessageStateRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_followup_message_states
      ORDER BY updated_at DESC, transport ASC, conversation_id ASC, issue_id ASC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is BotFollowupMessageStateRecord => row !== null);
  }

  updateState(record: UpdateBotFollowupMessageStateRecord): BotFollowupMessageStateRecord | null {
    const fields: string[] = ['updated_at = ?'];
    const params: Array<string | null> = [new Date().toISOString()];
    const assign = (field: string, value: string | null): void => {
      fields.push(`${field} = ?`);
      params.push(value);
    };

    if (record.issue_identifier !== undefined) assign('issue_identifier', record.issue_identifier ?? null);
    if (record.message_id !== undefined) assign('message_id', record.message_id);
    if (record.card_kind !== undefined) assign('card_kind', record.card_kind);
    if (record.card_key !== undefined) assign('card_key', record.card_key);
    if (record.card_state !== undefined) assign('card_state', record.card_state);

    params.push(record.transport, record.conversation_id, record.issue_id);

    const stmt = this.db.prepare(`
      UPDATE bot_followup_message_states
      SET ${fields.join(', ')}
      WHERE transport = ? AND conversation_id = ? AND issue_id = ?
    `);
    stmt.run(...params);
    return this.findByConversationIssue(record);
  }

  delete(key: DeleteBotFollowupMessageStateRecord): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM bot_followup_message_states
      WHERE transport = ? AND conversation_id = ? AND issue_id = ?
    `);
    const result = stmt.run(key.transport, key.conversation_id, key.issue_id);
    return (result as { changes: number }).changes > 0;
  }

  private mapRow(row: Record<string, unknown> | undefined): BotFollowupMessageStateRecord | null {
    if (!row) {
      return null;
    }

    return {
      transport: row.transport as BotFollowupMessageStateRecord['transport'],
      conversation_id: row.conversation_id as string,
      issue_id: row.issue_id as string,
      issue_identifier: row.issue_identifier as string | null,
      message_id: row.message_id as string,
      card_kind: row.card_kind as BotFollowupMessageStateRecord['card_kind'],
      card_key: row.card_key as string,
      card_state: row.card_state as BotFollowupMessageStateRecord['card_state'],
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
