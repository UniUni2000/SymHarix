import type { Database } from 'bun:sqlite';
import { Orchestrator, type OrchestratorStateSnapshot } from '../orchestrator';
import { createBotGatewayFromEnv } from '../bots/gateway';
import { RuntimeHub } from '../runtime/hub';
import { SymHarixServer } from '../server';
import { createRuntimeAccessControllerFromEnv } from '../server/runtimeAccess';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { LinearClient } from '../tracker/linear-client';
import type {
  CreateIssueRequest,
  CreateIssueResult,
  RuntimeActionResult,
  RuntimeControlPlane,
} from '../runtime/types';
import type { RuntimeDiagnosticsSnapshot, ServiceConfig, WorkflowDefinition } from '../types';

type RuntimeController = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStateSnapshot(): OrchestratorStateSnapshot;
  getDiagnosticsSnapshot(): RuntimeDiagnosticsSnapshot;
  createIssue(input: CreateIssueRequest): Promise<CreateIssueResult>;
  stopIssue(issueId: string): Promise<RuntimeActionResult>;
  retryIssue(issueId: string): Promise<RuntimeActionResult>;
  overrideGovernance(issueId: string): Promise<RuntimeActionResult>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
};

type RuntimeHubWithController = RuntimeControlPlane & {
  setController(controller: RuntimeController): void;
  dispose(): void;
};

type RuntimeServer = {
  start(): Promise<{ port: number; hostname: string }>;
  stop(): Promise<void>;
  getInfo?(): {
    running: boolean;
    port: number | null;
    hostname: string;
  };
};

type RuntimeHostOptions = {
  db: Database;
  initialConfig: ServiceConfig;
  initialDefinition: WorkflowDefinition;
  cliPortOverride?: number;
  orchestratorFactory?: (
    config: ServiceConfig,
    definition: WorkflowDefinition,
  ) => RuntimeController;
  runtimeHubFactory?: (
    db: Database,
    controller: RuntimeController,
  ) => RuntimeHubWithController;
  serverFactory?: (
    db: Database,
    config: { port: number },
    runtimeHub: RuntimeControlPlane,
  ) => RuntimeServer;
  bindOrchestrator?: (orchestrator: RuntimeController) => (() => void) | void;
};

function withCliPortOverride(
  config: ServiceConfig,
  cliPortOverride?: number,
): ServiceConfig {
  if (cliPortOverride === undefined) {
    return config;
  }

  return {
    ...config,
    serverPort: cliPortOverride > 0 ? cliPortOverride : null,
  };
}

function noop(): void {}

export class RuntimeHost {
  private config: ServiceConfig;
  private definition: WorkflowDefinition;
  private orchestrator: RuntimeController;
  private runtimeHub: RuntimeHubWithController;
  private server: RuntimeServer | null = null;
  private detachBindings: () => void = noop;
  private started = false;
  private desiredServerPort: number | null;
  private activeServerPort: number | null = null;
  private readonly orchestratorFactory: NonNullable<RuntimeHostOptions['orchestratorFactory']>;
  private readonly runtimeHubFactory: NonNullable<RuntimeHostOptions['runtimeHubFactory']>;
  private readonly serverFactory: NonNullable<RuntimeHostOptions['serverFactory']>;
  private readonly bindOrchestrator: NonNullable<RuntimeHostOptions['bindOrchestrator']>;

