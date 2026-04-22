import type { Database } from 'bun:sqlite';
import type {
  BotWatchSubscriptionRecord,
  CreateBotWatchSubscriptionRecord,
  DeleteBotWatchSubscriptionRecord,
} from '../types';

export class BotWatchSubscriptionRepository {
  constructor(private db: Database) {}

  upsert(subscription: CreateBotWatchSubscriptionRecord): BotWatchSubscriptionRecord {
    const existing = this.findByKey({
      transport: subscription.transport,
      conversation_id: subscription.conversation_id,
      issue_id: subscription.issue_id,
    });
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO bot_watch_subscriptions (
        transport, conversation_id, issue_id, issue_identifier, user_id, preset, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport, conversation_id, issue_id) DO UPDATE SET
        issue_identifier = excluded.issue_identifier,
        user_id = excluded.user_id,
        preset = excluded.preset,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      subscription.transport,
      subscription.conversation_id,
      subscription.issue_id,
      subscription.issue_identifier ?? null,
      subscription.user_id ?? null,
      subscription.preset ?? 'default',
      existing?.created_at.toISOString() ?? now,
      now,
    );

    return this.findByKey({
      transport: subscription.transport,
      conversation_id: subscription.conversation_id,
      issue_id: subscription.issue_id,
    })!;
  }

  findAll(): BotWatchSubscriptionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_watch_subscriptions ORDER BY updated_at DESC, transport ASC, conversation_id ASC, issue_id ASC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows
      .map((row) => this.mapToSubscription(row))
      .filter((row): row is BotWatchSubscriptionRecord => row !== null);
  }

  findByKey(key: DeleteBotWatchSubscriptionRecord): BotWatchSubscriptionRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM bot_watch_subscriptions
      WHERE transport = ? AND conversation_id = ? AND issue_id = ?
    `);
    return this.mapToSubscription(
      stmt.get(key.transport, key.conversation_id, key.issue_id) as Record<string, unknown> | undefined,
    );
  }

  delete(key: DeleteBotWatchSubscriptionRecord): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM bot_watch_subscriptions
      WHERE transport = ? AND conversation_id = ? AND issue_id = ?
    `);
    const result = stmt.run(key.transport, key.conversation_id, key.issue_id);
    return (result as { changes: number }).changes > 0;
  }

  private mapToSubscription(row: Record<string, unknown> | undefined): BotWatchSubscriptionRecord | null {
    if (!row) {
      return null;
    }

    return {
      transport: row.transport as BotWatchSubscriptionRecord['transport'],
      conversation_id: row.conversation_id as string,
      issue_id: row.issue_id as string,
      issue_identifier: row.issue_identifier as string | null,
      user_id: row.user_id as string | null,
      preset: row.preset as BotWatchSubscriptionRecord['preset'],
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
