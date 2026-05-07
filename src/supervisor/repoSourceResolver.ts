import type { ResolvedRepositoryRoute } from '../types';
import { RepoCacheManager, type RepoCacheResult } from '../workspace/repoCacheManager';
import { resolveGitCommit } from './claudeRepoUnderstandingService';

export type SupervisorRepoSourceStatus = 'unknown' | 'ready' | 'failed';

export interface SupervisorRepoSourceSnapshot {
  project_slug: string;
  repo_ref: string;
  configured_local_path: string | null;
  analysis_path: string | null;
  source_path: string | null;
  commit_sha: string | null;
  status: SupervisorRepoSourceStatus;
  last_sync_error: string | null;
  updated_at: string | null;
}

export interface SupervisorRepoSourceResolver {
  resolve(route: ResolvedRepositoryRoute): Promise<SupervisorRepoSourceSnapshot>;
  getDiagnostics(routes: ResolvedRepositoryRoute[]): SupervisorRepoSourceSnapshot[];
}

export interface SupervisorRepoSourceResolverOptions {
  ensureRepoSource(route: ResolvedRepositoryRoute): Promise<RepoCacheResult>;
  getSourcePath(route: Pick<ResolvedRepositoryRoute, 'cache_key'>): string;
  resolveCommit(sourcePath: string): Promise<string>;
  now?: () => string;
}

export function createSupervisorRepoSourceResolver(params: {
  workspaceRoot: string;
  githubToken: string;
}): SupervisorRepoSourceResolver {
  const manager = new RepoCacheManager({
    workspaceRoot: params.workspaceRoot,
    githubToken: params.githubToken,
  });
  return new DefaultSupervisorRepoSourceResolver({
    ensureRepoSource: manager.ensureRepoSource.bind(manager),
    getSourcePath: manager.getSourcePath.bind(manager),
    resolveCommit: resolveGitCommit,
  });
}

export class DefaultSupervisorRepoSourceResolver implements SupervisorRepoSourceResolver {
  private readonly snapshots = new Map<string, SupervisorRepoSourceSnapshot>();
  private readonly now: () => string;

  constructor(private readonly options: SupervisorRepoSourceResolverOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async resolve(route: ResolvedRepositoryRoute): Promise<SupervisorRepoSourceSnapshot> {
    const sourcePath = this.options.getSourcePath(route);
    const result = await this.options.ensureRepoSource(route);
    const updatedAt = this.now();
    if (!result.success || !result.sourcePath) {
      const snapshot = this.buildSnapshot(route, {
        analysisPath: null,
        sourcePath,
        commitSha: null,
        status: 'failed',
        lastSyncError: result.error || `Failed to prepare shared source for ${route.github_repo_full}.`,
        updatedAt,
      });
      this.snapshots.set(this.key(route), snapshot);
      return snapshot;
    }

    const commitSha = await this.options.resolveCommit(result.sourcePath);
    const snapshot = this.buildSnapshot(route, {
      analysisPath: result.sourcePath,
      sourcePath: result.sourcePath,
      commitSha: commitSha === 'unknown' ? null : commitSha,
      status: 'ready',
      lastSyncError: null,
      updatedAt,
    });
    this.snapshots.set(this.key(route), snapshot);
    return snapshot;
  }

  getDiagnostics(routes: ResolvedRepositoryRoute[]): SupervisorRepoSourceSnapshot[] {
    return routes.map((route) => this.snapshots.get(this.key(route)) ?? this.buildSnapshot(route, {
      analysisPath: null,
      sourcePath: this.options.getSourcePath(route),
      commitSha: null,
      status: 'unknown',
      lastSyncError: null,
      updatedAt: null,
    }));
  }

  private key(route: ResolvedRepositoryRoute): string {
    return route.github_repo_full.toLowerCase();
  }

  private buildSnapshot(
    route: ResolvedRepositoryRoute,
    values: {
      analysisPath: string | null;
      sourcePath: string | null;
      commitSha: string | null;
      status: SupervisorRepoSourceStatus;
      lastSyncError: string | null;
      updatedAt: string | null;
    },
  ): SupervisorRepoSourceSnapshot {
    return {
      project_slug: route.project_slug,
      repo_ref: route.github_repo_full,
      configured_local_path: route.local_path,
      analysis_path: values.analysisPath,
      source_path: values.sourcePath,
      commit_sha: values.commitSha,
      status: values.status,
      last_sync_error: values.lastSyncError,
      updated_at: values.updatedAt,
    };
  }
}
