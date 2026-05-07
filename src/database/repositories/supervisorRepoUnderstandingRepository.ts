import type { Database } from 'bun:sqlite';
import type {
  CreateSupervisorRepoUnderstanding,
  SupervisorRepoUnderstanding,
  SupervisorRepoUnderstandingJson,
} from '../types';

function emptyUnderstanding(): SupervisorRepoUnderstandingJson {
  return {
    project_purpose: '',
    tech_stack: [],
    key_paths: [],
    architecture_notes: [],
    artifact_opportunities: [],
    test_commands: [],
    risks: [],
  };
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseUnderstanding(value: unknown): SupervisorRepoUnderstandingJson {
  if (typeof value !== 'string' || !value.trim()) {
    return emptyUnderstanding();
  }

  try {
    const parsed = JSON.parse(value) as Partial<SupervisorRepoUnderstandingJson>;
    return {
      project_purpose: typeof parsed.project_purpose === 'string' ? parsed.project_purpose : '',
      tech_stack: normalizeStringArray(parsed.tech_stack),
      key_paths: normalizeStringArray(parsed.key_paths),
      architecture_notes: normalizeStringArray(parsed.architecture_notes),
      artifact_opportunities: normalizeStringArray(parsed.artifact_opportunities),
      test_commands: normalizeStringArray(parsed.test_commands),
      risks: normalizeStringArray(parsed.risks),
    };
  } catch {
    return emptyUnderstanding();
  }
}

export class SupervisorRepoUnderstandingRepository {
  constructor(private readonly db: Database) {}

  upsert(input: CreateSupervisorRepoUnderstanding): SupervisorRepoUnderstanding {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO supervisor_repo_understandings (
        id, repo_ref, local_path, commit_sha, status, summary,
        understanding_json, evidence_paths_json, generated_by, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_ref, commit_sha) DO UPDATE SET
        id = excluded.id,
        local_path = excluded.local_path,
        status = excluded.status,
        summary = excluded.summary,
        understanding_json = excluded.understanding_json,
        evidence_paths_json = excluded.evidence_paths_json,
        generated_by = excluded.generated_by,
        error = excluded.error,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      input.id,
      input.repo_ref,
      input.local_path ?? null,
      input.commit_sha,
      input.status,
      input.summary ?? null,
      JSON.stringify(input.understanding_json),
      JSON.stringify(input.evidence_paths_json ?? []),
      input.generated_by,
      input.error ?? null,
      now,
      now,
    );

    return this.findByRepoAndCommit(input.repo_ref, input.commit_sha)!;
  }

  findByRepoAndCommit(repoRef: string, commitSha: string): SupervisorRepoUnderstanding | null {
    const row = this.db
      .prepare('SELECT * FROM supervisor_repo_understandings WHERE repo_ref = ? AND commit_sha = ?')
      .get(repoRef, commitSha) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  findLatestReadyByRepo(repoRef: string): SupervisorRepoUnderstanding | null {
    const row = this.db
      .prepare(`
        SELECT * FROM supervisor_repo_understandings
        WHERE repo_ref = ? AND status = 'ready'
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      `)
      .get(repoRef) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  private map(row: Record<string, unknown> | undefined): SupervisorRepoUnderstanding | null {
    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      repo_ref: String(row.repo_ref),
      local_path: typeof row.local_path === 'string' ? row.local_path : null,
      commit_sha: String(row.commit_sha),
      status: row.status === 'pending' || row.status === 'failed' ? row.status : 'ready',
      summary: typeof row.summary === 'string' ? row.summary : null,
      understanding_json: parseUnderstanding(row.understanding_json),
      evidence_paths_json: parseStringArray(row.evidence_paths_json),
      generated_by: row.generated_by === 'fallback' ? 'fallback' : 'claude_code',
      error: typeof row.error === 'string' ? row.error : null,
      created_at: new Date(String(row.created_at)),
      updated_at: new Date(String(row.updated_at)),
    };
  }
}
