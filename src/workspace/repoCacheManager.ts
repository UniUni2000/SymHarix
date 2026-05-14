import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
import type { ResolvedRepositoryRoute } from '../types';
import { getRepoRootPath, getRepoSourcePath } from './shared';

const execAsync = promisify(cp.exec);

export interface RepoCacheManagerOptions {
  workspaceRoot: string;
  githubToken: string;
}

export interface RepoCacheResult {
  success: boolean;
  githubRepoFull: string;
  repoRoot?: string;
  sourcePath?: string;
  error?: string;
}

export class RepoCacheManager {
  private workspaceRoot: string;
  private githubToken: string;

  constructor(options: RepoCacheManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.githubToken = options.githubToken;
  }

  getRepoRoot(route: Pick<ResolvedRepositoryRoute, 'cache_key'>): string {
    return getRepoRootPath(this.workspaceRoot, route.cache_key);
  }

  getSourcePath(route: Pick<ResolvedRepositoryRoute, 'cache_key'>): string {
    return getRepoSourcePath(this.workspaceRoot, route.cache_key);
  }

  async ensureRepoSource(route: ResolvedRepositoryRoute): Promise<RepoCacheResult> {
    const repoRoot = this.getRepoRoot(route);
    const sourcePath = this.getSourcePath(route);
    const expectedRepo = route.github_repo_full.toLowerCase();

    try {
      await fs.promises.mkdir(repoRoot, { recursive: true });
      await fs.promises.mkdir(path.join(repoRoot, 'worktrees'), { recursive: true });

      if (route.local_path) {
        const localPathMismatch = await this.getRouteMismatch(route.local_path, expectedRepo);
        if (localPathMismatch) {
          return {
            success: false,
            githubRepoFull: route.github_repo_full,
            error: `Configured local_path ${route.local_path} resolves to ${localPathMismatch}, expected ${route.github_repo_full}.`,
          };
        }
      }

      if (await this.isGitRepo(sourcePath)) {
        const sourceMismatch = await this.getRouteMismatch(sourcePath, expectedRepo);
        if (sourceMismatch) {
          await fs.promises.rm(sourcePath, { recursive: true, force: true });
        } else {
          await this.ensureSourceOriginMatchesRoute(sourcePath, route);
          await this.refreshRepoSource(sourcePath);
          return { success: true, githubRepoFull: route.github_repo_full, repoRoot, sourcePath };
        }
      }

      await fs.promises.rm(sourcePath, { recursive: true, force: true });

      if (route.local_path) {
        if (!await this.isGitRepo(route.local_path)) {
          return {
            success: false,
            githubRepoFull: route.github_repo_full,
            error: `Configured local_path is not a git repository: ${route.local_path}`,
          };
        }

        await execAsync(`git clone "${route.local_path}" "${sourcePath}"`, { maxBuffer: 10 * 1024 * 1024 });
      } else {
        await execAsync(`git clone "${this.cloneUrlForRoute(route)}" "${sourcePath}"`, { maxBuffer: 10 * 1024 * 1024 });
      }

      const clonedSourceMismatch = await this.getRouteMismatch(sourcePath, expectedRepo);
      if (clonedSourceMismatch) {
        await fs.promises.rm(sourcePath, { recursive: true, force: true });
        return {
          success: false,
          githubRepoFull: route.github_repo_full,
          error: `Cloned source at ${sourcePath} resolves to ${clonedSourceMismatch}, expected ${route.github_repo_full}.`,
        };
      }

      await this.configureGitIdentity(sourcePath);
      await this.refreshRepoSource(sourcePath);

      return { success: true, githubRepoFull: route.github_repo_full, repoRoot, sourcePath };
    } catch (err) {
      const error = err as Error;
      return {
        success: false,
        githubRepoFull: route.github_repo_full,
        error: `Failed to ensure repo source for ${route.github_repo_full}: ${error.message}`
      };
    }
  }

  private cloneUrlForRoute(route: ResolvedRepositoryRoute): string {
    if (route.local_path) {
      return route.local_path;
    }

    return this.githubToken
      ? `https://${this.githubToken}@github.com/${route.github_repo_full}.git`
      : `https://github.com/${route.github_repo_full}.git`;
  }

  private async ensureSourceOriginMatchesRoute(
    sourcePath: string,
    route: ResolvedRepositoryRoute,
  ): Promise<void> {
    const desiredOrigin = this.cloneUrlForRoute(route);
    const currentOrigin = await this.getOriginRemoteUrl(sourcePath);
    if (currentOrigin === desiredOrigin) {
      return;
    }

    if (currentOrigin) {
      await execAsync(`git -C "${sourcePath}" remote set-url origin "${desiredOrigin}"`);
      return;
    }

    await execAsync(`git -C "${sourcePath}" remote add origin "${desiredOrigin}"`);
  }

