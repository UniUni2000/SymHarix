/**
 * Workspace Manager - Per-issue workspace lifecycle
 * Section 9: Workspace Management and Safety
 *
 * Uses a shared repo source cache plus per-issue git worktrees.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { Workspace, Issue } from '../types';
import { RepoCacheManager } from './repoCacheManager';
import { IssueWorktreeManager } from './issueWorktreeManager';
import { getIssueWorktreePath, sanitizeWorkspaceKey } from './shared';

/**
 * Re-export for existing imports/tests.
 */
export { sanitizeWorkspaceKey } from './shared';

/**
 * Workspace Manager options
 */
export interface WorkspaceManagerOptions {
  workspaceRoot: string;
  projectRoot: string;
  githubOwner: string;
  githubToken: string;
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
}

/**
 * Result of workspace operation
 */
export interface WorkspaceResult {
  success: boolean;
  workspace?: Workspace;
  error?: string;
}

/**
 * Workspace Manager facade
 *
 * Keeps the existing public API while delegating repo-source and worktree
 * responsibilities to dedicated managers.
 */
export class WorkspaceManager {
  private workspaceRoot: string;
  private projectRoot: string;
  private githubOwner: string;
  private hooks: WorkspaceManagerOptions['hooks'];
  private repoCacheManager: RepoCacheManager;
  private issueWorktreeManager: IssueWorktreeManager;

  constructor(options: WorkspaceManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.projectRoot = options.projectRoot;
    this.githubOwner = options.githubOwner;
    this.hooks = options.hooks;
    this.repoCacheManager = new RepoCacheManager({
      workspaceRoot: options.workspaceRoot,
      projectRoot: options.projectRoot,
      githubOwner: options.githubOwner,
      githubToken: options.githubToken,
    });
    this.issueWorktreeManager = new IssueWorktreeManager({
      workspaceRoot: options.workspaceRoot,
    });
  }

