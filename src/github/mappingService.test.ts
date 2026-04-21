import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema } from '../database/schema';
import { WorkItemRepository } from '../database/repositories/workItemRepository';
import { SyncEventRepository } from '../database/repositories/syncEventRepository';
import type { Issue } from '../types';
import { GitHubMappingService } from './mappingService';

function createTestDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'linear-1',
    identifier: 'INT-101',
    title: 'Implement mapping layer',
    description: 'Need a GitHub issue and PR mapping',
    priority: 1,
    state: 'Todo',
    project_slug: 'repo',
    project_name: 'Repo',
    branch_name: null,
    url: 'https://linear.app/acme/issue/INT-101',
    labels: ['backend'],
    blocked_by: [],
    created_at: new Date('2026-04-20T00:00:00Z'),
    updated_at: new Date('2026-04-20T00:00:00Z'),
    ...overrides,
  };
}

class FakeGitHubMappingClient {
  createIssueCalls = 0;
  createPullRequestCalls = 0;
  updatePullRequestCalls = 0;
  issues = new Map<number, { number: number; url: string }>();
  pullRequests = new Map<number, any>();
  branchToPr = new Map<string, any>();

  async issueExists(issueNumber: number): Promise<boolean> {
    return this.issues.has(issueNumber);
  }

  async createIssue(): Promise<{ number: number; url: string }> {
    this.createIssueCalls += 1;
    const created = { number: 501, url: 'https://github.com/acme/repo/issues/501' };
    this.issues.set(created.number, created);
    return created;
  }

  async getPullRequest(prNumber: number): Promise<any> {
    const pr = this.pullRequests.get(prNumber);
    if (!pr) {
      throw new Error('PR not found');
    }
    return pr;
  }

  async findOpenPullRequestByBranch(branch: string): Promise<any | null> {
    return this.branchToPr.get(branch) ?? null;
  }

  async createPullRequest(params: { title: string; body?: string; head: string }): Promise<any> {
    this.createPullRequestCalls += 1;
    const created = {
      number: 77,
      url: 'https://github.com/acme/repo/pull/77',
      title: params.title,
      body: params.body ?? '',
      state: 'open',
      draft: false,
      head_branch: params.head,
      head_sha: 'abc123',
      base_branch: 'main',
      mergeable: true,
      mergeable_state: 'clean',
    };
    this.pullRequests.set(created.number, created);
    this.branchToPr.set(params.head, created);
    return created;
  }

  async updatePullRequest(prNumber: number, params: { title?: string; body?: string }): Promise<any> {
    this.updatePullRequestCalls += 1;
    const current = this.pullRequests.get(prNumber);
    const updated = {
      ...current,
      title: params.title ?? current.title,
      body: params.body ?? current.body,
    };
    this.pullRequests.set(prNumber, updated);
    this.branchToPr.set(updated.head_branch, updated);
    return updated;
  }
}

describe('GitHubMappingService', () => {
  let db: Database;
  let workItemRepository: WorkItemRepository;
  let syncEventRepository: SyncEventRepository;
  let client: FakeGitHubMappingClient;
  let service: GitHubMappingService;

  beforeEach(() => {
    db = createTestDatabase();
    workItemRepository = new WorkItemRepository(db);
    syncEventRepository = new SyncEventRepository(db);
    client = new FakeGitHubMappingClient();
    service = new GitHubMappingService({
      workItemRepository,
      syncEventRepository,
      githubClientFactory: () => client,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('should create and reuse GitHub issue mapping for a Linear issue', async () => {
    const issue = createIssue();

    const first = await service.ensureGitHubIssue(issue, 'acme/repo');
    expect(first.created).toBe(true);
    expect(first.workItem.github_issue_number).toBe(501);
    expect(client.createIssueCalls).toBe(1);

    const second = await service.ensureGitHubIssue(issue, 'acme/repo');
    expect(second.created).toBe(false);
    expect(second.workItem.github_issue_number).toBe(501);
    expect(client.createIssueCalls).toBe(1);

    const syncEvents = syncEventRepository.findByWorkItemId(issue.id);
    expect(syncEvents).toHaveLength(1);
    expect(syncEvents[0]?.action).toBe('create_issue');
  });

  it('should attach workspace and keep mapping queryable for recovery', () => {
    const issue = createIssue();
    const workItem = service.ensureWorkItem(issue, 'acme/repo');
    const attached = service.attachWorkspace(workItem.id, '/workspace/repo/worktrees/INT-101', 'INT-101');

    expect(attached.workspace_path).toBe('/workspace/repo/worktrees/INT-101');
    expect(attached.orchestrator_state).toBe('workspace_ready');
    expect(service.findByLinearIssueId(issue.id)?.id).toBe(workItem.id);
    expect(service.findByIdentifier(issue.identifier)?.id).toBe(workItem.id);
  });

  it('should create one active pull request mapping and recover it by branch', async () => {
    const issue = createIssue();
    const workItem = service.ensureWorkItem(issue, 'acme/repo');

    const first = await service.ensurePullRequest({
      workItemId: workItem.id,
      title: 'Implement mapping layer',
      body: 'This adds mapping support.',
      headBranch: 'feature/int-101',
    });

    expect(first.created).toBe(true);
    expect(first.workItem.active_pr_number).toBe(77);
    expect(client.createPullRequestCalls).toBe(1);

    const second = await service.ensurePullRequest({
      workItemId: workItem.id,
      title: 'Implement mapping layer',
      body: 'This adds mapping support.',
      headBranch: 'feature/int-101',
    });

    expect(second.created).toBe(false);
    expect(second.workItem.active_pr_number).toBe(77);
    expect(client.createPullRequestCalls).toBe(1);
    expect(service.findByPullRequest('acme/repo', 77)?.id).toBe(workItem.id);
    expect(service.findByBranch('acme/repo', 'feature/int-101')?.id).toBe(workItem.id);
  });
});
