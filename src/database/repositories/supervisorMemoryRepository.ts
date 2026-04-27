import type { Database } from 'bun:sqlite';
import type {
  SupervisorMemoryRecord,
  UpsertSupervisorMemoryRecord,
} from '../types';

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class SupervisorMemoryRepository {
  constructor(private readonly db: Database) {}

  upsert(record: UpsertSupervisorMemoryRecord): SupervisorMemoryRecord {
    const now = new Date();
    const createdAt = (record.created_at ?? now).toISOString();
    const updatedAt = (record.updated_at ?? now).toISOString();
    const id = `${record.repo_ref}:${record.memory_kind}:${record.subject_key}`;
    const stmt = this.db.prepare(`
      INSERT INTO supervisor_memories (
        id, repo_ref, memory_kind, subject_key, summary, evidence_json, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_ref, memory_kind, subject_key) DO UPDATE SET
        summary = excluded.summary,
        evidence_json = excluded.evidence_json,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      id,
      record.repo_ref,
      record.memory_kind,
      record.subject_key,
      record.summary,
      record.evidence ? JSON.stringify(record.evidence) : null,
      record.confidence ?? 0.5,
      createdAt,
      updatedAt,
    );
    return this.find(record.repo_ref, record.memory_kind, record.subject_key)!;
  }

  find(
    repoRef: string,
    memoryKind: SupervisorMemoryRecord['memory_kind'],
    subjectKey: string,
  ): SupervisorMemoryRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM supervisor_memories
      WHERE repo_ref = ? AND memory_kind = ? AND subject_key = ?
      LIMIT 1
    `);
    return this.mapRow(stmt.get(repoRef, memoryKind, subjectKey) as Record<string, unknown> | undefined);
  }

  listRelevant(repoRef: string, limit = 8): SupervisorMemoryRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM supervisor_memories
      WHERE repo_ref = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(repoRef, Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is SupervisorMemoryRecord => row !== null);
  }

  searchRelevant(params: {
    repo_ref: string;
    query: string;
    limit?: number;
  }): SupervisorMemoryRecord[] {
    const candidates = this.listRelevant(params.repo_ref, 50);
    const terms = params.query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return candidates.slice(0, Math.max(1, params.limit ?? 8));
    }

    return candidates
      .map((memory) => {
        const haystack = [
          memory.memory_kind,
          memory.subject_key,
          memory.summary,
          JSON.stringify(memory.evidence ?? {}),
        ].join(' ').toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { memory, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.memory.updated_at.getTime() - left.memory.updated_at.getTime();
      })
      .slice(0, Math.max(1, params.limit ?? 8))
      .map((item) => item.memory);
  }

  private mapRow(row: Record<string, unknown> | undefined): SupervisorMemoryRecord | null {
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      repo_ref: String(row.repo_ref),
      memory_kind: row.memory_kind as SupervisorMemoryRecord['memory_kind'],
      subject_key: String(row.subject_key),
      summary: String(row.summary),
      evidence: parseJsonObject(row.evidence_json),
      confidence: Number(row.confidence ?? 0.5),
      created_at: new Date(String(row.created_at)),
      updated_at: new Date(String(row.updated_at)),
    };
  }
}
