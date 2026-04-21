/**
 * Repo Cache Repository - CRUD for shared per-repo source caches
 */

import type { Database } from 'bun:sqlite';
import type { CreateRepoCache, RepoCache, UpdateRepoCache } from '../types';

export class RepoCacheRepository {
  constructor(private db: Database) {}

  create(cache: CreateRepoCache): RepoCache {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO repo_caches (
        id, github_repo, local_source_path, default_branch,
        last_fetched_at, last_fetch_commit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      cache.id,
      cache.github_repo,
      cache.local_source_path,
      cache.default_branch ?? 'main',
      cache.last_fetched_at?.toISOString() ?? null,
      cache.last_fetch_commit ?? null,
      now,
      now
    );

    return this.findById(cache.id)!;
  }

  upsert(cache: CreateRepoCache): RepoCache {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO repo_caches (
        id, github_repo, local_source_path, default_branch,
        last_fetched_at, last_fetch_commit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        github_repo = excluded.github_repo,
        local_source_path = excluded.local_source_path,
        default_branch = excluded.default_branch,
        last_fetched_at = excluded.last_fetched_at,
        last_fetch_commit = excluded.last_fetch_commit,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      cache.id,
      cache.github_repo,
      cache.local_source_path,
      cache.default_branch ?? 'main',
      cache.last_fetched_at?.toISOString() ?? null,
      cache.last_fetch_commit ?? null,
      now,
      now
    );

    return this.findById(cache.id)!;
  }

  findById(id: string): RepoCache | null {
    const stmt = this.db.prepare(`SELECT * FROM repo_caches WHERE id = ?`);
    return this.mapToRepoCache(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findByGitHubRepo(githubRepo: string): RepoCache | null {
    const stmt = this.db.prepare(`SELECT * FROM repo_caches WHERE github_repo = ?`);
    return this.mapToRepoCache(stmt.get(githubRepo) as Record<string, unknown> | undefined);
  }

  findAll(): RepoCache[] {
    const stmt = this.db.prepare(`SELECT * FROM repo_caches ORDER BY github_repo ASC`);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => this.mapToRepoCache(row)).filter((item): item is RepoCache => item !== null);
  }

  update(cache: UpdateRepoCache): RepoCache | null {
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const params: Array<string | null> = [now];

    const assign = (field: string, value: string | null): void => {
      fields.push(`${field} = ?`);
      params.push(value);
    };

    if (cache.github_repo !== undefined) assign('github_repo', cache.github_repo);
    if (cache.local_source_path !== undefined) assign('local_source_path', cache.local_source_path);
    if (cache.default_branch !== undefined) assign('default_branch', cache.default_branch);
    if (cache.last_fetched_at !== undefined) assign('last_fetched_at', cache.last_fetched_at?.toISOString() ?? null);
    if (cache.last_fetch_commit !== undefined) assign('last_fetch_commit', cache.last_fetch_commit);

    params.push(cache.id);

    const stmt = this.db.prepare(`
      UPDATE repo_caches SET ${fields.join(', ')} WHERE id = ?
    `);
    stmt.run(...params);

    return this.findById(cache.id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM repo_caches WHERE id = ?`);
    const result = stmt.run(id);
    return (result as { changes: number }).changes > 0;
  }

  private mapToRepoCache(row: Record<string, unknown> | undefined): RepoCache | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      github_repo: row.github_repo as string,
      local_source_path: row.local_source_path as string,
      default_branch: row.default_branch as string,
      last_fetched_at: row.last_fetched_at ? new Date(row.last_fetched_at as string) : null,
      last_fetch_commit: row.last_fetch_commit as string | null,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
