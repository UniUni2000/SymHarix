import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
import { getRepoRootPath, getRepoSourcePath } from './shared';

const execAsync = promisify(cp.exec);

export interface RepoCacheManagerOptions {
  workspaceRoot: string;
  projectRoot: string;
  githubOwner: string;
  githubToken: string;
}

export interface RepoCacheResult {
  success: boolean;
  repoName: string;
  repoRoot?: string;
  sourcePath?: string;
  error?: string;
}

export class RepoCacheManager {
  private workspaceRoot: string;
  private projectRoot: string;
  private githubOwner: string;
  private githubToken: string;

  constructor(options: RepoCacheManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.projectRoot = options.projectRoot;
    this.githubOwner = options.githubOwner;
    this.githubToken = options.githubToken;
  }

  getRepoRoot(projectSlug?: string | null, projectName?: string | null): string {
    return getRepoRootPath(this.workspaceRoot, projectSlug, projectName);
  }

  getSourcePath(projectSlug?: string | null, projectName?: string | null): string {
    return getRepoSourcePath(this.workspaceRoot, projectSlug, projectName);
  }

  async ensureRepoSource(projectSlug?: string | null, projectName?: string | null): Promise<RepoCacheResult> {
    const repoName = projectName || projectSlug || 'main';
    const repoRoot = this.getRepoRoot(projectSlug, projectName);
    const sourcePath = this.getSourcePath(projectSlug, projectName);
    const seedPath = path.join(this.projectRoot, repoName);

    try {
      await fs.promises.mkdir(repoRoot, { recursive: true });
      await fs.promises.mkdir(path.join(repoRoot, 'worktrees'), { recursive: true });

      if (await this.isGitRepo(sourcePath)) {
        await this.refreshRepoSource(sourcePath);
        return { success: true, repoName, repoRoot, sourcePath };
      }

      await fs.promises.rm(sourcePath, { recursive: true, force: true });

      if (await this.isGitRepo(seedPath)) {
        await execAsync(`git clone "${seedPath}" "${sourcePath}"`, { maxBuffer: 10 * 1024 * 1024 });
      } else {
        const githubRepo = `${this.githubOwner}/${repoName}`;
        const cloneUrl = this.githubToken
          ? `https://${this.githubToken}@github.com/${githubRepo}.git`
          : `https://github.com/${githubRepo}.git`;
        await execAsync(`git clone "${cloneUrl}" "${sourcePath}"`, { maxBuffer: 10 * 1024 * 1024 });
      }

      await this.configureGitIdentity(sourcePath);
      await this.refreshRepoSource(sourcePath);

      return { success: true, repoName, repoRoot, sourcePath };
    } catch (err) {
      const error = err as Error;
      return {
        success: false,
        repoName,
        error: `Failed to ensure repo source for ${repoName}: ${error.message}`
      };
    }
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
    await execAsync(`git -C "${repoPath}" config user.name "Symphony Agent"`);
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
