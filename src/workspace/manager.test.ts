import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import { WorkspaceManager } from './manager';

function run(cmd: string, cwd?: string): string {
  return cp.execSync(cmd, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function createSeedRepo(projectRoot: string, repoName: string): string {
  const repoPath = path.join(projectRoot, repoName);
  fs.mkdirSync(repoPath, { recursive: true });
  run('git init -b main', repoPath);
  run('git config user.name "Symphony Test"', repoPath);
  run('git config user.email "symphony-test@example.com"', repoPath);
  fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${repoName}\n`);
  run('git add README.md', repoPath);
  run('git commit -m "Initial commit"', repoPath);
  return repoPath;
}

function commitSeedChange(repoPath: string, filename: string, content: string, message: string): void {
  fs.writeFileSync(path.join(repoPath, filename), content);
  run(`git add ${filename}`, repoPath);
  run(`git commit -m "${message}"`, repoPath);
}

describe('WorkspaceManager', () => {
  let tempRoot: string;
  let projectRoot: string;
  let workspaceRoot: string;
  let manager: WorkspaceManager;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-workspace-'));
    projectRoot = path.join(tempRoot, 'projects');
    workspaceRoot = path.join(tempRoot, 'workspace');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });

    createSeedRepo(projectRoot, 'sample-repo');

    manager = new WorkspaceManager({
      workspaceRoot,
      projectRoot,
      githubOwner: 'acme',
      githubToken: '',
      hooks: {
        after_create: null,
        before_run: null,
        after_run: null,
        before_remove: null,
        timeout_ms: 1000,
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('creates shared source under repo root and issue worktree underneath worktrees', async () => {
    const result = await manager.createForIssue({
      identifier: 'INT-101',
      project_slug: 'sample-repo',
      project_name: 'sample-repo',
    });

    expect(result.success).toBe(true);
    expect(result.workspace?.created_now).toBe(true);

    const sourcePath = manager.getRepoSourcePath('sample-repo', 'sample-repo');
    const workspacePath = manager.getWorkspacePath('INT-101', 'sample-repo', 'sample-repo');

    expect(result.workspace?.path).toBe(workspacePath);
    expect(sourcePath).toBe(path.join(workspaceRoot, 'sample-repo', 'source'));
    expect(workspacePath).toBe(path.join(workspaceRoot, 'sample-repo', 'worktrees', 'INT-101'));
    expect(fs.existsSync(path.join(sourcePath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'README.md'))).toBe(true);

    const gitPointer = fs.readFileSync(path.join(workspacePath, '.git'), 'utf8');
    const gitDir = path.resolve(workspacePath, gitPointer.replace(/^gitdir:\s*/, '').trim());
    const excludeContent = fs.readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8');
    expect(excludeContent).toContain('.symphony/');
  });

  it('reuses same worktree for the same issue and shares the same repo source', async () => {
    const first = await manager.createForIssue({
      identifier: 'INT-102',
      project_slug: 'sample-repo',
      project_name: 'sample-repo',
    });
    const second = await manager.createForIssue({
      identifier: 'INT-102',
      project_slug: 'sample-repo',
      project_name: 'sample-repo',
    });
    const other = await manager.createForIssue({
      identifier: 'INT-103',
      project_slug: 'sample-repo',
      project_name: 'sample-repo',
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.workspace?.created_now).toBe(false);
    expect(other.success).toBe(true);

    const sourcePath = manager.getRepoSourcePath('sample-repo', 'sample-repo');
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(first.workspace?.path).toBe(second.workspace?.path);
    expect(other.workspace?.path).not.toBe(first.workspace?.path);
  });

  it('removes only the issue worktree and preserves shared source cache', async () => {
    const result = await manager.createForIssue({
      identifier: 'INT-104',
      project_slug: 'sample-repo',
      project_name: 'sample-repo',
    });

    expect(result.success).toBe(true);
    const workspacePath = result.workspace!.path;
    const sourcePath = manager.getRepoSourcePath('sample-repo', 'sample-repo');

    const removed = await manager.removeWorkspace(workspacePath, 'sample-repo');
    expect(removed.success).toBe(true);
    expect(fs.existsSync(workspacePath)).toBe(false);
    expect(fs.existsSync(path.join(sourcePath, '.git'))).toBe(true);
  });

  it('starts a new issue worktree from the latest fetched remote default branch', async () => {
    const first = await manager.createForIssue({
      identifier: 'INT-105',
      project_slug: 'sample-repo',
      project_name: 'sample-repo',
    });

    expect(first.success).toBe(true);

    const seedRepoPath = path.join(projectRoot, 'sample-repo');
    commitSeedChange(seedRepoPath, 'LATEST.txt', 'remote v2\n', 'Advance default branch');

    const second = await manager.createForIssue({
      identifier: 'INT-106',
      project_slug: 'sample-repo',
      project_name: 'sample-repo',
    });

    expect(second.success).toBe(true);

    const sourcePath = manager.getRepoSourcePath('sample-repo', 'sample-repo');
    const workspacePath = second.workspace!.path;

    expect(fs.readFileSync(path.join(sourcePath, 'LATEST.txt'), 'utf8')).toBe('remote v2\n');
    expect(fs.readFileSync(path.join(workspacePath, 'LATEST.txt'), 'utf8')).toBe('remote v2\n');
  });

  it('copies legacy workflow artifacts into .symphony without deleting tracked root files', async () => {
    const seedRepoPath = path.join(projectRoot, 'sample-repo');
    fs.writeFileSync(path.join(seedRepoPath, 'HANDOVER.md'), '# Legacy handover\n');
    fs.writeFileSync(path.join(seedRepoPath, 'REVIEW_REPORT.md'), '# Legacy review\n');
    run('git add HANDOVER.md REVIEW_REPORT.md', seedRepoPath);
    run('git commit -m "Add legacy workflow artifacts"', seedRepoPath);

    const result = await manager.createForIssue({
      identifier: 'INT-107',
      project_slug: 'sample-repo',
      project_name: 'sample-repo',
    });

    expect(result.success).toBe(true);

    const workspacePath = result.workspace!.path;
    expect(fs.readFileSync(path.join(workspacePath, 'HANDOVER.md'), 'utf8')).toBe('# Legacy handover\n');
    expect(fs.readFileSync(path.join(workspacePath, '.symphony', 'HANDOVER.md'), 'utf8')).toBe('# Legacy handover\n');
    expect(fs.readFileSync(path.join(workspacePath, '.symphony', 'REVIEW_REPORT.md'), 'utf8')).toBe('# Legacy review\n');

    const statusOutput = run('git status --short', workspacePath);
    expect(statusOutput).not.toContain(' D HANDOVER.md');
    expect(statusOutput).not.toContain(' D REVIEW_REPORT.md');
  });

  it('installs a pre-commit hook that blocks workflow artifacts from being committed', async () => {
    const result = await manager.createForIssue({
      identifier: 'INT-108',
      project_slug: 'sample-repo',
      project_name: 'sample-repo',
    });

    expect(result.success).toBe(true);

    const workspacePath = result.workspace!.path;
    const commonGitDir = run('git rev-parse --git-common-dir', workspacePath);
    const resolvedCommonGitDir = path.resolve(workspacePath, commonGitDir);
    const hookPath = path.join(resolvedCommonGitDir, 'hooks', 'pre-commit');
    const managedHookPath = path.join(resolvedCommonGitDir, 'hooks', 'pre-commit.symphony');

    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.existsSync(managedHookPath)).toBe(true);
    expect(fs.readFileSync(managedHookPath, 'utf8')).toContain('Symphony workflow artifacts must not be committed');

    fs.writeFileSync(path.join(workspacePath, 'HANDOVER.md'), '# Generated handover\n');
    run('git add HANDOVER.md', workspacePath);

    expect(() => run('git commit -m "bad commit"', workspacePath)).toThrow(
      /Symphony workflow artifacts must not be committed/,
    );
  });
});
