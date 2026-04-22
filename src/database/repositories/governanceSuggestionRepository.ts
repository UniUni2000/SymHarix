import type { Database } from 'bun:sqlite';
import type {
  CreateGovernanceSuggestionRecord,
  GovernanceSuggestionRecord,
} from '../types';

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class GovernanceSuggestionRepository {
  constructor(private db: Database) {}

  create(record: CreateGovernanceSuggestionRecord): GovernanceSuggestionRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO governance_suggestions (
        id, work_item_id, issue_id, suggestion_type, status, title, summary,
        detail_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.work_item_id ?? null,
      record.issue_id,
      record.suggestion_type,
      record.status ?? 'pending',
      record.title,
      record.summary,
      JSON.stringify(record.detail_json ?? null),
      now,
      now,
    );

    return this.findById(record.id)!;
  }

  findById(id: string): GovernanceSuggestionRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM governance_suggestions WHERE id = ?`);
    return this.mapRow(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findPendingByIssueId(issueId: string): GovernanceSuggestionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM governance_suggestions
      WHERE issue_id = ? AND status = 'pending'
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(issueId) as Record<string, unknown>[];
    return rows
      .map((row) => this.mapRow(row))
      .filter((row): row is GovernanceSuggestionRecord => row !== null);
  }

  findByIssueId(issueId: string): GovernanceSuggestionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM governance_suggestions
      WHERE issue_id = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(issueId) as Record<string, unknown>[];
    return rows
      .map((row) => this.mapRow(row))
      .filter((row): row is GovernanceSuggestionRecord => row !== null);
  }

  updateStatus(id: string, status: GovernanceSuggestionRecord['status']): GovernanceSuggestionRecord | null {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE governance_suggestions
      SET status = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, now, id);
    return this.findById(id);
  }

  private mapRow(row: Record<string, unknown> | undefined): GovernanceSuggestionRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      work_item_id: row.work_item_id as string | null,
      issue_id: row.issue_id as string,
      suggestion_type: row.suggestion_type as GovernanceSuggestionRecord['suggestion_type'],
      status: row.status as GovernanceSuggestionRecord['status'],
      title: row.title as string,
      summary: row.summary as string,
      detail_json: parseJsonRecord(row.detail_json),
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
