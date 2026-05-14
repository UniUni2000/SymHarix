#!/usr/bin/env node
/**
 * SymHarix CLI - Main entrypoint
 * Section 17.7: CLI and Host Lifecycle
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { syncSymHarixEnvAliases } from '../config/env';

// Load .env file explicitly
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}
syncSymHarixEnvAliases();

import { Orchestrator } from '../orchestrator';
import { createDatabase } from '../database';
import { WorkflowWatcher } from '../workflow/watcher';
import { loadWorkflow, resolveWorkflowPath } from '../workflow/loader';
import { buildServiceConfig, validateConfigForDispatch } from '../config/loader';
import { logger } from '../logging';
import { Issue, AgentEvent, WorkflowDefinition, ServiceConfig } from '../types';
import { RuntimeHost } from './runtimeHost';
import { RuntimeHub } from '../runtime/hub';
import { BotFollowupRepairService } from '../bots/followupRepair';
import { GlobalRepairService } from '../maintenance/globalRepair';
import {
	BotFollowupDeliveryStateRepository,
	BotFollowupMessageStateRepository,
	BotIssueFollowupRepository,
	BotPendingActionRepository,
	BotConversationFocusRepository,
	WorkItemRepository,
} from '../database';
import { LinearClient } from '../tracker/linear-client';
import { createGitHubIssueClient } from '../github/issue-client';
import {
  consumeTimelineEventForCli,
  createCliTimelineRenderState,
  flushCliTimelineState,
  shouldLogStructuredAgentEvent,
} from './timeline';
import { parseMaintenanceArgs, type MaintenanceCommand } from '../maintenance/cli';
import {
  parseVerifyLiveLifecycleArgs,
  parseVerifyLiveSupervisorArgs,
  shouldRunAttachedVerifierBeforeServiceBootstrap,
  type VerifyLiveLifecycleCommand,
} from '../verification/cli';
import { LiveLifecycleVerifier } from '../verification/liveLifecycleVerifier';
import {
  verifyAttachedLiveSupervisor,
  verifyAttachedLiveSupervisorMatrix,
} from '../verification/attachedLiveSupervisorVerifier';
import { ensureEmbeddedClaudeRuntimeReady } from '../agent/embeddedClaudeRuntime';

/**
 * Parse command line arguments
 */
function parseArgs(): {
  workflowPath?: string;
  port?: number;
  kill?: boolean;
  maintenance?: MaintenanceCommand;
  verifyLiveLifecycle?: VerifyLiveLifecycleCommand;
  verifyLiveSupervisor?: VerifyLiveLifecycleCommand;
} {
  const args = process.argv.slice(2);
  const result: {
    workflowPath?: string;
    port?: number;
    kill?: boolean;
    maintenance?: MaintenanceCommand;
    verifyLiveLifecycle?: VerifyLiveLifecycleCommand;
    verifyLiveSupervisor?: VerifyLiveLifecycleCommand;
  } = {};

  if (args[0] === 'repair') {
    const parsed = parseMaintenanceArgs(args.slice(1));
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    result.maintenance = parsed.command;
    return result;
  }

  if (args[0] === 'verify-live-lifecycle') {
    const parsed = parseVerifyLiveLifecycleArgs(args.slice(1));
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    result.verifyLiveLifecycle = parsed.command;
    return result;
  }

  if (args[0] === 'verify-live-supervisor') {
    const parsed = parseVerifyLiveSupervisorArgs(args.slice(1));
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    result.verifyLiveSupervisor = parsed.command;
    return result;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--kill') {
      result.kill = true;
    } else if (arg === '--port' && args[i + 1]) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    } else if (arg.startsWith('--port=')) {
      result.port = parseInt(arg.slice(7), 10);
    } else if (!arg.startsWith('-')) {
      // Positional argument - workflow path
      result.workflowPath = arg;
    }
  }

  return result;
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
symharix - Harnessed Coding Agent Orchestrator

Usage: symharix [options] [workflow-path]

Options:
  --port <number>    Enable HTTP server on specified port
  --kill             Stop all running symharix agent processes
  repair bot-followups
  repair all
  verify-live-lifecycle --project-slug <slug> [--timeout-ms <n>] [--json] [--title-suffix <text>]
  verify-live-supervisor --project-slug <slug> [--server-url <url>] [--telegram-chat-id <id>] [--scenario simple|governed-split|destructive-cleanup] [--matrix] [--timeout-ms <n>] [--json] [--title-suffix <text>]
  --help             Show this help message