  private async getRouteMismatch(repoPath: string, expectedRepo: string): Promise<string | null> {
    const actualRepo = await this.resolveRepositoryIdentity(repoPath);
    if (!actualRepo) {
      return null;
    }

    return actualRepo === expectedRepo ? null : actualRepo;
  }

  private async resolveRepositoryIdentity(repoPath: string, seenPaths = new Set<string>()): Promise<string | null> {
    const normalizedPath = await fs.promises.realpath(repoPath).catch(() => path.resolve(repoPath));
    if (seenPaths.has(normalizedPath)) {
      return null;
    }
    seenPaths.add(normalizedPath);

    const remoteUrl = await this.getOriginRemoteUrl(repoPath);
    if (!remoteUrl) {
      return null;
    }

    const githubRepo = this.parseGitHubRepoFull(remoteUrl);
    if (githubRepo) {
      return githubRepo;
    }

    const localRemotePath = this.parseLocalRemotePath(repoPath, remoteUrl);
    if (!localRemotePath || !await this.isGitRepo(localRemotePath)) {
      return null;
    }

    return this.resolveRepositoryIdentity(localRemotePath, seenPaths);
  }

  private async getOriginRemoteUrl(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`git -C "${repoPath}" remote get-url origin`);
      const remoteUrl = stdout.trim();
      return remoteUrl || null;
    } catch {
      return null;
    }
  }

  private parseGitHubRepoFull(remoteUrl: string): string | null {
    const trimmed = remoteUrl.trim();
    const httpsMatch = trimmed.match(/^https?:\/\/(?:[^/@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
    if (httpsMatch) {
      return `${httpsMatch[1]}/${httpsMatch[2]}`.toLowerCase();
    }

    const sshMatch = trimmed.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
    if (sshMatch) {
      return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase();
    }

    return null;
  }

  private parseLocalRemotePath(repoPath: string, remoteUrl: string): string | null {
    const trimmed = remoteUrl.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith('file://')) {
      return trimmed.slice('file://'.length);
    }

    if (path.isAbsolute(trimmed)) {
      return trimmed;
    }

    if (/^[./~]/.test(trimmed)) {
      const expanded = trimmed.startsWith('~/')
        ? path.join(process.env.HOME || '', trimmed.slice(2))
        : trimmed;
      return path.resolve(repoPath, expanded);
    }

    return null;
  }

  private async isGitRepo(repoPath: string): Promise<boolean> {
    try {
      await execAsync(`git -C "${repoPath}" rev-parse --git-dir`);
      return true;
    } catch {
      return false;
    }
  }

  private async configureGitIdentity(repoPath: string): Promise<void> {
    await execAsync(`git -C "${repoPath}" config user.name "SymHarix Agent"`);
    await execAsync(`git -C "${repoPath}" config user.email "symphony@example.com"`);
  }

  private async refreshRepoSource(sourcePath: string): Promise<void> {
    try {
      await execAsync(`git -C "${sourcePath}" remote get-url origin`);
      await execAsync(`git -C "${sourcePath}" fetch --all --prune`, { maxBuffer: 10 * 1024 * 1024 });
      await this.fastForwardCurrentBranchToRemoteDefault(sourcePath);
    } catch {
      return;
    }
  }

  private async fastForwardCurrentBranchToRemoteDefault(sourcePath: string): Promise<void> {
    const remoteDefaultRef = await this.getRemoteDefaultRef(sourcePath);
    if (!remoteDefaultRef) {
      return;
    }

    const localDefaultBranch = remoteDefaultRef.replace(/^refs\/remotes\/origin\//, '');

    try {
      const { stdout } = await execAsync(`git -C "${sourcePath}" branch --show-current`);
      const currentBranch = stdout.trim();
      if (!currentBranch || currentBranch !== localDefaultBranch) {
        return;
      }

      // Keep the shared source cache aligned with the fetched remote default branch
      // without rewriting history or clobbering unexpected local changes.
      await execAsync(`git -C "${sourcePath}" merge --ff-only "${remoteDefaultRef}"`, {
        maxBuffer: 10 * 1024 * 1024
      });
    } catch {
      return;
    }
  }

  private async getRemoteDefaultRef(sourcePath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`git -C "${sourcePath}" symbolic-ref --quiet refs/remotes/origin/HEAD`);
      const ref = stdout.trim();
      return ref || null;
    } catch {
      return null;
    }
  }
}
