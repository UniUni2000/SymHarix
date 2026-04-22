import type { Database } from 'bun:sqlite';
import type {
  ShadowHarnessRecord,
  UpsertShadowHarnessRecord,
} from '../types';

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class ShadowHarnessRepository {
  constructor(private db: Database) {}

  findByRepoKey(repoKey: string): ShadowHarnessRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM shadow_harnesses WHERE repo_key = ?`);
    return this.mapRow(stmt.get(repoKey) as Record<string, unknown> | undefined);
  }

  upsert(record: UpsertShadowHarnessRecord): ShadowHarnessRecord {
    const now = new Date().toISOString();
    const existing = this.findByRepoKey(record.repo_key);
    const stmt = this.db.prepare(`
      INSERT INTO shadow_harnesses (
        repo_key, source, config_json, inference_details_json, successful_runs,
        failed_runs, adoption_suggested_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_key) DO UPDATE SET
        source = excluded.source,
        config_json = excluded.config_json,
        inference_details_json = excluded.inference_details_json,
        successful_runs = excluded.successful_runs,
        failed_runs = excluded.failed_runs,
        adoption_suggested_at = excluded.adoption_suggested_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.repo_key,
      record.source,
      JSON.stringify(record.config_json ?? {}),
      JSON.stringify(record.inference_details_json ?? {}),
      record.successful_runs ?? existing?.successful_runs ?? 0,
      record.failed_runs ?? existing?.failed_runs ?? 0,
      record.adoption_suggested_at?.toISOString() ?? existing?.adoption_suggested_at?.toISOString() ?? null,
      existing?.created_at.toISOString() ?? now,
      now,
    );

    return this.findByRepoKey(record.repo_key)!;
  }

  markRunOutcome(repoKey: string, success: boolean): ShadowHarnessRecord | null {
    const existing = this.findByRepoKey(repoKey);
    if (!existing) {
      return null;
    }

    return this.upsert({
      repo_key: repoKey,
      source: existing.source,
      config_json: existing.config_json,
      inference_details_json: existing.inference_details_json,
      successful_runs: existing.successful_runs + (success ? 1 : 0),
      failed_runs: existing.failed_runs + (success ? 0 : 1),
      adoption_suggested_at: existing.adoption_suggested_at,
    });
  }

  markAdoptionSuggested(repoKey: string, when: Date = new Date()): ShadowHarnessRecord | null {
    const existing = this.findByRepoKey(repoKey);
    if (!existing) {
      return null;
    }

    return this.upsert({
      repo_key: repoKey,
      source: existing.source,
      config_json: existing.config_json,
      inference_details_json: existing.inference_details_json,
      successful_runs: existing.successful_runs,
      failed_runs: existing.failed_runs,
      adoption_suggested_at: when,
    });
  }

  private mapRow(row: Record<string, unknown> | undefined): ShadowHarnessRecord | null {
    if (!row) {
      return null;
    }

    return {
      repo_key: row.repo_key as string,
      source: row.source as ShadowHarnessRecord['source'],
      config_json: parseJsonRecord(row.config_json) as ShadowHarnessRecord['config_json'],
      inference_details_json: parseJsonRecord(row.inference_details_json),
      successful_runs: Number(row.successful_runs ?? 0),
      failed_runs: Number(row.failed_runs ?? 0),
      adoption_suggested_at: row.adoption_suggested_at ? new Date(row.adoption_suggested_at as string) : null,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