Arguments:
  workflow-path      Path to WORKFLOW.md file (default: ./WORKFLOW.md)

Examples:
  symharix                        # Use local ./WORKFLOW.md (copy from WORKFLOW.md.example first)
  symharix path/to/WORKFLOW.md    # Use specified workflow file
  symharix --port 3000            # Enable HTTP server on port 3000
  symharix --kill                 # Stop all running agents
  symharix repair bot-followups   # Repair persisted Telegram follow-up/card state
  symharix repair all             # Repair Telegram follow-up state plus GitHub orphan issue/PR artifacts
  symharix verify-live-lifecycle --project-slug sample-project
  symharix verify-live-supervisor --project-slug sample-project
`);
}

function createMaintenanceRuntimeHub(db: ReturnType<typeof createDatabase>): RuntimeHub {
  const controller = Object.assign(new EventEmitter(), {
    getStateSnapshot: () => ({
      generated_at: new Date().toISOString(),
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
    }),
    async createIssue() {
      return {
        accepted: false as const,
        status: 'rejected' as const,
        message: 'maintenance runtime is read-only',
        issue_id: null,
        issue_identifier: null,
        issue: null,
      };
    },
    async stopIssue() {
      return { accepted: false as const, status: 'rejected' as const, message: 'maintenance runtime is read-only', issue_id: null, issue_identifier: null };
    },
    async retryIssue() {
      return { accepted: false as const, status: 'rejected' as const, message: 'maintenance runtime is read-only', issue_id: null, issue_identifier: null };
    },
    async closeIssue() {
      return { accepted: false as const, status: 'rejected' as const, message: 'maintenance runtime is read-only', issue_id: null, issue_identifier: null };
    },
    async overrideGovernance() {
      return { accepted: false as const, status: 'rejected' as const, message: 'maintenance runtime is read-only', issue_id: null, issue_identifier: null };
    },
    async rewriteGovernance() {
      return { accepted: false as const, status: 'rejected' as const, message: 'maintenance runtime is read-only', issue_id: null, issue_identifier: null };
    },
    async splitGovernance() {
      return { accepted: false as const, status: 'rejected' as const, message: 'maintenance runtime is read-only', issue_id: null, issue_identifier: null };
    },
    async executeGovernanceSuggestion() {
      return { accepted: false as const, status: 'rejected' as const, message: 'maintenance runtime is read-only', issue_id: null, issue_identifier: null };
    },
    async dismissGovernanceSuggestion() {
      return { accepted: false as const, status: 'rejected' as const, message: 'maintenance runtime is read-only', issue_id: null, issue_identifier: null };
    },
  });

  return new RuntimeHub(db, controller);
}

async function killKnownSymHarixProcesses(currentPid?: number): Promise<void> {
  const { execSync } = await import('child_process');
  const orchestratorPattern = 'bun .*src/cli/index\\.ts|node .*src/cli/index\\.ts|bun .*cli\\.tsx|node.*symharix.*cli';
  const collectPids = (command: string): number[] => execSync(command)
    .toString()
    .trim()
    .split('\n')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n !== 1 && n !== currentPid);

  const orchestratorPids = execSync(
    `ps aux | grep -E '${orchestratorPattern}' | grep -v grep | awk '{print $2}'`
  ).toString().trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n !== 1 && n !== currentPid);

  if (orchestratorPids.length > 0) {
    console.log('[symharix] Stopping processes:', orchestratorPids.join(', '));
  }
  for (const pid of orchestratorPids) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[symharix] Sent SIGTERM to ${pid}`);
    } catch (err) {
      console.error(`[symharix] Failed to kill ${pid}:`, err);
    }
  }

  try {
    const adapterPids = collectPids(
      `ps aux | grep 'claude-adapter\\.cjs' | grep -v grep | awk '{print $2}'`
    );
    for (const pid of adapterPids) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`[symharix] Sent SIGTERM to adapter ${pid}`);
      } catch {}
    }
  } catch {}

  try {
    const tunnelPids = collectPids(
      `ps aux | grep -E 'cloudflared tunnel --url http://(127\\.0\\.0\\.1|localhost):[0-9]+' | grep -v grep | awk '{print $2}'`
    );
    for (const pid of tunnelPids) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`[symharix] Sent SIGTERM to tunnel ${pid}`);
      } catch {}
    }
  } catch {}
}

