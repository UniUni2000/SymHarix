#!/usr/bin/env bun

import { execSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createCloudflaredTunnelProvider, type TelegramTunnelHandle } from '../bots/telegramBootstrap';
import { loadWorkflow, resolveWorkflowPath } from '../workflow/loader';
import { buildServiceConfig } from '../config/loader';
import {
  buildTelegramStartupSummary,
  resolveStartLocalPort,
  shouldEmitTelegramStartupSummary,
  shouldProvisionStartLocalTunnel,
  upsertEnvAssignment,
} from './startLocalTunnel';

const projectRoot = path.resolve(__dirname, '../..');
const envFilePath = path.join(projectRoot, '.env');

function portHasListener(port: number): boolean {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function stopExistingSymphonynessIfNeeded(port: number): void {
  if (!portHasListener(port)) {
    return;
  }

  console.log(`[symphonyness] start:local detected an existing listener on port ${port}; stopping prior local instance...`);
  try {
    execSync(`${process.execPath} --env-file=.env run src/cli/index.ts --kill`, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });
  } catch {
    // Let the normal startup path surface any remaining port conflict with the real error.
  }
}

async function printTelegramStartupSummary(
  port: number,
  expectedPublicBaseUrl: string | null,
): Promise<void> {
  const manifestUrl = `http://127.0.0.1:${port}/api/v1/bots/manifest`;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        throw new Error(`manifest returned ${response.status}`);
      }
      const payload = await response.json() as {
        data?: {
          transports?: {
            telegram?: {
              health?: string | null;
              webhook_url?: string | null;
              webhook_last_error_message?: string | null;
              public_base_url?: string | null;
            };
          };
        };
      };
      const telegram = payload.data?.transports?.telegram;
      if (telegram && shouldEmitTelegramStartupSummary(telegram, expectedPublicBaseUrl)) {
        console.log(`[symphonyness] ${buildTelegramStartupSummary(telegram)}`);
        return;
      }
    } catch {
      // Service may still be booting. Keep polling briefly and stay quiet.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log('[symphonyness] telegram: unhealthy webhook_url=(none)');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const childEnv = { ...process.env } as Record<string, string | undefined>;
  const workflowPath = resolveWorkflowPath();
  const workflowLoad = loadWorkflow(workflowPath);
  const workflowServerPort = workflowLoad.success
    ? buildServiceConfig(workflowLoad.definition!).serverPort
    : null;
  const requestedPort = resolveStartLocalPort(args, childEnv, workflowServerPort);

  stopExistingSymphonynessIfNeeded(requestedPort);

  let originalEnvContent: string | null = null;
  let tunnelHandle: TelegramTunnelHandle | null = null;
  let child: ChildProcess | null = null;
  let cleanedUp = false;
  let finished = false;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    if (originalEnvContent !== null) {
      fs.writeFileSync(envFilePath, originalEnvContent, 'utf8');
    }

    if (tunnelHandle) {
      await tunnelHandle.dispose();
      tunnelHandle = null;
    }
  };

  const finish = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
    if (finished) {
      return;
    }
    finished = true;
    await cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  };

  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (child && child.exitCode === null) {
      child.kill(signal);
      return;
    }
    void finish(1, signal);
  };

  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));

  if (shouldProvisionStartLocalTunnel(childEnv)) {
    try {
      console.log('[symphonyness] start:local provisioning temporary Telegram tunnel...');
      const localBaseUrl = `http://127.0.0.1:${requestedPort}`;
      const tunnelProvider = createCloudflaredTunnelProvider();
      tunnelHandle = await tunnelProvider(localBaseUrl);

      originalEnvContent = fs.existsSync(envFilePath)
        ? fs.readFileSync(envFilePath, 'utf8')
        : '';

      const publicBaseUrl = tunnelHandle.publicBaseUrl;
      fs.writeFileSync(
        envFilePath,
        upsertEnvAssignment(originalEnvContent, 'SYMPHONY_PUBLIC_BASE_URL', publicBaseUrl),
        'utf8',
      );
      childEnv.SYMPHONY_PUBLIC_BASE_URL = publicBaseUrl;
      console.log(`[symphonyness] start:local tunnel ready: ${publicBaseUrl}`);
    } catch (error) {
      console.warn(
        '[symphonyness] start:local could not pre-provision Telegram tunnel; falling back to normal bootstrap.',
      );
      if (error instanceof Error) {
        console.warn(`[symphonyness] ${error.message}`);
      }
      await cleanup();
    }
  }

  child = spawn(
    process.execPath,
    ['--env-file=.env', 'run', 'src/cli/index.ts', ...args],
    {
      cwd: projectRoot,
      env: childEnv,
      stdio: 'inherit',
    },
  );

  child.once('error', (error) => {
    console.error('[symphonyness] start:local failed to launch the service process.');
    console.error(error);
    void finish(1, null);
  });
  void printTelegramStartupSummary(
    requestedPort,
    childEnv.SYMPHONY_PUBLIC_BASE_URL?.trim() || null,
  );
  child.once('exit', (code, signal) => {
    void finish(code, signal);
  });
}

void main().catch((error) => {
  console.error('[symphonyness] start:local wrapper failed.');
  console.error(error);
  process.exit(1);
});
