import type { Database } from 'bun:sqlite';
import type {
  CreateDecisionMemoryRecord,
  DecisionMemoryRecord,
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

export class DecisionMemoryRepository {
  constructor(private db: Database) {}

  create(record: CreateDecisionMemoryRecord): DecisionMemoryRecord {
    const now = (record.created_at ?? new Date()).toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO decision_memories (
        id, repo_key, summary, detail_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.repo_key,
      record.summary,
      JSON.stringify(record.detail_json ?? null),
      now,
      now,
    );

    return this.findById(record.id)!;
  }

  findById(id: string): DecisionMemoryRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM decision_memories WHERE id = ?`);
    return this.mapRow(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findByRepoKey(repoKey: string): DecisionMemoryRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM decision_memories
      WHERE repo_key = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(repoKey) as Record<string, unknown>[];
    return rows
      .map((row) => this.mapRow(row))
      .filter((row): row is DecisionMemoryRecord => row !== null);
  }

  private mapRow(row: Record<string, unknown> | undefined): DecisionMemoryRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      repo_key: row.repo_key as string,
      summary: row.summary as string,
      detail_json: parseJsonRecord(row.detail_json),
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
