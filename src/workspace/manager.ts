/**
 * Workspace Manager - Per-issue workspace lifecycle
 * Section 9: Workspace Management and Safety
 *
 * Uses Git Worktree for proper workspace isolation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
import { Workspace, Issue } from '../types';

const execAsync = promisify(cp.exec);

/**
 * Sanitize an issue identifier for use as a workspace directory name
 * Section 9.5 Safety Invariants - Invariant 3
 * Only [A-Za-z0-9._-] allowed, replace all other characters with _
 */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Workspace Manager options
 */
export interface WorkspaceManagerOptions {
  workspaceRoot: string;
  repoPath?: string;  // Git repository path for worktree
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
 * Workspace Manager
 * Section 9.3: Workspace Layout and Lifecycle
 *
 * Uses git worktree for isolation instead of plain directories
 */
export class WorkspaceManager {
  private workspaceRoot: string;
  private repoPath: string;
  private hooks: WorkspaceManagerOptions['hooks'];

  constructor(options: WorkspaceManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.repoPath = options.repoPath || process.cwd();
    this.hooks = options.hooks;
  }

  /**
   * Ensure workspace root directory exists
   */
  private async ensureWorkspaceRoot(): Promise<{ success: boolean; error?: string }> {
    try {
      await fs.promises.mkdir(this.workspaceRoot, { recursive: true });
      return { success: true };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      return { success: false, error: `Failed to create workspace root: ${error.message}` };
    }
  }

  /**
   * Validate that a workspace path is inside the workspace root
   * Section 9.5 Safety Invariants - Invariant 2
   */
  private validateWorkspacePath(workspacePath: string): { valid: boolean; error?: string } {
    const normalizedRoot = path.resolve(this.workspaceRoot);
    const normalizedPath = path.resolve(workspacePath);

    if (!normalizedPath.startsWith(normalizedRoot + path.sep) && normalizedPath !== normalizedRoot) {
      return {
        valid: false,
        error: `Workspace path "${workspacePath}" is outside workspace root "${this.workspaceRoot}"`
      };
    }

    return { valid: true };
  }

  /**
   * Execute a hook script in the workspace directory
   */
  private async executeHook(hookName: string, script: string, workspacePath: string, envOverrides: Record<string, string> = {}): Promise<{ success: boolean; output?: string; error?: string }> {
    if (!script) {
      return { success: true, output: '' };
    }

    const timeoutMs = this.hooks.timeout_ms;

    try {
      const { stdout, stderr } = await execAsync(script, {
        cwd: workspacePath,
        timeout: timeoutMs,
        shell: '/bin/bash',
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...envOverrides }
      });

      return {
        success: true,
        output: (stdout + stderr).trim().slice(0, 1000)
      };
    } catch (err) {
      const execError = err as cp.ExecException & { stdout?: string; stderr?: string };

      if (execError.killed || String(execError.code) === 'ETIMEDOUT') {
        return { success: false, error: `Hook ${hookName} timed out after ${timeoutMs}ms` };
      }

      return {
        success: false,
        error: `Hook ${hookName} failed: ${execError.message}`,
        output: ((execError.stdout || '') + (execError.stderr || '')).trim().slice(0, 1000)
      };
    }
  }

  /**
   * Check if git is available and the repo is valid
   */
  private async checkGitRepo(): Promise<{ valid: boolean; error?: string }> {
    try {
      await execAsync(`git -C "${this.repoPath}" rev-parse --git-dir`);
      return { valid: true };
    } catch (err) {
      const execError = err as cp.ExecException;
      return {
        valid: false,
        error: `Git repository not found at "${this.repoPath}": ${execError.message}`
      };
    }
  }

