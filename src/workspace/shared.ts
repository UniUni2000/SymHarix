import * as path from 'path';

/**
 * Sanitize an issue identifier or repo name for safe filesystem use.
 */
export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function resolveRepoCacheKey(cacheKey: string): string {
  return sanitizeWorkspaceKey(cacheKey);
}

export function getRepoRootPath(workspaceRoot: string, cacheKey: string): string {
  return path.join(workspaceRoot, resolveRepoCacheKey(cacheKey));
}

export function getRepoSourcePath(workspaceRoot: string, cacheKey: string): string {
  return path.join(getRepoRootPath(workspaceRoot, cacheKey), 'source');
}

export function getRepoWorktreesRoot(workspaceRoot: string, cacheKey: string): string {
  return path.join(getRepoRootPath(workspaceRoot, cacheKey), 'worktrees');
}

export function getIssueWorktreePath(
  workspaceRoot: string,
  identifier: string,
  cacheKey: string,
): string {
  const workspaceKey = sanitizeWorkspaceKey(identifier);
  return path.join(getRepoWorktreesRoot(workspaceRoot, cacheKey), workspaceKey);
}

export function getSourcePathFromWorktree(workspacePath: string): string {
  const worktreesRoot = path.dirname(workspacePath);
  const repoRoot = path.dirname(worktreesRoot);
  return path.join(repoRoot, 'source');
}
