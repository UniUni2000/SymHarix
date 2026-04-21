import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema } from '../database/schema';
import { WorkItemRepository } from '../database/repositories/workItemRepository';
import { ReviewEventRepository } from '../database/repositories/reviewEventRepository';
import { AgentRunRepository } from '../database/repositories/agentRunRepository';
import { GitHubContextService } from './contextService';

function createTestDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

class FakeGitHubContextClient {
  async getIssue(issueNumber: number) {
    return {
      number: issueNumber,
      url: `https://github.com/acme/repo/issues/${issueNumber}`,
      title: '[INT-101] Implement mapping layer',
      body: 'Issue body',
      labels: ['backend'],
      state: 'open',
    };
  }

  async listIssueComments() {
    return [
      {
        id: 1,
        body: 'Issue summary',
        author: 'symphony-bot',
        created_at: '2026-04-20T01:00:00Z',
        updated_at: '2026-04-20T01:00:00Z',
        url: 'https://github.com/acme/repo/issues/501#issuecomment-1',
      }
    ];
  }

  async getPullRequest(prNumber: number) {
    return {
      number: prNumber,
      url: `https://github.com/acme/repo/pull/${prNumber}`,
      title: 'Implement mapping layer',
      body: 'PR body',
      state: 'open',
      draft: false,
      head_branch: 'feature/int-101',
      head_sha: 'abc123',
      base_branch: 'main',
      mergeable: true,
      mergeable_state: 'clean',
    };
  }

  async findOpenPullRequestByBranch(branch: string) {
    return {
      number: 88,
      url: 'https://github.com/acme/repo/pull/88',
      title: `PR for ${branch}`,
      body: 'Fallback PR body',
      state: 'open',
      draft: false,
      head_branch: branch,
      head_sha: 'def456',
      base_branch: 'main',
      mergeable: true,
      mergeable_state: 'clean',
    };
  }

  async listPullRequestReviews() {
    return [
      {
        id: 10,
        state: 'COMMENTED',
        body: 'Please check one more thing',
        author: 'reviewer-1',
        submitted_at: '2026-04-20T02:00:00Z',
        commit_id: 'abc123',
        url: 'https://github.com/acme/repo/pull/77#pullrequestreview-10',
      },
      {
        id: 11,
        state: 'CHANGES_REQUESTED',
        body: 'Need test coverage',
        author: 'reviewer-2',
        submitted_at: '2026-04-20T02:05:00Z',
        commit_id: 'abc123',
        url: 'https://github.com/acme/repo/pull/77#pullrequestreview-11',
      }
    ];
  }

  async listPullRequestReviewComments() {
    return [
      {
        id: 100,
        body: 'Please add tests',
        path: 'src/github/mappingService.ts',
        line: 42,
        in_reply_to_id: null,
        author: 'reviewer-2',
        created_at: '2026-04-20T02:06:00Z',
        updated_at: '2026-04-20T02:06:00Z',
        url: 'https://github.com/acme/repo/pull/77#discussion_r100',
      },
      {
        id: 101,
        body: 'Will do',
        path: 'src/github/mappingService.ts',
        line: 42,
        in_reply_to_id: 100,
        author: 'dev-agent',
        created_at: '2026-04-20T02:07:00Z',
        updated_at: '2026-04-20T02:07:00Z',
        url: 'https://github.com/acme/repo/pull/77#discussion_r101',
      }
    ];
  }

  async getCombinedStatus() {
    return {
      state: 'pending',
      statuses: [
        {
          context: 'ci/test',
          state: 'pending',
          description: 'Tests are running',
          target_url: 'https://ci.example.test/run/1',
        }
      ],
    };
  }
}

describe('GitHubContextService', () => {
  let db: Database;
  let workItemRepository: WorkItemRepository;
  let reviewEventRepository: ReviewEventRepository;
  let agentRunRepository: AgentRunRepository;
  let service: GitHubContextService;

  beforeEach(() => {
    db = createTestDatabase();
    workItemRepository = new WorkItemRepository(db);
    reviewEventRepository = new ReviewEventRepository(db);
    agentRunRepository = new AgentRunRepository(db);

    workItemRepository.create({
      id: 'wi-ctx',
      linear_issue_id: 'linear-ctx',
      linear_identifier: 'INT-101',
      linear_title: 'Implement mapping layer',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      github_issue_number: 501,
      active_pr_number: 77,
      branch_name: 'feature/int-101',
      orchestrator_state: 'review_running',
    });

    reviewEventRepository.create({
      id: 'review-1',
      work_item_id: 'wi-ctx',
      pr_number: 77,
      review_round: 1,
      decision: 'REQUEST_CHANGES',
      summary_md: 'Need test coverage',
      requested_changes_md: '- add mapping service tests',
    });

    agentRunRepository.create({
      id: 'run-1',
      work_item_id: 'wi-ctx',
      agent_type: 'dev',
      phase: 'coding',
      input_summary: 'GitHub issue + PR context',
      output_summary: 'Implemented mapping service',
      run_status: 'completed',
      finished_at: new Date('2026-04-20T03:00:00Z'),
    });

    agentRunRepository.create({
      id: 'run-2',
      work_item_id: 'wi-ctx',
      agent_type: 'review',
      phase: 'review',
      input_summary: 'PR diff',
      output_summary: 'Requested changes',
      run_status: 'completed',
      finished_at: new Date('2026-04-20T03:05:00Z'),
    });

    service = new GitHubContextService({
      workItemRepository,
      reviewEventRepository,
      agentRunRepository,
      githubClientFactory: () => new FakeGitHubContextClient(),
    });
  });

  afterEach(() => {
    db.close();
  });

  it('should build dev context with grouped review threads and latest review summary', async () => {
    const context = await service.buildDevContext('wi-ctx');

    expect(context.github_issue?.number).toBe(501);
    expect(context.active_pr?.number).toBe(77);
    expect(context.active_pr?.review_state).toBe('changes_requested');
    expect(context.unresolved_review_threads).toHaveLength(1);
    expect(context.unresolved_review_threads[0]?.comments).toHaveLength(2);
    expect(context.latest_review?.summary_md).toBe('Need test coverage');
    expect(context.recent_agent_runs).toHaveLength(2);
  });

  it('should build review context and expose latest dev run', async () => {
    const context = await service.buildReviewContext('wi-ctx');

    expect(context.previous_reviews).toHaveLength(1);
    expect(context.latest_dev_run?.id).toBe('run-1');
    expect(context.active_pr?.combined_status?.state).toBe('pending');
  });

  it('should fall back to branch lookup when active PR number is missing', async () => {
    workItemRepository.update({
      id: 'wi-ctx',
      active_pr_number: null,
    });

    const context = await service.buildDevContext('wi-ctx');
    expect(context.active_pr?.number).toBe(88);
    expect(context.active_pr?.head_branch).toBe('feature/int-101');
  });
});