function attachCliObservers(
  orchestrator: Orchestrator,
  timelineRenderStateByIssue: Map<string, ReturnType<typeof createCliTimelineRenderState>>,
): () => void {
  const listeners: Array<{ event: string; listener: (...args: any[]) => void }> = [];
  const bind = (event: string, listener: (...args: any[]) => void) => {
    orchestrator.on(event as any, listener);
    listeners.push({ event, listener });
  };

  bind('issue:dispatched', (issue: Issue) => {
    logger.info('Issue dispatched', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      phase: issue.state.toLowerCase() === 'in review' ? 'REVIEW' : 'DEV'
    });
  });

  bind('issue:completed', (issue: Issue, success: boolean) => {
    const timelineState = timelineRenderStateByIssue.get(issue.id);
    if (timelineState) {
      for (const message of flushCliTimelineState(timelineState)) {
        console.log(`[agent] ${message}`);
      }
      timelineRenderStateByIssue.delete(issue.id);
    }
    logger.info('Issue completed', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      success
    });
  });

  bind('issue:failed', (issue: Issue, error: string) => {
    const timelineState = timelineRenderStateByIssue.get(issue.id);
    if (timelineState) {
      for (const message of flushCliTimelineState(timelineState)) {
        console.log(`[agent] ${message}`);
      }
      timelineRenderStateByIssue.delete(issue.id);
    }
    logger.error('Issue failed', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      error
    });
  });

  bind('issue:retrying', (issue: Issue, attempt: number, delay: number) => {
    logger.info('Issue retrying', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      delay_ms: delay
    });
  });

  bind('session:event', (issueId: string, event: AgentEvent) => {
    let timelineState = timelineRenderStateByIssue.get(issueId);
    if (!timelineState) {
      timelineState = createCliTimelineRenderState();
      timelineRenderStateByIssue.set(issueId, timelineState);
    }

    const timelineMessages = consumeTimelineEventForCli(event, timelineState);
    if (timelineMessages.length > 0) {
      for (const message of timelineMessages) {
        console.log(`[agent] ${message}`);
      }
      return;
    }
    if (!shouldLogStructuredAgentEvent(event)) {
      return;
    }

    logger.info('Agent event', {
      issue_id: issueId,
      event: event.event,
      payload: event.payload,
      timestamp: event.timestamp.toISOString()
    });
  });

  bind('error', (error: Error) => {
    logger.error('Orchestrator error', {}, error);
  });

  return () => {
    for (const { event, listener } of listeners) {
      orchestrator.off(event as any, listener);
    }
  };
}

