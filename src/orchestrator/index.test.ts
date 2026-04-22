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
    repositories: {
      routing: {
        proj: {
          github_owner: 'owner',
          github_repo: 'repo',
          local_path: null,
        },
      },
    },
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
    verification: {
      lifecycle: {
        timeoutMs: 60_000,
        pollIntervalMs: 5_000,
        projects: {},
      },
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
    fetchIssueById: mock(async () => ({ issue: issueForRefresh, error: null })),
    postComment: mock(async () => ({ success: true })),
    updateIssueState: mock(async () => ({ success: true })),
    createIssue: mock(async () => ({ success: true, issue: issueForRefresh })),
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
  const entry = state.running.get(issueId) as { worker_handle: Promise<unknown> } | undefined;
  expect(entry).toBeDefined();
  if (!entry) {
    throw new Error(`Missing running worker for ${issueId}`);
  }
  await entry.worker_handle;
}

function clearRetryTimers(orchestrator: Orchestrator): void {
  const retryEntries = Array.from(
    ((orchestrator as any).state.retry_attempts.values()) as Iterable<{
      timer_handle: Timer | null;
    }>,
  );
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

  it('routes issues through repositories.routing and persists full owner/repo names', async () => {
    const issue = makeIssue({ project_slug: 'proj', project_name: 'Display Project' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    expect(ctx.workspaceManager.createForIssue).toHaveBeenCalledWith(
      issue,
      expect.objectContaining({
        project_slug: 'proj',
        github_owner: 'owner',
        github_repo: 'repo',
        github_repo_full: 'owner/repo',
        cache_key: 'owner__repo',
      }),
    );

    const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
    expect(workItem?.github_repo).toBe('owner/repo');
  });

  it('fails closed before workspace creation when repositories.routing does not contain the issue project_slug', async () => {
    const issue = makeIssue({ project_slug: 'missing-project', project_name: 'Missing Project' });
    const ctx = createOrchestrator(issue, {
      repositories: {
        routing: {
          other: {
            github_owner: 'owner',
            github_repo: 'repo',
            local_path: null,
          },
        },
      },
    });
    orchestrator = ctx.orchestrator;
    const timelineEvents: Array<{ issueId: string; event: any }> = [];
    orchestrator.on('session:event', (issueId, event) => {
      timelineEvents.push({ issueId, event });
    });

    await (orchestrator as any).dispatchIssue(issue, null);

    expect((orchestrator as any).state.running.has(issue.id)).toBe(false);
    expect(ctx.workspaceManager.createForIssue).not.toHaveBeenCalled();
    expect(ctx.agentRunner.launch).not.toHaveBeenCalled();
    expect(ctx.workItemRepository.findByLinearIssueId(issue.id)).toBeNull();
    expect(
      timelineEvents.some(({ issueId, event }) =>
        issueId === issue.id &&
        event.event === 'timeline' &&
        (event.payload as { code?: string } | undefined)?.code === 'missing_repository_route',
      ),
    ).toBe(true);
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

  it('treats simple python program tasks like INT-30 as one-turn dev runs', async () => {
    const issue = makeIssue({
      state: 'Todo',
      identifier: 'INT-30',
      title: '写一个生成随机数的python 程序',
      description: '生成一个简单随机数并打印出来。',
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
        return '# Handover\n开发摘要：实现了随机数 python 程序。\n测试情况：PASS';
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

  it('fails closed and schedules a review retry when the turn budget is exhausted without a canonical review report', async () => {
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

      const state = (orchestrator as any).state;
      const workItem = ctx.workItemRepository.findById(issue.id);

      expect(ctx.agentRunner.runTurn).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(`${workspacePath}/.symphony/REVIEW_REPORT.md`)).toBe(false);
      expect(ctx.supervisor.decideNextAction).toHaveBeenCalledTimes(1);
      expect((orchestrator as any).runCliCommand).toHaveBeenCalledTimes(1);
      expect(state.retry_attempts.get(issue.id)?.attempt).toBe(1);
      expect(workItem?.linear_state).toBe('In Review');
      expect(workItem?.orchestrator_state).toBe('retry_scheduled');
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

    const finishAttempt = resolveAttempt;
    expect(finishAttempt).toBeDefined();
    if (!finishAttempt) {
      throw new Error('Expected resolveAttempt to be set');
    }
    (finishAttempt as (result: WorkerResult) => void)({
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

  it('preserves APPROVE_MINOR as the final review decision when review completes', async () => {
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
          final_state: 'Done',
          review_decision: 'APPROVE_MINOR',
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
      filename === 'REVIEW_REPORT.md'
        ? '## Review Decision: APPROVE_MINOR\n\n## Review Summary\nMinor suggestions only.'
        : null
    ));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const workItem = ctx.workItemRepository.findById(issue.id);
    const latestReview = ctx.reviewEventRepository.findLatestByWorkItemId(issue.id);

    expect(workItem?.linear_state).toBe('Done');
    expect(workItem?.last_review_decision).toBe('APPROVE_MINOR');
    expect(latestReview?.decision).toBe('APPROVE_MINOR');
    expect(ctx.githubSyncService.postPullRequestComment).not.toHaveBeenCalled();
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
      filename === 'REVIEW_REPORT.md'
        ? '## Review Decision: APPROVE\n\n## Review Summary\nReview passed before the merge conflict surfaced.'
        : null
    ));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const workItem = ctx.workItemRepository.findById(issue.id);
    const latestReview = ctx.reviewEventRepository.findLatestByWorkItemId(issue.id);
    const state = (orchestrator as any).state;

    expect(workItem?.linear_state).toBe('In Progress');
    expect(workItem?.last_review_decision).toBe('MERGE_BLOCKED');
    expect(latestReview?.decision).toBe('MERGE_BLOCKED');
    expect(String(latestReview?.merge_block_reason || '')).toContain('Merge blocked by conflicts');
    expect(ctx.tracker.postComment).toHaveBeenCalledWith(
      issue.id,
      expect.stringContaining('Review passed, but the merge failed'),
    );
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(issue.id, 'In Progress');
    expect(state.retry_attempts.get(issue.id)?.attempt).toBe(1);
  });

  it('writes structured review follow-up steps into HANDOVER for non-approval decisions', async () => {
    const issue = makeIssue({ state: 'In Review' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const workspacePath = '/tmp/symphony-tests/repo/INT-1';
    fs.mkdirSync(`${workspacePath}/.symphony`, { recursive: true });
    fs.writeFileSync(
      `${workspacePath}/.symphony/HANDOVER.md`,
      '# Handover: INT-1\n\n## 下次继续\n(由 Review 填写)\n',
      'utf-8',
    );

    try {
      await (orchestrator as any).handleReviewFeedback(
        workspacePath,
        makeCliResult({
          review_decision: 'REQUEST_TESTS',
          feedback: 'Please add focused regression tests before approval.',
        }),
      );

      const handoverContent = fs.readFileSync(`${workspacePath}/.symphony/HANDOVER.md`, 'utf-8');
      expect(handoverContent).toContain('### Review Follow-up');
      expect(handoverContent).toContain('- Decision: REQUEST_TESTS');
      expect(handoverContent).toContain('### Required Next Steps');
      expect(handoverContent).toContain('Please add focused regression tests before approval.');
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('preserves REQUEST_TESTS as a distinct review decision and sends the issue back to dev', async () => {
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
          review_decision: 'REQUEST_TESTS',
          feedback: 'Please add focused regression tests before approval.',
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
      filename === 'REVIEW_REPORT.md'
        ? '## Review Decision: REQUEST_TESTS\n\n## Review Summary\nPlease add focused regression coverage.'
        : null
    ));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const workItem = ctx.workItemRepository.findById(issue.id);
    const latestReview = ctx.reviewEventRepository.findLatestByWorkItemId(issue.id);
    const state = (orchestrator as any).state;

    expect(workItem?.linear_state).toBe('In Progress');
    expect(workItem?.last_review_decision).toBe('REQUEST_TESTS');
    expect(latestReview?.decision).toBe('REQUEST_TESTS');
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(issue.id, 'In Progress');
    expect(ctx.githubSyncService.postPullRequestComment).not.toHaveBeenCalled();
    expect(state.retry_attempts.get(issue.id)?.attempt).toBe(1);
  });

  it('createIssue provisions a discovering work item from the created Linear issue', async () => {
    const issue = makeIssue({ id: 'issue-created', identifier: 'INT-55', title: 'Created from runtime' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const result = await orchestrator.createIssue({
      title: 'Created from runtime',
      description: 'hello',
      team_id: 'team-1',
    });

    const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
    expect(result.accepted).toBe(true);
    expect(result.issue_id).toBe(issue.id);
    expect(ctx.tracker.createIssue).toHaveBeenCalled();
    expect(workItem?.linear_identifier).toBe('INT-55');
    expect(workItem?.orchestrator_state).toBe('discovering');
  });

  it('createIssue resolves project_slug through the shared tracker project resolver before calling Linear', async () => {
    const issue = makeIssue({
      id: 'issue-created',
      identifier: 'INT-56',
      title: 'Created with project slug',
      project_slug: 'test2',
      project_name: 'Test Two',
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;
    (orchestrator as any).projectResolutionService = {
      resolveProjectSlug: mock(async () => ({
        project: {
          project_id: 'project-1',
          project_slug: 'test2',
          project_name: 'Test Two',
        },
        route: {
          project_slug: 'test2',
          project_name: 'Test Two',
          github_owner: 'owner',
          github_repo: 'repo',
          github_repo_full: 'owner/repo',
          local_path: null,
          cache_key: 'owner__repo',
        },
      })),
    };

    const result = await orchestrator.createIssue({
      title: 'Created with project slug',
      description: 'hello',
      project_slug: 'test2',
    });

    expect(result.accepted).toBe(true);
    expect(ctx.tracker.createIssue).toHaveBeenCalledWith({
      title: 'Created with project slug',
      description: 'hello',
      teamId: null,
      projectId: 'project-1',
      stateId: null,
    });
  });

  it('retryIssue queues an idle active issue when no execution slots are available', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue, { maxConcurrentAgents: 0 });
    orchestrator = ctx.orchestrator;

    const workItem = ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'repo',
      orchestrator_state: 'failed',
    });

    const result = await orchestrator.retryIssue(issue.id);
    const retryEntry = (orchestrator as any).state.retry_attempts.get(issue.id);
    const updatedWorkItem = ctx.workItemRepository.findById(workItem.id);

    expect(result.accepted).toBe(true);
    expect(result.status).toBe('queued');
    expect(retryEntry?.attempt).toBe(1);
    expect(updatedWorkItem?.orchestrator_state).toBe('retry_scheduled');
  });

  it('stopIssue cancels a queued retry without leaving the claim reserved', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    await (orchestrator as any).scheduleRetry(issue.id, issue.identifier, 1, 'Manual retry requested', 1000);
    (orchestrator as any).state.claimed.add(issue.id);

    const result = await orchestrator.stopIssue(issue.id);

    expect(result.accepted).toBe(true);
    expect(result.status).toBe('completed');
    expect((orchestrator as any).state.retry_attempts.has(issue.id)).toBe(false);
    expect((orchestrator as any).state.claimed.has(issue.id)).toBe(false);
  });
});