  constructor(private readonly options: RuntimeHostOptions) {
    this.config = withCliPortOverride(options.initialConfig, options.cliPortOverride);
    this.definition = options.initialDefinition;
    this.orchestratorFactory =
      options.orchestratorFactory ??
      ((config, definition) => new Orchestrator(config, definition, { db: options.db }));
    this.runtimeHubFactory =
      options.runtimeHubFactory ??
      ((db, controller) => new RuntimeHub(db, controller, { workspaceRoot: this.config.workspaceRoot }));
    this.serverFactory =
      options.serverFactory ??
      ((db, config, runtimeHub) => {
        const projectResolver = new TrackerProjectResolutionService(
          new LinearClient({
            endpoint: this.config.trackerEndpoint,
            apiKey: this.config.trackerApiKey,
            projectSlugs: [],
          }),
          this.config.repositories.routing,
        );

        return new SymHarixServer(
          db,
          config,
          runtimeHub,
          createBotGatewayFromEnv(runtimeHub, db, {
            projectResolver,
            workspaceRoot: this.config.workspaceRoot,
            githubToken: this.config.githubToken,
          }),
          createRuntimeAccessControllerFromEnv(),
        );
      });
    this.bindOrchestrator = options.bindOrchestrator ?? (() => noop);

    this.orchestrator = this.orchestratorFactory(this.config, this.definition);
    this.runtimeHub = this.runtimeHubFactory(options.db, this.orchestrator);
    this.desiredServerPort = this.config.serverPort ?? null;
  }

  getOrchestrator(): RuntimeController {
    return this.orchestrator;
  }

  getRuntimeHub(): RuntimeControlPlane {
    return this.runtimeHub;
  }

  getServer(): RuntimeServer | null {
    return this.server;
  }

  getConfig(): ServiceConfig {
    return this.config;
  }

  getDiagnosticsSnapshot(): RuntimeDiagnosticsSnapshot {
    return this.orchestrator.getDiagnosticsSnapshot();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.detachBindings = this.bindOrchestrator(this.orchestrator) ?? noop;
    await this.reconcileServer();
    await this.orchestrator.start();
    this.started = true;
  }

  async reload(
    definition: WorkflowDefinition,
    config: ServiceConfig,
  ): Promise<void> {
    const nextConfig = withCliPortOverride(config, this.options.cliPortOverride);
    const nextOrchestrator = this.orchestratorFactory(nextConfig, definition);

    if (!this.started) {
      this.detachBindings();
      this.orchestrator = nextOrchestrator;
      this.definition = definition;
      this.config = nextConfig;
      this.desiredServerPort = nextConfig.serverPort ?? null;
      this.runtimeHub.setController(nextOrchestrator);
      this.detachBindings = this.bindOrchestrator(nextOrchestrator) ?? noop;
      return;
    }

    const previousOrchestrator = this.orchestrator;
    const previousConfig = this.config;
    const previousDefinition = this.definition;

    await previousOrchestrator.stop();
    this.detachBindings();

    try {
      this.orchestrator = nextOrchestrator;
      this.definition = definition;
      this.config = nextConfig;
      this.desiredServerPort = nextConfig.serverPort ?? null;
      this.runtimeHub.setController(nextOrchestrator);
      this.detachBindings = this.bindOrchestrator(nextOrchestrator) ?? noop;
      await this.reconcileServer();
      await nextOrchestrator.start();
    } catch (error) {
      this.detachBindings();
      this.orchestrator = previousOrchestrator;
      this.definition = previousDefinition;
      this.config = previousConfig;
      this.desiredServerPort = previousConfig.serverPort ?? null;
      this.runtimeHub.setController(previousOrchestrator);
      this.detachBindings = this.bindOrchestrator(previousOrchestrator) ?? noop;
      await this.reconcileServer();
      await previousOrchestrator.start();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      this.detachBindings();
      this.runtimeHub.dispose();
      if (this.server) {
        await this.server.stop();
        this.server = null;
      }
      return;
    }

    if (this.server) {
      await this.server.stop();
      this.server = null;
      this.activeServerPort = null;
    }
    this.detachBindings();
    await this.orchestrator.stop();
    this.runtimeHub.dispose();
    this.started = false;
  }

  private async reconcileServer(): Promise<void> {
    const desiredPort = this.desiredServerPort;

    if (desiredPort === null) {
      if (this.server) {
        await this.server.stop();
        this.server = null;
        this.activeServerPort = null;
      }
      return;
    }

    if (this.server && desiredPort === this.activeServerPort) {
      return;
    }

    if (this.server) {
      await this.server.stop();
    }

    this.server = this.serverFactory(
      this.options.db,
      { port: desiredPort },
      this.runtimeHub,
    );
    await this.server.start();
    this.activeServerPort = desiredPort;
  }
}
