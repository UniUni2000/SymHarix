#!/usr/bin/env node
/**
 * Symphony CLI - Main entrypoint
 * Section 17.7: CLI and Host Lifecycle
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// Load .env file explicitly
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

import { Orchestrator } from '../orchestrator';
import { WorkflowWatcher } from '../workflow/watcher';
import { loadWorkflow, resolveWorkflowPath } from '../workflow/loader';
import { buildServiceConfig, validateConfigForDispatch } from '../config/loader';
import { logger } from '../logging';
import { Issue, AgentEvent, WorkflowDefinition, ServiceConfig } from '../types';

/**
 * Parse command line arguments
 */
function parseArgs(): { workflowPath?: string; port?: number; kill?: boolean } {
  const args = process.argv.slice(2);
  const result: { workflowPath?: string; port?: number; kill?: boolean } = {};

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
Symphony - Coding Agent Orchestrator

Usage: symphony [options] [workflow-path]

Options:
  --port <number>    Enable HTTP server on specified port
  --kill             Stop all running symphony agent processes
  --help             Show this help message

Arguments:
  workflow-path      Path to WORKFLOW.md file (default: ./WORKFLOW.md)

Examples:
  symphony                        # Use ./WORKFLOW.md
  symphony path/to/WORKFLOW.md    # Use specified workflow file
  symphony --port 3000            # Enable HTTP server on port 3000
  symphony --kill                 # Stop all running agents
`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs();

  // Handle --help
  if (process.argv.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  // --kill: terminate all running symphony processes
  if (args.kill) {
    const myPid = process.pid;
    const { execSync } = await import('child_process');

    // Find symphony-related processes
    const pids = execSync(
      `ps aux | grep -E 'bun run src/cli|node.*test-cc.*cli|bun.*cli\\.tsx' | grep -v grep | awk '{print $2}'`
    ).toString().trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n !== myPid && n !== 1);

    if (pids.length === 0) {
      console.log('[symphony] No running processes found.');
      process.exit(0);
    }

    console.log('[symphony] Stopping processes:', pids.join(', '));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`[symphony] Sent SIGTERM to ${pid}`);
      } catch (err) {
        console.error(`[symphony] Failed to kill ${pid}:`, err);
      }
    }

    // Also kill any orphaned claude-adapter processes
    try {
      const adapterPids = execSync(
        `ps aux | grep 'claude-adapter\\.cjs' | grep -v grep | awk '{print $2}'`
      ).toString().trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      for (const pid of adapterPids) {
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`[symphony] Sent SIGTERM to adapter ${pid}`);
        } catch {}
      }
    } catch {}

    console.log('[symphony] All processes stopped.');
    process.exit(0);
  }

  // Resolve workflow path
  // Section 17.7: CLI accepts optional positional workflow path argument
  const workflowPath = args.workflowPath
    ? path.resolve(args.workflowPath)
    : resolveWorkflowPath();

  console.log('[symphony] Starting...');
  console.log('[symphony] Workflow path:', workflowPath);

  // Check if workflow file exists
  if (!fs.existsSync(workflowPath)) {
    console.error('[symphony] ERROR: Workflow file not found:', workflowPath);
    console.error('[symphony] Please create a WORKFLOW.md file or specify a path.');
    process.exit(1);
  }

  // Load initial workflow
  const loadResult = loadWorkflow(workflowPath);
  if (!loadResult.success) {
    console.error('[symphony] ERROR: Failed to load workflow:', loadResult.errorMessage);
    process.exit(1);
  }

  // Build service config
  let config = buildServiceConfig(loadResult.definition!);

  // Override port from CLI if specified
  // Section 13.7: CLI --port overrides server.port
  if (args.port !== undefined) {
    config.serverPort = args.port > 0 ? args.port : null;
  }

  // Validate config for dispatch
  const validation = validateConfigForDispatch(config);
  if (!validation.valid) {
    console.error('[symphony] ERROR: Configuration validation failed:');
    validation.errors.forEach(err => console.error('  -', err));
    process.exit(1);
  }

  console.log('[symphony] Configuration valid');
  console.log('[symphony] Tracker:', config.trackerKind);
  console.log('[symphony] Project:', config.trackerProjectSlug);
  console.log('[symphony] Poll interval:', config.pollIntervalMs, 'ms');
  console.log('[symphony] Max concurrent agents:', config.maxConcurrentAgents);

  // Create orchestrator
  const orchestrator = new Orchestrator(config, loadResult.definition!);

  // Set up event handlers
  orchestrator.on('issue:dispatched', (issue: Issue) => {
    logger.info('Issue dispatched', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      phase: issue.state.toLowerCase() === 'in review' ? 'REVIEW' : 'DEV'
    });
  });

  orchestrator.on('issue:completed', (issue: Issue, success: boolean) => {
    logger.info('Issue completed', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      success
    });
  });

  orchestrator.on('issue:failed', (issue: Issue, error: string) => {
    logger.error('Issue failed', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      error
    });
  });

  orchestrator.on('issue:retrying', (issue: Issue, attempt: number, delay: number) => {
    logger.info('Issue retrying', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt,
      delay_ms: delay
    });
  });

  orchestrator.on('session:event', (issueId: string, event: AgentEvent) => {
    logger.info('Agent event', {
      issue_id: issueId,
      event: event.event,
      payload: event.payload,
      timestamp: event.timestamp.toISOString()
    });
  });

  orchestrator.on('error', (error: Error) => {
    logger.error('Orchestrator error', {}, error);
  });

  // Set up workflow watcher for dynamic reload
  // Section 6.2: Dynamic Reload Semantics
  const workflowWatcher = new WorkflowWatcher({
    workflowPath,
    onReload: (newDefinition: WorkflowDefinition, newConfig: ServiceConfig) => {
      console.log('[symphony] Workflow reloaded, applying new configuration...');
      // Note: In a full implementation, we'd update the orchestrator's config here
      config = newConfig;
      // The orchestrator would need a method to apply new config dynamically
    },
    onError: (error: Error) => {
      logger.warn('Workflow reload error', { error: error.message });
    }
  });

  // Start the watcher
  const watchResult = workflowWatcher.start();
  if (!watchResult.success) {
    console.error('[symphony] WARNING: Workflow watcher failed to start:', watchResult.error);
    // Continue anyway - we already loaded the workflow
  }

  // Handle shutdown signals
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      console.log('[symphony] Force shutdown...');
      process.exit(1);
    }

    shuttingDown = true;
    console.log(`[symphony] Received ${signal}, shutting down gracefully...`);

    try {
      await workflowWatcher.stop();
      await orchestrator.stop();
      console.log('[symphony] Shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[symphony] Shutdown error:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start the orchestrator
  try {
    await orchestrator.start();
    console.log('[symphony] Symphony is running. Press Ctrl+C to stop.');

    // Keep process alive
    // The orchestrator's poll timer will keep things running
  } catch (err) {
    console.error('[symphony] Failed to start orchestrator:', err);
    process.exit(1);
  }
}

// Run main
main().catch((err) => {
  console.error('[symphony] Unhandled error:', err);
  process.exit(1);
});
