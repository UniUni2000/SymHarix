import * as path from 'path';

/**
 * Sanitize an issue identifier or repo name for safe filesystem use.
 */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function resolveWorkspaceProjectName(projectSlug?: string | null, projectName?: string | null): string {
  return projectName
    ? sanitizeWorkspaceKey(projectName)
    : (projectSlug ? sanitizeWorkspaceKey(projectSlug) : 'main');
}

export function getRepoRootPath(workspaceRoot: string, projectSlug?: string | null, projectName?: string | null): string {
  return path.join(workspaceRoot, resolveWorkspaceProjectName(projectSlug, projectName));
}

export function getRepoSourcePath(workspaceRoot: string, projectSlug?: string | null, projectName?: string | null): string {
  return path.join(getRepoRootPath(workspaceRoot, projectSlug, projectName), 'source');
}

export function getRepoWorktreesRoot(workspaceRoot: string, projectSlug?: string | null, projectName?: string | null): string {
  return path.join(getRepoRootPath(workspaceRoot, projectSlug, projectName), 'worktrees');
}

export function getIssueWorktreePath(
  workspaceRoot: string,
  identifier: string,
  projectSlug?: string | null,
  projectName?: string | null
): string {
  const workspaceKey = sanitizeWorkspaceKey(identifier);
  return path.join(getRepoWorktreesRoot(workspaceRoot, projectSlug, projectName), workspaceKey);
}

export function getSourcePathFromWorktree(workspacePath: string): string {
  const worktreesRoot = path.dirname(workspacePath);
  const repoRoot = path.dirname(worktreesRoot);
  return path.join(repoRoot, 'source');
}
