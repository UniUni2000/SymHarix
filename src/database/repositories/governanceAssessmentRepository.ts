import type { Database } from 'bun:sqlite';
import type {
  CreateGovernanceAssessmentRecord,
  GovernanceAssessmentRecord,
} from '../types';

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

export class GovernanceAssessmentRepository {
  constructor(private db: Database) {}

  create(record: CreateGovernanceAssessmentRecord): GovernanceAssessmentRecord {
    const createdAt = (record.created_at ?? new Date()).toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO governance_assessments (
        id, work_item_id, issue_id, decision, status, summary,
        constitution_hits_json, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.work_item_id ?? null,
      record.issue_id,
      record.decision,
      record.status,
      record.summary,
      JSON.stringify(record.constitution_hits_json ?? []),
      JSON.stringify(record.detail_json ?? null),
      createdAt,
    );

    return this.findById(record.id)!;
  }

  findById(id: string): GovernanceAssessmentRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM governance_assessments WHERE id = ?`);
    return this.mapRow(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findLatestByWorkItemId(workItemId: string): GovernanceAssessmentRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM governance_assessments
      WHERE work_item_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return this.mapRow(stmt.get(workItemId) as Record<string, unknown> | undefined);
  }

  findByWorkItemId(workItemId: string): GovernanceAssessmentRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM governance_assessments
      WHERE work_item_id = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(workItemId) as Record<string, unknown>[];
    return rows
      .map((row) => this.mapRow(row))
      .filter((row): row is GovernanceAssessmentRecord => row !== null);
  }

  private mapRow(row: Record<string, unknown> | undefined): GovernanceAssessmentRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      work_item_id: row.work_item_id as string | null,
      issue_id: row.issue_id as string,
      decision: row.decision as GovernanceAssessmentRecord['decision'],
      status: row.status as GovernanceAssessmentRecord['status'],
      summary: row.summary as string,
      constitution_hits_json: parseJsonArray(row.constitution_hits_json),
      detail_json: parseJsonRecord(row.detail_json),
      created_at: new Date(row.created_at as string),
    };
  }
}