  /**
   * Find bash executable path
   * Use absolute path for reliability
   */
  private async findBashPath(): Promise<string> {
    const paths = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
    for (const p of paths) {
      try {
        await fs.promises.access(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
    return 'bash';
  }

  /**
   * Execute a hook script in the workspace directory
   */
  private async executeHook(
    hookName: string,
    script: string,
    workspacePath: string,
    envOverrides: Record<string, string> = {}
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const allowedHooks = ['after_create'];
    if (!allowedHooks.includes(hookName)) {
      console.log(`[executeHook] Skipping disallowed hook: ${hookName}`);
      return { success: true, output: '' };
    }

    console.log(`[executeHook] ${hookName}: script="${script}", workspace="${workspacePath}"`);
    if (!script) {
      return { success: true, output: '' };
    }

    const timeoutMs = this.hooks.timeout_ms;

    try {
      const bashPath = await this.findBashPath();
      const scriptPath = path.isAbsolute(script) ? script : path.resolve(this.projectRoot, script);
      await fs.promises.mkdir(workspacePath, { recursive: true });

      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const scriptExt = path.extname(scriptPath).toLowerCase();
        const cmd = scriptExt === '.py' ? 'python3' : bashPath;
        const args = scriptExt === '.py' ? [scriptPath] : [scriptPath];

        const child = cp.spawn(cmd, args, {
          cwd: workspacePath,
          env: { ...process.env, ...envOverrides }
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', d => stdout += d.toString());
        child.stderr?.on('data', d => stderr += d.toString());

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('ETIMEDOUT'));
        }, timeoutMs);

        child.on('error', err => {
          clearTimeout(timer);
          reject(err);
        });

        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) {
            const err = new Error(`Exited with code ${code}`) as cp.ExecException & { stdout?: string; stderr?: string };
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
          } else {
            resolve({ stdout, stderr });
          }
        });
      });

      return {
        success: true,
        output: (result.stdout + result.stderr).trim().slice(0, 10000)
      };
    } catch (err) {
      const execError = err as cp.ExecException & { stdout?: string; stderr?: string };

      if (execError.killed || String(execError.code) === 'ETIMEDOUT') {
        return { success: false, error: `Hook ${hookName} timed out after ${timeoutMs}ms` };
      }

      const errorMsg = `Hook ${hookName} failed: ${execError.message}`;
      const errorOutput = ((execError.stdout || '') + (execError.stderr || '')).trim().slice(0, 10000);
      console.error(`[hook-error] ${errorMsg}`);
      if (errorOutput) {
        console.error(`[hook-error] Output: ${errorOutput}`);
      }

      return {
        success: false,
        error: errorMsg,
        output: errorOutput
      };
    }
  }

  /**
   * Prepare workspace for an issue.
   * Kept for compatibility with older call sites.
   */
  async prepareWorkspace(issue: Pick<Issue, 'identifier' | 'project_slug' | 'project_name'>): Promise<WorkspaceResult> {
    return this.createForIssue(issue);
  }

  /**
   * Create or reuse a workspace for an issue using a shared repo source plus git worktree.
   */
  async createForIssue(issue: Pick<Issue, 'identifier' | 'project_slug' | 'project_name'>): Promise<WorkspaceResult> {
    const repoResult = await this.repoCacheManager.ensureRepoSource(issue.project_slug, issue.project_name);
    if (!repoResult.success || !repoResult.sourcePath) {
      return { success: false, error: repoResult.error };
    }

    const worktreeResult = await this.issueWorktreeManager.createOrReuse(
      repoResult.sourcePath,
      issue.identifier,
      issue.project_slug,
      issue.project_name
    );

    if (!worktreeResult.success || !worktreeResult.workspace) {
      return { success: false, error: worktreeResult.error };
    }

    if (worktreeResult.workspace.created_now && this.hooks.after_create) {
      const repoName = issue.project_name
        ? sanitizeWorkspaceKey(issue.project_name)
        : (issue.project_slug ? sanitizeWorkspaceKey(issue.project_slug) : 'main');

      const hookResult = await this.executeHook(
        'after_create',
        this.hooks.after_create,
        worktreeResult.workspace.path,
        {
          SYMPHONY_GITHUB_OWNER: this.githubOwner,
          SYMPHONY_GITHUB_REPO: repoName,
          SYMPHONY_ISSUE_IDENTIFIER: issue.identifier
        }
      );

      if (!hookResult.success) {
        await this.issueWorktreeManager.removeWorktree(worktreeResult.workspace.path).catch(() => undefined);
        return { success: false, error: hookResult.error };
      }
    }

    return {
      success: true,
      workspace: worktreeResult.workspace
    };
  }

  /**
   * Run before_run hook for a workspace
   */
  async beforeRun(
    workspacePath: string,
    issue?: Pick<Issue, 'identifier' | 'state' | 'project_slug' | 'project_name'>
  ): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  /**
   * Run after_run hook for a workspace
   */
  async afterRun(
    workspacePath: string,
    issue?: Pick<Issue, 'identifier' | 'state' | 'project_slug' | 'project_name'>
  ): Promise<{ success: boolean; output?: string }> {
    return { success: true, output: undefined };
  }

  /**
   * Remove a workspace worktree while preserving the shared repo source.
   */
  async removeWorkspace(workspacePath: string, projectSlug?: string | null): Promise<{ success: boolean; error?: string }> {
    return this.issueWorktreeManager.removeWorktree(workspacePath);
  }

  /**
   * Get workspace path for an issue identifier (without creating).
   */
  getWorkspacePath(identifier: string, projectSlug?: string | null, projectName?: string | null): string {
    return getIssueWorktreePath(this.workspaceRoot, identifier, projectSlug, projectName);
  }

  /**
   * Get repo source path for an issue repo.
   */
  getRepoSourcePath(projectSlug?: string | null, projectName?: string | null): string {
    return this.repoCacheManager.getSourcePath(projectSlug, projectName);
  }

  /**
   * Check if a workspace exists.
   */
  async workspaceExists(identifier: string, projectSlug?: string | null, projectName?: string | null): Promise<boolean> {
    return this.issueWorktreeManager.workspaceExists(identifier, projectSlug, projectName);
  }
}
