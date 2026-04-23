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
    expect(ctx.workspaceManager.removeWorkspace).toHaveBeenCalled();
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
      const pendingSuggestions = ctx.governanceSuggestionRepository.findPendingByIssueId(currentIssue.id);

      expect(result.accepted).toBe(true);
      expect(result.message).toContain('Split applied');
      expect(childIssues.length).toBeGreaterThanOrEqual(1);
      expect(ctx.tracker.updateIssueContent).toHaveBeenCalledTimes(1);
      expect(workItem?.governance_decision).toBe('accept');
      expect(workItem?.orchestrator_state).not.toBe('halted');
      expect(pendingSuggestions).toHaveLength(0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
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
    expect(ctx.governanceSuggestionRepository.findById('suggestion-cleanup')?.status).toBe('accepted');
    expect(ctx.governanceSuggestionRepository.findById('suggestion-dismiss')?.status).toBe('dismissed');
    expect(dismissed.accepted).toBe(true);
    expect(dismissed.message).toContain('Dismissed');
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
