/**
 * Symphony - Main Entry Point
 * Starts HTTP server, Telegram bot, and orchestrator
 */

import * as path from 'path';
import * as fs from 'fs';
import { Database } from 'bun:sqlite';

// Load .env file
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0 && !key.trim().startsWith('#')) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  });
}

import { Orchestrator } from './orchestrator';
import { WorkflowWatcher } from './workflow/watcher';
import { loadWorkflow, resolveWorkflowPath } from './workflow/loader';
import { buildServiceConfig, validateConfigForDispatch } from './config/loader';
import { logger } from './logging';
import { Issue, WorkflowDefinition, ServiceConfig } from './types';
import { SymphonyServer } from './server';
import { SymphonyBot } from './telegram';
import type { TelegramBotConfig } from './telegram/types';

/**
 * Parse command line arguments
 */
function parseArgs(): { workflowPath?: string; port?: number } {
  const args = process.argv.slice(2);
  const result: { workflowPath?: string; port?: number } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--port' && args[i + 1]) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    } else if (arg.startsWith('--port=')) {
      result.port = parseInt(arg.slice(7), 10);
    } else if (!arg.startsWith('-')) {
      result.workflowPath = arg;
    }
  }

  return result;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs();

  // Resolve workflow path
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

  // Initialize database
  const dbPath = path.join(process.cwd(), 'symphony.db');
  const db = new Database(dbPath);
  console.log('[symphony] Database:', dbPath);

  // Initialize schema
  const { initializeSchema } = await import('./database/schema');
  initializeSchema(db);
  console.log('[symphony] Database schema initialized');

  // Start HTTP server
  if (config.serverPort) {
    const server = new SymphonyServer(db, {
      port: config.serverPort,
      hostname: '0.0.0.0',
      enableWebSocket: true,
    });
    await server.start();
    console.log('[symphony] HTTP server started on port', config.serverPort);
  }

  // Start Telegram bot if token is configured
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedUserId = process.env.TELEGRAM_ALLOWED_USER_ID;

  if (telegramToken) {
    const botConfig: TelegramBotConfig = {
      token: telegramToken,
      verbose: true,
      allowedUserIds: allowedUserId ? [parseInt(allowedUserId, 10)] : [],
    };

    const bot = new SymphonyBot(db, botConfig);
    await bot.start();
    console.log('[symphony] Telegram bot started');
  } else {
    console.log('[symphony] Telegram bot not configured (skiped)');
  }

  // Create orchestrator
  const orchestrator = new Orchestrator(config, loadResult.definition!);

  // Set up event handlers
  orchestrator.on('issue:dispatched', (issue: Issue) => {
    logger.info('Issue dispatched', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      title: issue.title
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

  // Start orchestrator
  await orchestrator.start();
  console.log('[symphony] Orchestrator started');

  // Set up workflow watcher for hot-reload
  const watcher = new WorkflowWatcher({
    workflowPath: workflowPath,
    onReload: (definition: WorkflowDefinition, config: ServiceConfig) => {
      logger.info('Workflow reloaded', { definition });
    },
    onError: (error: Error) => {
      logger.error('Workflow watch error', { error: error.message });
    }
  });
  watcher.start();
  console.log('[symphony] Workflow watcher started');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[symphony] Shutting down...');
    await orchestrator.stop();
    if (config.serverPort) {
      await server.stop();
    }
    if (telegramToken) {
      await bot.stop();
    }
    db.close();
    console.log('[symphony] Goodbye!');
    process.exit(0);
  });
}

// Run main
main().catch((err) => {
  console.error('[symphony] Fatal error:', err);
  process.exit(1);
});
