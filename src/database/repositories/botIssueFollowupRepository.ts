import type { Database } from 'bun:sqlite';
import type {
  BotIssueFollowupRecord,
  CreateBotIssueFollowupRecord,
  DeleteBotIssueFollowupRecord,
} from '../types';

export class BotIssueFollowupRepository {
  constructor(private db: Database) {}

  upsert(record: CreateBotIssueFollowupRecord): BotIssueFollowupRecord {
    const role = record.role ?? 'origin';
    const existing = this.findByKey({
      transport: record.transport,
      conversation_id: record.conversation_id,
      issue_id: record.issue_id,
      role,
    });
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO bot_issue_followups (
        transport, conversation_id, issue_id, issue_identifier, user_id, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport, conversation_id, issue_id, role) DO UPDATE SET
        issue_identifier = excluded.issue_identifier,
        user_id = excluded.user_id,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.transport,
      record.conversation_id,
      record.issue_id,
      record.issue_identifier ?? null,
      record.user_id ?? null,
      role,
      existing?.created_at.toISOString() ?? now,
      now,
    );

    return this.findByKey({
      transport: record.transport,
      conversation_id: record.conversation_id,
      issue_id: record.issue_id,
      role,
    })!;
  }

  findByKey(key: DeleteBotIssueFollowupRecord): BotIssueFollowupRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_issue_followups
      WHERE transport = ? AND conversation_id = ? AND issue_id = ? AND role = ?
    `);
    return this.mapRow(
      stmt.get(
        key.transport,
        key.conversation_id,
        key.issue_id,
        key.role ?? 'origin',
      ) as Record<string, unknown> | undefined,
    );
  }

  findByIssueId(issueId: string): BotIssueFollowupRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_issue_followups
      WHERE issue_id = ?
      ORDER BY updated_at DESC, conversation_id ASC
    `);
    const rows = stmt.all(issueId) as Record<string, unknown>[];
    return rows
      .map((row) => this.mapRow(row))
      .filter((row): row is BotIssueFollowupRecord => row !== null);
  }

  findByConversation(key: {
    transport: DeleteBotIssueFollowupRecord['transport'];
    conversation_id: string;
  }): BotIssueFollowupRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_issue_followups
      WHERE transport = ? AND conversation_id = ?
      ORDER BY updated_at DESC, issue_id ASC
    `);
    const rows = stmt.all(key.transport, key.conversation_id) as Record<string, unknown>[];
    return rows
      .map((row) => this.mapRow(row))
      .filter((row): row is BotIssueFollowupRecord => row !== null);
  }

  findAll(): BotIssueFollowupRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_issue_followups
      ORDER BY updated_at DESC, transport ASC, conversation_id ASC, issue_id ASC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows
      .map((row) => this.mapRow(row))
      .filter((row): row is BotIssueFollowupRecord => row !== null);
  }

  delete(key: DeleteBotIssueFollowupRecord): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM bot_issue_followups
      WHERE transport = ? AND conversation_id = ? AND issue_id = ? AND role = ?
    `);
    const result = stmt.run(
      key.transport,
      key.conversation_id,
      key.issue_id,
      key.role ?? 'origin',
    );
    return (result as { changes: number }).changes > 0;
  }

  private mapRow(row: Record<string, unknown> | undefined): BotIssueFollowupRecord | null {
    if (!row) {
      return null;
    }

    return {
      transport: row.transport as BotIssueFollowupRecord['transport'],
      conversation_id: row.conversation_id as string,
      issue_id: row.issue_id as string,
      issue_identifier: row.issue_identifier as string | null,
      user_id: row.user_id as string | null,
      role: row.role as BotIssueFollowupRecord['role'],
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
