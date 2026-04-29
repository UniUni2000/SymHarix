import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
import type { Workspace } from '../types';
import { getIssueWorktreePath, getSourcePathFromWorktree, sanitizeWorkspaceKey } from './shared';

const execAsync = promisify(cp.exec);
const WORKFLOW_ARTIFACT_PATHS = [
  'DEVELOPMENT_LOG.md',
  'HANDOVER.md',
  'REVIEW_REPORT.md',
  '.symphony',
] as const;

export interface IssueWorktreeManagerOptions {
  workspaceRoot: string;
}

export interface IssueWorktreeResult {
  success: boolean;
  workspace?: Workspace;
  error?: string;
}

export class IssueWorktreeManager {
  private workspaceRoot: string;

  constructor(options: IssueWorktreeManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
  }

  getWorkspacePath(identifier: string, cacheKey: string): string {
    return getIssueWorktreePath(this.workspaceRoot, identifier, cacheKey);
  }

  async createOrReuse(
    sourcePath: string,
    identifier: string,
    cacheKey: string,
  ): Promise<IssueWorktreeResult> {
    const workspaceKey = sanitizeWorkspaceKey(identifier);
    const branchName = `feature/${workspaceKey.toLowerCase()}`;
    const workspacePath = this.getWorkspacePath(identifier, cacheKey);

    try {
      await fs.promises.mkdir(path.dirname(workspacePath), { recursive: true });
      const validation = this.validateWorkspacePath(workspacePath);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const existingWorktree = await this.findRegisteredWorktree(sourcePath, workspacePath);
      if (existingWorktree) {
        await this.migrateLegacyWorkflowArtifacts(workspacePath);
        await this.ensureLocalRuntimeExcludes(workspacePath);
        await this.ensureLocalGitHooks(workspacePath);
        return {
          success: true,
          workspace: {
            path: workspacePath,
            workspace_key: workspaceKey,
            created_now: false,
            git_branch: branchName
          }
        };
      }

      await execAsync(`git -C "${sourcePath}" worktree prune`);
      await fs.promises.rm(workspacePath, { recursive: true, force: true });

      const branchExists = await this.branchExists(sourcePath, branchName);
      if (branchExists) {
        await execAsync(
          `git -C "${sourcePath}" worktree add --force "${workspacePath}" "${branchName}"`,
          { maxBuffer: 10 * 1024 * 1024 }
        );
      } else {
        const startPoint = await this.resolveBranchStartPoint(sourcePath);
        const startPointArg = startPoint ? ` "${startPoint}"` : '';
        await execAsync(
          `git -C "${sourcePath}" worktree add -b "${branchName}" "${workspacePath}"${startPointArg}`,
          { maxBuffer: 10 * 1024 * 1024 }
        );
      }

      await this.migrateLegacyWorkflowArtifacts(workspacePath);
      await this.ensureLocalRuntimeExcludes(workspacePath);
      await this.ensureLocalGitHooks(workspacePath);

      return {
        success: true,
        workspace: {
          path: workspacePath,
          workspace_key: workspaceKey,
          created_now: true,
          git_branch: branchName
        }
      };
    } catch (err) {
      const error = err as Error;
      return {
        success: false,
        error: `Failed to create worktree for ${identifier}: ${error.message}`
      };
    }
  }

  async removeWorktree(workspacePath: string): Promise<{ success: boolean; error?: string }> {
    const sourcePath = getSourcePathFromWorktree(workspacePath);

    try {
      await execAsync(`git -C "${sourcePath}" worktree remove --force "${workspacePath}"`, {
        maxBuffer: 10 * 1024 * 1024
      });
      await execAsync(`git -C "${sourcePath}" worktree prune`);
      return { success: true };
    } catch (gitErr) {
      const gitError = gitErr as Error;
      try {
        await fs.promises.rm(workspacePath, { recursive: true, force: true });
        return { success: true };
      } catch (fsErr) {
        const error = fsErr as Error;
        return {
          success: false,
          error: `Failed to remove workspace: ${gitError.message}; fallback rm failed: ${error.message}`
        };
      }
    }
  }

