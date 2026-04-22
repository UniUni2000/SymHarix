import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import { RuntimeHost } from './runtimeHost';
import type { ServiceConfig, WorkflowDefinition } from '../types';

class FakeOrchestrator extends EventEmitter {
  public startCalls = 0;
  public stopCalls = 0;

  constructor(public readonly label: string) {
    super();
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  getStateSnapshot() {
    return {
      generated_at: new Date('2026-04-21T00:00:00.000Z').toISOString(),
      counts: { running: 0, retrying: 0 },
      running: [],
      retrying: [],
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0,
      },
      rate_limits: null,
    };
  }

  async createIssue() {
    return {
      accepted: true as const,
      status: 'accepted' as const,
      message: `created by ${this.label}`,
      issue_id: null,
      issue_identifier: null,
      issue: null,
    };
  }

  async stopIssue() {
    return {
      accepted: true as const,
      status: 'accepted' as const,
      message: `stopped by ${this.label}`,
      issue_id: null,
      issue_identifier: null,
    };
  }

  async retryIssue() {
    return {
      accepted: true as const,
      status: 'queued' as const,
      message: `retried by ${this.label}`,
      issue_id: null,
      issue_identifier: null,
    };
  }

  getDiagnosticsSnapshot() {
    return {
      running_issue_count: 0,
      retry_count: 0,
      worker_process_count: 0,
      active_session_count: 0,
      claimed_issue_count: 0,
      leadership_lease_held: false,
    };
  }
}

class FakeRuntimeHub {
  public readonly controllers: string[] = [];

  constructor(_db: unknown, controller: FakeOrchestrator) {
    this.controllers.push(controller.label);
  }

  setController(controller: FakeOrchestrator): void {
    this.controllers.push(controller.label);
  }

  dispose(): void {}
}

class FakeServer {
  public startCalls = 0;
  public stopCalls = 0;

  constructor(
    _db: unknown,
    public readonly config: { port?: number | null },
    _runtimeHub: FakeRuntimeHub,
  ) {}

  async start(): Promise<{ port: number; hostname: string }> {
    this.startCalls += 1;
    return {
      port: this.config.port ?? 0,
      hostname: '127.0.0.1',
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

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
        pollIntervalMs: 5_000,
        projects: {},
      },
    },
    serverPort: 3100,
    ...overrides,
  };
}

function makeWorkflow(label: string): WorkflowDefinition {
  return {
    config: {
      label,
    },
    prompt_template: `Prompt ${label}`,
  };
}

describe('RuntimeHost', () => {
  test('reload replaces the orchestrator and refreshes runtime/server bindings', async () => {
    const first = new FakeOrchestrator('first');
    const second = new FakeOrchestrator('second');
    const orchestratorFactory = mock((_config: ServiceConfig, definition: WorkflowDefinition) => {
      return definition.prompt_template.includes('second') ? second : first;
    });
    const bindOrchestrator = mock((_orchestrator: FakeOrchestrator) => mock(() => undefined));
    const runtimeHubFactory = mock((db: unknown, controller: FakeOrchestrator) => new FakeRuntimeHub(db, controller));
    const serverFactory = mock((db: unknown, config: { port?: number | null }, runtimeHub: FakeRuntimeHub) => new FakeServer(db, config, runtimeHub));

    const host = new RuntimeHost({
      db: {} as never,
      initialConfig: makeConfig({ serverPort: 3100 }),
      initialDefinition: makeWorkflow('first'),
      cliPortOverride: undefined,
      orchestratorFactory,
      runtimeHubFactory,
      serverFactory,
      bindOrchestrator,
    });

    await host.start();
    await host.reload(makeWorkflow('second'), makeConfig({ serverPort: 3200 }));

    const runtimeHub = host.getRuntimeHub() as unknown as FakeRuntimeHub;
    const server = host.getServer() as unknown as FakeServer;

    expect(first.startCalls).toBe(1);
    expect(first.stopCalls).toBe(1);
    expect(second.startCalls).toBe(1);
    expect(runtimeHub.controllers).toEqual(['first', 'second']);
    expect(bindOrchestrator).toHaveBeenCalledTimes(2);
    expect(serverFactory).toHaveBeenCalledTimes(2);
    expect(server.config.port).toBe(3200);

    await host.stop();
    expect(second.stopCalls).toBe(1);
  });

  test('exposes orchestrator diagnostics for internal verification tooling', async () => {
    const orchestrator = new FakeOrchestrator('primary');
    const host = new RuntimeHost({
      db: {} as never,
      initialConfig: makeConfig({ serverPort: null }),
      initialDefinition: makeWorkflow('primary'),
      orchestratorFactory: () => orchestrator,
      runtimeHubFactory: (db, controller) => new FakeRuntimeHub(db, controller as FakeOrchestrator),
      serverFactory: (db, config, runtimeHub) => new FakeServer(db, config, runtimeHub as FakeRuntimeHub),
      bindOrchestrator: () => undefined,
    });

    expect(host.getDiagnosticsSnapshot()).toEqual({
      running_issue_count: 0,
      retry_count: 0,
      worker_process_count: 0,
      active_session_count: 0,
      claimed_issue_count: 0,
      leadership_lease_held: false,
    });
  });
});