  /**
   * Create or reuse a workspace for an issue using git worktree
   * Section 9.3: Workspace Layout and Lifecycle
   */
  async createForIssue(issue: Pick<Issue, 'identifier'>): Promise<WorkspaceResult> {
    // Step 1: Check git repository
    const gitResult = await this.checkGitRepo();
    if (!gitResult.valid) {
      return { success: false, error: gitResult.error };
    }

    // Step 2: Sanitize identifier
    const workspaceKey = sanitizeWorkspaceKey(issue.identifier);

    // Step 3: Compute workspace path
    const workspacePath = path.join(this.workspaceRoot, workspaceKey);

    // Validate path safety
    const pathValidation = this.validateWorkspacePath(workspacePath);
    if (!pathValidation.valid) {
      return { success: false, error: pathValidation.error };
    }

    // Ensure workspace root exists
    const rootResult = await this.ensureWorkspaceRoot();
    if (!rootResult.success) {
      return { success: false, error: rootResult.error };
    }

    // Step 4: Check if worktree already exists
    let createdNow = false;
    try {
      const { stdout } = await execAsync(`git -C "${this.repoPath}" worktree list --porcelain`);
      const worktrees = stdout.split('\n').filter(line => line.startsWith('worktree '));
      const existingWorktree = worktrees.find(w => {
        const match = w.match(/^worktree\s+(.+)$/);
        return match && path.resolve(match[1]) === path.resolve(workspacePath);
      });

      if (existingWorktree) {
        createdNow = false;
      } else {
        const branchName = `feature/${workspaceKey.toLowerCase()}`;
        await execAsync(
          `git -C "${this.repoPath}" worktree add -b "${branchName}" "${workspacePath}"`,
          { maxBuffer: 10 * 1024 * 1024 }
        );
        createdNow = true;
      }
    } catch (err) {
      const execError = err as cp.ExecException;
      return {
        success: false,
        error: `Failed to create git worktree: ${execError.message}`
      };
    }

    // Step 5: Run after_create hook if newly created
    if (createdNow && this.hooks.after_create) {
      const hookResult = await this.executeHook('after_create', this.hooks.after_create, workspacePath);
      if (!hookResult.success) {
        try {
          await execAsync(`git -C "${this.repoPath}" worktree remove "${workspacePath}"`, { maxBuffer: 10 * 1024 * 1024 });
        } catch {}
        return { success: false, error: hookResult.error };
      }
    }

    return {
      success: true,
      workspace: {
        path: workspacePath,
        workspace_key: workspaceKey,
        created_now: createdNow,
        git_branch: createdNow ? `feature/${workspaceKey.toLowerCase()}` : undefined
      }
    };
  }

  /**
   * Run before_run hook for a workspace
   */
  async beforeRun(workspacePath: string, issue?: Pick<Issue, 'identifier' | 'state'>): Promise<{ success: boolean; error?: string }> {
    if (!this.hooks.before_run) {
      return { success: true };
    }

    const envOverrides: Record<string, string> = {};
    if (issue) {
      envOverrides['SYMPHONY_ISSUE_IDENTIFIER'] = issue.identifier;
      envOverrides['SYMPHONY_ISSUE_STATE'] = issue.state;
    }

    const result = await this.executeHook('before_run', this.hooks.before_run, workspacePath, envOverrides);
    return { success: result.success, error: result.error };
  }

  /**
   * Run after_run hook for a workspace
   */
  async afterRun(workspacePath: string, issue?: Pick<Issue, 'identifier' | 'state'>): Promise<void> {
    if (!this.hooks.after_run) {
      return;
    }

    const envOverrides: Record<string, string> = {};
    if (issue) {
      envOverrides['SYMPHONY_ISSUE_IDENTIFIER'] = issue.identifier;
      envOverrides['SYMPHONY_ISSUE_STATE'] = issue.state;
    }

    const result = await this.executeHook('after_run', this.hooks.after_run, workspacePath, envOverrides);
    if (!result.success) {
      console.warn(`after_run hook failed: ${result.error}`);
    }
  }

  /**
   * Remove a workspace using git worktree remove
   */
  async removeWorkspace(workspacePath: string): Promise<{ success: boolean; error?: string }> {
    if (this.hooks.before_remove) {
      const hookResult = await this.executeHook('before_remove', this.hooks.before_remove, workspacePath);
      if (!hookResult.success) {
        console.warn(`before_remove hook failed: ${hookResult.error}`);
      }
    }

    try {
      // Try git worktree remove first
      await execAsync(`git -C "${this.repoPath}" worktree remove "${workspacePath}"`, {
        maxBuffer: 10 * 1024 * 1024
      });
      return { success: true };
    } catch (gitErr) {
      // If git remove fails, fall back to fs.rm
      const gitError = gitErr as cp.ExecException;
      console.warn(`Git worktree remove failed, using fs.rm: ${gitError.message}`);

      try {
        await fs.promises.rm(workspacePath, { recursive: true, force: true });
        return { success: true };
      } catch (fsErr) {
        const error = fsErr as NodeJS.ErrnoException;
        return { success: false, error: `Failed to remove workspace: ${error.message}` };
      }
    }
  }

  /**
   * Get workspace path for an issue identifier (without creating)
   */
  getWorkspacePath(identifier: string): string {
    const workspaceKey = sanitizeWorkspaceKey(identifier);
    return path.join(this.workspaceRoot, workspaceKey);
  }

  /**
   * Check if a workspace exists
   */
  async workspaceExists(identifier: string): Promise<boolean> {
    const workspacePath = this.getWorkspacePath(identifier);
    try {
      const stat = await fs.promises.stat(workspacePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