async function runAttachedLiveVerificationCommand(liveVerificationCommand: VerifyLiveLifecycleCommand): Promise<number> {
  if (!liveVerificationCommand.supervisorScenario || !liveVerificationCommand.serverUrl) {
    throw new Error('Attached live verification requires a supervisor scenario and --server-url.');
  }

  const result = liveVerificationCommand.supervisorLiveMatrix
    ? await verifyAttachedLiveSupervisorMatrix({
        serverUrl: liveVerificationCommand.serverUrl,
        projectSlug: liveVerificationCommand.projectSlug,
        timeoutMs: liveVerificationCommand.timeoutMs,
        titleSuffix: liveVerificationCommand.titleSuffix,
        telegramChatId: liveVerificationCommand.telegramChatId ?? null,
        reporter: (message) => {
          if (!liveVerificationCommand.json) {
            console.log(`[verify] ${message}`);
          }
        },
      })
    : await verifyAttachedLiveSupervisor({
        serverUrl: liveVerificationCommand.serverUrl,
        projectSlug: liveVerificationCommand.projectSlug,
        timeoutMs: liveVerificationCommand.timeoutMs,
        titleSuffix: liveVerificationCommand.titleSuffix,
        telegramChatId: liveVerificationCommand.telegramChatId ?? null,
        supervisorLiveScenario: liveVerificationCommand.supervisorLiveScenario ?? null,
        reporter: (message) => {
          if (!liveVerificationCommand.json) {
            console.log(`[verify] ${message}`);
          }
        },
      });

  if (liveVerificationCommand.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[verify] ${result.success ? 'PASS' : 'FAIL'} ${result.message}`);
    if ('results' in result) {
      for (const item of result.results) {
        console.log(`[verify] Scenario: ${item.scenario} · ${item.success ? 'PASS' : 'FAIL'} · ${item.issue_identifier ?? 'no issue'}`);
      }
    } else {
      console.log(`[verify] Project: ${result.project_slug}`);
      if (result.issue_identifier) {
        console.log(`[verify] Issue: ${result.issue_identifier}`);
      }
      if (result.pull_request_number) {
        console.log(`[verify] PR: #${result.pull_request_number}`);
      }
      for (const checkpoint of result.checkpoints) {
        const marker = checkpoint.status === 'passed' ? 'OK' : checkpoint.status === 'failed' ? 'FAIL' : 'WAIT';
        console.log(`[verify] ${marker} ${checkpoint.label}${checkpoint.detail ? ` · ${checkpoint.detail}` : ''}`);
      }
      if (!result.success && result.last_timeline_message) {
        console.log(`[verify] Last signal: ${result.last_timeline_message}`);
      }
    }
  }

  return result.success ? 0 : 1;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    console.error('[symharix] ERROR:', (error as Error).message);
    process.exit(1);
  }

  // Handle --help
  if (process.argv.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  // --kill: terminate all running symphony processes
  if (args.kill) {
    const myPid = process.pid;
    await killKnownSymHarixProcesses(myPid);
    const { execSync } = await import('child_process');
    const remainingPids = execSync(
      `ps aux | grep -E 'bun .*src/cli/index\\.ts|node .*src/cli/index\\.ts|bun .*cli\\.tsx|node.*symharix.*cli' | grep -v grep | awk '{print $2}'`
    ).toString().trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n !== myPid && n !== 1);

    if (remainingPids.length === 0) {
      console.log('[symharix] No running processes found.');
    }
    console.log('[symharix] All processes stopped.');
    process.exit(0);
  }

  const earlyLiveVerificationCommand = args.verifyLiveSupervisor ?? args.verifyLiveLifecycle ?? null;
  if (
    earlyLiveVerificationCommand?.supervisorScenario &&
    shouldRunAttachedVerifierBeforeServiceBootstrap(earlyLiveVerificationCommand)
  ) {
    process.exit(await runAttachedLiveVerificationCommand(earlyLiveVerificationCommand));
  }

  // Resolve workflow path
  // Section 17.7: CLI accepts optional positional workflow path argument
  const workflowPath = args.workflowPath
    ? path.resolve(args.workflowPath)
    : resolveWorkflowPath();

  console.log('[symharix] Starting...');
  console.log('[symharix] Workflow path:', workflowPath);

  // Load initial workflow
  const loadResult = loadWorkflow(workflowPath);
  if (!loadResult.success) {
    console.error('[symharix] ERROR: Failed to load workflow:', loadResult.errorMessage);
    process.exit(1);
  }

  // Build service config
  let config: ServiceConfig;
  try {
    config = buildServiceConfig(loadResult.definition!);
  } catch (error) {
    console.error('[symharix] ERROR: Failed to build config:', (error as Error).message);
    process.exit(1);
  }

  // Override port from CLI if specified
  // Section 13.7: CLI --port overrides server.port
  if (args.port !== undefined) {
    config.serverPort = args.port > 0 ? args.port : null;
  }

  // Validate config for dispatch
  const validation = validateConfigForDispatch(config);
  if (!validation.valid) {
    console.error('[symharix] ERROR: Configuration validation failed:');
    validation.errors.forEach(err => console.error('  -', err));
    process.exit(1);
  }

  console.log('[symharix] Configuration valid');
  console.log('[symharix] Tracker:', config.trackerKind);
  console.log('[symharix] Project root:', config.projectRoot);
  console.log('[symharix] Poll interval:', config.pollIntervalMs, 'ms');
  console.log('[symharix] Max concurrent agents:', config.maxConcurrentAgents);

  try {
    ensureEmbeddedClaudeRuntimeReady({
      projectRoot: config.projectRoot,
      codexCommand: config.codexCommand,
      log: (message) => console.log(message),
    });
  } catch (error) {
    console.error('[symharix] ERROR:', (error as Error).message);
    process.exit(1);
  }

  const db = createDatabase({
    path: path.join(config.projectRoot, 'symphony.db'),
  });

  if (args.maintenance?.kind === 'repair_bot_followups') {
    const runtimeHub = createMaintenanceRuntimeHub(db);
    const summary = new BotFollowupRepairService(
      runtimeHub,
      new WorkItemRepository(db),
      new BotIssueFollowupRepository(db),
      new BotFollowupMessageStateRepository(db),
      new BotFollowupDeliveryStateRepository(db),
      new BotPendingActionRepository(db),
      new BotConversationFocusRepository(db),
    ).repair();
    runtimeHub.dispose();

    console.log('[repair] Bot follow-up repair complete');
    console.log(`[repair] Folded descendant follow-ups: ${summary.descendant_followups_folded}`);
    console.log(`[repair] Deleted descendant card states: ${summary.descendant_message_states_deleted}`);
    console.log(`[repair] Deleted descendant pending actions: ${summary.descendant_pending_actions_deleted}`);
    console.log(`[repair] Deleted orphan card states: ${summary.orphan_message_states_deleted}`);
    console.log(`[repair] Deleted orphan delivery states: ${summary.orphan_delivery_states_deleted}`);
    console.log(`[repair] Deleted expired pending actions: ${summary.expired_pending_actions_deleted}`);
    console.log(`[repair] Resolved terminal legacy cards: ${summary.terminal_message_states_resolved}`);
    console.log(`[repair] Cancelled terminal pending actions: ${summary.terminal_pending_actions_cancelled}`);
    console.log(`[repair] Cleared terminal conversation focuses: ${summary.terminal_conversation_focuses_cleared}`);
    console.log(`[repair] Seeded delivery baselines: ${summary.delivery_baselines_seeded}`);
    process.exit(0);
  }

  if (args.maintenance?.kind === 'repair_all') {
    const runtimeHub = createMaintenanceRuntimeHub(db);
    const botSummary = new BotFollowupRepairService(
      runtimeHub,
      new WorkItemRepository(db),
      new BotIssueFollowupRepository(db),
      new BotFollowupMessageStateRepository(db),
      new BotFollowupDeliveryStateRepository(db),
      new BotPendingActionRepository(db),
      new BotConversationFocusRepository(db),
    ).repair();
    runtimeHub.dispose();

    const tracker = new LinearClient({
      endpoint: config.trackerEndpoint,
      apiKey: config.trackerApiKey,
      projectSlugs: Object.keys(config.repositories.routing),
    });
    const githubSummary = await new GlobalRepairService({
      config,
      tracker,
      workItemRepository: new WorkItemRepository(db),
      githubClientFactory: (repo) => createGitHubIssueClient(
        config.githubToken,
        repo,
        config.githubOwner,
      ),
    }).repair();

    console.log('[repair] Global repair complete');
    console.log(`[repair] Folded descendant follow-ups: ${botSummary.descendant_followups_folded}`);
    console.log(`[repair] Deleted descendant card states: ${botSummary.descendant_message_states_deleted}`);
    console.log(`[repair] Deleted descendant pending actions: ${botSummary.descendant_pending_actions_deleted}`);
    console.log(`[repair] Deleted expired pending actions: ${botSummary.expired_pending_actions_deleted}`);
    console.log(`[repair] Resolved terminal legacy cards: ${botSummary.terminal_message_states_resolved}`);
    console.log(`[repair] Cancelled terminal pending actions: ${botSummary.terminal_pending_actions_cancelled}`);
    console.log(`[repair] Cleared terminal conversation focuses: ${botSummary.terminal_conversation_focuses_cleared}`);
    console.log(`[repair] Seeded delivery baselines: ${botSummary.delivery_baselines_seeded}`);
    console.log(`[repair] Terminal issues scanned: ${githubSummary.terminal_issues_scanned}`);
    console.log(`[repair] Repos scanned: ${githubSummary.repos_scanned}`);
    console.log(`[repair] GitHub issues closed: ${githubSummary.github_issues_closed}`);
    console.log(`[repair] GitHub PRs closed: ${githubSummary.github_prs_closed}`);
    process.exit(0);
  }

  const liveVerificationCommand = args.verifyLiveSupervisor ?? args.verifyLiveLifecycle ?? null;
  if (liveVerificationCommand) {
    if (liveVerificationCommand.supervisorScenario && liveVerificationCommand.serverUrl) {
      process.exit(await runAttachedLiveVerificationCommand(liveVerificationCommand));
    }

    const verifyConfig: ServiceConfig = {
      ...config,
      serverPort: null,
    };
    const verifier = new LiveLifecycleVerifier({
      db,
      config: verifyConfig,
      workflow: loadResult.definition!,
      runtimeHostFactory: async () => new RuntimeHost({
        db,
        initialConfig: verifyConfig,
        initialDefinition: loadResult.definition!,
      }),
    });

    const result = await verifier.verify({
      projectSlug: liveVerificationCommand.projectSlug,
      timeoutMs: liveVerificationCommand.timeoutMs,
      titleSuffix: liveVerificationCommand.titleSuffix,
      supervisorScenario: liveVerificationCommand.supervisorScenario,
      reporter: (message) => {
        if (!liveVerificationCommand.json) {
          console.log(`[verify] ${message}`);
        }
      },
    });

    if (liveVerificationCommand.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[verify] ${result.success ? 'PASS' : 'FAIL'} ${result.message}`);
      console.log(`[verify] Project: ${result.project_slug}`);
      if (result.issue_identifier) {
        console.log(`[verify] Issue: ${result.issue_identifier}`);
      }
      if (result.pull_request_number) {
        console.log(`[verify] PR: #${result.pull_request_number}`);
      }
      if (result.review_decision) {
        console.log(`[verify] Review: ${result.review_decision}`);
      }
      for (const checkpoint of result.checkpoints) {
        const marker = checkpoint.status === 'passed' ? 'OK' : checkpoint.status === 'failed' ? 'FAIL' : 'WAIT';
        console.log(`[verify] ${marker} ${checkpoint.label}${checkpoint.detail ? ` · ${checkpoint.detail}` : ''}`);
      }
      if (!result.success && result.last_timeline_message) {
        console.log(`[verify] Last timeline: ${result.last_timeline_message}`);
      }
    }

    process.exit(result.success ? 0 : 1);
  }

  const timelineRenderStateByIssue = new Map<string, ReturnType<typeof createCliTimelineRenderState>>();
  const runtimeHost = new RuntimeHost({
    db,
    initialConfig: config,
    initialDefinition: loadResult.definition!,
    cliPortOverride: args.port,
    bindOrchestrator: (orchestrator) =>
      attachCliObservers(orchestrator as Orchestrator, timelineRenderStateByIssue),
  });

  // Set up workflow watcher for dynamic reload
  // Section 6.2: Dynamic Reload Semantics
  let reloadChain = Promise.resolve();
  const workflowWatcher = new WorkflowWatcher({
    workflowPath,
    onReload: (newDefinition: WorkflowDefinition, newConfig: ServiceConfig) => {
      reloadChain = reloadChain
        .then(async () => {
          console.log('[symharix] Workflow reloaded, rebuilding orchestrator/runtime...');
          await runtimeHost.reload(newDefinition, newConfig);
          config = runtimeHost.getConfig();
          const server = runtimeHost.getServer() as { getInfo?: () => { port: number | null } } | null;
          const info = server?.getInfo?.();
          if (info?.port) {
            console.log(`[symharix] Runtime UI: http://localhost:${info.port}/runtime`);
            console.log(`[symharix] Runtime API: http://localhost:${info.port}/api/v1/runtime/overview`);
            console.log(`[symharix] Bot manifest: http://localhost:${info.port}/api/v1/bots/manifest`);
          }
          console.log('[symharix] Workflow reload applied');
        })
        .catch((error: Error) => {
          logger.warn('Workflow reload error', { error: error.message });
        });
    },
    onError: (error: Error) => {
      logger.warn('Workflow reload error', { error: error.message });
    }
  });

  // Start the watcher
  const watchResult = workflowWatcher.start();
  if (!watchResult.success) {
    console.error('[symharix] WARNING: Workflow watcher failed to start:', watchResult.error);
    // Continue anyway - we already loaded the workflow
  }

  // Handle shutdown signals
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      console.log('[symharix] Force shutdown...');
      await killKnownSymHarixProcesses(process.pid);
      process.exit(1);
    }

    shuttingDown = true;
    console.log(`[symharix] Received ${signal}, shutting down gracefully...`);

    try {
      await workflowWatcher.stop();
      await runtimeHost.stop();
      console.log('[symharix] Shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[symharix] Shutdown error:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start the orchestrator
  try {
    await runtimeHost.start();
    config = runtimeHost.getConfig();
    const server = runtimeHost.getServer() as { getInfo?: () => { port: number | null } } | null;
    const info = server?.getInfo?.();
    if (info?.port) {
      console.log(`[symharix] Runtime UI: http://localhost:${info.port}/runtime`);
      console.log(`[symharix] Runtime API: http://localhost:${info.port}/api/v1/runtime/overview`);
      console.log(`[symharix] Bot manifest: http://localhost:${info.port}/api/v1/bots/manifest`);
    }
    console.log('[symharix] symharix is running. Press Ctrl+C to stop.');

    // Keep process alive
    // The orchestrator's poll timer will keep things running
  } catch (err) {
    console.error('[symharix] Failed to start orchestrator:', err);
    process.exit(1);
  }
}

// Run main
main().catch((err) => {
  console.error('[symharix] Unhandled error:', err);
  process.exit(1);
});