  async workspaceExists(identifier: string, cacheKey: string): Promise<boolean> {
    const workspacePath = this.getWorkspacePath(identifier, cacheKey);
    try {
      const stat = await fs.promises.stat(workspacePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

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

  private async branchExists(sourcePath: string, branchName: string): Promise<boolean> {
    try {
      await execAsync(`git -C "${sourcePath}" show-ref --verify --quiet refs/heads/${branchName}`);
      return true;
    } catch {
      return false;
    }
  }

  private async findRegisteredWorktree(sourcePath: string, workspacePath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`git -C "${sourcePath}" worktree list --porcelain`);
      const worktrees = stdout.split('\n').filter(line => line.startsWith('worktree '));
      const targetPath = await this.normalizePath(workspacePath);
      for (const line of worktrees) {
        const match = line.match(/^worktree\s+(.+)$/);
        if (!match) {
          continue;
        }
        const candidatePath = await this.normalizePath(match[1]);
        if (candidatePath === targetPath) {
          return line;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private async normalizePath(inputPath: string): Promise<string> {
    try {
      return await fs.promises.realpath(inputPath);
    } catch {
      return path.resolve(inputPath);
    }
  }

  private async resolveBranchStartPoint(sourcePath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`git -C "${sourcePath}" symbolic-ref --quiet refs/remotes/origin/HEAD`);
      const remoteDefaultRef = stdout.trim();
      if (remoteDefaultRef) {
        return remoteDefaultRef;
      }
    } catch {}

    try {
      const { stdout } = await execAsync(`git -C "${sourcePath}" branch --show-current`);
      const currentBranch = stdout.trim();
      if (currentBranch) {
        return currentBranch;
      }
    } catch {}

    return null;
  }

  private async ensureLocalRuntimeExcludes(workspacePath: string): Promise<void> {
    try {
      const excludeOutput = await execAsync(`git -C "${workspacePath}" rev-parse --git-path info/exclude`);
      const rawExcludePath = excludeOutput.stdout.trim();
      if (!rawExcludePath) {
        return;
      }

      const excludePath = path.isAbsolute(rawExcludePath)
        ? rawExcludePath
        : path.resolve(workspacePath, rawExcludePath);
      const infoDir = path.dirname(excludePath);
      await fs.promises.mkdir(infoDir, { recursive: true });

      let current = '';
      try {
        current = await fs.promises.readFile(excludePath, 'utf-8');
      } catch {}

      const requiredEntries = [
        '.symphony/',
        'target/',
        'Cargo.lock'
      ];
      const lines = new Set(
        current
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean)
      );

      let changed = false;
      for (const entry of requiredEntries) {
        if (!lines.has(entry)) {
          lines.add(entry);
          changed = true;
        }
      }

      if (!changed) {
        return;
      }

      await fs.promises.writeFile(
        excludePath,
        `${Array.from(lines).sort().join('\n')}\n`,
        'utf-8'
      );
    } catch {
      // Best-effort only.
    }
  }

  private async ensureLocalGitHooks(workspacePath: string): Promise<void> {
    const gitFile = path.join(workspacePath, '.git');

    try {
      const gitPointer = await fs.promises.readFile(gitFile, 'utf-8');
      const match = gitPointer.match(/gitdir:\s*(.+)\s*$/m);
      if (!match) {
        return;
      }

      const gitDir = path.resolve(workspacePath, match[1]);
      const commonDirOutput = await execAsync(`git -C "${workspacePath}" rev-parse --git-common-dir`);
      const commonDir = path.resolve(workspacePath, commonDirOutput.stdout.trim() || path.join(gitDir, '..', '..'));
      const hooksDir = path.join(commonDir, 'hooks');
      const preCommitPath = path.join(hooksDir, 'pre-commit');
      const managedHookPath = path.join(hooksDir, 'pre-commit.symphony');
      const userHookPath = path.join(hooksDir, 'pre-commit.user');
      await fs.promises.mkdir(hooksDir, { recursive: true });

      const managedHookScript = `#!/bin/sh
# symphony-workflow-guard
set -eu

blocked_paths=$(git diff --cached --name-only --diff-filter=ACMR -- ${WORKFLOW_ARTIFACT_PATHS.map((item) => `"${item}"`).join(' ')} || true)

if [ -n "$blocked_paths" ]; then
  echo "Symphony workflow artifacts must not be committed:" >&2
  echo "$blocked_paths" >&2
  echo "Keep DEVELOPMENT_LOG/HANDOVER/REVIEW_REPORT and .symphony outside product commits." >&2
  exit 1
fi
`;
      const wrapperScript = `#!/bin/sh
# symphony-managed-wrapper
set -eu

hook_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
"$hook_dir/pre-commit.symphony" "$@"

if [ -x "$hook_dir/pre-commit.user" ]; then
  exec "$hook_dir/pre-commit.user" "$@"
fi
`;

      let current = '';
      try {
        current = await fs.promises.readFile(preCommitPath, 'utf-8');
      } catch {}

      const isManagedHook =
        current.includes('symphony-managed-wrapper') ||
        current.includes('symphony-workflow-guard') ||
        current.includes('Symphony workflow artifacts must not be committed');

      if (current && !isManagedHook) {
        try {
          await fs.promises.access(userHookPath);
        } catch {
          await fs.promises.rename(preCommitPath, userHookPath);
        }
      }

      await fs.promises.writeFile(managedHookPath, managedHookScript, {
        encoding: 'utf-8',
        mode: 0o755,
      });
      await fs.promises.writeFile(preCommitPath, wrapperScript, {
        encoding: 'utf-8',
        mode: 0o755,
      });
      await fs.promises.chmod(managedHookPath, 0o755);
      await fs.promises.chmod(preCommitPath, 0o755);
    } catch {
      // Best-effort only.
    }
  }

  private async migrateLegacyWorkflowArtifacts(workspacePath: string): Promise<void> {
    const symphonyDir = path.join(workspacePath, '.symphony');
    const legacyFiles = ['DEVELOPMENT_LOG.md', 'HANDOVER.md', 'REVIEW_REPORT.md'];

    try {
      await fs.promises.mkdir(symphonyDir, { recursive: true });

      for (const filename of legacyFiles) {
        const legacyPath = path.join(workspacePath, filename);
        const currentPath = path.join(symphonyDir, filename);

        try {
          await fs.promises.access(legacyPath);
        } catch {
          continue;
        }

        try {
          await fs.promises.access(currentPath);
          continue;
        } catch {
          // Destination missing; migrate the legacy artifact.
        }

        await fs.promises.copyFile(legacyPath, currentPath);
      }
    } catch {
      // Best-effort only.
    }
  }
}
