import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Orchestrator, parseCliCommandResult, type CliCommandResult, type WorkerResult } from './index';
import type { Issue, ServiceConfig, WorkflowDefinition } from '../types';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { initializeSchema } from '../database/schema';
import {
  AgentRunRepository,
  ConflictMemoryRepository,
  DecisionMemoryRepository,
  DebtSignalRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  SupervisorMemoryRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
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

function writeWorkflowArtifacts(
  workspacePath: string,
  artifacts: {
    handover?: string | null;
    developmentLog?: string | null;
    reviewReport?: string | null;
  },
): void {
  fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });
  if (artifacts.handover !== undefined && artifacts.handover !== null) {
    fs.writeFileSync(path.join(workspacePath, '.symphony', 'HANDOVER.md'), artifacts.handover, 'utf8');
  }
  if (artifacts.developmentLog !== undefined && artifacts.developmentLog !== null) {
    fs.writeFileSync(path.join(workspacePath, '.symphony', 'DEVELOPMENT_LOG.md'), artifacts.developmentLog, 'utf8');
  }
  if (artifacts.reviewReport !== undefined && artifacts.reviewReport !== null) {
    fs.writeFileSync(path.join(workspacePath, '.symphony', 'REVIEW_REPORT.md'), artifacts.reviewReport, 'utf8');
  }
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
  governanceSuggestionRepository: GovernanceSuggestionRepository;
  githubSyncService: Record<string, ReturnType<typeof mock>>;
  githubIssueClient: Record<string, ReturnType<typeof mock>>;
};

function createTestDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

