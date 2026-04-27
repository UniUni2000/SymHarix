import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeSchema } from '../database/schema';
import { ReviewEventRepository, WorkItemRepository } from '../database';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeTimelineEvent } from '../runtime/types';
import type { ServiceConfig, WorkflowDefinition } from '../types';
import { LiveLifecycleVerifier } from './liveLifecycleVerifier';

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    trackerKind: 'linear',
    trackerEndpoint: 'https://api.linear.app/graphql',
    trackerApiKey: 'test-key',
    githubOwner: 'owner',
    githubToken: 'token',
    activeStates: ['Todo', 'In Progress', 'In Review'],
    terminalStates: ['Done', 'Cancelled'],
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
    maxTurns: 2,
    codexCommand: 'claude-haha',
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
        pollIntervalMs: 1,
        projects: {
          test2: {
            title: 'Lifecycle smoke test',
            description: 'Create a tiny change and verify the full lifecycle.',
          },
        },
      },
    },
    serverPort: null,
    ...overrides,
  };
}

function makeWorkflow(): WorkflowDefinition {
  return {
    config: {},
    prompt_template: 'Prompt',
  };
}

function makeIssueView(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-1',
    work_item_id: 'issue-1',
    identifier: 'INT-1',
    title: 'Lifecycle smoke test',
    phase: 'DEV',
    tracker_state: 'Todo',
    orchestrator_state: 'discovering',
    workspace_path: '/tmp/workspaces/owner__repo/worktrees/INT-1',
    branch_name: 'feature/int-1',
    github_repo: 'owner/repo',
    github_issue_number: 101,
    active_pr_number: null,
    session: null,
    actions: {
      can_stop: true,
      can_retry: false,
      can_open_pr: false,
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type FakeDiagnostics = {
  running_issue_count: number;
  retry_count: number;
  worker_process_count: number;
  active_session_count: number;
  claimed_issue_count: number;
  leadership_lease_held: boolean;
};

class FakeRuntimeHost {
  public readonly start = mock(async () => undefined);
  public readonly stop = mock(async () => undefined);

  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly config: ServiceConfig,
    private readonly diagnostics: () => FakeDiagnostics,
  ) {}

  getRuntimeHub(): RuntimeControlPlane {
    return this.runtime;
  }

  getConfig(): ServiceConfig {
    return this.config;
  }

  getDiagnosticsSnapshot(): FakeDiagnostics {
    return this.diagnostics();
  }
}

describe('LiveLifecycleVerifier', () => {
  let db: Database;
  let tempRoot: string;

  afterEach(() => {
    db?.close();
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('fails closed when the requested project has no lifecycle scenario', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime: RuntimeControlPlane = {
      getOverview: () => ({ generated_at: '', counts: { running: 0, retrying: 0, total: 0 }, issues: [] }),
      getIssue: () => null,
      getTimeline: () => [],
      getHistoryView: () => null,
      createIssue: async () => ({ accepted: true, status: 'accepted', message: 'created', issue_id: 'issue-1', issue_identifier: 'INT-1', issue: null }),
      stopIssue: async () => ({ accepted: true, status: 'accepted', message: 'stopped', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      retryIssue: async () => ({ accepted: true, status: 'queued', message: 'retried', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      rewriteGovernance: async () => ({ accepted: true, status: 'accepted', message: 'rewritten', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      splitGovernance: async () => ({ accepted: true, status: 'accepted', message: 'split', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      createStream: () => new ReadableStream(),
      subscribe: () => () => undefined,
    };

    const verifier = new LiveLifecycleVerifier({
      db,
      config: makeConfig({
        verification: {
          lifecycle: {
            timeoutMs: 1000,
            pollIntervalMs: 1,
            projects: {},
          },
        },
      }),
      workflow: makeWorkflow(),
      runtimeHostFactory: async () => new FakeRuntimeHost(runtime, makeConfig(), () => ({
        running_issue_count: 0,
        retry_count: 0,
        worker_process_count: 0,
        active_session_count: 0,
        claimed_issue_count: 0,
        leadership_lease_held: false,
      })) as any,
    });

    const result = await verifier.verify({
      projectSlug: 'test2',
    });

    expect(result.success).toBe(false);
    expect(result.failure_code).toBe('missing_verification_scenario');
  });

  test('returns a successful verification result once the full lifecycle and cleanup complete', async () => {
    db = new Database(':memory:');
    initializeSchema(db);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-live-verify-'));

    const config = makeConfig({
      workspaceRoot: tempRoot,
      projectRoot: tempRoot,
    });
    const workItemRepository = new WorkItemRepository(db);
    const reviewEventRepository = new ReviewEventRepository(db);
    const worktreePath = path.join(tempRoot, 'owner__repo', 'worktrees', 'INT-1');
    fs.mkdirSync(path.join(tempRoot, 'owner__repo', 'source'), { recursive: true });

    let pollCount = 0;
    const runtime: RuntimeControlPlane = {
      getOverview: () => ({ generated_at: '', counts: { running: 0, retrying: 0, total: 1 }, issues: [] }),
      getIssue: () => {
        pollCount += 1;
        if (pollCount === 1) {
          workItemRepository.upsert({
            id: 'issue-1',
            linear_issue_id: 'issue-1',
            linear_identifier: 'INT-1',
            linear_title: 'Lifecycle smoke test',
            linear_state: 'Todo',
            github_repo: 'owner/repo',
            github_issue_number: 101,
            branch_name: 'feature/int-1',
            workspace_path: worktreePath,
            orchestrator_state: 'dev_running',
          });
          return makeIssueView({
            tracker_state: 'In Progress',
            orchestrator_state: 'dev_running',
            workspace_path: worktreePath,
          });
        }
        if (pollCount === 2) {
          workItemRepository.update({
            id: 'issue-1',
            linear_state: 'In Review',
            active_pr_number: 77,
            orchestrator_state: 'review_running',
          });
          reviewEventRepository.create({
            id: 'review-1',
            work_item_id: 'issue-1',
            pr_number: 77,
            review_round: 1,
            decision: 'APPROVE_MINOR',
            summary_md: 'Looks good.',
          });
          return makeIssueView({
            tracker_state: 'In Review',
            phase: 'REVIEW',
            orchestrator_state: 'review_running',
            active_pr_number: 77,
            workspace_path: worktreePath,
          });
        }
        workItemRepository.update({
          id: 'issue-1',
          linear_state: 'Done',
          merged_at: new Date('2026-01-01T00:10:00.000Z'),
          workspace_path: null,
          branch_name: 'feature/int-1',
          orchestrator_state: 'completed',
        });
        fs.rmSync(worktreePath, { recursive: true, force: true });
        return makeIssueView({
          tracker_state: 'Done',
          phase: 'REVIEW',
          orchestrator_state: 'completed',
          active_pr_number: 77,
          workspace_path: null,
        });
      },
      getTimeline: () => [] as RuntimeTimelineEvent[],
      getHistoryView: () => null,
      createIssue: async () => ({
        accepted: true,
        status: 'accepted',
        message: 'created',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        issue: null,
      }),
      stopIssue: async () => ({ accepted: true, status: 'accepted', message: 'stopped', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      retryIssue: async () => ({ accepted: true, status: 'queued', message: 'retried', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      rewriteGovernance: async () => ({ accepted: true, status: 'accepted', message: 'rewritten', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      splitGovernance: async () => ({ accepted: true, status: 'accepted', message: 'split', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      createStream: () => new ReadableStream(),
      subscribe: () => () => undefined,
    };

    const runGitCheck = mock(async (_args: string[], cwd?: string) => {
      if (cwd?.endsWith(path.join('owner__repo', 'source'))) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const verifier = new LiveLifecycleVerifier({
      db,
      config,
      workflow: makeWorkflow(),
      runtimeHostFactory: async () => new FakeRuntimeHost(runtime, config, () => ({
        running_issue_count: pollCount < 3 ? 1 : 0,
        retry_count: 0,
        worker_process_count: pollCount < 3 ? 1 : 0,
        active_session_count: pollCount < 3 ? 1 : 0,
        claimed_issue_count: pollCount < 3 ? 1 : 0,
        leadership_lease_held: true,
      })) as any,
      sleep: async () => undefined,
      runGitCommand: runGitCheck,
    });

    const result = await verifier.verify({
      projectSlug: 'test2',
      titleSuffix: 'nightly',
    });

    expect(result.success).toBe(true);
    expect(result.issue_identifier).toBe('INT-1');
    expect(result.review_decision).toBe('APPROVE_MINOR');
    expect(result.pull_request_number).toBe(77);
    expect(result.checkpoints.every((checkpoint) => checkpoint.status === 'passed')).toBe(true);
    expect(runGitCheck).toHaveBeenCalled();
  });

  test('fails when review ends with changes requested instead of approval', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const config = makeConfig();
    const workItemRepository = new WorkItemRepository(db);
    const reviewEventRepository = new ReviewEventRepository(db);
    let pollCount = 0;

    const runtime: RuntimeControlPlane = {
      getOverview: () => ({ generated_at: '', counts: { running: 1, retrying: 0, total: 1 }, issues: [] }),
      getIssue: () => {
        pollCount += 1;
        workItemRepository.upsert({
          id: 'issue-1',
          linear_issue_id: 'issue-1',
          linear_identifier: 'INT-1',
          linear_title: 'Lifecycle smoke test',
          linear_state: pollCount === 1 ? 'In Progress' : 'In Review',
          github_repo: 'owner/repo',
          github_issue_number: 101,
          active_pr_number: 77,
          branch_name: 'feature/int-1',
          workspace_path: '/tmp/workspaces/INT-1',
          orchestrator_state: pollCount === 1 ? 'dev_running' : 'needs_rework',
        });
        if (pollCount >= 2) {
          reviewEventRepository.create({
            id: `review-${pollCount}`,
            work_item_id: 'issue-1',
            pr_number: 77,
            review_round: pollCount - 1,
            decision: 'REQUEST_CHANGES',
            summary_md: 'Please fix the regression.',
          });
        }
        return makeIssueView({
          tracker_state: pollCount === 1 ? 'In Progress' : 'In Progress',
          phase: pollCount === 1 ? 'DEV' : 'REVIEW',
          orchestrator_state: pollCount === 1 ? 'dev_running' : 'needs_rework',
          active_pr_number: 77,
        });
      },
      getTimeline: () => [],
      getHistoryView: () => null,
      createIssue: async () => ({
        accepted: true,
        status: 'accepted',
        message: 'created',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        issue: null,
      }),
      stopIssue: async () => ({ accepted: true, status: 'accepted', message: 'stopped', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      retryIssue: async () => ({ accepted: true, status: 'queued', message: 'retried', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      rewriteGovernance: async () => ({ accepted: true, status: 'accepted', message: 'rewritten', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      splitGovernance: async () => ({ accepted: true, status: 'accepted', message: 'split', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      createStream: () => new ReadableStream(),
      subscribe: () => () => undefined,
    };

    const verifier = new LiveLifecycleVerifier({
      db,
      config,
      workflow: makeWorkflow(),
      runtimeHostFactory: async () => new FakeRuntimeHost(runtime, config, () => ({
        running_issue_count: 1,
        retry_count: 0,
        worker_process_count: 1,
        active_session_count: 1,
        claimed_issue_count: 1,
        leadership_lease_held: true,
      })) as any,
      sleep: async () => undefined,
      runGitCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    const result = await verifier.verify({
      projectSlug: 'test2',
    });

    expect(result.success).toBe(false);
    expect(result.failure_code).toBe('review_not_approved');
    expect(result.review_decision).toBe('REQUEST_CHANGES');
  });

  test('fails fast when the runtime issue reaches failed orchestrator state', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const config = makeConfig({
      verification: {
        lifecycle: {
          timeoutMs: 60_000,
          pollIntervalMs: 1,
          projects: {
            test2: {
              title: 'Lifecycle smoke test',
              description: 'Create a tiny change and verify the full lifecycle.',
            },
          },
        },
      },
    });
    const workItemRepository = new WorkItemRepository(db);

    let pollCount = 0;
    const runtime: RuntimeControlPlane = {
      getOverview: () => ({ generated_at: '', counts: { running: 0, retrying: 0, total: 1 }, issues: [] }),
      getIssue: () => {
        pollCount += 1;
        workItemRepository.upsert({
          id: 'issue-1',
          linear_issue_id: 'issue-1',
          linear_identifier: 'INT-1',
          linear_title: 'Lifecycle smoke test',
          linear_state: 'In Progress',
          github_repo: 'owner/repo',
          github_issue_number: 101,
          branch_name: 'feature/int-1',
          workspace_path: '/tmp/workspaces/INT-1',
          orchestrator_state: 'failed',
          delivery_summary: 'ERROR creating PR: 422 Client Error: Unprocessable Entity',
        });
        return makeIssueView({
          tracker_state: 'In Progress',
          orchestrator_state: 'failed',
          delivery_state: 'delivery_failed',
          delivery_summary: 'ERROR creating PR: 422 Client Error: Unprocessable Entity',
        });
      },
      getTimeline: () => [
        {
          id: 'timeline-1',
          issue_id: 'issue-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          phase: 'DEV',
          code: 'delivery_failed',
          message: 'ERROR creating PR: 422 Client Error: Unprocessable Entity',
          tool_name: null,
          payload: null,
        },
      ],
      getHistoryView: () => null,
      createIssue: async () => ({
        accepted: true,
        status: 'accepted',
        message: 'created',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        issue: null,
      }),
      stopIssue: async () => ({ accepted: true, status: 'accepted', message: 'stopped', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      retryIssue: async () => ({ accepted: true, status: 'queued', message: 'retried', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      rewriteGovernance: async () => ({ accepted: true, status: 'accepted', message: 'rewritten', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      splitGovernance: async () => ({ accepted: true, status: 'accepted', message: 'split', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      createStream: () => new ReadableStream(),
      subscribe: () => () => undefined,
    };

    const verifier = new LiveLifecycleVerifier({
      db,
      config,
      workflow: makeWorkflow(),
      runtimeHostFactory: async () => new FakeRuntimeHost(runtime, config, () => ({
        running_issue_count: 0,
        retry_count: 0,
        worker_process_count: 0,
        active_session_count: 0,
        claimed_issue_count: 0,
        leadership_lease_held: true,
      })) as any,
      sleep: async () => undefined,
      runGitCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    const result = await verifier.verify({
      projectSlug: 'test2',
    });

    expect(result.success).toBe(false);
    expect(result.failure_code).toBe('orchestrator_failed');
    expect(result.message).toContain('ERROR creating PR: 422');
    expect(pollCount).toBe(1);
  });

  test('adds unique non-conflicting guidance to live verification issues', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const config = makeConfig();
    const createIssue = mock(async () => ({
      accepted: true,
      status: 'accepted' as const,
      message: 'created',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      issue: null,
    }));

    const runtime: RuntimeControlPlane = {
      getOverview: () => ({ generated_at: '', counts: { running: 0, retrying: 0, total: 0 }, issues: [] }),
      getIssue: () => null,
      getTimeline: () => [],
      getHistoryView: () => null,
      createIssue,
      stopIssue: async () => ({ accepted: true, status: 'accepted', message: 'stopped', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      retryIssue: async () => ({ accepted: true, status: 'queued', message: 'retried', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      rewriteGovernance: async () => ({ accepted: true, status: 'accepted', message: 'rewritten', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      splitGovernance: async () => ({ accepted: true, status: 'accepted', message: 'split', issue_id: 'issue-1', issue_identifier: 'INT-1' }),
      createStream: () => new ReadableStream(),
      subscribe: () => () => undefined,
    };

    let nowMs = new Date('2026-04-25T03:00:00.000Z').getTime();
    const verifier = new LiveLifecycleVerifier({
      db,
      config,
      workflow: makeWorkflow(),
      runtimeHostFactory: async () => new FakeRuntimeHost(runtime, config, () => ({
        running_issue_count: 0,
        retry_count: 0,
        worker_process_count: 0,
        active_session_count: 0,
        claimed_issue_count: 0,
        leadership_lease_held: true,
      })) as any,
      sleep: async () => undefined,
      runGitCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      now: () => {
        const current = nowMs;
        nowMs += 10;
        return current;
      },
    });

    await verifier.verify({
      projectSlug: 'test2',
      timeoutMs: 1,
      titleSuffix: 'uniqueness-check',
    });

    expect(createIssue).toHaveBeenCalledTimes(1);
    const request = createIssue.mock.calls[0]?.[0];
    expect(request?.description).toContain('Verification nonce:');
    expect(request?.description).toContain('Create or update one uniquely named smoke-test file');
    expect(request?.description).toContain('Avoid editing previously touched smoke-test files');
  });
});
