import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema } from '../database/schema';
import { WorkItemRepository } from '../database';
import { GlobalRepairService } from './globalRepair';
import type { Issue, ServiceConfig } from '../types';

function makeConfig(): ServiceConfig {
  return {
    trackerKind: 'linear',
    trackerEndpoint: 'https://api.linear.app/graphql',
    trackerApiKey: 'test-key',
    githubOwner: 'owner',
    githubToken: 'token',
    activeStates: ['Todo', 'In Progress', 'In Review'],
    terminalStates: ['Done', 'Cancelled', 'Canceled', 'Duplicate'],
    pollIntervalMs: 1000,
    workspaceRoot: '/tmp/symphony-tests',
    projectRoot: '/tmp/symphony-project',
    repositories: {
      routing: {
        test2: {
          github_owner: 'owner',
          github_repo: 'repo',
          local_path: null,
        },
      },
    },
    hooks: {
      after_create: null,
      timeout_ms: 1000,
    },
    maxConcurrentAgents: 1,
    maxRetryBackoffMs: 1000,
    maxConcurrentAgentsByState: new Map(),
    maxTurns: 3,
    codexCommand: 'codex',
    codexApprovalPolicy: null,
    codexThreadSandbox: null,
    codexTurnSandboxPolicy: null,
    codexTurnTimeoutMs: 1000,
    codexReadTimeoutMs: 100,
    codexStallTimeoutMs: 10_000,
    devPolicy: {
      maxDevAttempts: 2,
    },
    reviewPolicy: {
      notifyLinearOnReview: true,
    },
    verification: {
      lifecycle: {
        timeoutMs: 60_000,
        pollIntervalMs: 1000,
        projects: {},
      },
    },
    serverPort: null,
  };
}

function makeTerminalIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'INT-88',
    title: 'Terminal issue',
    description: 'done',
    priority: 1,
    state: 'Done',
    project_slug: 'test2',
    project_name: 'repo',
    branch_name: 'feature/int-88',
    url: 'https://linear.app/example/issue/INT-88',
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('GlobalRepairService', () => {
  test('closes orphan GitHub issues and PRs that still point at terminal tracker issues', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const workItems = new WorkItemRepository(db);

    workItems.create({
      id: 'issue-1',
      linear_issue_id: 'issue-1',
      linear_identifier: 'INT-88',
      linear_title: 'Terminal issue',
      linear_state: 'Done',
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
    });

    const closeIssue = mock(async () => undefined);
    const updatePullRequest = mock(async () => ({
      number: 41,
      url: 'https://github.com/owner/repo/pull/41',
      title: '[INT-88] stale PR',
      body: null,
      state: 'closed',
      draft: false,
      head_branch: 'feature/int-88',
      head_sha: 'abc123',
      base_branch: 'main',
      mergeable: null,
      mergeable_state: null,
    }));

    const service = new GlobalRepairService({
      config: makeConfig(),
      tracker: {
        fetchIssuesByStates: mock(async () => ({
          issues: [makeTerminalIssue()],
          error: null,
        })),
      } as any,
      workItemRepository: workItems,
      githubClientFactory: () => ({
        listOpenIssues: mock(async () => [
          {
            number: 31,
            url: 'https://github.com/owner/repo/issues/31',
            title: '[INT-88] stale mapped issue',
            body: '## Linear Issue\nINT-88',
            labels: [],
            state: 'open',
          },
        ]),
        listOpenPullRequests: mock(async () => [
          {
            number: 41,
            url: 'https://github.com/owner/repo/pull/41',
            title: '[INT-88] stale PR',
            body: null,
            state: 'open',
            draft: false,
            head_branch: 'feature/int-88',
            head_sha: 'abc123',
            base_branch: 'main',
            mergeable: null,
            mergeable_state: null,
          },
        ]),
        closeIssue,
        updatePullRequest,
      }),
    });

    const summary = await service.repair();

    expect(closeIssue).toHaveBeenCalledWith(31);
    expect(updatePullRequest).toHaveBeenCalledWith(41, { state: 'closed' });
    expect(summary).toEqual({
      terminal_issues_scanned: 1,
      repos_scanned: 1,
      github_issues_closed: 1,
      github_prs_closed: 1,
    });

    db.close();
  });

  test('continues scanning other repos when one repo fails to list open artifacts', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const workItems = new WorkItemRepository(db);
    const warnSpy = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;

    workItems.create({
      id: 'issue-1',
      linear_issue_id: 'issue-1',
      linear_identifier: 'INT-88',
      linear_title: 'Terminal issue',
      linear_state: 'Done',
      github_repo: 'owner/repo-a',
      orchestrator_state: 'completed',
    });
    workItems.create({
      id: 'issue-2',
      linear_issue_id: 'issue-2',
      linear_identifier: 'INT-89',
      linear_title: 'Terminal issue 2',
      linear_state: 'Done',
      github_repo: 'owner/repo-b',
      orchestrator_state: 'completed',
    });

    const service = new GlobalRepairService({
      config: makeConfig(),
      tracker: {
        fetchIssuesByStates: mock(async () => ({
          issues: [
            makeTerminalIssue({ identifier: 'INT-88', id: 'issue-1', project_slug: null }),
            makeTerminalIssue({ identifier: 'INT-89', id: 'issue-2', project_slug: null }),
          ],
          error: null,
        })),
      } as any,
      workItemRepository: workItems,
      githubClientFactory: (repo) => {
        if (repo === 'owner/repo-a') {
          return {
            listOpenIssues: mock(async () => {
              throw new Error('repo-a unavailable');
            }),
            listOpenPullRequests: mock(async () => []),
            closeIssue: mock(async () => undefined),
            updatePullRequest: mock(async () => {
              throw new Error('should not be called');
            }),
          };
        }

        return {
          listOpenIssues: mock(async () => [{
            number: 51,
            url: 'https://github.com/owner/repo-b/issues/51',
            title: '[INT-89] stale mapped issue',
            body: null,
            labels: [],
            state: 'open',
          }]),
          listOpenPullRequests: mock(async () => []),
          closeIssue: mock(async () => undefined),
          updatePullRequest: mock(async () => {
            throw new Error('should not be called');
          }),
        };
      },
    });

    try {
      const summary = await service.repair();

      expect(summary).toEqual({
        terminal_issues_scanned: 2,
        repos_scanned: 2,
        github_issues_closed: 1,
        github_prs_closed: 0,
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
      db.close();
    }
  });

  test('continues after individual GitHub close operations fail', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const workItems = new WorkItemRepository(db);
    const warnSpy = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;

    workItems.create({
      id: 'issue-1',
      linear_issue_id: 'issue-1',
      linear_identifier: 'INT-88',
      linear_title: 'Terminal issue',
      linear_state: 'Done',
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
    });

    const closeIssue = mock(async (issueNumber: number) => {
      if (issueNumber === 31) {
        throw new Error('close failed');
      }
    });
    const updatePullRequest = mock(async (prNumber: number) => {
      if (prNumber === 42) {
        throw new Error('close pr failed');
      }
      return {
        number: prNumber,
        url: `https://github.com/owner/repo/pull/${prNumber}`,
        title: `[INT-88] stale PR ${prNumber}`,
        body: null,
        state: 'closed',
        draft: false,
        head_branch: 'feature/int-88',
        head_sha: 'abc123',
        base_branch: 'main',
        mergeable: null,
        mergeable_state: null,
      };
    });

    const service = new GlobalRepairService({
      config: makeConfig(),
      tracker: {
        fetchIssuesByStates: mock(async () => ({
          issues: [makeTerminalIssue()],
          error: null,
        })),
      } as any,
      workItemRepository: workItems,
      githubClientFactory: () => ({
        listOpenIssues: mock(async () => [
          {
            number: 31,
            url: 'https://github.com/owner/repo/issues/31',
            title: '[INT-88] stale mapped issue',
            body: null,
            labels: [],
            state: 'open',
          },
          {
            number: 32,
            url: 'https://github.com/owner/repo/issues/32',
            title: '[INT-88] stale mapped issue 2',
            body: null,
            labels: [],
            state: 'open',
          },
        ]),
        listOpenPullRequests: mock(async () => [
          {
            number: 42,
            url: 'https://github.com/owner/repo/pull/42',
            title: '[INT-88] stale PR',
            body: null,
            state: 'open',
            draft: false,
            head_branch: 'feature/int-88',
            head_sha: 'abc123',
            base_branch: 'main',
            mergeable: null,
            mergeable_state: null,
          },
          {
            number: 43,
            url: 'https://github.com/owner/repo/pull/43',
            title: '[INT-88] stale PR 2',
            body: null,
            state: 'open',
            draft: false,
            head_branch: 'feature/int-88',
            head_sha: 'abc123',
            base_branch: 'main',
            mergeable: null,
            mergeable_state: null,
          },
        ]),
        closeIssue,
        updatePullRequest,
      }),
    });

    try {
      const summary = await service.repair();

      expect(closeIssue).toHaveBeenCalledTimes(2);
      expect(updatePullRequest).toHaveBeenCalledTimes(2);
      expect(summary).toEqual({
        terminal_issues_scanned: 1,
        repos_scanned: 1,
        github_issues_closed: 1,
        github_prs_closed: 1,
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
      db.close();
    }
  });
});
