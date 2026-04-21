import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Orchestrator, parseCliCommandResult, type CliCommandResult, type WorkerResult } from './index';
import type { Issue, ServiceConfig, WorkflowDefinition } from '../types';
import { initializeSchema } from '../database/schema';
import {
  AgentRunRepository,
  ReviewEventRepository,
  SyncEventRepository,
  WorkItemRepository
} from '../database';

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
    projectRoot: process.cwd(),
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 1000,
    },
    maxConcurrentAgents: 2,
    maxRetryBackoffMs: 60_000,
    maxConcurrentAgentsByState: new Map(),
    maxTurns: 1,
    codexCommand: 'codex app-server',
    codexApprovalPolicy: null,
    codexThreadSandbox: null,
    codexTurnSandboxPolicy: null,
    codexTurnTimeoutMs: 1000,
    codexReadTimeoutMs: 100,
    codexStallTimeoutMs: 60_000,
    devPolicy: {
      maxDevAttempts: 3,
    },
    reviewPolicy: {
      notifyLinearOnReview: true,
    },
    serverPort: null,
  };
}

function makeWorkflow(): WorkflowDefinition {
  return {
    config: {},
    prompt_template: 'Prompt',
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'INT-1',
    title: 'Test issue',
    description: 'desc',
    priority: 1,
    state: 'Todo',
    project_slug: 'proj',
    project_name: 'repo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2025-01-01T00:00:00Z'),
    updated_at: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeCliResult(overrides: Partial<CliCommandResult> = {}): CliCommandResult {
  return {
    ok: true,
    final_state: 'In Review',
    review_decision: null,
    feedback: null,
    retry_hint: null,
    linear_api_calls: 0,
    github_api_calls: 0,
    ...overrides,
  };
}

type TestContext = {
  db: Database;
  orchestrator: Orchestrator;
  tracker: Record<string, ReturnType<typeof mock>>;
  workspaceManager: Record<string, ReturnType<typeof mock>>;
  agentRunner: Record<string, ReturnType<typeof mock>>;
  supervisor: Record<string, ReturnType<typeof mock>>;
  workItemRepository: WorkItemRepository;
  reviewEventRepository: ReviewEventRepository;
  syncEventRepository: SyncEventRepository;
  githubSyncService: Record<string, ReturnType<typeof mock>>;
};

function createTestDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

function createOrchestrator(
  issueForRefresh: Issue,
  configOverrides: Partial<ServiceConfig> = {},
  sharedDb?: Database,
): TestContext {
  const db = sharedDb ?? createTestDatabase();
  const workItemRepository = new WorkItemRepository(db);
  const agentRunRepository = new AgentRunRepository(db);
  const reviewEventRepository = new ReviewEventRepository(db);
  const syncEventRepository = new SyncEventRepository(db);
  const config = {
    ...makeConfig(),
    ...configOverrides,
  };

  const fakeMappingService = {
    ensureWorkItem: mock((issue: Issue, githubRepo: string) => workItemRepository.upsert({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: githubRepo,
      github_issue_number: 501,
    })),
    ensureGitHubIssue: mock(async (issue: Issue, githubRepo: string) => {
      const workItem = workItemRepository.upsert({
        id: issue.id,
        linear_issue_id: issue.id,
        linear_identifier: issue.identifier,
        linear_title: issue.title,
        linear_state: issue.state,
        github_repo: githubRepo,
        github_issue_number: 501,
      });
      return {
        workItem,
        created: false,
        issue_url: `https://github.com/${githubRepo}/issues/501`,
      };
    }),
    attachWorkspace: mock((workItemId: string, workspacePath: string, workspaceKey?: string) => (
      workItemRepository.update({
        id: workItemId,
        workspace_path: workspacePath,
        workspace_key: workspaceKey ?? 'INT-1',
        orchestrator_state: 'workspace_ready',
      })
    )),
  };

  const fakeContextService = {
    buildDevContext: mock(async (workItemId: string) => ({
      work_item: workItemRepository.findById(workItemId)!,
      github_issue: {
        number: 501,
        url: 'https://github.com/owner/repo/issues/501',
        title: '[INT-1] Test issue',
        body: 'Issue body',
        labels: [],
        state: 'open',
      },
      issue_comments: [],
      active_pr: null,
      unresolved_review_threads: [],
      latest_review: null,
      recent_agent_runs: [],
    })),
    buildReviewContext: mock(async (workItemId: string) => ({
      work_item: workItemRepository.findById(workItemId)!,
      github_issue: {
        number: 501,
        url: 'https://github.com/owner/repo/issues/501',
        title: '[INT-1] Test issue',
        body: 'Issue body',
        labels: [],
        state: 'open',
      },
      issue_comments: [],
      active_pr: {
        number: 77,
        url: 'https://github.com/owner/repo/pull/77',
        title: 'PR title',
        body: 'PR body',
        state: 'open',
        draft: false,
        head_branch: 'feature/int-1',
        head_sha: 'abc123',
        base_branch: 'main',
        mergeable: true,
        mergeable_state: 'clean',
        review_state: 'pending',
        reviews: [],
        review_comments: [],
        review_threads: [],
        combined_status: null,
      },
      previous_reviews: [],
      latest_dev_run: null,
    })),
  };

  const githubSyncService = {
    publishPullRequestSummary: mock(async () => undefined),
    postPullRequestComment: mock(async () => undefined),
    postIssueComment: mock(async () => undefined),
  };

  const supervisor = {
    decideNextAction: mock(async () => ({ kind: 'finish', reason: 'ready for post-processing' })),
    respondToRuntimeRequest: mock(async () => ({
      response: { behavior: 'allow', updatedInput: {} },
    })),
  };

  const orchestrator = new Orchestrator(config, makeWorkflow(), {
    db,
    workItemRepository,
    agentRunRepository,
    reviewEventRepository,
    syncEventRepository,
    githubMappingService: fakeMappingService as any,
    githubContextService: fakeContextService as any,
    githubSyncService: githubSyncService as any,
    supervisor: supervisor as any,
  });

  const tracker = {
    fetchIssueStatesByIds: mock(async () => ({ issues: [issueForRefresh], error: null })),
    fetchCandidateIssues: mock(async () => ({ issues: [issueForRefresh], error: null })),
    fetchIssuesByStates: mock(async () => ({ issues: [], error: null })),
    postComment: mock(async () => ({ success: true })),
    updateIssueState: mock(async () => ({ success: true })),
  };

  const workspaceManager = {
    createForIssue: mock(async () => ({
      success: true,
      workspace: {
        path: '/tmp/symphony-tests/repo/INT-1',
        workspace_key: 'INT-1',
        created_now: false,
      },
    })),
    removeWorkspace: mock(async () => ({ success: true })),
    getWorkspacePath: mock(() => '/tmp/symphony-tests/repo/INT-1'),
    getRepoSourcePath: mock(() => '/tmp/symphony-tests/repo/source'),
  };

  const agentRunner = {
    launch: mock(() => ({ pid: 12345 })),
    initializeSession: mock(async () => ({ threadId: 'thread-1' })),
    runTurn: mock(async () => ({
      success: true,
      completed: true,
      cancelled: false,
      tokens: { input: 10, output: 5, total: 15 },
      claude_api_calls: 1,
      timeline: [],
      transcript: [],
    })),
    stopSession: mock(() => undefined),
    forceStopSession: mock(() => undefined),
  };

  (orchestrator as any).tracker = tracker;
  (orchestrator as any).workspaceManager = workspaceManager;
  (orchestrator as any).agentRunner = agentRunner;

  return {
    db,
    orchestrator,
    tracker,
    workspaceManager,
    agentRunner,
    supervisor,
    workItemRepository,
    reviewEventRepository,
    syncEventRepository,
    githubSyncService,
  };
}

async function awaitWorker(orchestrator: Orchestrator, issueId: string): Promise<void> {
  const state = (orchestrator as any).state;
  const entry = state.running.get(issueId);
  expect(entry).toBeDefined();
  await entry.worker_handle;
}

function clearRetryTimers(orchestrator: Orchestrator): void {
  const retryEntries = Array.from((orchestrator as any).state.retry_attempts.values());
  for (const entry of retryEntries) {
    if (entry.timer_handle) {
      clearTimeout(entry.timer_handle);
    }
  }
}

describe('Orchestrator Stability', () => {
  let orchestrator: Orchestrator;

  afterEach(() => {
    if (orchestrator) {
      clearRetryTimers(orchestrator);
      const db = (orchestrator as any).db as Database | undefined;
      db?.close();
    }
  });

  it('parses structured CLI results and rejects malformed output', () => {
    const parsed = parseCliCommandResult(
      'hello\nSYMPHONY_RESULT:{"ok":true,"final_state":"Done","review_decision":"APPROVED","feedback":null,"retry_hint":null,"linear_api_calls":2,"github_api_calls":1}\nbye'
    );

    expect(parsed).toEqual({
      ok: true,
      final_state: 'Done',
      review_decision: 'APPROVED',
      feedback: null,
      retry_hint: null,
      linear_api_calls: 2,
      github_api_calls: 1,
    });
    expect(parseCliCommandResult('SYMPHONY_RESULT:not-json')).toBeNull();
    expect(parseCliCommandResult('no result here')).toBeNull();
  });

  it('reads workflow artifacts only from the canonical .symphony directory', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-artifact-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'HANDOVER.md'), '# Legacy root handover\n');
    fs.writeFileSync(
      path.join(workspacePath, '.symphony', 'HANDOVER.md'),
      '# Canonical handover\n',
    );

    try {
      await expect(
        (orchestrator as any).readWorkspaceFile(workspacePath, 'HANDOVER.md'),
      ).resolves.toBe('# Canonical handover');

      fs.unlinkSync(path.join(workspacePath, '.symphony', 'HANDOVER.md'));

      await expect(
        (orchestrator as any).readWorkspaceFile(workspacePath, 'HANDOVER.md'),
      ).resolves.toBeNull();
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('completes a dev run and releases running state', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
    });

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const state = (orchestrator as any).state;
    expect(state.running.has(issue.id)).toBe(false);
    expect(state.claimed.has(issue.id)).toBe(false);
    expect(state.retry_attempts.size).toBe(0);
    expect(state.completed.has(issue.id)).toBe(false);
  });

  it('enforces a singleton orchestrator lease and releases it on stop', async () => {
    const sharedDb = createTestDatabase();
    const issue = makeIssue({ state: 'Todo' });
    const first = createOrchestrator(issue, {}, sharedDb);
    const second = createOrchestrator(issue, {}, sharedDb);
    orchestrator = first.orchestrator;

    first.tracker.fetchCandidateIssues = mock(async () => ({ issues: [], error: null }));
    first.tracker.fetchIssuesByStates = mock(async () => ({ issues: [], error: null }));
    second.tracker.fetchCandidateIssues = mock(async () => ({ issues: [], error: null }));
    second.tracker.fetchIssuesByStates = mock(async () => ({ issues: [], error: null }));

    await expect(first.orchestrator.start()).resolves.toBeUndefined();
    await expect(second.orchestrator.start()).rejects.toThrow(
      /Another Symphony orchestrator instance already holds the primary lease/,
    );

    await first.orchestrator.stop();
    await expect(second.orchestrator.start()).resolves.toBeUndefined();
    await second.orchestrator.stop();
  });

  it('schedules exactly one retry when review requests changes', async () => {
    const issue = makeIssue({ state: 'In Review' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    (orchestrator as any).handleReviewFeedback = mock(async () => undefined);
    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
      }
      return {
        success: true,
        result: makeCliResult({
          final_state: 'In Progress',
          review_decision: 'REQUEST_CHANGES',
          feedback: 'Please fix tests',
          retry_hint: 'retry_dev',
        }),
      };
    });

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const state = (orchestrator as any).state;
    expect(state.running.has(issue.id)).toBe(false);
    expect(state.retry_attempts.size).toBe(1);
    expect(state.retry_attempts.get(issue.id)?.attempt).toBe(1);
    expect(state.claimed.has(issue.id)).toBe(true);
  });

  it('halts without retry when tracker moves issue out of active states', async () => {
    const activeIssue = makeIssue({ state: 'Todo' });
    const haltedIssue = makeIssue({ state: 'Blocked' });
    const ctx = createOrchestrator(haltedIssue);
    orchestrator = ctx.orchestrator;

    (orchestrator as any).runCliCommand = mock(async () => ({
      success: true,
      result: makeCliResult({ final_state: 'In Progress' }),
    }));

    await (orchestrator as any).dispatchIssue(activeIssue, null);
    await awaitWorker(orchestrator, activeIssue.id);

    const state = (orchestrator as any).state;
    expect(state.running.has(activeIssue.id)).toBe(false);
    expect(state.claimed.has(activeIssue.id)).toBe(false);
    expect(state.retry_attempts.size).toBe(0);
    expect(ctx.agentRunner.runTurn).not.toHaveBeenCalled();
  });

  it('queues a retry on agent turn failure and keeps the claim reserved', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.agentRunner.runTurn = mock(async () => ({
      success: false,
      completed: false,
      cancelled: false,
      error: 'turn failed',
      tokens: { input: 10, output: 5, total: 15 },
      claude_api_calls: 1,
      timeline: [],
      transcript: [],
    }));
    (orchestrator as any).agentRunner = ctx.agentRunner;

    (orchestrator as any).runCliCommand = mock(async () => ({
      success: true,
      result: makeCliResult({ final_state: 'In Progress' }),
    }));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const state = (orchestrator as any).state;
    expect(state.running.has(issue.id)).toBe(false);
    expect(state.retry_attempts.size).toBe(1);
    expect(state.retry_attempts.get(issue.id)?.attempt).toBe(1);
    expect(state.claimed.has(issue.id)).toBe(true);
  });

  it('lets the supervisor continue the native Claude session across multiple turns', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue, { maxTurns: 2 });
    orchestrator = ctx.orchestrator;

    ctx.supervisor.decideNextAction = mock(async (_context: unknown) => {
      const callCount = ctx.supervisor.decideNextAction.mock.calls.length;
      if (callCount === 1) {
        return {
          kind: 'continue',
          message: 'Continue with the next concrete implementation step.',
        };
      }

      return {
        kind: 'finish',
        reason: 'Implementation and verification are complete.',
      };
    });
    (orchestrator as any).supervisor = ctx.supervisor;

    ctx.agentRunner.runTurn = mock(async (_child: unknown, _threadId: string, prompt: string) => ({
      success: true,
      completed: true,
      cancelled: false,
      tokens: { input: 10, output: 5, total: 15 },
      claude_api_calls: 1,
      timeline: [{
        level: 'info',
        category: 'turn',
        code: 'turn_completed',
        message: 'Turn completed',
        turn: prompt.includes('next concrete') ? 2 : 1,
        tool_name: null,
        detail: null,
      }],
      transcript: [{
        role: 'assistant',
        kind: 'message',
        text: prompt,
        turn: prompt.includes('next concrete') ? 2 : 1,
        tool_name: null,
      }],
    }));
    (orchestrator as any).agentRunner = ctx.agentRunner;

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
    });

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    expect(ctx.agentRunner.runTurn).toHaveBeenCalledTimes(2);
    expect(ctx.supervisor.decideNextAction).toHaveBeenCalledTimes(2);
    expect(ctx.agentRunner.runTurn.mock.calls[1]?.[2]).toBe('Continue with the next concrete implementation step.');
  });

  it('keeps most review runs to one turn and only expands budgets for complex reviews', () => {
    const mediumReviewIssue = makeIssue({
      state: 'In Review',
      title: '检查 txt 导出结果',
      description: '确认输出文件内容符合预期。',
    });
    const largeReviewIssue = makeIssue({
      state: 'In Review',
      title: 'Refactor authentication review',
      description: 'Review a refactor touching authentication behavior.',
    });
    const veryComplexReviewIssue = makeIssue({
      state: 'In Review',
      title: 'Architecture migration security review',
      description: 'Review a large migration with security and performance implications.',
      labels: ['complex'],
      blocked_by: [{ id: 'b1', identifier: 'INT-99', state: 'In Progress' }],
    });

    const ctx = createOrchestrator(mediumReviewIssue, { maxTurns: 5 });
    orchestrator = ctx.orchestrator;

    expect((orchestrator as any).getTurnBudget('review', mediumReviewIssue)).toBe(1);
    expect((orchestrator as any).getTurnBudget('review', largeReviewIssue)).toBe(2);
    expect((orchestrator as any).getTurnBudget('review', veryComplexReviewIssue)).toBe(3);
  });

  it('collects canonical issue branch names for cleanup without touching protected branches', () => {
    const issue = makeIssue({
      identifier: 'INT-42',
      branch_name: 'feature/int-42',
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    expect(
      (orchestrator as any).collectIssueBranchCandidates({
        issue,
        explicitBranchName: 'feature/custom-int-42',
      }),
    ).toEqual([
      'feature/custom-int-42',
      'feature/int-42',
    ]);

    expect(
      (orchestrator as any).collectIssueBranchCandidates({
        issue: makeIssue({
          identifier: 'MAIN-1',
          branch_name: 'main',
        }),
        explicitBranchName: 'main',
      }),
    ).toEqual(['feature/main-1']);
  });

  it('accumulates tokens across multiple turns in the final worker summary', async () => {
    const issue = makeIssue({ state: 'Todo', title: 'Implement multi-turn task' });
    const ctx = createOrchestrator(issue, { maxTurns: 2 });
    orchestrator = ctx.orchestrator;

    ctx.supervisor.decideNextAction = mock(async (_context: unknown) => {
      const callCount = ctx.supervisor.decideNextAction.mock.calls.length;
      if (callCount === 1) {
        return {
          kind: 'continue',
          message: 'Continue to the second pass.',
        };
      }

      return {
        kind: 'finish',
        reason: 'Done.',
      };
    });
    (orchestrator as any).supervisor = ctx.supervisor;

    const originalLog = console.log;
    const loggedLines: string[] = [];
    console.log = (...args: unknown[]) => {
      loggedLines.push(args.map((arg) => String(arg)).join(' '));
    };

    ctx.agentRunner.runTurn = mock(async (_child: unknown, _threadId: string, prompt: string) => ({
      success: true,
      completed: true,
      cancelled: false,
      tokens: prompt.includes('second pass')
        ? { input: 20, output: 10, total: 30 }
        : { input: 10, output: 5, total: 15 },
      claude_api_calls: 1,
      timeline: [],
      transcript: [],
    }));
    (orchestrator as any).agentRunner = ctx.agentRunner;

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
    });

    try {
      await (orchestrator as any).dispatchIssue(issue, null);
      await awaitWorker(orchestrator, issue.id);
    } finally {
      console.log = originalLog;
    }

    expect(loggedLines.some((line) => line.includes('Tokens:       45 (input: 30, output: 15)'))).toBe(true);
  });

  it('finishes cleanly at the turn budget when workspace artifacts indicate completion', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue, { maxTurns: 1 });
    orchestrator = ctx.orchestrator;

    ctx.supervisor.decideNextAction = mock(async () => ({
      kind: 'continue',
      message: 'Continue with one more polish pass.',
    }));
    (orchestrator as any).supervisor = ctx.supervisor;

    ctx.agentRunner.runTurn = mock(async () => ({
      success: true,
      completed: true,
      cancelled: false,
      tokens: { input: 10, output: 5, total: 15 },
      claude_api_calls: 1,
      timeline: [],
      transcript: [],
    }));
    (orchestrator as any).agentRunner = ctx.agentRunner;

    (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => {
      if (filename === 'HANDOVER.md') {
        return '# Handover\n单元测试: PASS (4/4 tests passed)\n实现了 fibonacci.py';
      }
      if (filename === 'DEVELOPMENT_LOG.md') {
        return '# Development Log\n状态: Completed\n准备提交代码并创建 PR。';
      }
      return null;
    });

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
    });

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const state = (orchestrator as any).state;
    expect(ctx.supervisor.decideNextAction).not.toHaveBeenCalled();
    expect(ctx.agentRunner.runTurn).toHaveBeenCalledTimes(1);
    expect(state.retry_attempts.size).toBe(0);
    expect(state.claimed.has(issue.id)).toBe(false);
  });

  it('auto-finishes a simple completed dev task after the first turn without asking the supervisor to continue', async () => {
    const issue = makeIssue({
      state: 'Todo',
      title: '写一个 python 文件输出 hello world',
      description: '创建一个简单的 python 脚本文件。',
    });
    const ctx = createOrchestrator(issue, { maxTurns: 3 });
    orchestrator = ctx.orchestrator;

    ctx.agentRunner.runTurn = mock(async () => ({
      success: true,
      completed: true,
      cancelled: false,
      tokens: { input: 8, output: 4, total: 12 },
      claude_api_calls: 1,
      timeline: [],
      transcript: [],
    }));
    (orchestrator as any).agentRunner = ctx.agentRunner;

    (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => {
      if (filename === 'HANDOVER.md') {
        return '# Handover\n开发摘要：实现了 hello world python 文件。\n测试情况：PASS';
      }
      if (filename === 'DEVELOPMENT_LOG.md') {
        return '# Development Log\n状态: Completed';
      }
      return null;
    });

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
    });

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    expect(ctx.agentRunner.runTurn).toHaveBeenCalledTimes(1);
    expect(ctx.supervisor.decideNextAction).not.toHaveBeenCalled();
  });

  it('writes a heuristic review report for a simple task when the review turn budget is exhausted', async () => {
    const issue = makeIssue({
      state: 'In Review',
      title: '写一个 python 文件输出 hello world',
      description: '创建一个简单的 python 脚本文件。',
    });
    const ctx = createOrchestrator(issue, { maxTurns: 3 });
    orchestrator = ctx.orchestrator;

    const workspacePath = '/tmp/symphony-tests/repo/INT-1';
    fs.mkdirSync(`${workspacePath}/.symphony`, { recursive: true });
    try {
      ctx.supervisor.decideNextAction = mock(async () => ({
        kind: 'continue',
        message: 'Continue the review.',
      }));
      (orchestrator as any).supervisor = ctx.supervisor;

      ctx.agentRunner.runTurn = mock(async () => ({
        success: true,
        completed: true,
        cancelled: false,
        tokens: { input: 6, output: 3, total: 9 },
        claude_api_calls: 1,
        timeline: [],
        transcript: [],
      }));
      (orchestrator as any).agentRunner = ctx.agentRunner;

      (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => {
        if (filename === 'HANDOVER.md') {
          return '# Handover\n开发摘要：实现了 hello world python 文件。\n测试情况：PASS';
        }
        if (filename === 'DEVELOPMENT_LOG.md') {
          return '# Development Log\n状态: Completed\n已知问题\n（无）';
        }
        if (filename === 'REVIEW_REPORT.md') {
          return null;
        }
        return null;
      });

      (orchestrator as any).runCliCommand = mock(async (command: string) => {
        if (command === 'dispatch') {
          return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
        }
        return {
          success: true,
          result: makeCliResult({
            final_state: 'Done',
            review_decision: 'APPROVED',
          }),
        };
      });

      await (orchestrator as any).dispatchIssue(issue, null);
      await awaitWorker(orchestrator, issue.id);

      const reportContent = fs.readFileSync(`${workspacePath}/.symphony/REVIEW_REPORT.md`, 'utf-8');
      const state = (orchestrator as any).state;

      expect(ctx.agentRunner.runTurn).toHaveBeenCalledTimes(1);
      expect(reportContent).toContain('## Review Decision: APPROVE_MINOR');
      expect(state.retry_attempts.size).toBe(0);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('blocks duplicate dispatch while an issue is already claimed', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    let resolveAttempt: ((result: WorkerResult) => void) | null = null;
    const attemptPromise = new Promise<WorkerResult>((resolve) => {
      resolveAttempt = resolve;
    });

    (orchestrator as any).runAgentAttempt = mock(() => attemptPromise);
    (orchestrator as any).handleWorkerExit = mock(async (issueId: string) => {
      const state = (orchestrator as any).state;
      state.running.delete(issueId);
      state.claimed.delete(issueId);
    });

    await (orchestrator as any).dispatchIssue(issue, null);
    await (orchestrator as any).dispatchIssue(issue, null);

    expect((orchestrator as any).state.running.size).toBe(1);

    resolveAttempt?.({
      issueId: issue.id,
      success: true,
      completed: true,
      outcome: 'completed',
      next_action: 'none',
      turns: 1,
      tokens: { input: 0, output: 0, total: 0 },
      claude_api_calls: 0,
      linear_api_calls: 0,
      github_api_calls: 0,
    });

    await awaitWorker(orchestrator, issue.id);
  });

  it('syncs dev completion into work_items and advances Linear to In Review', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
    });
    (orchestrator as any).readWorkspaceStateFile = mock(async () => ({
      metadata: {
        branch: 'feature/int-1',
        pr_number: 77,
      },
    }));
    (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => (
      filename === 'HANDOVER.md' ? '# Handover\nImplemented feature.' : null
    ));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const workItem = ctx.workItemRepository.findById(issue.id);
    expect(workItem?.linear_state).toBe('In Review');
    expect(workItem?.active_pr_number).toBe(77);
    expect(workItem?.branch_name).toBe('feature/int-1');
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(issue.id, 'In Progress');
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(issue.id, 'In Review');
    expect(ctx.githubSyncService.publishPullRequestSummary).toHaveBeenCalled();
  });

  it('records review approval, marks the work item done, and cleans the workspace after merge', async () => {
    const issue = makeIssue({ state: 'In Review' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;
    (orchestrator as any).cleanupAllTerminalIssueBranches = mock(async () => undefined);

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
      }
      return {
        success: true,
        result: makeCliResult({
          final_state: 'Done',
          review_decision: 'APPROVED',
        }),
      };
    });
    (orchestrator as any).readWorkspaceStateFile = mock(async () => ({
      metadata: {
        branch: 'feature/int-1',
        pr_number: 77,
        pr_merged: true,
      },
    }));
    (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => (
      filename === 'REVIEW_REPORT.md' ? '## Review Decision: APPROVE\nLooks good.' : null
    ));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const workItem = ctx.workItemRepository.findById(issue.id);
    const latestReview = ctx.reviewEventRepository.findLatestByWorkItemId(issue.id);

    expect(workItem?.linear_state).toBe('Done');
    expect(workItem?.merged_at).not.toBeNull();
    expect(latestReview?.decision).toBe('APPROVE');
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(issue.id, 'Done');
    expect(ctx.workspaceManager.removeWorkspace).toHaveBeenCalled();
  });

  it('deletes local and remote branches after terminal completion cleanup', async () => {
    const issue = makeIssue({ state: 'In Review' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const cleanupAllTerminalIssueBranches = mock(async () => undefined);
    (orchestrator as any).cleanupAllTerminalIssueBranches = cleanupAllTerminalIssueBranches;

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
      }
      return {
        success: true,
        result: makeCliResult({
          final_state: 'Done',
          review_decision: 'APPROVED',
        }),
      };
    });
    (orchestrator as any).readWorkspaceStateFile = mock(async () => ({
      metadata: {
        branch: 'feature/int-1',
        pr_number: 77,
      },
    }));
    (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => (
      filename === 'REVIEW_REPORT.md' ? '## Review Decision: APPROVE\nLooks good.' : null
    ));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    expect(cleanupAllTerminalIssueBranches).toHaveBeenCalled();
  });

  it('stop() terminates running workers and force kills stuck sessions', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    let resolveWorker: (() => void) | null = null;
    const workerPromise = new Promise<void>((resolve) => {
      resolveWorker = resolve;
    });
    const child = {
      pid: 12345,
      kill: mock(() => true),
    };

    (orchestrator as any).state.running.set(issue.id, {
      worker_handle: workerPromise,
      identifier: issue.identifier,
      issue,
      stage: 'coding',
      session_id: 'thread-1-turn-1',
      codex_app_server_pid: '12345',
      last_codex_message: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      retry_attempt: 0,
      started_at: new Date(),
      turn_count: 1,
      workspace_path: '/tmp/symphony-tests/repo/INT-1',
      branch_name: 'feature/int-1',
      codex_child_process: child,
    });
    (orchestrator as any).state.claimed.add(issue.id);
    (orchestrator as any).workerRegistry.set(issue.id, child);

    ctx.agentRunner.stopSession = mock(() => undefined);
    ctx.agentRunner.forceStopSession = mock(() => {
      resolveWorker?.();
    });

    await (orchestrator as any).stopRunningWorker((orchestrator as any).state.running.get(issue.id), 1);
    expect(ctx.agentRunner.stopSession).toHaveBeenCalledWith(child);
    expect(ctx.agentRunner.forceStopSession).toHaveBeenCalledWith(child);
  });

  it('treats merge blocked as needs_rework and records a MERGE_BLOCKED review event', async () => {
    const issue = makeIssue({ state: 'In Review' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
      }
      return {
        success: true,
        result: makeCliResult({
          final_state: 'In Progress',
          review_decision: 'MERGE_BLOCKED',
          feedback: 'Merge blocked by conflicts',
          retry_hint: 'retry_dev',
        }),
      };
    });
    (orchestrator as any).readWorkspaceStateFile = mock(async () => ({
      metadata: {
        branch: 'feature/int-1',
        pr_number: 77,
      },
    }));
    (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => (
      filename === 'REVIEW_REPORT.md' ? '## Review Decision: APPROVE\nMerge blocked by conflicts.' : null
    ));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const workItem = ctx.workItemRepository.findById(issue.id);
    const latestReview = ctx.reviewEventRepository.findLatestByWorkItemId(issue.id);
    const state = (orchestrator as any).state;

    expect(workItem?.linear_state).toBe('In Progress');
    expect(workItem?.last_review_decision).toBe('MERGE_BLOCKED');
    expect(latestReview?.decision).toBe('MERGE_BLOCKED');
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(issue.id, 'In Progress');
    expect(state.retry_attempts.get(issue.id)?.attempt).toBe(1);
  });
});
