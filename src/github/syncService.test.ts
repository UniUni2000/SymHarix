import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema } from '../database/schema';
import { WorkItemRepository } from '../database/repositories/workItemRepository';
import { SyncEventRepository } from '../database/repositories/syncEventRepository';
import { GitHubSyncService } from './syncService';

function createTestDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

class FakeGitHubSyncClient {
  issueComments: Array<{ issueNumber: number; body: string }> = [];
  prComments: Array<{ prNumber: number; body: string }> = [];

  async addComment(issueNumber: number, body: string): Promise<void> {
    this.issueComments.push({ issueNumber, body });
  }

  async addPullRequestComment(prNumber: number, body: string): Promise<void> {
    this.prComments.push({ prNumber, body });
  }
}

describe('GitHubSyncService', () => {
  let db: Database;
  let workItemRepository: WorkItemRepository;
  let syncEventRepository: SyncEventRepository;
  let client: FakeGitHubSyncClient;
  let service: GitHubSyncService;

  beforeEach(() => {
    db = createTestDatabase();
    workItemRepository = new WorkItemRepository(db);
    syncEventRepository = new SyncEventRepository(db);
    client = new FakeGitHubSyncClient();

    workItemRepository.create({
      id: 'wi-sync',
      linear_issue_id: 'linear-sync',
      linear_identifier: 'INT-202',
      linear_title: 'Publish PR summary',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      github_issue_number: 601,
      active_pr_number: 88,
      branch_name: 'feature/int-202',
      orchestrator_state: 'review_running',
    });

    service = new GitHubSyncService({
      workItemRepository,
      syncEventRepository,
      githubClientFactory: () => client,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('should publish PR summaries back to the GitHub issue and log sync events', async () => {
    await service.publishPullRequestSummary('wi-sync', 'Implemented the mapping and context layer.');

    expect(client.issueComments).toHaveLength(1);
    expect(client.issueComments[0]?.issueNumber).toBe(601);
    expect(client.issueComments[0]?.body).toContain('PR #88');

    const syncEvents = syncEventRepository.findByWorkItemId('wi-sync');
    expect(syncEvents).toHaveLength(1);
    expect(syncEvents[0]?.action).toBe('publish_pr_summary');
  });
});
