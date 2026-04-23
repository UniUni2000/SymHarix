import type { Database } from 'bun:sqlite';
import type {
  CreateDebtSignalRecord,
  DebtSignalRecord,
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

export class DebtSignalRepository {
  constructor(private db: Database) {}

  create(record: CreateDebtSignalRecord): DebtSignalRecord {
    const createdAt = (record.created_at ?? new Date()).toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO debt_signals (
        id, repo_key, signal_code, summary, severity, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.repo_key,
      record.signal_code,
      record.summary,
      record.severity,
      JSON.stringify(record.detail_json ?? null),
      createdAt,
    );

    return this.findById(record.id)!;
  }

  findById(id: string): DebtSignalRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM debt_signals WHERE id = ?`);
    return this.mapRow(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findByRepoKey(repoKey: string): DebtSignalRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM debt_signals
      WHERE repo_key = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(repoKey) as Record<string, unknown>[];
    return rows
      .map((row) => this.mapRow(row))
      .filter((row): row is DebtSignalRecord => row !== null);
  }

  findActiveByRepoKey(repoKey: string): DebtSignalRecord[] {
    return this.findByRepoKey(repoKey);
  }

  private mapRow(row: Record<string, unknown> | undefined): DebtSignalRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      repo_key: row.repo_key as string,
      signal_code: row.signal_code as string,
      summary: row.summary as string,
      severity: row.severity as DebtSignalRecord['severity'],
      detail_json: parseJsonRecord(row.detail_json),
      created_at: new Date(row.created_at as string),
    };
  }
}
