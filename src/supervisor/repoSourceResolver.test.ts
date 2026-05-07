import { describe, expect, test } from 'bun:test';
import type { ResolvedRepositoryRoute } from '../types';
import { DefaultSupervisorRepoSourceResolver } from './repoSourceResolver';

function makeRoute(overrides: Partial<ResolvedRepositoryRoute> = {}): ResolvedRepositoryRoute {
  return {
    project_slug: 'test2',
    project_name: null,
    github_owner: 'UniUni2000',
    github_repo: 'test2',
    github_repo_full: 'UniUni2000/test2',
    local_path: null,
    cache_key: 'uniuni2000__test2',
    require_repo_harness: false,
    ...overrides,
  };
}

describe('DefaultSupervisorRepoSourceResolver', () => {
  test('prepares the shared repo source when a configured route has no local_path', async () => {
    const calls: ResolvedRepositoryRoute[] = [];
    const resolver = new DefaultSupervisorRepoSourceResolver({
      ensureRepoSource: async (route) => {
        calls.push(route);
        return {
          success: true,
          githubRepoFull: route.github_repo_full,
          repoRoot: '/tmp/workspaces/uniuni2000__test2',
          sourcePath: '/tmp/workspaces/uniuni2000__test2/source',
        };
      },
      getSourcePath: () => '/tmp/workspaces/uniuni2000__test2/source',
      resolveCommit: async (sourcePath) => {
        expect(sourcePath).toBe('/tmp/workspaces/uniuni2000__test2/source');
        return 'abc123';
      },
      now: () => '2026-05-07T00:00:00.000Z',
    });

    const snapshot = await resolver.resolve(makeRoute());

    expect(calls).toHaveLength(1);
    expect(snapshot).toEqual({
      project_slug: 'test2',
      repo_ref: 'UniUni2000/test2',
      configured_local_path: null,
      analysis_path: '/tmp/workspaces/uniuni2000__test2/source',
      source_path: '/tmp/workspaces/uniuni2000__test2/source',
      commit_sha: 'abc123',
      status: 'ready',
      last_sync_error: null,
      updated_at: '2026-05-07T00:00:00.000Z',
    });
  });

  test('reports failed source preparation without falling back to a missing local_path', async () => {
    const resolver = new DefaultSupervisorRepoSourceResolver({
      ensureRepoSource: async (route) => ({
        success: false,
        githubRepoFull: route.github_repo_full,
        error: 'fetch failed',
      }),
      getSourcePath: () => '/tmp/workspaces/uniuni2000__test2/source',
      resolveCommit: async () => 'should-not-run',
      now: () => '2026-05-07T00:00:00.000Z',
    });

    const snapshot = await resolver.resolve(makeRoute());

    expect(snapshot.status).toBe('failed');
    expect(snapshot.analysis_path).toBeNull();
    expect(snapshot.source_path).toBe('/tmp/workspaces/uniuni2000__test2/source');
    expect(snapshot.last_sync_error).toBe('fetch failed');
  });

  test('diagnostics include configured routes that have not been synced yet', () => {
    const resolver = new DefaultSupervisorRepoSourceResolver({
      ensureRepoSource: async () => ({
        success: true,
        githubRepoFull: 'UniUni2000/test2',
        sourcePath: '/tmp/workspaces/uniuni2000__test2/source',
      }),
      getSourcePath: () => '/tmp/workspaces/uniuni2000__test2/source',
      resolveCommit: async () => 'abc123',
      now: () => '2026-05-07T00:00:00.000Z',
    });

    expect(resolver.getDiagnostics([makeRoute()])).toEqual([
      {
        project_slug: 'test2',
        repo_ref: 'UniUni2000/test2',
        configured_local_path: null,
        analysis_path: null,
        source_path: '/tmp/workspaces/uniuni2000__test2/source',
        commit_sha: null,
        status: 'unknown',
        last_sync_error: null,
        updated_at: null,
      },
    ]);
  });
});
