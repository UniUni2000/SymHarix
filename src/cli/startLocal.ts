#!/usr/bin/env bun

import { execSync, spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { createCloudflaredTunnelProvider, type TelegramTunnelHandle } from '../bots/telegramBootstrap';
import { loadWorkflow, resolveWorkflowPath } from '../workflow/loader';
import { buildServiceConfig } from '../config/loader';
import {
  buildTelegramStartupSummary,
  applyProxyEnv,
  disableProxyEnv,
  ensureNoProxyForLocalhost,
  hasHttpProxyEnv,
  resolveStartLocalPort,
  shouldEmitTelegramStartupSummary,
  shouldProvisionStartLocalTunnel,
} from './startLocalTunnel';

const projectRoot = path.resolve(__dirname, '../..');

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

function detectMacosHttpProxy(): string | null {
  try {
    const output = execSync('scutil --proxy', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const enabled = output.match(/^\s*HTTPEnable\s*:\s*(\d+)/m)?.[1];
    const host = output.match(/^\s*HTTPProxy\s*:\s*(.+)$/m)?.[1]?.trim();
    const port = output.match(/^\s*HTTPPort\s*:\s*(\d+)/m)?.[1];
    if (enabled === '1' && host && port) {
      return `http://${host}:${port}`;
    }
  } catch {
    // scutil is macOS-only and optional.
  }
  return null;
}

async function canConnectToLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function detectLocalHttpProxy(): Promise<string | null> {
  const macosProxy = detectMacosHttpProxy();
  if (macosProxy) {
    return macosProxy;
  }

  for (const port of [1087, 7890, 7897, 8080, 6152]) {
    if (await canConnectToLocalPort(port)) {
      return `http://127.0.0.1:${port}`;
    }
  }

  return null;
}

async function configureStartLocalProxyEnv(env: Record<string, string | undefined>): Promise<void> {
  const proxyMode = env.SYMPHONY_PROXY_MODE?.trim().toLowerCase() || 'auto';
  if (proxyMode === 'off') {
    disableProxyEnv(env);
    console.log('[symphonyness] start:local Telegram proxy disabled by SYMPHONY_PROXY_MODE=off');
    return;
  }

  const configuredProxy = env.SYMPHONY_PROXY_URL?.trim();
  if (configuredProxy) {
    applyProxyEnv(env, configuredProxy);
    ensureNoProxyForLocalhost(env);
    console.log(`[symphonyness] start:local using Telegram proxy from SYMPHONY_PROXY_URL: ${configuredProxy}`);
    return;
  }

  if (hasHttpProxyEnv(env)) {
    if (!env.HTTP_PROXY && env.HTTPS_PROXY) {
      env.HTTP_PROXY = env.HTTPS_PROXY;
    }
    if (!env.HTTPS_PROXY && env.HTTP_PROXY) {
      env.HTTPS_PROXY = env.HTTP_PROXY;
    }
    ensureNoProxyForLocalhost(env);
    console.log('[symphonyness] start:local using existing HTTP_PROXY/HTTPS_PROXY for Telegram API calls');
    return;
  }

  if (proxyMode !== 'auto') {
    ensureNoProxyForLocalhost(env);
    return;
  }

  const detectedProxy = await detectLocalHttpProxy();
  if (detectedProxy) {
    applyProxyEnv(env, detectedProxy);
    ensureNoProxyForLocalhost(env);
    console.log(`[symphonyness] start:local detected local Telegram proxy: ${detectedProxy}`);
  } else {
    ensureNoProxyForLocalhost(env);
    console.log('[symphonyness] start:local no local Telegram proxy detected; continuing without proxy');
  }
}

function configureStartLocalTelegramRetryEnv(env: Record<string, string | undefined>): void {
  env.SYMPHONY_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS ||= '6';
  env.SYMPHONY_TELEGRAM_WEBHOOK_RETRY_DELAY_MS ||= '2000';
  env.SYMPHONY_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS ||= '60';
}

function resolveTelegramStartupSummaryAttempts(env: Record<string, string | undefined>): number {
  const maxAttempts = Number.parseInt(env.SYMPHONY_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS || '', 10);
  return Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 60;
}

async function printTelegramStartupSummary(
  port: number,
  expectedPublicBaseUrl: string | null,
  attempts: number,
): Promise<void> {
  const manifestUrl = `http://127.0.0.1:${port}/api/v1/bots/manifest`;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
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
              webhook_pending_update_count?: number | null;
              public_base_url?: string | null;
            };
          };
        };
      };
      const telegram = payload.data?.transports?.telegram;
      if (telegram && shouldEmitTelegramStartupSummary(telegram, expectedPublicBaseUrl)) {
        console.log(`[symphonyness] ${buildTelegramStartupSummary(telegram, expectedPublicBaseUrl)}`);
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
  if (childEnv.SYMPHONY_TELEGRAM_BOT_TOKEN?.trim()) {
    await configureStartLocalProxyEnv(childEnv);
    configureStartLocalTelegramRetryEnv(childEnv);
  }

  let tunnelHandle: TelegramTunnelHandle | null = null;
  let child: ChildProcess | null = null;
  let cleanedUp = false;
  let finished = false;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

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

      const publicBaseUrl = tunnelHandle.publicBaseUrl;
      childEnv.SYMPHONY_PUBLIC_BASE_URL = publicBaseUrl;
      console.log(`[symphonyness] start:local tunnel ready: ${publicBaseUrl}`);
      console.log('[symphonyness] start:local using temporary tunnel only for this process; .env was not modified.');
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
    resolveTelegramStartupSummaryAttempts(childEnv),
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
