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
import { GitHubClient } from '../github/client';

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
 * Workspace Manager
 * Section 9.3: Workspace Layout and Lifecycle
 *
 * Uses git worktree for isolation instead of plain directories
 */
export class WorkspaceManager {
  private workspaceRoot: string;
  private projectRoot: string;
  private githubOwner: string;
  private githubClient: GitHubClient;
  private hooks: WorkspaceManagerOptions['hooks'];

  constructor(options: WorkspaceManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.projectRoot = options.projectRoot;
    this.githubOwner = options.githubOwner;
    this.githubClient = new GitHubClient({
      token: options.githubToken,
      owner: options.githubOwner
    });
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
   * Check if a path exists
   */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a bare git repository
   */
  private async createBareRepo(bareRepoPath: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(bareRepoPath), { recursive: true });
    await execAsync(`git init --bare "${bareRepoPath}"`);
  }

  /**
   * Clone bare repo to main working directory
   */
  private async cloneToMain(mainWorkDir: string, bareRepoPath: string): Promise<void> {
    await execAsync(`git clone "${bareRepoPath}" "${mainWorkDir}"`);
  }

  /**
   * Create a git worktree for an issue
   */
  private async createWorktree(mainWorkDir: string, worktreePath: string, branchName: string): Promise<void> {
    await execAsync(`git -C "${mainWorkDir}" worktree add -b "${branchName}" "${worktreePath}"`);
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
   * Find bash executable path
   * Use absolute path for reliability
   */
  private async findBashPath(): Promise<string> {
    // Try common bash locations
    const paths = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
    for (const p of paths) {
      try {
        await fs.promises.access(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
    // Fall back to 'bash' in PATH
    return 'bash';
  }

  /**
   * Execute a hook script in the workspace directory
   */
  private async executeHook(hookName: string, script: string, workspacePath: string, envOverrides: Record<string, string> = {}): Promise<{ success: boolean; output?: string; error?: string }> {
    // Only allow after_create hook
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
      // Find bash path dynamically
      const bashPath = await this.findBashPath();

      // Resolve script path relative to project root
      const scriptPath = path.isAbsolute(script) ? script : path.resolve(this.projectRoot, script);

      // Ensure workspace directory exists before executing hook
      // This is needed because git worktree may not have fully initialized the directory
      await fs.promises.mkdir(workspacePath, { recursive: true });

      const result = await new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
        // Detect script type and use appropriate interpreter
        const scriptExt = path.extname(scriptPath).toLowerCase();
        let cmd: string;
        let args: string[];

        if (scriptExt === '.py') {
          // Python script
          cmd = 'python3';
          args = [scriptPath];
        } else {
          // Shell script (default)
          cmd = bashPath;
          args = [scriptPath];
        }

        const child = cp.spawn(cmd, args, {
          cwd: workspacePath,
          env: { ...process.env, ...envOverrides }
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', d => stdout += d.toString());
        child.stderr?.on('data', d => stderr += d.toString());

        // Timeout handling
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
            const err = new Error(`Exited with code ${code}`) as any;
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
      
      // Log detailed error information for debugging
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
   * Check if git is available and the repo is valid for a given project
   * If repo doesn't exist, clone from remote to ensure proper history
   */
  private async checkGitRepo(repoPath: string, githubRepo?: string): Promise<{ valid: boolean; error?: string }> {
    try {
      await execAsync(`git -C "${repoPath}" rev-parse --git-dir`);
      return { valid: true };
    } catch (err) {
      // Repo doesn't exist, clone from remote
      try {
        // Build clone URL
        let cloneUrl: string;
        if (githubRepo && this.githubClient) {
          // Use authenticated URL for private repos
          cloneUrl = `https://${this.githubClient.token}@github.com/${githubRepo}.git`;
        } else if (githubRepo) {
          // Public repo URL
          cloneUrl = `https://github.com/${githubRepo}.git`;
        } else {
          // No repo specified, initialize local-only repo
          await fs.promises.mkdir(repoPath, { recursive: true });
          const readmePath = path.join(repoPath, 'README.md');
          await fs.promises.writeFile(readmePath, `# ${path.basename(repoPath)}\n\nAutomatically initialized by Symphony Agent.\n`);
          await execAsync(`git -C "${repoPath}" init`);
          await execAsync(`git -C "${repoPath}" config user.name "Symphony Agent"`);
          await execAsync(`git -C "${repoPath}" config user.email "symphony@example.com"`);
          await execAsync(`git -C "${repoPath}" add .`);
          await execAsync(`git -C "${repoPath}" commit -m "Initial commit"`);
          return { valid: true };
        }

        // Clone the repository
        await execAsync(`git clone "${cloneUrl}" "${repoPath}"`, { maxBuffer: 10 * 1024 * 1024 });

        // Configure git user
        await execAsync(`git -C "${repoPath}" config user.name "Symphony Agent"`);
        await execAsync(`git -C "${repoPath}" config user.email "symphony@example.com"`);

        return { valid: true };
      } catch (cloneErr) {
        const error = cloneErr as NodeJS.ErrnoException & { stderr?: string };
        return {
          valid: false,
          error: `Failed to clone repository: ${error.message}${error.stderr ? ' - ' + error.stderr : ''}`
        };
      }
    }
  }

  /**
   * Prepare workspace for an issue using bare repo structure
   * Creates bare repo, main working directory, and worktree if needed
   */
  async prepareWorkspace(issue: Pick<Issue, 'identifier' | 'project_slug'>): Promise<WorkspaceResult> {
    const projectName = issue.project_slug ? sanitizeWorkspaceKey(issue.project_slug) : 'main';
    const bareRepoPath = path.join(this.workspaceRoot, 'repos', `${projectName}.git`);
    const mainWorkDir = path.join(this.workspaceRoot, projectName);
    const workspaceKey = sanitizeWorkspaceKey(issue.identifier);
    const worktreePath = path.join(mainWorkDir, workspaceKey);

    // Ensure workspace root exists
    await this.ensureWorkspaceRoot();

    // Step 1: Create bare repo if not exists
    if (!(await this.pathExists(bareRepoPath))) {
      await this.createBareRepo(bareRepoPath);
    }

    // Step 2: Clone to main working directory if not exists
    if (!(await this.pathExists(mainWorkDir))) {
      await this.cloneToMain(mainWorkDir, bareRepoPath);
    }

    // Step 3: Create worktree for issue
    const branchName = `feature/${workspaceKey.toLowerCase()}`;

    // Check if worktree already exists
    try {
      const { stdout } = await execAsync(`git -C "${mainWorkDir}" worktree list --porcelain`);
      const worktrees = stdout.split('\n').filter(line => line.startsWith('worktree '));
      const existingWorktree = worktrees.find(w => {
        const match = w.match(/^worktree\s+(.+)$/);
        return match && path.resolve(match[1]) === path.resolve(worktreePath);
      });

      if (existingWorktree) {
        // Worktree already exists, reuse it
        return {
          success: true,
          workspace: {
            path: worktreePath,
            workspace_key: workspaceKey,
            created_now: false,
            git_branch: branchName
          }
        };
      }
    } catch {}

    // Prune missing worktrees
    try {
      await execAsync(`git -C "${mainWorkDir}" worktree prune`);
    } catch {}

    // Create new worktree
    await this.createWorktree(mainWorkDir, worktreePath, branchName);

    return {
      success: true,
      workspace: {
        path: worktreePath,
        workspace_key: workspaceKey,
        created_now: true,
        git_branch: branchName
      }
    };
  }

  /**
   * Create or reuse a workspace for an issue using git worktree
   * Section 9.3: Workspace Layout and Lifecycle
   */
  async createForIssue(issue: Pick<Issue, 'identifier' | 'project_slug' | 'project_name'>): Promise<WorkspaceResult> {
    // Use project_name for GitHub repo (e.g., "test2"), not project_slug (Linear slugId)
    const repoName = issue.project_name ? sanitizeWorkspaceKey(issue.project_name) : (issue.project_slug ? sanitizeWorkspaceKey(issue.project_slug) : 'main');
    const repoPath = path.join(this.projectRoot, repoName);
    const githubRepo = `${this.githubOwner}/${repoName}`;

    // Step 1: Check git repository
    const gitResult = await this.checkGitRepo(repoPath, githubRepo);
    if (!gitResult.valid) {
      return { success: false, error: gitResult.error };
    }

    // Step 2: Sanitize identifier
    const workspaceKey = sanitizeWorkspaceKey(issue.identifier);

    // Step 3: Compute workspace path (use project_name, fallback to project_slug)
    const workspacePath = this.getWorkspacePath(issue.identifier, issue.project_slug, issue.project_name);

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
      const { stdout } = await execAsync(`git -C "${repoPath}" worktree list --porcelain`);
      const worktrees = stdout.split('\n').filter(line => line.startsWith('worktree '));
      const existingWorktree = worktrees.find(w => {
        const match = w.match(/^worktree\s+(.+)$/);
        return match && path.resolve(match[1]) === path.resolve(workspacePath);
      });

      if (existingWorktree) {
        createdNow = false;
      } else {
        const branchName = `feature/${workspaceKey.toLowerCase()}`;
        
        // Check if workspace directory exists and remove it if it does
        try {
          await fs.promises.rm(workspacePath, { recursive: true, force: true });
        } catch {}
        
        // Prune git worktree records to remove missing worktrees
        try {
          await execAsync(`git -C "${repoPath}" worktree prune`);
        } catch {}
        
        try {
          // First try to delete the branch if it exists
          await execAsync(`git -C "${repoPath}" branch -D "${branchName}"`);
        } catch {}
        
        try {
          // Try to create worktree with new branch
          await execAsync(
            `git -C "${repoPath}" worktree add -b "${branchName}" "${workspacePath}"`,
            { maxBuffer: 10 * 1024 * 1024 }
          );
          createdNow = true;
        } catch (branchErr) {
          // If branch already exists, try without -b flag
          try {
            // Check if workspace directory exists and remove it if it does
            try {
              await fs.promises.rm(workspacePath, { recursive: true, force: true });
            } catch {}
            
            // Prune again just in case
            try {
              await execAsync(`git -C "${repoPath}" worktree prune`);
            } catch {}
            
            // Try with -f to force override
            await execAsync(
              `git -C "${repoPath}" worktree add -f "${workspacePath}" "${branchName}"`,
              { maxBuffer: 10 * 1024 * 1024 }
            );
            createdNow = true;
          } catch (worktreeErr) {
            // If all else fails, try with -f and no branch
            try {
              // Check if workspace directory exists and remove it if it does
              try {
                await fs.promises.rm(workspacePath, { recursive: true, force: true });
              } catch {}
              
              // Prune again
              try {
                await execAsync(`git -C "${repoPath}" worktree prune`);
              } catch {}
              
              // Try with -f and no branch
              await execAsync(
                `git -C "${repoPath}" worktree add -f "${workspacePath}"`,
                { maxBuffer: 10 * 1024 * 1024 }
              );
              createdNow = true;
            } catch {
              // If worktree already exists at path, just use it
              try {
                const { stdout } = await execAsync(`git -C "${repoPath}" worktree list --porcelain`);
                const worktrees = stdout.split('\n').filter(line => line.startsWith('worktree '));
                const existingWorktree = worktrees.find(w => {
                  const match = w.match(/^worktree\s+(.+)$/);
                  return match && path.resolve(match[1]) === path.resolve(workspacePath);
                });
                if (existingWorktree) {
                  createdNow = false;
                } else {
                  throw worktreeErr;
                }
              } catch {
                throw worktreeErr;
              }
            }
          }
        }
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
      const hookResult = await this.executeHook('after_create', this.hooks.after_create, workspacePath, {
        SYMPHONY_GITHUB_OWNER: this.githubOwner,
        SYMPHONY_GITHUB_REPO: repoName,
        SYMPHONY_ISSUE_IDENTIFIER: issue.identifier
      });
      if (!hookResult.success) {
        try {
          await execAsync(`git -C "${repoPath}" worktree remove "${workspacePath}"`, { maxBuffer: 10 * 1024 * 1024 });
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
  async beforeRun(workspacePath: string, issue?: Pick<Issue, 'identifier' | 'state' | 'project_slug' | 'project_name'>): Promise<{ success: boolean; error?: string }> {
    // before_run hook is disabled - only after_create is allowed
    return { success: true };
  }

  /**
   * Run after_run hook for a workspace
   */
  async afterRun(workspacePath: string, issue?: Pick<Issue, 'identifier' | 'state' | 'project_slug' | 'project_name'>): Promise<{ success: boolean; output?: string }> {
    // after_run hook is disabled - only after_create is allowed
    return { success: true, output: undefined };
  }

  /**
   * Remove a workspace using git worktree remove
   */
  async removeWorkspace(workspacePath: string, projectSlug?: string | null): Promise<{ success: boolean; error?: string }> {
    const repoName = projectSlug ? sanitizeWorkspaceKey(projectSlug) : 'main';
    const repoPath = path.join(this.projectRoot, repoName);

    try {
      // Try git worktree remove first with --force to handle modified/untracked files
      await execAsync(`git -C "${repoPath}" worktree remove --force "${workspacePath}"`, {
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
  getWorkspacePath(identifier: string, projectSlug?: string | null, projectName?: string | null): string {
    // Prefer project_name for workspace path, fallback to projectSlug
    const workspaceProjectName = projectName ? sanitizeWorkspaceKey(projectName) : (projectSlug ? sanitizeWorkspaceKey(projectSlug) : 'main');
    const workspaceKey = sanitizeWorkspaceKey(identifier);
    return path.join(this.workspaceRoot, workspaceProjectName, workspaceKey);
  }

  /**
   * Check if a workspace exists
   */
  async workspaceExists(identifier: string, projectSlug?: string | null): Promise<boolean> {
    const workspacePath = this.getWorkspacePath(identifier, projectSlug);
    try {
      const stat = await fs.promises.stat(workspacePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