function runGit(args: string[], cwd: string): string {
  return cp.execFileSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
  }).trim();
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
  const governanceSuggestionRepository = new GovernanceSuggestionRepository(db);
  const config = {
    ...makeConfig(),
    ...configOverrides,
  };

  const fakeMappingService = {
    ensureWorkItem: mock((issue: Issue, githubRepo: string) => {
      const existing = workItemRepository.findByLinearIssueId(issue.id);
      return workItemRepository.upsert({
        id: issue.id,
        linear_issue_id: issue.id,
        linear_identifier: issue.identifier,
        linear_title: issue.title,
        linear_state: issue.state,
        github_repo: githubRepo,
        github_issue_number: 501,
        supervisor_root_session_id: existing?.supervisor_root_session_id ?? null,
        supervisor_plan_summary: existing?.supervisor_plan_summary ?? null,
        supervisor_acceptance_summary: existing?.supervisor_acceptance_summary ?? null,
        supervisor_execution_mode: existing?.supervisor_execution_mode ?? null,
      });
    }),
    ensureGitHubIssue: mock(async (issue: Issue, githubRepo: string) => {
      const existing = workItemRepository.findByLinearIssueId(issue.id);
      const workItem = workItemRepository.upsert({
        id: issue.id,
        linear_issue_id: issue.id,
        linear_identifier: issue.identifier,
        linear_title: issue.title,
        linear_state: issue.state,
        github_repo: githubRepo,
        github_issue_number: 501,
        supervisor_root_session_id: existing?.supervisor_root_session_id ?? null,
        supervisor_plan_summary: existing?.supervisor_plan_summary ?? null,
        supervisor_acceptance_summary: existing?.supervisor_acceptance_summary ?? null,
        supervisor_execution_mode: existing?.supervisor_execution_mode ?? null,
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
  const githubIssueClient = {
    closeIssue: mock(async () => undefined),
    listOpenIssues: mock(async () => []),
    listOpenPullRequests: mock(async () => []),
    updatePullRequest: mock(async (prNumber: number, params: { state?: 'open' | 'closed' }) => ({
      number: prNumber,
      url: `https://github.com/owner/repo/pull/${prNumber}`,
      title: 'PR title',
      body: null,
      state: params.state ?? 'open',
      draft: false,
      head_branch: 'feature/int-1',
      head_sha: 'abc123',
      base_branch: 'main',
      mergeable: null,
      mergeable_state: null,
    })),
  };

  const supervisor = {
    decideNextAction: mock(async () => ({ kind: 'finish', reason: 'ready for post-processing' })),
    respondToRuntimeRequest: mock(async () => ({
      response: { behavior: 'allow', updatedInput: {} },
    })),
  };

  const tracker = {
    fetchIssueStatesByIds: mock(async () => ({ issues: [issueForRefresh], error: null })),
    fetchCandidateIssues: mock(async () => ({ issues: [issueForRefresh], error: null })),
    fetchIssuesByStates: mock(async () => ({ issues: [], error: null })),
    fetchIssueById: mock(async () => ({ issue: issueForRefresh, error: null })),
    listProjects: mock(async () => ({
      projects: issueForRefresh.project_slug
        ? [{
            project_id: `project-${issueForRefresh.project_slug}`,
            project_slug: issueForRefresh.project_slug,
            project_name: issueForRefresh.project_name ?? issueForRefresh.project_slug,
          }]
        : [],
      error: false,
      errorMessage: null,
    })),
    findProjectBySlug: mock(async (projectSlug: string) => ({
      project:
        issueForRefresh.project_slug === projectSlug
          ? {
              project_id: `project-${projectSlug}`,
              project_slug: projectSlug,
              project_name: issueForRefresh.project_name ?? projectSlug,
            }
          : null,
      error: false,
      errorMessage: issueForRefresh.project_slug === projectSlug ? null : 'not found',
    })),
    postComment: mock(async () => ({ success: true })),
    updateIssueState: mock(async () => ({ success: true })),
    updateIssueContent: mock(async () => ({ success: true })),
    createIssue: mock(async () => ({ success: true, issue: issueForRefresh })),
  };

  const projectResolutionService = new TrackerProjectResolutionService(
    tracker as any,
    config.repositories.routing,
  );

  const orchestrator = new Orchestrator(config, makeWorkflow(), {
    db,
    tracker: tracker as any,
    workItemRepository,
    agentRunRepository,
    reviewEventRepository,
    syncEventRepository,
    governanceSuggestionRepository,
    githubMappingService: fakeMappingService as any,
    githubContextService: fakeContextService as any,
    githubSyncService: githubSyncService as any,
    supervisor: supervisor as any,
    projectResolutionService,
    githubIssueClientFactory: mock(() => githubIssueClient) as any,
  });

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
    governanceSuggestionRepository,
    githubSyncService,
    githubIssueClient,
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

async function drainWorkers(orchestrator: Orchestrator, issueId: string, maxPasses = 5): Promise<void> {
  const state = (orchestrator as any).state;
  for (let index = 0; index < maxPasses; index += 1) {
    const entry = state.running.get(issueId) as { worker_handle: Promise<unknown> } | undefined;
    if (!entry) {
      return;
    }
    await entry.worker_handle;
  }
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

function clearScheduledTick(orchestrator: Orchestrator): void {
  const pollTimer = (orchestrator as any).pollTimer as Timer | null;
  if (pollTimer) {
    clearTimeout(pollTimer);
    (orchestrator as any).pollTimer = null;
  }
  (orchestrator as any).running = false;
}

describe('Orchestrator Stability', () => {
  let orchestrator: Orchestrator;

  afterEach(() => {
    if (orchestrator) {
      clearRetryTimers(orchestrator);
      clearScheduledTick(orchestrator);
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
      delivery_code: null,
      delivery_summary: null,
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

  it('preserves non-retryable dev delivery failures after post-processing halts', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-dev-delivery-failure-'));
    fs.mkdirSync(path.join(workspacePath, '.git'), { recursive: true });
    writeWorkflowArtifacts(workspacePath, {
      handover: '# Handover\nReady, but delivery publishing failed.\n',
      developmentLog: '# Development Log\nReady, but delivery publishing failed.\n',
    });

    ctx.workspaceManager.createForIssue = mock(async () => ({
      success: true,
      workspace: {
        path: workspacePath,
        workspace_key: 'INT-1',
        created_now: false,
      },
    }));
    (orchestrator as any).workspaceManager = ctx.workspaceManager;

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      return {
        success: false,
        result: makeCliResult({
          ok: false,
          final_state: 'In Progress',
          feedback: 'GitHub rejected the branch push.',
          delivery_code: 'review_submit_failed',
          delivery_summary: 'GitHub rejected the branch push.',
          retry_hint: 'stop',
        }),
      };
    });

    try {
      await (orchestrator as any).dispatchIssue(issue, null);
      await awaitWorker(orchestrator, issue.id);

      const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
      expect(workItem?.orchestrator_state).toBe('halted');
      expect(workItem?.delivery_code).toBe('review_submit_failed');
      expect(workItem?.delivery_summary).toBe('GitHub rejected the branch push.');
      expect((orchestrator as any).state.retry_attempts.size).toBe(0);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('treats tracker terminal state after a dev turn as completion instead of rerunning dev post-processing', async () => {
    const issue = makeIssue({ state: 'In Progress' });
    const terminalIssue = { ...issue, state: 'Done' };
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-terminal-after-turn-'));
    fs.mkdirSync(path.join(workspacePath, '.git'), { recursive: true });
    writeWorkflowArtifacts(workspacePath, {
      handover: '# Handover: INT-1\n\n## 开发摘要\nCompleted externally.\n\n## 测试情况\n- 单元测试: N/A\n',
      developmentLog: '# Development Log\n状态: Completed\n',
    });

    ctx.workspaceManager.createForIssue.mockImplementation(async () => ({
      success: true,
      workspace: {
        path: workspacePath,
        workspace_key: 'INT-1',
        created_now: false,
      },
    }));
    ctx.tracker.fetchIssueStatesByIds.mockImplementation(async () => ({ issues: [issue], error: null }));
    ctx.tracker.fetchIssueById.mockImplementation(async () => ({ issue: terminalIssue, error: null }));
    const commands: string[] = [];
    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      commands.push(command);
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      return { success: false, error: 'dev post-process should not run' };
    });

    try {
      await (orchestrator as any).dispatchIssue(issue, null);
      await awaitWorker(orchestrator, issue.id);

      expect(commands).toEqual(['dispatch']);
      const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
      expect(workItem?.orchestrator_state).toBe('completed');
      expect(workItem?.linear_state).toBe('Done');
      const state = (orchestrator as any).state;
      expect(state.retry_attempts.size).toBe(0);
      expect(state.claimed.has(issue.id)).toBe(false);
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
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

  it('starts serving work without waiting for heavy startup terminal cleanup', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;
    const previousDelay = process.env.SYMPHONY_STARTUP_CLEANUP_DELAY_MS;
    process.env.SYMPHONY_STARTUP_CLEANUP_DELAY_MS = '0';
    let cleanupFinished = false;
    (orchestrator as any).startupTerminalCleanup = mock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      cleanupFinished = true;
    });
    ctx.tracker.fetchCandidateIssues = mock(async () => ({ issues: [], error: null }));

    try {
      await expect(orchestrator.start()).resolves.toBeUndefined();

      expect(cleanupFinished).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(cleanupFinished).toBe(true);
    } finally {
      if (previousDelay === undefined) {
        delete process.env.SYMPHONY_STARTUP_CLEANUP_DELAY_MS;
      } else {
        process.env.SYMPHONY_STARTUP_CLEANUP_DELAY_MS = previousDelay;
      }
    }
    await orchestrator.stop();
  });

  it('keeps default startup terminal cleanup outside the first-turn budget', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;
    const previousDelay = process.env.SYMPHONY_STARTUP_CLEANUP_DELAY_MS;
    const previousFirstTickDelay = process.env.SYMPHONY_FIRST_TICK_DELAY_MS;
    const originalSetTimeout = globalThis.setTimeout;
    delete process.env.SYMPHONY_STARTUP_CLEANUP_DELAY_MS;
    delete process.env.SYMPHONY_FIRST_TICK_DELAY_MS;
    const scheduledDelays: number[] = [];
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduledDelays.push(typeof timeout === 'number' ? timeout : 0);
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;
    let cleanupStarted = false;
    (orchestrator as any).startupTerminalCleanup = mock(async () => {
      cleanupStarted = true;
    });
    ctx.tracker.fetchCandidateIssues = mock(async () => ({ issues: [], error: null }));

    try {
      await expect(orchestrator.start()).resolves.toBeUndefined();
      expect(scheduledDelays).toContain(900_000);
      expect(scheduledDelays).toContain(10_000);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(cleanupStarted).toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      if (previousDelay === undefined) {
        delete process.env.SYMPHONY_STARTUP_CLEANUP_DELAY_MS;
      } else {
        process.env.SYMPHONY_STARTUP_CLEANUP_DELAY_MS = previousDelay;
      }
      if (previousFirstTickDelay === undefined) {
        delete process.env.SYMPHONY_FIRST_TICK_DELAY_MS;
      } else {
        process.env.SYMPHONY_FIRST_TICK_DELAY_MS = previousFirstTickDelay;
      }
    }
    await orchestrator.stop();
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

  it('records harness setup execution only once per workspace state file', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-harness-setup-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.symphony', 'state.json'),
      JSON.stringify({
        version: 1,
        issue_id: issue.identifier,
        current_state: 'IN_PROGRESS',
        previous_state: 'TODO',
        transition_history: [],
        metadata: {},
        error: null,
        retry_count: 0,
      }, null, 2),
      'utf8',
    );

    const effectiveHarness = {
      source: 'formal' as const,
      config: {
        commands: {
          setup: 'python3 -c "from pathlib import Path; p=Path(\'setup-count.txt\'); n=int(p.read_text())+1 if p.exists() else 1; p.write_text(str(n))"',
        },
      },
      has_verification_requirements: false,
    };

    try {
      await (orchestrator as any).runHarnessSetupOnce(issue, workspacePath, effectiveHarness);
      await (orchestrator as any).runHarnessSetupOnce(issue, workspacePath, effectiveHarness);

      expect(
        fs.readFileSync(path.join(workspacePath, 'setup-count.txt'), 'utf8'),
      ).toBe('1');

      const state = JSON.parse(
        fs.readFileSync(path.join(workspacePath, '.symphony', 'state.json'), 'utf8'),
      ) as { metadata?: { harness_setup?: { command?: string; completed_at?: string } } };

      expect(state.metadata?.harness_setup?.command).toContain('setup-count.txt');
      expect(state.metadata?.harness_setup?.completed_at).toBeTruthy();

      const evidence = JSON.parse(
        fs.readFileSync(path.join(workspacePath, '.symphony', 'change-pack', 'evidence.json'), 'utf8'),
      ) as {
        command_runs?: Array<{ command_key?: string | null; status?: string }>;
      };
      expect(evidence.command_runs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          command_key: 'setup',
          status: 'satisfied',
        }),
      ]));
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('builds harness bridge env and workspace hints from the effective harness contract', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-harness-hint-'));
    fs.mkdirSync(path.join(workspacePath, '.git'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });

    const effectiveHarness = {
      source: 'shadow' as const,
      config: {
        commands: {
          test: 'bun test',
          review_checks: 'bun test src/review.spec.ts',
        },
        verification: {
          required_commands: ['test'],
        },
        runtime_hints: {
          url: 'http://localhost:3000',
          ready_signal: 'server ready',
        },
      },
      has_verification_requirements: true,
    };

    try {
      const env = (orchestrator as any).buildHarnessBridgeEnv(effectiveHarness);
      expect(JSON.parse(env.SYMPHONY_EFFECTIVE_HARNESS_JSON)).toMatchObject({
        source: 'shadow',
        commands: {
          test: 'bun test',
          review_checks: 'bun test src/review.spec.ts',
        },
        verification: {
          required_commands: ['test'],
        },
      });

      const hint = await (orchestrator as any).buildWorkspaceHint(workspacePath, effectiveHarness);
      expect(hint).toContain('Harness source: shadow');
      expect(hint).toContain('review_checks');
      expect(hint).toContain('http://localhost:3000');
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('captures a final dev post-process evidence sweep after the CLI finishes', async () => {
    const issue = makeIssue({
      state: 'Todo',
      title: 'Produce a runtime status markdown summary',
      description: 'Write the final runtime handover artifact.',
    });
    const ctx = createOrchestrator(issue, { maxTurns: 1 });
    orchestrator = ctx.orchestrator;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-final-dev-evidence-'));
    fs.mkdirSync(path.join(workspacePath, '.git'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.symphony-repo.yaml'),
      [
        'profiles:',
        '  - coding',
        'verification:',
        '  required_artifacts:',
        '    - reports/dev-summary.md',
        'runtime_hints:',
        '  ready_signal: ready for ship',
      ].join('\n'),
      'utf8',
    );

    ctx.workspaceManager.createForIssue = mock(async () => ({
      success: true,
      workspace: {
        path: workspacePath,
        workspace_key: 'INT-1',
        created_now: false,
      },
    }));
    (orchestrator as any).workspaceManager = ctx.workspaceManager;

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

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dev') {
        fs.mkdirSync(path.join(workspacePath, 'reports'), { recursive: true });
        fs.writeFileSync(path.join(workspacePath, 'reports', 'dev-summary.md'), '# Summary\nready for ship\n', 'utf8');
        writeWorkflowArtifacts(workspacePath, {
          handover: '# Handover\nready for ship\n',
          developmentLog: '# Development Log\nready for ship\n',
        });
        return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
      }
      return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
    });

    try {
      const workerResult = await (orchestrator as any).runAgentAttempt(
        issue,
        null,
        (orchestrator as any).resolveRepositoryRoute(issue),
      );
      expect(workerResult.success).toBe(true);

      const evidence = JSON.parse(
        fs.readFileSync(path.join(workspacePath, '.symphony', 'change-pack', 'evidence.json'), 'utf8'),
      ) as {
        command_runs?: Array<{ command_key?: string | null; source?: string; status?: string }>;
        artifact_observations?: Array<{ path?: string; exists?: boolean; non_empty?: boolean }>;
        runtime_observations?: Array<{ hint_key?: string; status?: string; value?: string }>;
      };

      expect(evidence.command_runs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          command_key: 'dev',
          source: 'cli_postprocess',
          status: 'satisfied',
        }),
      ]));
      expect(evidence.artifact_observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'reports/dev-summary.md',
          exists: true,
          non_empty: true,
        }),
      ]));
      expect(evidence.runtime_observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          hint_key: 'ready_signal',
          status: 'satisfied',
          value: 'ready for ship',
        }),
      ]));

      const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
      expect(workItem?.evidence_summary?.observed_artifacts).toContain('reports/dev-summary.md');
      expect(workItem?.evidence_summary?.runtime_checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          hint_key: 'ready_signal',
          status: 'satisfied',
          value: 'ready for ship',
        }),
      ]));
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it('captures a final review post-process evidence sweep after the CLI finishes', async () => {
    const issue = makeIssue({
      state: 'In Review',
      title: 'Review the runtime status markdown summary',
      description: 'Confirm the final report is ready.',
    });
    const ctx = createOrchestrator(issue, { maxTurns: 1 });
    orchestrator = ctx.orchestrator;

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-final-review-evidence-'));
    fs.mkdirSync(path.join(workspacePath, '.git'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.symphony-repo.yaml'),
      [
        'profiles:',
        '  - review',
        'verification:',
        '  required_artifacts:',
        '    - reports/review-summary.md',
        'runtime_hints:',
        '  ready_signal: review complete',
      ].join('\n'),
      'utf8',
    );

    ctx.workspaceManager.createForIssue = mock(async () => ({
      success: true,
      workspace: {
        path: workspacePath,
        workspace_key: 'INT-1',
        created_now: false,
      },
    }));
    (orchestrator as any).workspaceManager = ctx.workspaceManager;

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

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'review') {
        fs.mkdirSync(path.join(workspacePath, 'reports'), { recursive: true });
        fs.writeFileSync(path.join(workspacePath, 'reports', 'review-summary.md'), '# Review Summary\nreview complete\n', 'utf8');
        writeWorkflowArtifacts(workspacePath, {
          reviewReport: [
            '## Review Decision: APPROVE',
            '',
            '## Review Summary',
            'review complete',
          ].join('\n'),
          developmentLog: '# Development Log\nreview complete\n',
        });
        return {
          success: true,
          result: makeCliResult({
            final_state: 'Done',
            review_decision: 'APPROVE',
          }),
        };
      }
      return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
    });

    try {
      const workerResult = await (orchestrator as any).runAgentAttempt(
        issue,
        null,
        (orchestrator as any).resolveRepositoryRoute(issue),
      );
      expect(workerResult.success).toBe(true);

      const evidence = JSON.parse(
        fs.readFileSync(path.join(workspacePath, '.symphony', 'change-pack', 'evidence.json'), 'utf8'),
      ) as {
        command_runs?: Array<{ command_key?: string | null; source?: string; status?: string }>;
        artifact_observations?: Array<{ path?: string; exists?: boolean; non_empty?: boolean }>;
        runtime_observations?: Array<{ hint_key?: string; status?: string; value?: string }>;
      };

      expect(evidence.command_runs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          command_key: 'review',
          source: 'cli_postprocess',
          status: 'satisfied',
        }),
      ]));
      expect(evidence.artifact_observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'reports/review-summary.md',
          exists: true,
          non_empty: true,
        }),
      ]));
      expect(evidence.runtime_observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          hint_key: 'ready_signal',
          status: 'satisfied',
          value: 'review complete',
        }),
      ]));

      const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
      expect(workItem?.evidence_summary?.observed_artifacts).toContain('reports/review-summary.md');
      expect(workItem?.evidence_summary?.runtime_checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          hint_key: 'ready_signal',
          status: 'satisfied',
          value: 'review complete',
        }),
      ]));
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
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

    writeWorkflowArtifacts('/tmp/symphony-tests/repo/INT-1', {
      handover: '# Handover\n单元测试: PASS (4/4 tests passed)\n实现了 fibonacci.py',
      developmentLog: '# Development Log\n状态: Completed\n准备提交代码并创建 PR。',
    });

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

  it('pauses for a supervisor decision instead of retrying when dev turn budget is exhausted', async () => {
    const issue = makeIssue({
      state: 'Todo',
      title: '把这个仓库清空成 GitHub 空仓库状态',
      description: '删除所有 tracked files，只留下空仓库可验证状态。',
    });
    const ctx = createOrchestrator(issue, { maxTurns: 1 });
    orchestrator = ctx.orchestrator;
    const sessions = new SupervisorSessionRepository(ctx.db);
    const events = new SupervisorSessionEventRepository(ctx.db);
    const session = sessions.create({
      id: 'session-turn-budget',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'UniUni2000/test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: issue.id,
      plan_card: {
        title: '把这个仓库清空成 GitHub 空仓库状态',
        user_goal: '把这个仓库清空成 GitHub 空仓库状态',
        in_scope: ['删除所有 tracked files', '给出可验证交付证据'],
        out_of_scope: ['不删除 .git 目录', '不绕过用户确认'],
        acceptance: ['仓库只剩空仓库状态', '最终交付前用户确认范围'],
        known_risks: ['误删风险高'],
        execution_strategy: '先确认范围，再执行删除并交付。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '批准并开始', summary: '按受控清理计划执行。' },
        alternate_option: null,
        governance_preview: null,
      },
    });

    ctx.supervisor.decideNextAction = mock(async () => ({
      kind: 'continue',
      message: 'Need one more dev turn.',
    }));
    (orchestrator as any).supervisor = ctx.supervisor;
    (orchestrator as any).reconcileMissingRequirementsWithArtifacts = mock(() => [
      {
        key: 'verification:empty_state',
        label: 'Verify empty repository state',
        reason: 'The final empty-state proof is still missing.',
        kind: 'verification',
      },
    ]);

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

    (orchestrator as any).readWorkspaceFile = mock(async () => null);
    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      throw new Error(`Unexpected ${command} post-processing`);
    });

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const state = (orchestrator as any).state;
    const workItem = ctx.workItemRepository.findById(issue.id);
    const updatedSession = sessions.findById(session.id);
    const eventKinds = events.listBySession(session.id).map((event) => event.event_kind);

    expect(ctx.agentRunner.runTurn).toHaveBeenCalledTimes(1);
    expect((orchestrator as any).runCliCommand).toHaveBeenCalledTimes(1);
    expect(state.retry_attempts.size).toBe(0);
    expect(state.claimed.has(issue.id)).toBe(false);
    expect(workItem?.orchestrator_state).toBe('halted');
    expect(workItem?.delivery_code).toBe('supervisor_turn_budget_exhausted');
    expect(updatedSession?.state).toBe('awaiting_user_decision');
    expect(updatedSession?.active_decision_kind).toBe('execution_decision');
    expect(eventKinds).toContain('supervisor_turn_budget_exhausted');
  });

  it('auto-finishes supervisor live docs verification at the turn budget even when harness checks remain noisy', () => {
    const issue = makeIssue({
      title: '创建 docs/supervisor-live-smoke.md 验证文件',
      description: 'supervisor live e2e',
    });
    const ctx = createOrchestrator(issue, { maxTurns: 2 });
    orchestrator = ctx.orchestrator;

    const shouldFinish = (orchestrator as any).shouldAutoFinishAfterTurn(
      'dev',
      issue,
      2,
      2,
      {
        handover: '# Handover\n开发摘要：创建 docs/supervisor-live-smoke.md 验证文件。\n测试情况：N/A（纯文档任务）',
        developmentLog: '# Development Log\n状态: Completed',
        reviewReport: null,
      },
      [
        { key: 'command:test', label: 'Record successful test verification', reason: 'Formal harness still asks for tests.', kind: 'verification' },
        { key: 'command:build', label: 'Record successful build verification', reason: 'Formal harness still asks for build.', kind: 'verification' },
        { key: 'artifact:dist/index.js', label: 'Produce required artifact dist/index.js', reason: 'Formal harness artifact is noisy for docs-only verifier.', kind: 'artifact' },
      ],
    );

    expect(shouldFinish).toBe(true);
  });

  it('auto-finishes review at the turn budget when a canonical review report exists despite noisy harness checks', () => {
    const issue = makeIssue({
      state: 'In Review',
      title: 'Review supervisor live E2E child',
      description: 'Supervisor live E2E request entered through Telegram.',
    });
    const ctx = createOrchestrator(issue, { maxTurns: 1 });
    orchestrator = ctx.orchestrator;

    const shouldFinish = (orchestrator as any).shouldAutoFinishAfterTurn(
      'review',
      issue,
      1,
      1,
      {
        handover: '# Handover\n开发摘要：实现完成。',
        developmentLog: '# Development Log\n状态: Completed',
        reviewReport: [
          '## Review Decision: APPROVE',
          '',
          '## Review Summary',
          'The implementation is safe to merge.',
        ].join('\n'),
      },
      [
        {
          key: 'command:test',
          label: 'Record successful test verification',
          reason: 'Formal harness still asks for tests after the canonical review report.',
          kind: 'verification',
        },
      ],
    );

    expect(shouldFinish).toBe(true);
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

    writeWorkflowArtifacts('/tmp/symphony-tests/repo/INT-1', {
      handover: '# Handover\n开发摘要：实现了 hello world python 文件。\n测试情况：PASS',
      developmentLog: '# Development Log\n状态: Completed',
    });

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

    writeWorkflowArtifacts('/tmp/symphony-tests/repo/INT-1', {
      handover: '# Handover\n开发摘要：实现了随机数 python 程序。\n测试情况：PASS',
      developmentLog: '# Development Log\n状态: Completed',
    });

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

  it('gives live lifecycle verification issues at least two dev turns to avoid first-turn retry churn', () => {
    const issue = makeIssue({
      state: 'Todo',
      title: 'Live lifecycle smoke test [live-lifecycle 2026-04-25-00-00-00]',
      description: [
        'Create a tiny repository-safe change and verify the full lifecycle.',
        '',
        'Verification nonce: 2026-04-25-00-00-00',
        'Create or update one uniquely named smoke-test file or tiny repo-safe change that includes this nonce.',
      ].join('\n'),
    });
    const ctx = createOrchestrator(issue, { maxTurns: 3 });
    orchestrator = ctx.orchestrator;

    expect((orchestrator as any).getTurnBudget('dev', issue)).toBe(2);
  });

  it('gives Telegram supervisor live E2E issues at least two dev turns for delivery recovery', () => {
    const issue = makeIssue({
      state: 'Todo',
      title: '创建 docs/supervisor-live-codex-matrix.md，写一句 supervisor live e2e passed',
      description: [
        'Supervisor live E2E request entered through Telegram.',
        'nonce codex-matrix',
      ].join('\n'),
    });
    const ctx = createOrchestrator(issue, { maxTurns: 1 });
    orchestrator = ctx.orchestrator;

    expect((orchestrator as any).getTurnBudget('dev', issue)).toBe(2);
  });

  it('recreates missing private runtime state before dev post-processing', async () => {
    const issue = makeIssue({
      identifier: 'INT-918',
      state: 'In Progress',
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-missing-state-'));

    await (orchestrator as any).ensureWorkspaceStateForPostProcess({
      command: 'dev',
      issue,
      workspacePath,
      workItem: {
        branch_name: 'feature/int-918',
        github_repo: 'owner/repo',
        github_issue_number: 918,
      },
      route: {
        github_repo_full: 'owner/repo',
      },
    });

    const state = JSON.parse(fs.readFileSync(path.join(workspacePath, '.symphony', 'state.json'), 'utf8'));
    expect(state.issue_id).toBe('INT-918');
    expect(state.current_state).toBe('IN_PROGRESS');
    expect(state.metadata.branch).toBe('feature/int-918');
    expect(state.metadata.github_repo).toBe('owner/repo');
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
        message: 'Write the missing .symphony/REVIEW_REPORT.md.',
      }));
      (orchestrator as any).supervisor = ctx.supervisor;

      const reviewPrompts: string[] = [];
      ctx.agentRunner.runTurn = mock(async (_child, _threadId, prompt: string) => {
        reviewPrompts.push(prompt);
        return {
          success: true,
          completed: true,
          cancelled: false,
          tokens: { input: 6, output: 3, total: 9 },
          claude_api_calls: 1,
          timeline: [],
          transcript: [],
        };
      });
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

      expect(ctx.agentRunner.runTurn).toHaveBeenCalledTimes(2);
      expect(reviewPrompts[1]).toContain('.symphony/REVIEW_REPORT.md');
      expect(fs.existsSync(`${workspacePath}/.symphony/REVIEW_REPORT.md`)).toBe(false);
      expect(ctx.supervisor.decideNextAction).toHaveBeenCalledTimes(2);
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

  it('does not redispatch a governance-blocked halted issue when the tracker content has not changed', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-governance-unchanged-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, '.symphony-constitution.md'),
        [
          '# Constitution',
          '',
          '## Main Path',
          '- Keep one control plane.',
        ].join('\n'),
        'utf8',
      );

      const issue = makeIssue({
        id: 'issue-blocked',
        identifier: 'INT-92',
        title: 'Runtime and bot and server cleanup together',
        description: 'Do all three at once.',
        updated_at: new Date('2026-01-01T00:00:00Z'),
        project_slug: 'proj',
        project_name: 'repo',
      });
      const ctx = createOrchestrator(issue, {
        repositories: {
          routing: {
            proj: {
              github_owner: 'owner',
              github_repo: 'repo',
              local_path: repoRoot,
            },
          },
        },
      });
      orchestrator = ctx.orchestrator;

      ctx.tracker.createIssue = mock(async () => ({ success: true, issue }));
      ctx.tracker.fetchCandidateIssues = mock(async () => ({ issues: [issue], error: null }));
      (orchestrator as any).tracker = ctx.tracker;

      await orchestrator.createIssue({
        title: issue.title,
        description: issue.description,
        project_slug: 'proj',
      });

      (orchestrator as any).running = true;
      (orchestrator as any).dispatchIssue = mock(async () => undefined);
      (orchestrator as any).scheduleTick = mock(() => undefined);

      (orchestrator as any).executeTick();
      await (orchestrator as any).currentTickPromise;

      expect((orchestrator as any).dispatchIssue).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
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

  it('does not redispatch a stale In Progress tracker snapshot after local dev completion advanced to review', async () => {
    const issue = makeIssue({
      id: 'issue-stale-dev-state',
      identifier: 'INT-915',
      state: 'In Progress',
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: 'In Review',
      github_repo: 'owner/repo',
      orchestrator_state: 'workspace_ready',
      active_pr_number: 77,
      branch_name: 'feature/int-915',
    });

    expect((orchestrator as any).shouldDispatch(issue)).toBe(false);
    expect((orchestrator as any).shouldDispatch({ ...issue, state: 'In Review' })).toBe(true);
  });

  it('immediately hands off a locally completed dev issue to review when the tracker poll has not caught up yet', async () => {
    const issue = makeIssue({
      id: 'issue-local-review-handoff',
      identifier: 'INT-916',
      state: 'In Progress',
    });
    const ctx = createOrchestrator(issue, { maxConcurrentAgents: 2 });
    orchestrator = ctx.orchestrator;
    (orchestrator as any).running = true;
    (orchestrator as any).readWorkspaceStateFile = mock(async () => ({
      metadata: {
        branch: 'feature/int-916',
        pr_number: 916,
      },
    }));
    (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => {
      if (filename === 'HANDOVER.md') {
        return '# Handover\nReady for review.';
      }
      if (filename === 'REVIEW_REPORT.md') {
        return '# Review Report\n\n## Review Decision: APPROVE\n\nLooks good.';
      }
      return null;
    });
    const commands: string[] = [];
    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      commands.push(command);
      if (command === 'review') {
        return {
          success: true,
          result: makeCliResult({
            final_state: 'Done',
            review_decision: 'APPROVE',
          }),
        };
      }
      return {
        success: true,
        result: makeCliResult({
          final_state: command === 'dev' ? 'In Review' : 'In Progress',
        }),
      };
    });

    await (orchestrator as any).dispatchIssue(issue, null);
    await drainWorkers(orchestrator, issue.id);

    expect(commands).toContain('dev');
    expect(commands).toContain('review');
  });

  it('recovers a persisted workspace_ready In Review work item even when the tracker candidate poll omits it', async () => {
    const issue = makeIssue({
      id: 'issue-persisted-review',
      identifier: 'INT-917',
      state: 'In Progress',
    });
    const ctx = createOrchestrator(issue, { maxConcurrentAgents: 2 });
    orchestrator = ctx.orchestrator;
    (orchestrator as any).running = true;
    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: 'In Review',
      github_repo: 'owner/repo',
      orchestrator_state: 'workspace_ready',
      branch_name: 'feature/int-917',
    });
    const commands: string[] = [];
    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      commands.push(command);
      return {
        success: true,
        result: makeCliResult({
          final_state: command === 'review' ? 'Done' : 'In Review',
          review_decision: command === 'review' ? 'APPROVE' : null,
        }),
      };
    });
    (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => (
      filename === 'REVIEW_REPORT.md'
        ? '# Review Report\n\n## Review Decision: APPROVE\n\nLooks good.'
        : null
    ));

    await (orchestrator as any).dispatchLocalReviewReadyWorkItems(new Set<string>());
    await drainWorkers(orchestrator, issue.id);

    expect(commands).toContain('review');
  });

  it('captures touched paths and touched areas from the native agent timeline into the work item', async () => {
    const issue = makeIssue({ state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.agentRunner.runTurn = mock(async () => ({
      success: true,
      completed: true,
      cancelled: false,
      tokens: { input: 10, output: 5, total: 15 },
      claude_api_calls: 1,
      timeline: [
        {
          level: 'info',
          category: 'tool',
          code: 'tool_started',
          message: 'Using Read',
          turn: 1,
          tool_name: 'Read',
          detail: {
            path: 'src/runtime/hub.ts',
            summary: 'src/runtime/hub.ts',
          },
        },
        {
          level: 'info',
          category: 'tool',
          code: 'tool_completed',
          message: 'Write completed',
          turn: 1,
          tool_name: 'Write',
          detail: {
            path: 'src/server/routes/runtime.ts',
            summary: 'src/server/routes/runtime.ts',
          },
        },
      ],
      transcript: [],
    }));
    (orchestrator as any).agentRunner = ctx.agentRunner;

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Progress' }) };
      }
      return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
    });
    (orchestrator as any).readWorkspaceFile = mock(async (_workspacePath: string, filename: string) => (
      filename === 'HANDOVER.md' ? '# Handover\nImplemented feature.' : null
    ));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
    expect(workItem?.touched_paths).toEqual([
      'src/runtime/hub.ts',
      'src/server/routes/runtime.ts',
    ]);
    expect(workItem?.touched_areas).toEqual(['runtime', 'server']);
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
    expect(ctx.githubIssueClient.closeIssue).toHaveBeenCalledWith(501);
    expect(ctx.workspaceManager.removeWorkspace).toHaveBeenCalled();
  });

  it('closes the mapped GitHub issue when merge success is handled directly', async () => {
    const issue = makeIssue({ state: 'In Review' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;
    (orchestrator as any).cleanupAllTerminalIssueBranches = mock(async () => undefined);

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: 'In Review',
      github_repo: 'owner/repo',
      github_issue_number: 501,
      workspace_path: '/tmp/symphony-tests/repo/INT-1',
      orchestrator_state: 'workspace_ready',
    });

    const result = await orchestrator.handleMergeSuccess(issue);

    expect(result).toEqual({ success: true });
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(issue.id, 'Done');
    expect(ctx.githubIssueClient.closeIssue).toHaveBeenCalledWith(501);
  });

  it('records decision memory when a review completes with approval and no missing requirements', async () => {
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
      filename === 'REVIEW_REPORT.md'
        ? '## Review Decision: APPROVE\n\n## Review Summary\nLooks good to merge.'
        : null
    ));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const decisions = new DecisionMemoryRepository(ctx.db).findByRepoKey('owner/repo');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.detail_json).toMatchObject({
      source_issue_identifier: issue.identifier,
    });
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

  it('halts merge blocked work and records a MERGE_BLOCKED delivery failure', async () => {
    const issue = makeIssue({ state: 'In Review' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;
    const failedEvents: string[] = [];
    orchestrator.on('issue:failed', (_issue, error) => {
      failedEvents.push(String(error));
    });

    (orchestrator as any).runCliCommand = mock(async (command: string) => {
      if (command === 'dispatch') {
        return { success: true, result: makeCliResult({ final_state: 'In Review' }) };
      }
      return {
        success: true,
        result: makeCliResult({
          final_state: 'Error',
          review_decision: 'MERGE_BLOCKED',
          feedback: 'Merge blocked by conflicts',
          delivery_code: 'merge_blocked',
          delivery_summary: 'Merge blocked: conflicts need manual resolution',
          retry_hint: 'stop',
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

    expect(workItem?.linear_state).toBe('In Review');
    expect(workItem?.orchestrator_state).toBe('halted');
    expect(workItem?.delivery_code).toBe('merge_blocked');
    expect(workItem?.delivery_summary).toContain('manual resolution');
    expect(workItem?.last_review_decision).toBe('MERGE_BLOCKED');
    expect(latestReview?.decision).toBe('MERGE_BLOCKED');
    expect(String(latestReview?.merge_block_reason || '')).toContain('Merge blocked by conflicts');
    expect(ctx.tracker.postComment).toHaveBeenCalledWith(
      issue.id,
      expect.stringContaining('The orchestrator stopped this task'),
    );
    expect(ctx.tracker.updateIssueState).not.toHaveBeenCalledWith(issue.id, 'In Progress');
    expect(state.retry_attempts.get(issue.id)).toBeUndefined();
    expect(state.running.has(issue.id)).toBe(false);
    expect(failedEvents.some((error) => error.includes('manual resolution'))).toBe(true);
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

  it('infers supervisor locale from the original createIssue request language', async () => {
    const englishIssue = makeIssue({ id: 'issue-created-en', identifier: 'INT-55E', title: 'Create smoke test' });
    let ctx = createOrchestrator(englishIssue);
    orchestrator = ctx.orchestrator;

    await orchestrator.createIssue({
      title: 'Create an issue and conduct a smoke test',
      description: 'Require the consumption of as few tokens as possible.',
      team_id: 'team-1',
    });

    expect(ctx.workItemRepository.findByLinearIssueId(englishIssue.id)?.supervisor_locale).toBe('en');

    const chineseIssue = makeIssue({ id: 'issue-created-zh', identifier: 'INT-55Z', title: '建立 smoke test' });
    ctx = createOrchestrator(chineseIssue);
    orchestrator = ctx.orchestrator;

    await orchestrator.createIssue({
      title: '建立一个issue，进行一次smoke test',
      description: '要求消耗尽可能少的token',
      team_id: 'team-1',
    });

    expect(ctx.workItemRepository.findByLinearIssueId(chineseIssue.id)?.supervisor_locale).toBe('zh');
  });

  it('createIssue persists supervisor execution intent onto the created work item', async () => {
    const issue = makeIssue({ id: 'issue-created', identifier: 'INT-57', title: 'Created from supervisor plan' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const result = await orchestrator.createIssue({
      title: 'Created from supervisor plan',
      description: 'hello',
      team_id: 'team-1',
      supervisor_execution_intent: {
        root_session_id: 'session-42',
        repo_ref: 'proj',
        plan_summary: '清理 runtime 主链并保留 Telegram 治理体验',
        acceptance_summary: 'runtime 主链更稳定，Telegram 卡片语义不回退。',
        approved_execution_mode: 'root_with_split_queue',
        plan_card: {
          title: '清理 runtime 主链',
          user_goal: '清理 runtime 主链并保留 Telegram 治理体验',
          in_scope: ['runtime 主链', 'Telegram 治理卡'],
          out_of_scope: ['不重做 Discord'],
          acceptance: ['runtime 主链更稳定', 'Telegram 卡片语义不回退'],
          known_risks: ['需要顺序推进 child queue'],
          execution_strategy: 'root 保持主线程，child 顺序接力。',
          needs_user_approval: true,
          repo_ref: 'owner/repo',
          project_slug: 'proj',
          clarification_question: null,
          materialization_mode: 'root_with_split_queue',
          recommended_option: {
            label: '按推荐继续',
            summary: '批准后开始顺序执行子任务。',
          },
          alternate_option: null,
          governance_preview: null,
        },
      },
    });

    const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
    expect(result.accepted).toBe(true);
    expect(workItem?.supervisor_root_session_id).toBe('session-42');
    expect(workItem?.supervisor_plan_summary).toContain('清理 runtime 主链');
    expect(workItem?.supervisor_acceptance_summary).toContain('Telegram 卡片语义不回退');
    expect(workItem?.supervisor_execution_mode).toBe('root_with_split_queue');
  });

  it('createIssue with defer_dispatch does not immediately dispatch or schedule a tick before children are created', async () => {
    const issue = makeIssue({ id: 'issue-deferred-root', identifier: 'INT-58', title: 'Deferred root' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;
    (orchestrator as any).running = true;
    (orchestrator as any).dispatchIssue = mock(async () => undefined);
    (orchestrator as any).scheduleTick = mock(() => undefined);

    const result = await orchestrator.createIssue({
      title: 'Deferred root',
      description: 'root should wait for child queue',
      project_slug: 'proj',
      defer_dispatch: true,
    });

    expect(result.accepted).toBe(true);
    expect((orchestrator as any).dispatchIssue).not.toHaveBeenCalled();
    expect((orchestrator as any).scheduleTick).not.toHaveBeenCalled();
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

  it('injects persisted supervisor plan and acceptance guidance into the dev prompt', async () => {
    const issue = makeIssue({ state: 'Todo', title: 'Runtime cleanup with supervisor context' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'discovering',
      supervisor_root_session_id: 'session-99',
      supervisor_plan_summary: '先清理 runtime 主链，再稳定 Telegram 治理线程。',
      supervisor_acceptance_summary: 'runtime 不再抖动，Telegram 主卡稳定停留在同一条消息里。',
      supervisor_execution_mode: 'root_with_split_queue',
    });
    const supervisorSessions = new SupervisorSessionRepository(ctx.db);
    const supervisorEvents = new SupervisorSessionEventRepository(ctx.db);
    const supervisorMemories = new SupervisorMemoryRepository(ctx.db);
    supervisorSessions.create({
      id: 'session-99',
      transport: 'telegram',
      conversation_id: 'chat-99',
      user_id: 'user-99',
      state: 'executing',
      repo_ref: 'proj',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: issue.id,
      current_child_issue_id: 'child-1',
      plan_card: {
        title: '稳定 runtime 和 Telegram 治理线程',
        user_goal: '用户希望控制面不再刷屏，执行链路可以稳定闭环。',
        in_scope: ['runtime 主链降噪', 'Telegram root session 语义稳定'],
        out_of_scope: ['不重做 Discord'],
        acceptance: ['Telegram 主卡不重复', 'dev agent 按 root 计划推进'],
        known_risks: ['历史 followup 可能残留'],
        execution_strategy: '当前 child 完成后再接力后续队列。',
        needs_user_approval: true,
        repo_ref: 'owner/repo',
        project_slug: 'proj',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '批准并开始',
          summary: '按 root thread 推进。',
        },
        alternate_option: null,
        governance_preview: null,
      },
      delivery_state: 'proof_satisfied',
      delivery_summary: '证据基本满足，等待最终交付动作。',
      last_material_outcome: {
        milestone_kind: 'waiting_on_child',
        next_recommended_action: '先完成当前 child。',
        dev_instruction: '下一轮先确认 Telegram root card 不重复，再做最小可验证推进。',
        supervisor_decision: 'continue',
      },
    });
    supervisorEvents.create({
      id: 'event-99',
      session_id: 'session-99',
      event_kind: 'orchestrator_milestone',
      payload_json: {
        milestone_kind: 'waiting_on_child',
        summary: '当前 child 正在处理。',
      },
    });
    supervisorMemories.upsert({
      repo_ref: 'owner/repo',
      memory_kind: 'execution_pattern',
      subject_key: 'telegram-root-card-stability',
      summary: '历史经验：Telegram root card 更新必须保持同一 message_id，避免用户被 fallback 刷屏。',
      confidence: 0.9,
    });

    ctx.agentRunner.runTurn = mock(async (_child: unknown, _threadId: string, prompt: string) => ({
      success: true,
      completed: true,
      cancelled: false,
      tokens: { input: 10, output: 5, total: 15 },
      claude_api_calls: 1,
      timeline: [],
      transcript: [{
        role: 'assistant',
        kind: 'message',
        text: prompt,
        turn: 1,
        tool_name: null,
      }],
    }));
    (orchestrator as any).agentRunner = ctx.agentRunner;
    (orchestrator as any).runCliCommand = mock(async () => ({
      success: true,
      result: makeCliResult({ final_state: 'In Review' }),
    }));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const prompt = ctx.agentRunner.runTurn.mock.calls[0]?.[2];
    expect(prompt).toContain('Supervisor-Approved Plan');
    expect(prompt).toContain('先清理 runtime 主链，再稳定 Telegram 治理线程。');
    expect(prompt).toContain('runtime 不再抖动，Telegram 主卡稳定停留在同一条消息里。');
    expect(prompt).toContain('ROOT_WITH_SPLIT_QUEUE');
    expect(prompt).toContain('Supervisor Session Memory');
    expect(prompt).toContain('Supervisor Long-Term Memory');
    expect(prompt).toContain('Telegram root card 更新必须保持同一 message_id');
    expect(prompt).toContain('orchestrator_milestone');
    expect(prompt).toContain('Supervisor Oversight');
    expect(prompt).toContain('下一轮先确认 Telegram root card 不重复');
    expect(prompt).toContain('用户希望控制面不再刷屏');
    expect(prompt).toContain('child-1');
  });

  it('injects supervisor output language guidance into the dev prompt for English requests', async () => {
    const issue = makeIssue({ state: 'Todo', title: 'Create smoke test' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'discovering',
      supervisor_locale: 'en',
    });

    ctx.agentRunner.runTurn = mock(async (_child: unknown, _threadId: string, prompt: string) => ({
      success: true,
      completed: true,
      cancelled: false,
      tokens: { input: 10, output: 5, total: 15 },
      claude_api_calls: 1,
      timeline: [],
      transcript: [{
        role: 'assistant',
        kind: 'message',
        text: prompt,
        turn: 1,
        tool_name: null,
      }],
    }));
    (orchestrator as any).agentRunner = ctx.agentRunner;
    (orchestrator as any).runCliCommand = mock(async () => ({
      success: true,
      result: makeCliResult({ final_state: 'In Review' }),
    }));

    await (orchestrator as any).dispatchIssue(issue, null);
    await awaitWorker(orchestrator, issue.id);

    const prompt = ctx.agentRunner.runTurn.mock.calls[0]?.[2];
    expect(prompt).toContain('## Output Language');
    expect(prompt).toContain('The original user request is English');
    expect(prompt).toContain('Write all user-facing summaries');
    expect(prompt).toContain('## Development Summary');
    expect(prompt).not.toContain('## 开发摘要');
  });

  it('keeps supervisor prompt guidance compact when session memory is noisy', async () => {
    const issue = makeIssue({ id: 'issue-supervisor-compact', identifier: 'INT-920', state: 'Todo' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const workItem = ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'discovering',
      supervisor_root_session_id: 'session-compact',
      supervisor_plan_summary: 'Compact supervisor prompt test.',
      supervisor_acceptance_summary: 'Prompt remains small enough for first-turn budget.',
      supervisor_execution_mode: 'root_with_split_queue',
    });
    const supervisorSessions = new SupervisorSessionRepository(ctx.db);
    const supervisorEvents = new SupervisorSessionEventRepository(ctx.db);
    const supervisorMemories = new SupervisorMemoryRepository(ctx.db);
    supervisorSessions.create({
      id: 'session-compact',
      transport: 'telegram',
      conversation_id: 'chat-compact',
      user_id: 'user-compact',
      state: 'executing',
      repo_ref: 'proj',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 3,
      root_issue_id: issue.id,
      current_child_issue_id: 'child-compact',
      plan_card: {
        title: 'Compact supervisor prompt test',
        user_goal: 'Keep prompts compact.',
        in_scope: ['第一项很长 '.repeat(80), '第二项很长 '.repeat(80)],
        out_of_scope: ['不要把所有历史都塞进 dev prompt '.repeat(80)],
        acceptance: ['上下文裁剪后仍包含关键执行约束 '.repeat(80)],
        known_risks: [],
        execution_strategy: '只推进当前 child，后续排队。',
        needs_user_approval: true,
        repo_ref: 'owner/repo',
        project_slug: 'proj',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: { label: '批准并开始', summary: '继续。' },
        alternate_option: null,
        governance_preview: null,
      },
      delivery_state: 'proof_satisfied',
      delivery_summary: 'delivery summary '.repeat(120),
      last_material_outcome: {
        milestone_kind: 'waiting_on_child',
        latest_dev_instruction: '请检查当前 child，不要重复读取全部历史。'.repeat(80),
        supervisor_decision: 'continue',
        raw_overseer_payload: 'oversight payload '.repeat(200),
      },
    });
    for (let index = 0; index < 12; index += 1) {
      supervisorEvents.create({
        id: `event-compact-${index}`,
        session_id: 'session-compact',
        event_kind: 'orchestrator_milestone',
        payload_json: {
          index,
          summary: 'very noisy repeated milestone '.repeat(120),
        },
      });
    }
    supervisorMemories.upsert({
      repo_ref: 'owner/repo',
      memory_kind: 'execution_pattern',
      subject_key: 'noisy-history',
      summary: 'long memory '.repeat(200),
      confidence: 0.8,
    });

    const section = (orchestrator as any).buildSupervisorPromptSection(workItem);

    expect(section.length).toBeLessThanOrEqual(4200);
    expect(section).toContain('Supervisor-Approved Plan');
    expect(section).toContain('Compact supervisor prompt test');
    expect(section).not.toContain('very noisy repeated milestone very noisy repeated milestone very noisy repeated milestone very noisy repeated milestone');
    expect(section).not.toContain('oversight payload oversight payload oversight payload oversight payload');
  });

  it('createIssue records advisory governance state and skips dispatch when intake critic asks for a split first', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-create-intake-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, '.symphony-constitution.md'),
        [
          '# Constitution',
          '',
          '## Main Path',
          '- Keep one control plane.',
        ].join('\n'),
        'utf8',
      );

      const issue = makeIssue({
        id: 'issue-created',
        identifier: 'INT-88',
        title: 'Refactor runtime API and redesign the web dashboard and rewrite Telegram copy',
        description: 'Do all three in one issue and also clean related files.',
        project_slug: 'proj',
        project_name: 'repo',
      });
      const ctx = createOrchestrator(issue, {
        repositories: {
          routing: {
            proj: {
              github_owner: 'owner',
              github_repo: 'repo',
              local_path: repoRoot,
            },
          },
        },
      });
      orchestrator = ctx.orchestrator;
      ctx.tracker.createIssue = mock(async () => ({ success: true, issue }));
      (orchestrator as any).tracker = ctx.tracker;

      const result = await orchestrator.createIssue({
        title: issue.title,
        description: issue.description,
        project_slug: 'proj',
      });

      const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
      const suggestions = ctx.governanceSuggestionRepository.findPendingByIssueId(issue.id);
      expect(result.accepted).toBe(true);
      expect(result.message).toContain('dispatch is blocked');
      expect(result.message).toContain('split');
      expect(workItem?.governance_decision).toBe('split_before_implement');
      expect(workItem?.governance_status).toBe('advisory');
      expect(workItem?.orchestrator_state).toBe('halted');
      expect(workItem?.governance_source_updated_at?.toISOString()).toBe(issue.updated_at?.toISOString());
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.suggestion_type).toBe('architecture_alignment');
      expect(suggestions[0]?.title).toContain('Split');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('overrideGovernance persists an explicit override for a blocked issue without relying on tracker labels', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-override-intake-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, '.symphony-constitution.md'),
        [
          '# Constitution',
          '',
          '## Main Path',
          '- Keep one control plane.',
        ].join('\n'),
        'utf8',
      );

      const issue = makeIssue({
        id: 'issue-override',
        identifier: 'INT-89',
        title: 'Refactor runtime API and redesign the web dashboard and rewrite Telegram copy',
        description: 'Do all three in one issue and also clean related files.',
        project_slug: 'proj',
        project_name: 'repo',
        labels: [],
      });
      const ctx = createOrchestrator(issue, {
        repositories: {
          routing: {
            proj: {
              github_owner: 'owner',
              github_repo: 'repo',
              local_path: repoRoot,
            },
          },
        },
      });
      orchestrator = ctx.orchestrator;
      ctx.tracker.createIssue = mock(async () => ({ success: true, issue }));
      (orchestrator as any).tracker = ctx.tracker;

      await orchestrator.createIssue({
        title: issue.title,
        description: issue.description,
        project_slug: 'proj',
      });

      const result = await (orchestrator as any).overrideGovernance(issue.id);
      const workItem = ctx.workItemRepository.findByLinearIssueId(issue.id);

      expect(result.accepted).toBe(true);
      expect(result.message).toContain('Override approved');
      expect(workItem?.governance_override_at).not.toBeNull();
      expect((orchestrator as any).hasGovernanceOverride(issue)).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('rewriteGovernance updates the Linear issue, reassesses governance, and clears the pending rewrite suggestion', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-rewrite-intake-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, '.symphony-constitution.md'),
        [
          '# Constitution',
          '',
          '## Main Path',
          '- Keep one control plane.',
        ].join('\n'),
        'utf8',
      );

      let currentIssue = makeIssue({
        id: 'issue-rewrite',
        identifier: 'INT-90',
        title: '优化一下 runtime API',
        description: '处理一下就行',
        project_slug: 'proj',
        project_name: 'repo',
        labels: [],
      });

      const ctx = createOrchestrator(currentIssue, {
        repositories: {
          routing: {
            proj: {
              github_owner: 'owner',
              github_repo: 'repo',
              local_path: repoRoot,
            },
          },
        },
      });
      orchestrator = ctx.orchestrator;
      ctx.tracker.createIssue = mock(async () => ({ success: true, issue: currentIssue }));
      ctx.tracker.fetchIssueById = mock(async () => ({ issue: currentIssue, error: null }));
      ctx.tracker.updateIssueContent = mock(async (_issueId: string, input: { title?: string | null; description?: string | null }) => {
        currentIssue = {
          ...currentIssue,
          title: input.title ?? currentIssue.title,
          description: input.description ?? currentIssue.description,
        };
        return { success: true };
      });
      (orchestrator as any).tracker = ctx.tracker;

      await orchestrator.createIssue({
        title: currentIssue.title,
        description: currentIssue.description,
        project_slug: 'proj',
      });

      const result = await (orchestrator as any).rewriteGovernance(currentIssue.id);
      const workItem = ctx.workItemRepository.findByLinearIssueId(currentIssue.id);
      const pendingSuggestions = ctx.governanceSuggestionRepository.findPendingByIssueId(currentIssue.id);

      expect(result.accepted).toBe(true);
      expect(result.message).toContain('Rewrite applied');
      expect(ctx.tracker.updateIssueContent).toHaveBeenCalledTimes(1);
      expect(currentIssue.title).not.toContain('优化一下');
      expect(workItem?.governance_decision).toBe('accept');
      expect(workItem?.orchestrator_state).not.toBe('halted');
      expect(pendingSuggestions).toHaveLength(0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('splitGovernance rewrites the original issue and creates follow-up Linear issues for the remaining slices', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-split-intake-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, '.symphony-constitution.md'),
        [
          '# Constitution',
          '',
          '## Main Path',
          '- Keep one control plane.',
        ].join('\n'),
        'utf8',
      );

      let currentIssue = makeIssue({
        id: 'issue-split',
        identifier: 'INT-91',
        title: 'Refactor runtime API and redesign the web dashboard and rewrite Telegram copy',
        description: 'Do all three in one issue and also clean related files.',
        project_slug: 'proj',
        project_name: 'repo',
        labels: [],
      });

      const childIssues: Issue[] = [];
      const ctx = createOrchestrator(currentIssue, {
        repositories: {
          routing: {
            proj: {
              github_owner: 'owner',
              github_repo: 'repo',
              local_path: repoRoot,
            },
          },
        },
      });
      orchestrator = ctx.orchestrator;
      ctx.tracker.createIssue = mock(async (input: { title: string; description?: string | null }) => {
        if (input.title === currentIssue.title) {
          return { success: true, issue: currentIssue };
        }

        const childIssue: Issue = {
          ...makeIssue({
            id: `child-${childIssues.length + 1}`,
            identifier: `INT-91${childIssues.length + 2}`,
            title: input.title,
            description: input.description ?? null,
            project_slug: 'proj',
            project_name: 'repo',
          }),
        };
        childIssues.push(childIssue);
        return { success: true, issue: childIssue };
      });
      ctx.tracker.fetchIssueById = mock(async () => ({ issue: currentIssue, error: null }));
      ctx.tracker.updateIssueContent = mock(async (_issueId: string, input: { title?: string | null; description?: string | null }) => {
        currentIssue = {
          ...currentIssue,
          title: input.title ?? currentIssue.title,
          description: input.description ?? currentIssue.description,
        };
        return { success: true };
      });
      (orchestrator as any).tracker = ctx.tracker;

      await orchestrator.createIssue({
        title: currentIssue.title,
        description: currentIssue.description,
        project_slug: 'proj',
      });

      const result = await (orchestrator as any).splitGovernance(currentIssue.id);
      const workItem = ctx.workItemRepository.findByLinearIssueId(currentIssue.id);
      const childWorkItems = childIssues.map((childIssue) => ctx.workItemRepository.findByLinearIssueId(childIssue.id));
      const pendingSuggestions = ctx.governanceSuggestionRepository.findPendingByIssueId(currentIssue.id);

      expect(result.accepted).toBe(true);
      expect(result.message).toContain('Split applied');
      expect(result.governance_action?.outcome_kind).toBe('waiting_on_child');
      expect(result.governance_action?.created_issue_identifiers).toEqual(childIssues.map((childIssue) => childIssue.identifier));
      expect(childIssues.length).toBeGreaterThanOrEqual(1);
      expect(ctx.tracker.updateIssueContent).toHaveBeenCalledTimes(1);
      expect(workItem?.governance_decision).toBe('accept');
      expect(workItem?.orchestrator_state).toBe('halted');
      expect(workItem?.governance_root_issue_id).toBe(currentIssue.id);
      expect(workItem?.governance_parent_issue_id).toBeNull();
      expect(workItem?.governance_generation).toBe(0);
      expect(childWorkItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            governance_root_issue_id: currentIssue.id,
            governance_parent_issue_id: currentIssue.id,
            governance_generation: 1,
          }),
        ]),
      );
      expect(pendingSuggestions).toHaveLength(0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('splitGovernance keeps the root issue waiting on child work instead of redispatching it', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-split-root-waiting-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, '.symphony-constitution.md'),
        [
          '# Constitution',
          '',
          '## Main Path',
          '- Keep one control plane.',
        ].join('\n'),
        'utf8',
      );

      let currentIssue = makeIssue({
        id: 'issue-split-root-waiting',
        identifier: 'INT-911',
        title: 'Refactor runtime API and redesign the web dashboard and rewrite Telegram copy',
        description: 'Do all three in one issue and also clean related files.',
        project_slug: 'proj',
        project_name: 'repo',
        state: 'In Progress',
        labels: [],
      });

      const childIssues: Issue[] = [];
      const ctx = createOrchestrator(currentIssue, {
        repositories: {
          routing: {
            proj: {
              github_owner: 'owner',
              github_repo: 'repo',
              local_path: repoRoot,
            },
          },
        },
      });
      orchestrator = ctx.orchestrator;
      ctx.tracker.createIssue = mock(async (input: { title: string; description?: string | null }) => {
        if (input.title === currentIssue.title) {
          return { success: true, issue: currentIssue };
        }

        const childIssue: Issue = {
          ...makeIssue({
            id: `child-root-waiting-${childIssues.length + 1}`,
            identifier: `INT-911${childIssues.length + 2}`,
            title: input.title,
            description: input.description ?? null,
            project_slug: 'proj',
            project_name: 'repo',
          }),
        };
        childIssues.push(childIssue);
        return { success: true, issue: childIssue };
      });
      ctx.tracker.fetchIssueById = mock(async () => ({ issue: currentIssue, error: null }));
      ctx.tracker.updateIssueContent = mock(async (_issueId: string, input: { title?: string | null; description?: string | null }) => {
        currentIssue = {
          ...currentIssue,
          title: input.title ?? currentIssue.title,
          description: input.description ?? currentIssue.description,
        };
        return { success: true };
      });
      (orchestrator as any).tracker = ctx.tracker;
      (orchestrator as any).running = true;
      const dispatchIssue = mock(async () => {
        throw new Error('root issue should wait on governance children instead of redispatching');
      });
      (orchestrator as any).dispatchIssue = dispatchIssue;

      await orchestrator.createIssue({
        title: currentIssue.title,
        description: currentIssue.description,
        project_slug: 'proj',
      });

      const result = await (orchestrator as any).splitGovernance(currentIssue.id);
      const workItem = ctx.workItemRepository.findByLinearIssueId(currentIssue.id);

      expect(result.accepted).toBe(true);
      expect(result.governance_action?.outcome_kind).toBe('waiting_on_child');
      expect(result.governance_action?.created_issue_identifiers).toEqual(childIssues.map((childIssue) => childIssue.identifier));
      expect(dispatchIssue).not.toHaveBeenCalled();
      expect((orchestrator as any).shouldDispatch(currentIssue)).toBe(false);
      expect(workItem?.orchestrator_state).toBe('halted');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('does not dispatch a supervisor root after all child queue items completed', async () => {
    const rootIssue = makeIssue({
      id: 'issue-root-all-children-done',
      identifier: 'INT-915',
      title: 'Supervisor root coordinator',
      state: 'In Progress',
      project_slug: 'proj',
    });
    const ctx = createOrchestrator(rootIssue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: rootIssue.id,
      linear_issue_id: rootIssue.id,
      linear_identifier: rootIssue.identifier,
      linear_title: rootIssue.title,
      linear_state: rootIssue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'halted',
      governance_root_issue_id: rootIssue.id,
      governance_generation: 0,
      supervisor_root_session_id: 'session-root',
      supervisor_plan_summary: 'Root coordinates a child queue.',
      supervisor_acceptance_summary: 'All children complete.',
      supervisor_execution_mode: 'root_with_split_queue',
    });
    ctx.workItemRepository.create({
      id: 'issue-child-done-1',
      linear_issue_id: 'issue-child-done-1',
      linear_identifier: 'INT-916',
      linear_title: 'First child',
      linear_state: 'Done',
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
      governance_root_issue_id: rootIssue.id,
      governance_parent_issue_id: rootIssue.id,
      governance_generation: 1,
      delivery_state: 'completed',
    });
    ctx.workItemRepository.create({
      id: 'issue-child-done-2',
      linear_issue_id: 'issue-child-done-2',
      linear_identifier: 'INT-917',
      linear_title: 'Second child',
      linear_state: 'Done',
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
      governance_root_issue_id: rootIssue.id,
      governance_parent_issue_id: rootIssue.id,
      governance_generation: 1,
      delivery_state: 'completed',
    });

    expect((orchestrator as any).shouldDispatch(rootIssue)).toBe(false);
  });

  it('finalizes a supervisor root coordinator after all child queue items completed', async () => {
    const rootIssue = makeIssue({
      id: 'issue-root-ready-to-finalize',
      identifier: 'INT-918A',
      title: 'Supervisor root ready to finalize',
      state: 'In Progress',
      project_slug: 'proj',
    });
    const ctx = createOrchestrator(rootIssue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: rootIssue.id,
      linear_issue_id: rootIssue.id,
      linear_identifier: rootIssue.identifier,
      linear_title: rootIssue.title,
      linear_state: rootIssue.state,
      github_repo: 'owner/repo',
      github_issue_number: 777,
      orchestrator_state: 'halted',
      governance_root_issue_id: rootIssue.id,
      governance_generation: 0,
      supervisor_root_session_id: 'session-root',
      supervisor_plan_summary: 'Root coordinates a child queue.',
      supervisor_acceptance_summary: 'All children complete.',
      supervisor_execution_mode: 'root_with_split_queue',
    });
    ctx.workItemRepository.create({
      id: 'issue-child-finalize-1',
      linear_issue_id: 'issue-child-finalize-1',
      linear_identifier: 'INT-918B',
      linear_title: 'First child',
      linear_state: 'Done',
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
      governance_root_issue_id: rootIssue.id,
      governance_parent_issue_id: rootIssue.id,
      governance_generation: 1,
      delivery_state: 'completed',
    });
    ctx.workItemRepository.create({
      id: 'issue-child-finalize-2',
      linear_issue_id: 'issue-child-finalize-2',
      linear_identifier: 'INT-918C',
      linear_title: 'Second child',
      linear_state: 'Done',
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
      governance_root_issue_id: rootIssue.id,
      governance_parent_issue_id: rootIssue.id,
      governance_generation: 1,
      delivery_state: 'completed',
    });

    const finalized = await (orchestrator as any).finalizeCompletedSupervisorRootIfNeeded(rootIssue);

    expect(finalized).toBe(true);
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(rootIssue.id, 'Done');
    const workItem = ctx.workItemRepository.findByLinearIssueId(rootIssue.id);
    expect(workItem?.linear_state).toBe('Done');
    expect(workItem?.orchestrator_state).toBe('completed');
    expect(workItem?.delivery_code).toBeNull();
    expect(workItem?.delivery_summary).toContain('所有顺序子任务已完成');
  });

  it('serializes split governance children so only the earliest non-terminal child can dispatch', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-split-serialized-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, '.symphony-constitution.md'),
        [
          '# Constitution',
          '',
          '## Main Path',
          '- Keep one control plane.',
        ].join('\n'),
        'utf8',
      );

      let currentIssue = makeIssue({
        id: 'issue-split-serialized',
        identifier: 'INT-912',
        title: 'Refactor runtime API and redesign the web dashboard and rewrite Telegram copy',
        description: 'Do all three in one issue and also clean related files.',
        project_slug: 'proj',
        project_name: 'repo',
        state: 'In Progress',
        labels: [],
      });

      const childIssues: Issue[] = [];
      const ctx = createOrchestrator(currentIssue, {
        repositories: {
          routing: {
            proj: {
              github_owner: 'owner',
              github_repo: 'repo',
              local_path: repoRoot,
            },
          },
        },
      });
      orchestrator = ctx.orchestrator;
      ctx.tracker.createIssue = mock(async (input: { title: string; description?: string | null }) => {
        if (input.title === currentIssue.title) {
          return { success: true, issue: currentIssue };
        }

        const childIssue: Issue = {
          ...makeIssue({
            id: `child-serialized-${childIssues.length + 1}`,
            identifier: `INT-912${childIssues.length + 2}`,
            title: input.title,
            description: input.description ?? null,
            project_slug: 'proj',
            project_name: 'repo',
          }),
        };
        childIssues.push(childIssue);
        return { success: true, issue: childIssue };
      });
      ctx.tracker.fetchIssueById = mock(async () => ({ issue: currentIssue, error: null }));
      ctx.tracker.updateIssueContent = mock(async (_issueId: string, input: { title?: string | null; description?: string | null }) => {
        currentIssue = {
          ...currentIssue,
          title: input.title ?? currentIssue.title,
          description: input.description ?? currentIssue.description,
        };
        return { success: true };
      });
      (orchestrator as any).tracker = ctx.tracker;

      await orchestrator.createIssue({
        title: currentIssue.title,
        description: currentIssue.description,
        project_slug: 'proj',
      });

      const result = await (orchestrator as any).splitGovernance(currentIssue.id);
      expect(result.accepted).toBe(true);
      expect(childIssues.length).toBeGreaterThanOrEqual(2);

      const [firstChild, secondChild, thirdChild] = childIssues;
      if (!firstChild || !secondChild) {
        throw new Error('Expected at least two split governance children');
      }

      expect((orchestrator as any).shouldDispatch(firstChild)).toBe(true);
      expect((orchestrator as any).shouldDispatch(secondChild)).toBe(false);
      expect(ctx.workItemRepository.findByLinearIssueId(secondChild.id)?.orchestrator_state).toBe('halted');
      if (thirdChild) {
        expect((orchestrator as any).shouldDispatch(thirdChild)).toBe(false);
        expect(ctx.workItemRepository.findByLinearIssueId(thirdChild.id)?.orchestrator_state).toBe('halted');
      }

      firstChild.state = 'Done';
      ctx.workItemRepository.update({
        id: firstChild.id,
        linear_state: 'Done',
        orchestrator_state: 'completed',
      });

      expect((orchestrator as any).shouldDispatch(secondChild)).toBe(true);
      if (thirdChild) {
        expect((orchestrator as any).shouldDispatch(thirdChild)).toBe(false);
      }

      secondChild.state = 'Done';
      ctx.workItemRepository.update({
        id: secondChild.id,
        linear_state: 'Done',
        orchestrator_state: 'completed',
      });

      if (thirdChild) {
        expect((orchestrator as any).shouldDispatch(thirdChild)).toBe(true);
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('does not redispatch an unchanged in-review issue after it has failed and requires manual intervention', async () => {
    const issue = makeIssue({
      id: 'issue-manual-review-stop',
      identifier: 'INT-913',
      state: 'In Review',
      updated_at: new Date('2025-01-01T00:00:00Z'),
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'failed',
    });

    expect((orchestrator as any).shouldDispatch(issue)).toBe(false);
  });

  it('allows redispatch after a failed in-review issue has materially changed in the tracker', async () => {
    const issue = makeIssue({
      id: 'issue-manual-review-updated',
      identifier: 'INT-914',
      state: 'In Review',
      updated_at: new Date(Date.now() + 60_000),
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'failed',
    });

    expect((orchestrator as any).shouldDispatch(issue)).toBe(true);
  });

  it('recovers tracker state conflicts when the tracker is already at the requested state', async () => {
    const issue = makeIssue({
      id: 'issue-tracker-conflict',
      identifier: 'INT-914A',
      state: 'Todo',
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.tracker.updateIssueState = mock(async () => ({
      success: false,
      error: 'Issue issue-tracker-conflict already in state IN_REVIEW',
    }));
    ctx.tracker.fetchIssueById = mock(async () => ({
      issue: {
        ...issue,
        state: 'In Review',
      },
      error: null,
    }));
    (orchestrator as any).tracker = ctx.tracker;

    const result = await (orchestrator as any).syncLinearState(issue, 'In Review');

    expect(result).toEqual({
      success: true,
      recovered: true,
      currentState: 'In Review',
      error: null,
    });
    expect(ctx.tracker.fetchIssueById).toHaveBeenCalledWith(issue.id);
  });

  it('executeGovernanceSuggestion creates a governance follow-up issue and dismissGovernanceSuggestion hides it from active suggestions', async () => {
    const issue = makeIssue({
      id: 'issue-governance-exec',
      identifier: 'INT-92',
      state: 'Done',
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
      supervisor_root_session_id: 'session-root-92',
      supervisor_plan_summary: '先处理 root 计划，再按顺序推进治理 follow-up。',
      supervisor_acceptance_summary: '用户始终围绕 root thread 理解这次治理动作。',
      supervisor_execution_mode: 'root_with_split_queue',
    });
    ctx.governanceSuggestionRepository.create({
      id: 'suggestion-cleanup',
      work_item_id: issue.id,
      issue_id: issue.id,
      suggestion_type: 'cleanup',
      title: '[GOVERNANCE] Clean up runtime duplication',
      summary: 'Repeated review churn suggests a cleanup follow-up.',
      detail_json: {
        target_area: 'runtime',
        recommended_issue_title: '[GOVERNANCE] Clean up runtime duplication',
        recommended_issue_description: 'Source issue: INT-92\nRepo: owner/repo\nTarget area: runtime',
      },
    });
    ctx.governanceSuggestionRepository.create({
      id: 'suggestion-dismiss',
      work_item_id: issue.id,
      issue_id: issue.id,
      suggestion_type: 'consolidation',
      title: '[GOVERNANCE] Consolidate runtime duplication',
      summary: 'The same runtime path keeps being split.',
      detail_json: {
        target_area: 'runtime',
      },
    });

    const createdGovernanceIssue = makeIssue({
      id: 'issue-governance-created',
      identifier: 'INT-93',
      title: '[GOVERNANCE] Clean up runtime duplication',
      description: 'Source issue: INT-92\nRepo: owner/repo\nTarget area: runtime',
      state: 'Todo',
    });
    ctx.tracker.fetchIssueById = mock(async () => ({ issue, error: null }));
    ctx.tracker.createIssue = mock(async () => ({ success: true, issue: createdGovernanceIssue }));
    (orchestrator as any).tracker = ctx.tracker;

    const executed = await (orchestrator as any).executeGovernanceSuggestion(issue.id, 'suggestion-cleanup');
    const dismissed = await (orchestrator as any).dismissGovernanceSuggestion(issue.id, 'suggestion-dismiss');

    expect(executed.accepted).toBe(true);
    expect(executed.message).toContain('INT-93');
    expect(ctx.tracker.createIssue).toHaveBeenCalledTimes(1);
    expect(ctx.workItemRepository.findByLinearIssueId(createdGovernanceIssue.id)).toMatchObject({
      supervisor_root_session_id: 'session-root-92',
      supervisor_plan_summary: '先处理 root 计划，再按顺序推进治理 follow-up。',
      supervisor_acceptance_summary: '用户始终围绕 root thread 理解这次治理动作。',
      supervisor_execution_mode: 'root_with_split_queue',
    });
    expect(ctx.governanceSuggestionRepository.findById('suggestion-cleanup')?.status).toBe('accepted');
    expect(ctx.governanceSuggestionRepository.findById('suggestion-dismiss')?.status).toBe('dismissed');
    expect(dismissed.accepted).toBe(true);
    expect(dismissed.message).toContain('Dismissed');
  });

  it('executeGovernanceSuggestion creates only one governance descendant layer and suppresses descendant governance suggestions', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-governance-descendant-'));
    try {
      fs.writeFileSync(
        path.join(repoRoot, '.symphony-constitution.md'),
        [
          '# Constitution',
          '',
          '## Main Path',
          '- Keep one control plane.',
        ].join('\n'),
        'utf8',
      );

      const issue = makeIssue({
        id: 'issue-governance-root',
        identifier: 'INT-94',
        state: 'Done',
      });
      const ctx = createOrchestrator(issue, {
        repositories: {
          routing: {
            proj: {
              github_owner: 'owner',
              github_repo: 'repo',
              local_path: repoRoot,
            },
          },
        },
      });
      orchestrator = ctx.orchestrator;

      ctx.workItemRepository.create({
        id: issue.id,
        linear_issue_id: issue.id,
        linear_identifier: issue.identifier,
        linear_title: issue.title,
        linear_state: issue.state,
        github_repo: 'owner/repo',
        orchestrator_state: 'completed',
      });
      ctx.governanceSuggestionRepository.create({
        id: 'suggestion-descendant-stop',
        work_item_id: issue.id,
        issue_id: issue.id,
        suggestion_type: 'cleanup',
        title: '[GOVERNANCE] Consolidate runtime and bot cleanup',
        summary: 'Create a focused cleanup follow-up.',
        detail_json: {
          target_area: 'runtime',
          recommended_issue_title: '[GOVERNANCE FOLLOW-UP for INT-94] Runtime and bot cleanup',
          recommended_issue_description: 'Clean runtime + bot cleanup in a single focused task.',
        },
      });

      const createdGovernanceIssue = makeIssue({
        id: 'issue-governance-child',
        identifier: 'INT-95',
        title: '[GOVERNANCE FOLLOW-UP for INT-94] Runtime and bot cleanup',
        description: 'Clean runtime, bot copy, and webhook flow together.',
        state: 'Todo',
      });
      ctx.tracker.fetchIssueById = mock(async () => ({ issue, error: null }));
      ctx.tracker.createIssue = mock(async () => ({ success: true, issue: createdGovernanceIssue }));
      (orchestrator as any).tracker = ctx.tracker;

      const executed = await (orchestrator as any).executeGovernanceSuggestion(issue.id, 'suggestion-descendant-stop');
      const childWorkItem = ctx.workItemRepository.findByLinearIssueId(createdGovernanceIssue.id);

      expect(executed.accepted).toBe(true);
      expect(executed.governance_action?.outcome_kind).toBe('waiting_on_child');
      expect(executed.governance_action?.created_issue_identifiers).toEqual(['INT-95']);
      expect(childWorkItem?.governance_root_issue_id).toBe(issue.id);
      expect(childWorkItem?.governance_parent_issue_id).toBe(issue.id);
      expect(childWorkItem?.governance_generation).toBe(1);
      expect(ctx.governanceSuggestionRepository.findPendingByIssueId(createdGovernanceIssue.id)).toHaveLength(0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('executeGovernanceSuggestion reuses an equivalent open governance child instead of creating a duplicate', async () => {
    const issue = makeIssue({
      id: 'issue-governance-dedupe',
      identifier: 'INT-941',
      state: 'Done',
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
    });
    ctx.workItemRepository.create({
      id: 'issue-governance-existing-child',
      linear_issue_id: 'issue-governance-existing-child',
      linear_identifier: 'INT-942',
      linear_title: '[GOVERNANCE FOLLOW-UP for INT-941] Clean runtime duplication',
      linear_state: 'Todo',
      github_repo: 'owner/repo',
      orchestrator_state: 'halted',
      governance_root_issue_id: issue.id,
      governance_parent_issue_id: issue.id,
      governance_generation: 1,
      architectural_target: 'runtime<->server',
    });
    ctx.governanceSuggestionRepository.create({
      id: 'suggestion-dedupe',
      work_item_id: issue.id,
      issue_id: issue.id,
      suggestion_type: 'cleanup',
      title: '[GOVERNANCE] Clean up runtime duplication',
      summary: 'Repeated review churn suggests a cleanup follow-up.',
      detail_json: {
        target_area: 'runtime',
        architectural_target: 'runtime<->server',
        recommended_issue_title: '[GOVERNANCE FOLLOW-UP for INT-941] Clean runtime duplication',
        recommended_issue_description: 'Source issue: INT-941\nRepo: owner/repo\nTarget area: runtime',
      },
    });

    ctx.tracker.fetchIssueById = mock(async () => ({ issue, error: null }));
    ctx.tracker.createIssue = mock(async () => {
      throw new Error('duplicate governance child should be reused instead of recreated');
    });
    (orchestrator as any).tracker = ctx.tracker;

    const executed = await (orchestrator as any).executeGovernanceSuggestion(issue.id, 'suggestion-dedupe');

    expect(executed.accepted).toBe(true);
    expect(executed.message).toContain('INT-942');
    expect(executed.governance_action?.outcome_kind).toBe('waiting_on_child');
    expect(executed.governance_action?.created_issue_identifiers).toEqual(['INT-942']);
    expect(ctx.tracker.createIssue).not.toHaveBeenCalled();
    expect(ctx.governanceSuggestionRepository.findById('suggestion-dedupe')?.status).toBe('accepted');
  });

  it('executeGovernanceSuggestion does not synchronously dispatch the created governance issue', async () => {
    const issue = makeIssue({
      id: 'issue-governance-nonblocking',
      identifier: 'INT-98',
      state: 'Done',
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
    });
    ctx.governanceSuggestionRepository.create({
      id: 'suggestion-nonblocking',
      work_item_id: issue.id,
      issue_id: issue.id,
      suggestion_type: 'cleanup',
      title: '[GOVERNANCE] Clean up runtime duplication',
      summary: 'Repeated review churn suggests a cleanup follow-up.',
      detail_json: {
        target_area: 'runtime',
        recommended_issue_title: '[GOVERNANCE] Clean up runtime duplication',
        recommended_issue_description: 'Source issue: INT-98\nRepo: owner/repo\nTarget area: runtime',
      },
    });

    const createdGovernanceIssue = makeIssue({
      id: 'issue-governance-created-nonblocking',
      identifier: 'INT-99',
      title: '[GOVERNANCE] Clean up runtime duplication',
      description: 'Source issue: INT-98\nRepo: owner/repo\nTarget area: runtime',
      state: 'Todo',
    });
    ctx.tracker.fetchIssueById = mock(async () => ({ issue, error: null }));
    ctx.tracker.createIssue = mock(async () => ({ success: true, issue: createdGovernanceIssue }));
    (orchestrator as any).tracker = ctx.tracker;
    (orchestrator as any).running = true;
    const dispatchIssue = mock(async () => {
      throw new Error('executeGovernanceSuggestion should not await dispatchIssue');
    });
    (orchestrator as any).dispatchIssue = dispatchIssue;

    const executed = await (orchestrator as any).executeGovernanceSuggestion(issue.id, 'suggestion-nonblocking');

    expect(executed.accepted).toBe(true);
    expect(executed.message).toContain('INT-99');
    expect(dispatchIssue).not.toHaveBeenCalled();
    expect(ctx.governanceSuggestionRepository.findById('suggestion-nonblocking')?.status).toBe('accepted');
  });

  it('closes governance child issues as no-op completions when delivery finds no actionable diff', async () => {
    const rootIssue = makeIssue({
      id: 'issue-root-noop',
      identifier: 'INT-950',
      state: 'In Progress',
    });
    const childIssue = makeIssue({
      id: 'issue-child-noop',
      identifier: 'INT-951',
      title: '[GOVERNANCE FOLLOW-UP for INT-950] Validate cleanup',
      state: 'In Progress',
      updated_at: new Date('2025-01-01T00:05:00Z'),
    });
    const siblingIssue = makeIssue({
      id: 'issue-child-next',
      identifier: 'INT-952',
      title: '[GOVERNANCE FOLLOW-UP for INT-950] Real cleanup',
      state: 'Todo',
      updated_at: new Date('2025-01-01T00:06:00Z'),
    });
    const ctx = createOrchestrator(childIssue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: rootIssue.id,
      linear_issue_id: rootIssue.id,
      linear_identifier: rootIssue.identifier,
      linear_title: rootIssue.title,
      linear_state: rootIssue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'halted',
    });
    ctx.workItemRepository.create({
      id: childIssue.id,
      linear_issue_id: childIssue.id,
      linear_identifier: childIssue.identifier,
      linear_title: childIssue.title,
      linear_state: childIssue.state,
      github_repo: 'owner/repo',
      workspace_path: '/tmp/symphony-tests/repo/INT-951',
      orchestrator_state: 'dev_post_processing',
      governance_root_issue_id: rootIssue.id,
      governance_parent_issue_id: rootIssue.id,
      governance_generation: 1,
      delivery_code: 'no_actionable_diff',
      delivery_summary: 'No commits found after workflow artifact cleanup.',
    });
    ctx.workItemRepository.create({
      id: siblingIssue.id,
      linear_issue_id: siblingIssue.id,
      linear_identifier: siblingIssue.identifier,
      linear_title: siblingIssue.title,
      linear_state: siblingIssue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'halted',
      governance_root_issue_id: rootIssue.id,
      governance_parent_issue_id: rootIssue.id,
      governance_generation: 1,
    });

    const runningEntry = {
      worker_handle: Promise.resolve(),
      identifier: childIssue.identifier,
      issue: childIssue,
      stage: 'post_process_dev',
      session_id: null,
      codex_app_server_pid: null,
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
      started_at: new Date('2025-01-01T00:00:00Z'),
      turn_count: 1,
      workspace_path: '/tmp/symphony-tests/repo/INT-951',
      branch_name: 'owner/int-951',
    } as const;

    (orchestrator as any).state.running.set(childIssue.id, runningEntry);
    (orchestrator as any).state.claimed.add(childIssue.id);
    (orchestrator as any).running = true;

    const scheduleTick = mock(() => undefined);
    (orchestrator as any).scheduleTick = scheduleTick;

    await (orchestrator as any).handleWorkerExit(childIssue.id, {
      success: true,
      outcome: 'halted',
      completed: false,
      next_action: 'stop',
      final_state: childIssue.state,
      cleanup_workspace: false,
      workspace_path: '/tmp/symphony-tests/repo/INT-951',
      work_item_id: childIssue.id,
      turns: 1,
      tokens: { input: 0, output: 0, total: 0 },
      claude_api_calls: 0,
      linear_api_calls: 0,
      github_api_calls: 0,
      cli_result: makeCliResult({
        ok: false,
        final_state: childIssue.state,
        delivery_code: 'no_actionable_diff',
        delivery_summary: 'No commits found after workflow artifact cleanup.',
      }),
    } as WorkerResult);

    const closedChild = ctx.workItemRepository.findByLinearIssueId(childIssue.id);

    expect(closedChild?.linear_state).toBe('Done');
    expect(closedChild?.orchestrator_state).toBe('completed');
    expect(closedChild?.delivery_code).toBe('no_actionable_diff');
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(childIssue.id, 'Done');
    expect(ctx.tracker.postComment).toHaveBeenCalledWith(
      childIssue.id,
      expect.stringContaining('no-op'),
    );
    expect((orchestrator as any).shouldDispatch(siblingIssue)).toBe(true);
    expect(scheduleTick).toHaveBeenCalledWith(0);
  });

  it('executeGovernanceSuggestion creates a draft governance PR for constitution updates', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-governance-pr-'));
    const remoteRepoPath = path.join(tempRoot, 'remote.git');
    const seedRepoPath = path.join(tempRoot, 'seed');
    fs.mkdirSync(seedRepoPath, { recursive: true });

    runGit(['init', '--bare', remoteRepoPath], tempRoot);
    runGit(['init', '-b', 'main'], seedRepoPath);
    runGit(['config', 'user.name', 'Symphony Test'], seedRepoPath);
    runGit(['config', 'user.email', 'symphony-test@example.com'], seedRepoPath);
    fs.writeFileSync(
      path.join(seedRepoPath, '.symphony-constitution.md'),
      [
        '## Main Path',
        '- Keep the core runtime simple.',
        '',
        '## Preferred Directions',
        '- Prefer one runtime control plane.',
        '',
      ].join('\n'),
      'utf8',
    );
    runGit(['add', '.'], seedRepoPath);
    runGit(['commit', '-m', 'Initial constitution'], seedRepoPath);
    runGit(['remote', 'add', 'origin', remoteRepoPath], seedRepoPath);
    runGit(['push', '-u', 'origin', 'main'], seedRepoPath);
    runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remoteRepoPath);

    const issue = makeIssue({
      id: 'issue-governance-pr',
      identifier: 'INT-94',
      state: 'Done',
      project_slug: 'proj',
    });
    const ctx = createOrchestrator(issue, {
      workspaceRoot: path.join(tempRoot, 'workspaces'),
      repositories: {
        routing: {
          proj: {
            github_owner: 'owner',
            github_repo: 'repo',
            local_path: remoteRepoPath,
          },
        },
      },
    });
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
    });
    ctx.governanceSuggestionRepository.create({
      id: 'suggestion-constitution',
      work_item_id: issue.id,
      issue_id: issue.id,
      suggestion_type: 'constitution_update',
      title: '[GOVERNANCE] Update repository constitution',
      summary: 'Clarify the runtime control-plane rule.',
      detail_json: {
        section: 'Preferred Directions',
        operation: 'append_bullet',
        proposed_bullet: 'Clarify how runtime extensions should stay inside the shared control plane.',
      },
    });

    const pullRequest = {
      number: 18,
      url: 'https://github.com/owner/repo/pull/18',
      title: '[GOVERNANCE] Update repository constitution',
      body: 'body',
      state: 'open',
      draft: true,
      head_branch: 'governance/constitution-update/owner-repo',
      head_sha: 'abc123',
      base_branch: 'main',
      mergeable: true,
      mergeable_state: 'clean',
      review_state: 'pending',
      reviews: [],
      review_comments: [],
      review_threads: [],
      combined_status: null,
    };
    (orchestrator as any).createGitHubWriteClient = () => ({
      findOpenPullRequestByBranch: async () => null,
      createPullRequest: async () => pullRequest,
    });
    ctx.tracker.fetchIssueById = mock(async () => ({ issue, error: null }));
    (orchestrator as any).tracker = ctx.tracker;

    const executed = await (orchestrator as any).executeGovernanceSuggestion(issue.id, 'suggestion-constitution');
    const sourcePath = path.join(tempRoot, 'workspaces', 'owner__repo', 'source');
    const constitutionContent = runGit(
      ['show', 'governance/constitution-update/owner-repo:.symphony-constitution.md'],
      sourcePath,
    );

    expect(executed.accepted).toBe(true);
    expect(executed.message).toContain('#18');
    expect(ctx.governanceSuggestionRepository.findById('suggestion-constitution')?.status).toBe('accepted');
    expect(constitutionContent).toContain('Clarify how runtime extensions should stay inside the shared control plane.');
    expect(runGit(['branch', '--list', 'governance/constitution-update/owner-repo'], sourcePath)).toContain(
      'governance/constitution-update/owner-repo',
    );
  });

  it('executeGovernanceSuggestion creates a draft governance PR for harness adoption', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-governance-harness-'));
    const remoteRepoPath = path.join(tempRoot, 'remote.git');
    const seedRepoPath = path.join(tempRoot, 'seed');
    fs.mkdirSync(seedRepoPath, { recursive: true });

    runGit(['init', '--bare', remoteRepoPath], tempRoot);
    runGit(['init', '-b', 'main'], seedRepoPath);
    runGit(['config', 'user.name', 'Symphony Test'], seedRepoPath);
    runGit(['config', 'user.email', 'symphony-test@example.com'], seedRepoPath);
    fs.writeFileSync(path.join(seedRepoPath, 'README.md'), '# Seed\n', 'utf8');
    runGit(['add', '.'], seedRepoPath);
    runGit(['commit', '-m', 'Initial repo'], seedRepoPath);
    runGit(['remote', 'add', 'origin', remoteRepoPath], seedRepoPath);
    runGit(['push', '-u', 'origin', 'main'], seedRepoPath);
    runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remoteRepoPath);

    const issue = makeIssue({
      id: 'issue-harness-pr',
      identifier: 'INT-97',
      state: 'Done',
      project_slug: 'proj',
    });
    const ctx = createOrchestrator(issue, {
      workspaceRoot: path.join(tempRoot, 'workspaces'),
      repositories: {
        routing: {
          proj: {
            github_owner: 'owner',
            github_repo: 'repo',
            local_path: remoteRepoPath,
          },
        },
      },
    });
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
    });
    ctx.governanceSuggestionRepository.create({
      id: 'suggestion-harness',
      work_item_id: issue.id,
      issue_id: issue.id,
      suggestion_type: 'harness_adoption',
      title: '[GOVERNANCE] Adopt formal repo harness for owner/repo',
      summary: 'Promote the shadow harness into the repository.',
      detail_json: {
        harness_payload: {
          profiles: ['coding'],
          commands: {
            test: 'bun test',
          },
          verification: {
            required_commands: ['bun test'],
          },
        },
      },
    });

    const pullRequest = {
      number: 19,
      url: 'https://github.com/owner/repo/pull/19',
      title: '[GOVERNANCE] Adopt formal repo harness for owner/repo',
      body: 'body',
      state: 'open',
      draft: true,
      head_branch: 'governance/harness-adoption/owner-repo',
      head_sha: 'def456',
      base_branch: 'main',
      mergeable: true,
      mergeable_state: 'clean',
      review_state: 'pending',
      reviews: [],
      review_comments: [],
      review_threads: [],
      combined_status: null,
    };
    (orchestrator as any).createGitHubWriteClient = () => ({
      findOpenPullRequestByBranch: async () => null,
      createPullRequest: async () => pullRequest,
    });
    ctx.tracker.fetchIssueById = mock(async () => ({ issue, error: null }));
    (orchestrator as any).tracker = ctx.tracker;

    const executed = await (orchestrator as any).executeGovernanceSuggestion(issue.id, 'suggestion-harness');
    const sourcePath = path.join(tempRoot, 'workspaces', 'owner__repo', 'source');
    const harnessContent = runGit(
      ['show', 'governance/harness-adoption/owner-repo:.symphony-repo.yaml'],
      sourcePath,
    );

    expect(executed.accepted).toBe(true);
    expect(executed.message).toContain('#19');
    expect(ctx.governanceSuggestionRepository.findById('suggestion-harness')?.status).toBe('accepted');
    expect(harnessContent).toContain('profiles:');
    expect(harnessContent).toContain('required_commands:');
  });

  it('refreshes repo fitness signals and creates threshold-driven governance suggestions', async () => {
    const issue = makeIssue({
      id: 'issue-governance-fitness',
      identifier: 'INT-95',
      state: 'Done',
    });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    for (let index = 0; index < 6; index += 1) {
      ctx.workItemRepository.create({
        id: `history-${index}`,
        linear_issue_id: `history-issue-${index}`,
        linear_identifier: `INT-H${index}`,
        linear_title: `History ${index}`,
        linear_state: 'Done',
        github_repo: 'owner/repo',
        touched_paths: index < 4 ? ['src/runtime/hub.ts'] : ['src/server/routes/runtime.ts'],
        touched_areas: index < 4 ? ['runtime'] : ['server'],
        orchestrator_state: 'completed',
      });
    }
    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'completed',
      touched_paths: ['src/runtime/hub.ts'],
      touched_areas: ['runtime'],
    });
    for (let round = 1; round <= 3; round += 1) {
      ctx.reviewEventRepository.create({
        id: `review-churn-${round}`,
        work_item_id: issue.id,
        pr_number: 50,
        review_round: round,
        decision: round === 3 ? 'REQUEST_TESTS' : 'REQUEST_CHANGES',
        summary_md: `Round ${round}`,
      });
    }
    new ConflictMemoryRepository(ctx.db).create({
      id: 'conflict-runtime',
      repo_key: 'owner/repo',
      summary: 'Runtime path keeps churning.',
      detail_json: {
        kind: 'split_before_implement',
        target_area: 'runtime',
      },
    });
    ctx.governanceSuggestionRepository.create({
      id: 'accepted-cleanup',
      work_item_id: issue.id,
      issue_id: issue.id,
      suggestion_type: 'cleanup',
      status: 'accepted',
      title: '[GOVERNANCE] Clean up runtime',
      summary: 'Already accepted for this repo target.',
      detail_json: {
        target_area: 'runtime',
        normalized_target: 'runtime',
      },
    });

    const signals = await (orchestrator as any).refreshRepoGovernanceIntelligence(issue, issue.id, 'owner/repo');
    const updated = ctx.workItemRepository.findById(issue.id);
    const suggestions = ctx.governanceSuggestionRepository.findPendingByIssueId(issue.id);

    expect(signals.map((signal: any) => signal.code)).toEqual(expect.arrayContaining([
      'hotspot_concentration',
      'repeated_review_churn',
    ]));
    expect(updated?.fitness_signals.map((signal) => signal.code)).toEqual(expect.arrayContaining([
      'hotspot_concentration',
      'repeated_review_churn',
    ]));
    expect(suggestions.map((suggestion) => suggestion.suggestion_type)).not.toContain('cleanup');
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

  it('retryIssue reconciles a failed work item when the tracker issue is already terminal Done', async () => {
    const issue = makeIssue({ state: 'Done' });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    const workItem = ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: 'In Progress',
      github_repo: 'owner/repo',
      github_issue_number: 100,
      workspace_path: '/tmp/symphony-tests/repo/INT-1',
      orchestrator_state: 'failed',
      delivery_summary: 'Issue not in valid state for dev, current: State.DONE',
    });

    const result = await orchestrator.retryIssue(issue.id);
    const updatedWorkItem = ctx.workItemRepository.findById(workItem.id);

    expect(result.accepted).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.message).toContain('already Done');
    expect(updatedWorkItem?.linear_state).toBe('Done');
    expect(updatedWorkItem?.orchestrator_state).toBe('completed');
    expect(updatedWorkItem?.delivery_code).toBe('tracker_terminal_reconciled');
    expect((orchestrator as any).state.retry_attempts.has(issue.id)).toBe(false);
    expect((orchestrator as any).state.completed.has(issue.id)).toBe(true);
    expect(ctx.githubIssueClient.closeIssue).toHaveBeenCalledWith(100);
    expect(ctx.workspaceManager.removeWorkspace).toHaveBeenCalledWith('/tmp/symphony-tests/repo/INT-1');
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

  it('stopIssue persistently halts an idle active work item so restart polling does not redispatch it', async () => {
    const issue = makeIssue({ state: 'In Progress', updated_at: new Date('2025-01-01T00:00:00Z') });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'failed',
    });

    const result = await orchestrator.stopIssue(issue.id);
    const updatedWorkItem = ctx.workItemRepository.findByLinearIssueId(issue.id);

    expect(result.accepted).toBe(true);
    expect(result.status).toBe('completed');
    expect(updatedWorkItem?.orchestrator_state).toBe('halted');
    expect(updatedWorkItem?.delivery_code).toBe('manual_stop');
    expect((orchestrator as any).shouldDispatch(issue)).toBe(false);
  });

  it('does not redispatch a stale delivery-halted active work item', () => {
    const issue = makeIssue({ state: 'In Progress', updated_at: new Date('2025-01-01T00:00:00Z') });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'halted',
      delivery_code: 'dirty_workspace_no_commit',
      delivery_summary: 'Workspace has product changes but no delivery commit.',
    });

    expect((orchestrator as any).shouldDispatch(issue)).toBe(false);
  });

  it('closeIssue marks an idle active work item as superseded and closes external tracker surfaces', async () => {
    const issue = makeIssue({ state: 'In Progress', updated_at: new Date('2025-01-01T00:00:00Z') });
    const successor = makeIssue({
      id: 'issue-158',
      identifier: 'INT-158',
      title: 'Successor issue',
      state: 'In Progress',
    });
    const ctx = createOrchestrator(issue, {
      terminalStates: ['Done', 'Canceled'],
    });
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      github_issue_number: 100,
      active_pr_number: 77,
      branch_name: 'feature/int-1',
      workspace_path: '/tmp/symphony-tests/repo/INT-1',
      orchestrator_state: 'halted',
    });
    ctx.workItemRepository.create({
      id: successor.id,
      linear_issue_id: successor.id,
      linear_identifier: successor.identifier,
      linear_title: successor.title,
      linear_state: successor.state,
      github_repo: 'owner/repo',
      github_issue_number: 101,
      orchestrator_state: 'dev_running',
    });

    const result = await orchestrator.closeIssue(issue.id, {
      successor_issue_id: successor.id,
      reason: '用户决定让 INT-158 承接。',
    });
    const updatedWorkItem = ctx.workItemRepository.findByLinearIssueId(issue.id);
    const syncEvents = ctx.syncEventRepository.findByWorkItemId(issue.id);

    expect(result.accepted).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.issue_identifier).toBe(issue.identifier);
    expect(updatedWorkItem?.linear_state).toBe('Canceled');
    expect(updatedWorkItem?.orchestrator_state).toBe('cancelled');
    expect(updatedWorkItem?.delivery_code).toBe('superseded');
    expect(updatedWorkItem?.delivery_summary).toContain('INT-158');
    expect(updatedWorkItem?.cancelled_at).toBeInstanceOf(Date);
    expect(ctx.tracker.updateIssueState).toHaveBeenCalledWith(issue.id, 'Canceled');
    expect(ctx.tracker.postComment).toHaveBeenCalledWith(
      issue.id,
      expect.stringContaining('INT-158'),
    );
    expect(ctx.githubIssueClient.closeIssue).toHaveBeenCalledWith(100);
    expect(ctx.githubIssueClient.updatePullRequest).toHaveBeenCalledWith(77, { state: 'closed' });
    expect(ctx.workspaceManager.removeWorkspace).toHaveBeenCalledWith('/tmp/symphony-tests/repo/INT-1');
    expect(syncEvents.map((event) => `${event.target_system}:${event.action}`).sort()).toEqual([
      'github:close_issue',
      'github:close_pull_request',
      'linear:post_comment',
      'linear:update_state',
    ]);
  });

  it('does not dispatch work items whose supervisor session has already been cancelled', () => {
    const issue = makeIssue({ state: 'In Progress', updated_at: new Date('2025-01-01T00:00:00Z') });
    const ctx = createOrchestrator(issue);
    orchestrator = ctx.orchestrator;

    new SupervisorSessionRepository(ctx.db).create({
      id: 'session-cancelled',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'cancelled',
      repo_ref: 'proj',
      intake_mode: 'direct_run',
      approval_mode: 'auto',
      plan_version: 1,
      root_issue_id: issue.id,
    });
    ctx.workItemRepository.create({
      id: issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: 'owner/repo',
      orchestrator_state: 'discovering',
      supervisor_root_session_id: 'session-cancelled',
    });

    expect((orchestrator as any).shouldDispatch(issue)).toBe(false);
  });

  it('startup terminal cleanup closes mapped GitHub issues and PRs for terminal tracker items', async () => {
    const terminalIssue = makeIssue({ state: 'Canceled' });
    const ctx = createOrchestrator(terminalIssue);
    orchestrator = ctx.orchestrator;

    ctx.tracker.fetchIssuesByStates = mock(async () => ({ issues: [terminalIssue], error: null }));
    ctx.workItemRepository.create({
      id: terminalIssue.id,
      linear_issue_id: terminalIssue.id,
      linear_identifier: terminalIssue.identifier,
      linear_title: terminalIssue.title,
      linear_state: 'In Progress',
      github_repo: 'owner/repo',
      github_issue_number: 501,
      active_pr_number: 77,
      workspace_path: '/tmp/symphony-tests/repo/INT-1',
      orchestrator_state: 'failed',
    });

    await (orchestrator as any).startupTerminalCleanup();

    expect(ctx.workspaceManager.removeWorkspace).toHaveBeenCalledWith('/tmp/symphony-tests/repo/INT-1');
    expect(ctx.githubIssueClient.closeIssue).toHaveBeenCalledWith(501);
    expect(ctx.githubIssueClient.updatePullRequest).toHaveBeenCalledWith(77, { state: 'closed' });
    const syncEvents = new SyncEventRepository(ctx.db).findByWorkItemId(terminalIssue.id);
    expect(syncEvents.map((event) => `${event.target_system}:${event.action}`)).toContain('github:close_pull_request');
  });

  it('startup terminal cleanup skips while active execution is in flight', async () => {
    const terminalIssue = makeIssue({ state: 'Done' });
    const activeIssue = makeIssue({ id: 'active-issue', identifier: 'INT-ACTIVE', state: 'In Progress' });
    const ctx = createOrchestrator(terminalIssue);
    orchestrator = ctx.orchestrator;

    ctx.tracker.fetchIssuesByStates = mock(async () => ({ issues: [terminalIssue], error: null }));
    (orchestrator as any).state.running.set(activeIssue.id, {
      issue: activeIssue,
      identifier: activeIssue.identifier,
      workspace_path: '/tmp/symphony-tests/repo/INT-ACTIVE',
      branch_name: 'feature/int-active',
      started_at: new Date(),
      last_codex_timestamp: new Date(),
      retry_attempt: 0,
      stage: 'dev',
    });

    await (orchestrator as any).startupTerminalCleanup();

    expect(ctx.tracker.fetchIssuesByStates).not.toHaveBeenCalled();
    expect(ctx.workspaceManager.removeWorkspace).not.toHaveBeenCalled();
  });

  it('global terminal branch cleanup skips while another issue is actively executing', async () => {
    const terminalIssue = makeIssue({ state: 'Done' });
    const activeIssue = makeIssue({ id: 'active-issue', identifier: 'INT-ACTIVE', state: 'In Progress' });
    const ctx = createOrchestrator(terminalIssue);
    orchestrator = ctx.orchestrator;

    ctx.tracker.fetchIssuesByStates = mock(async () => ({ issues: [terminalIssue], error: null }));
    (orchestrator as any).cleanupIssueBranch = mock(async () => undefined);
    (orchestrator as any).state.running.set(activeIssue.id, {
      issue: activeIssue,
      identifier: activeIssue.identifier,
      workspace_path: '/tmp/symphony-tests/repo/INT-ACTIVE',
      branch_name: 'feature/int-active',
      started_at: new Date(),
      last_codex_timestamp: new Date(),
      retry_attempt: 0,
      stage: 'dev',
    });

    await (orchestrator as any).cleanupAllTerminalIssueBranches();

    expect(ctx.tracker.fetchIssuesByStates).not.toHaveBeenCalled();
    expect((orchestrator as any).cleanupIssueBranch).not.toHaveBeenCalled();
  });

  it('startup terminal cleanup globally repairs orphan GitHub issues and PRs for terminal tracker identifiers', async () => {
    const terminalIssue = makeIssue({ state: 'Done' });
    const ctx = createOrchestrator(terminalIssue);
    orchestrator = ctx.orchestrator;

    ctx.tracker.fetchIssuesByStates = mock(async () => ({ issues: [terminalIssue], error: null }));
    ctx.githubIssueClient.listOpenIssues = mock(async () => [{
      number: 611,
      url: 'https://github.com/owner/repo/issues/611',
      title: '[INT-1] orphan issue',
      body: '## Linear Issue\nINT-1',
      labels: [],
      state: 'open',
    }]);
    ctx.githubIssueClient.listOpenPullRequests = mock(async () => [{
      number: 612,
      url: 'https://github.com/owner/repo/pull/612',
      title: '[INT-1] orphan pull request',
      body: null,
      state: 'open',
      draft: false,
      head_branch: 'feature/int-1',
      head_sha: 'abc123',
      base_branch: 'main',
      mergeable: null,
      mergeable_state: null,
    }]);

    await (orchestrator as any).startupTerminalCleanup();

    expect(ctx.githubIssueClient.closeIssue).toHaveBeenCalledWith(611);
    expect(ctx.githubIssueClient.updatePullRequest).toHaveBeenCalledWith(612, { state: 'closed' });
  });

  it('startup terminal cleanup keeps startup alive when global orphan repair hits GitHub API noise', async () => {
    const terminalIssue = makeIssue({ state: 'Done' });
    const ctx = createOrchestrator(terminalIssue);
    orchestrator = ctx.orchestrator;
    const warnSpy = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;

    ctx.tracker.fetchIssuesByStates = mock(async () => ({ issues: [terminalIssue], error: null }));
    ctx.githubIssueClient.listOpenIssues = mock(async () => {
      throw new Error('GitHub API unavailable');
    });

    try {
      await expect((orchestrator as any).startupTerminalCleanup()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  it('reconcileRunningIssues closes mapped GitHub issues and PRs when a running issue becomes canceled', async () => {
    const cancelledIssue = makeIssue({ state: 'Canceled' });
    const ctx = createOrchestrator(cancelledIssue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: cancelledIssue.id,
      linear_issue_id: cancelledIssue.id,
      linear_identifier: cancelledIssue.identifier,
      linear_title: cancelledIssue.title,
      linear_state: 'In Progress',
      github_repo: 'owner/repo',
      github_issue_number: 501,
      active_pr_number: 77,
      branch_name: 'feature/int-1',
      workspace_path: '/tmp/symphony-tests/repo/INT-1',
      orchestrator_state: 'dev_running',
    });
    (orchestrator as any).cleanupIssueBranch = mock(async () => undefined);

    (orchestrator as any).state.running.set(cancelledIssue.id, {
      issue: makeIssue({ id: cancelledIssue.id, identifier: cancelledIssue.identifier, state: 'In Progress' }),
      identifier: cancelledIssue.identifier,
      workspace_path: '/tmp/symphony-tests/repo/INT-1',
      branch_name: null,
      started_at: new Date(),
      last_codex_timestamp: new Date(),
      retry_attempt: 0,
      stage: 'dev',
    });

    await (orchestrator as any).reconcileRunningIssues();

    expect(ctx.workspaceManager.removeWorkspace).toHaveBeenCalledWith('/tmp/symphony-tests/repo/INT-1');
    expect(ctx.githubIssueClient.closeIssue).toHaveBeenCalledWith(501);
    expect(ctx.githubIssueClient.updatePullRequest).toHaveBeenCalledWith(77, { state: 'closed' });
    expect((orchestrator as any).cleanupIssueBranch).toHaveBeenCalledWith(expect.objectContaining({
      explicitBranchName: 'feature/int-1',
    }));
    const syncEvents = new SyncEventRepository(ctx.db).findByWorkItemId(cancelledIssue.id);
    expect(syncEvents.map((event) => `${event.target_system}:${event.action}`)).toContain('github:close_pull_request');
  });

  it('reconcileTrackedTerminalStates cancels a failed non-running issue after Linear is cancelled externally', async () => {
    const cancelledIssue = makeIssue({ state: 'Canceled' });
    const ctx = createOrchestrator(cancelledIssue);
    orchestrator = ctx.orchestrator;

    ctx.workItemRepository.create({
      id: cancelledIssue.id,
      linear_issue_id: cancelledIssue.id,
      linear_identifier: cancelledIssue.identifier,
      linear_title: cancelledIssue.title,
      linear_state: 'In Progress',
      github_repo: 'owner/repo',
      github_issue_number: 501,
      active_pr_number: 77,
      branch_name: 'feature/int-1',
      workspace_path: '/tmp/symphony-tests/repo/INT-1',
      orchestrator_state: 'failed',
      delivery_code: 'dirty_workspace_no_commit',
      delivery_summary: 'Needs user decision.',
    });
    (orchestrator as any).cleanupIssueBranch = mock(async () => undefined);

    await (orchestrator as any).reconcileTrackedTerminalStates();

    const updated = ctx.workItemRepository.findByLinearIssueId(cancelledIssue.id);
    expect(updated?.linear_state).toBe('Canceled');
    expect(updated?.orchestrator_state).toBe('cancelled');
    expect(updated?.cancelled_at).toBeInstanceOf(Date);
    expect(ctx.workspaceManager.removeWorkspace).toHaveBeenCalledWith('/tmp/symphony-tests/repo/INT-1');
    expect(ctx.githubIssueClient.closeIssue).toHaveBeenCalledWith(501);
    expect(ctx.githubIssueClient.updatePullRequest).toHaveBeenCalledWith(77, { state: 'closed' });
    expect((orchestrator as any).cleanupIssueBranch).toHaveBeenCalledWith(expect.objectContaining({
      explicitBranchName: 'feature/int-1',
    }));
    const syncEvents = new SyncEventRepository(ctx.db).findByWorkItemId(cancelledIssue.id);
    expect(syncEvents.map((event) => `${event.target_system}:${event.action}`)).toContain('github:close_pull_request');
  });
});
