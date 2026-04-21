/**
 * Review Event Repository - CRUD for structured review events
 */

import type { Database } from 'bun:sqlite';
import type { CreateReviewEvent, ReviewEvent } from '../types';

export class ReviewEventRepository {
  constructor(private db: Database) {}

  create(event: CreateReviewEvent): ReviewEvent {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO review_events (
        id, work_item_id, pr_number, review_round, decision,
        summary_md, requested_changes_md, merge_block_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.id,
      event.work_item_id,
      event.pr_number,
      event.review_round,
      event.decision,
      event.summary_md,
      event.requested_changes_md ?? null,
      event.merge_block_reason ?? null,
      now
    );

    return this.findById(event.id)!;
  }

  findById(id: string): ReviewEvent | null {
    const stmt = this.db.prepare(`SELECT * FROM review_events WHERE id = ?`);
    return this.mapToReviewEvent(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findByWorkItemId(workItemId: string): ReviewEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM review_events WHERE work_item_id = ? ORDER BY review_round ASC, created_at ASC
    `);
    const rows = stmt.all(workItemId) as Record<string, unknown>[];
    return rows.map(row => this.mapToReviewEvent(row)).filter((item): item is ReviewEvent => item !== null);
  }

  findLatestByWorkItemId(workItemId: string): ReviewEvent | null {
    const stmt = this.db.prepare(`
      SELECT * FROM review_events
      WHERE work_item_id = ?
      ORDER BY review_round DESC, created_at DESC
      LIMIT 1
    `);
    return this.mapToReviewEvent(stmt.get(workItemId) as Record<string, unknown> | undefined);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM review_events WHERE id = ?`);
    const result = stmt.run(id);
    return (result as { changes: number }).changes > 0;
  }

  private mapToReviewEvent(row: Record<string, unknown> | undefined): ReviewEvent | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      work_item_id: row.work_item_id as string,
      pr_number: row.pr_number as number,
      review_round: row.review_round as number,
      decision: row.decision as ReviewEvent['decision'],
      summary_md: row.summary_md as string,
      requested_changes_md: row.requested_changes_md as string | null,
      merge_block_reason: row.merge_block_reason as string | null,
      created_at: new Date(row.created_at as string),
    };
  }
}
