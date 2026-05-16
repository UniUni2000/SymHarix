#!/usr/bin/env bun

import { execSync, spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { createCloudflaredTunnelProvider, type TelegramTunnelHandle } from '../bots/telegramBootstrap';
import {
  deleteSymHarixEnv,
  readSymHarixEnv,
  readSymHarixEnvTrimmed,
  setSymHarixEnv,
  syncSymHarixEnvAliases,
} from '../config/env';
import { loadWorkflow, resolveWorkflowPath } from '../workflow/loader';
import { buildServiceConfig } from '../config/loader';
import {
  buildTelegramStartupSummary,
  applyProxyEnv,
  disableProxyEnv,
  ensureNoProxyForLocalhost,
  getStartLocalTunnelProbeRecoveryReason,
  getStartLocalTunnelRecoveryReason,
  hasHttpProxyEnv,
  resolveStartLocalPort,
  shouldEmitTelegramStartupSummary,
  shouldProvisionStartLocalTunnel,
} from './startLocalTunnel';

const projectRoot = path.resolve(__dirname, '../..');
syncSymHarixEnvAliases(process.env);

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

function stopExistingSymHarixnessIfNeeded(port: number): void {
  if (!portHasListener(port)) {
    return;
  }

  console.log(`[symharix] start:local detected an existing listener on port ${port}; stopping prior local instance...`);
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
  const proxyMode = readSymHarixEnvTrimmed('SYMPHONY_PROXY_MODE', env)?.toLowerCase() || 'auto';
  if (proxyMode === 'off') {
    setSymHarixEnv('SYMPHONY_TELEGRAM_DISABLE_PROXY', '1', env);
    console.log(
      '[symharix] start:local Telegram proxy disabled by SYMHARIX_PROXY_MODE=off (legacy SYMPHONY_PROXY_MODE also accepted)',
    );
    return;
  }

  deleteSymHarixEnv('SYMPHONY_TELEGRAM_DISABLE_PROXY', env);

  const configuredProxy = readSymHarixEnvTrimmed('SYMPHONY_PROXY_URL', env);
  if (configuredProxy) {
    applyProxyEnv(env, configuredProxy);
    ensureNoProxyForLocalhost(env);
    console.log(
      `[symharix] start:local using Telegram proxy from SYMHARIX_PROXY_URL (legacy SYMPHONY_PROXY_URL also accepted): ${configuredProxy}`,
    );
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
    console.log('[symharix] start:local using existing HTTP_PROXY/HTTPS_PROXY for Telegram API calls');
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
    console.log(`[symharix] start:local detected local Telegram proxy: ${detectedProxy}`);
  } else {
    ensureNoProxyForLocalhost(env);
    console.log('[symharix] start:local no local Telegram proxy detected; continuing without proxy');
  }
}

function configureStartLocalTelegramRetryEnv(env: Record<string, string | undefined>): void {
  if (!readSymHarixEnvTrimmed('SYMPHONY_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS', env)) {
    setSymHarixEnv('SYMPHONY_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS', '6', env);
  }
  if (!readSymHarixEnvTrimmed('SYMPHONY_TELEGRAM_WEBHOOK_RETRY_DELAY_MS', env)) {
    setSymHarixEnv('SYMPHONY_TELEGRAM_WEBHOOK_RETRY_DELAY_MS', '2000', env);
  }
  if (!readSymHarixEnvTrimmed('SYMPHONY_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS', env)) {
    setSymHarixEnv('SYMPHONY_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS', '60', env);
  }
}

function resolveTelegramStartupSummaryAttempts(env: Record<string, string | undefined>): number {
  const maxAttempts = Number.parseInt(readSymHarixEnv('SYMPHONY_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS', env) || '', 10);
  return Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 60;
}

function resolvePositiveIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const parsed = Number.parseInt(readSymHarixEnv(name, env) || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type TelegramManifestSnapshot = {
  health?: string | null;
  webhook_url?: string | null;
  webhook_last_error_message?: string | null;
  webhook_pending_update_count?: number | null;
  public_base_url?: string | null;
};

async function readTelegramManifestSnapshot(port: number): Promise<TelegramManifestSnapshot | null> {
  const manifestUrl = `http://127.0.0.1:${port}/api/v1/bots/manifest`;
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`manifest returned ${response.status}`);
  }
  const payload = await response.json() as {
    data?: {
      transports?: {
        telegram?: TelegramManifestSnapshot;
      };
    };
  };
  return payload.data?.transports?.telegram ?? null;
}

async function probePublicTunnelReachability(publicBaseUrl: string): Promise<{
  status: number | null;
  errorMessage: string | null;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(publicBaseUrl, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    });
    return {
      status: response.status,
      errorMessage: null,
    };
  } catch (error) {
    return {
      status: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function printTelegramStartupSummary(
  port: number,
  expectedPublicBaseUrl: string | null,
  attempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const telegram = await readTelegramManifestSnapshot(port);
      if (telegram && shouldEmitTelegramStartupSummary(telegram, expectedPublicBaseUrl)) {
        console.log(`[symharix] ${buildTelegramStartupSummary(telegram, expectedPublicBaseUrl)}`);
        return;
      }
    } catch {
      // Service may still be booting. Keep polling briefly and stay quiet.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log('[symharix] telegram: unhealthy webhook_url=(none)');
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 3_000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const childEnv = { ...process.env } as Record<string, string | undefined>;
  syncSymHarixEnvAliases(childEnv);
  const workflowPath = resolveWorkflowPath();
  const workflowLoad = loadWorkflow(workflowPath);
  const workflowServerPort = workflowLoad.success
    ? buildServiceConfig(workflowLoad.definition!).serverPort
    : null;
  const requestedPort = resolveStartLocalPort(args, childEnv, workflowServerPort);

  stopExistingSymHarixnessIfNeeded(requestedPort);
  if (readSymHarixEnvTrimmed('SYMPHONY_TELEGRAM_BOT_TOKEN', childEnv)) {
    await configureStartLocalProxyEnv(childEnv);
    configureStartLocalTelegramRetryEnv(childEnv);
  }

  let tunnelHandle: TelegramTunnelHandle | null = null;
  let child: ChildProcess | null = null;
  let cleanedUp = false;
  let finished = false;
  let tunnelWatchdog: NodeJS.Timeout | null = null;
  let recoveryInFlight: Promise<void> | null = null;
  const intentionalChildStops = new WeakSet<ChildProcess>();

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    if (tunnelWatchdog) {
      clearInterval(tunnelWatchdog);
      tunnelWatchdog = null;
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

  const provisionTemporaryTunnel = async (): Promise<TelegramTunnelHandle | null> => {
    const maxAttempts = resolvePositiveIntegerEnv(
      childEnv,
      'SYMPHONY_TELEGRAM_TUNNEL_RETRY_ATTEMPTS',
      3,
    );
    const retryDelayMs = resolvePositiveIntegerEnv(
      childEnv,
      'SYMPHONY_TELEGRAM_TUNNEL_RETRY_DELAY_MS',
      1500,
    );
    let lastError: unknown = null;
    try {
      console.log('[symharix] start:local provisioning temporary Telegram tunnel...');
      const localBaseUrl = `http://127.0.0.1:${requestedPort}`;
      const tunnelProvider = createCloudflaredTunnelProvider();
      let nextTunnelHandle: TelegramTunnelHandle | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          nextTunnelHandle = await tunnelProvider(localBaseUrl);
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= maxAttempts) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[symharix] start:local tunnel attempt ${attempt}/${maxAttempts} failed; retrying: ${message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }

      if (!nextTunnelHandle) {
        throw lastError instanceof Error ? lastError : new Error('Telegram tunnel provider did not return a handle');
      }

      console.log(`[symharix] start:local tunnel ready: ${nextTunnelHandle.publicBaseUrl}`);
      console.log('[symharix] start:local using temporary tunnel only for this process; .env was not modified.');
      return nextTunnelHandle;
    } catch (error) {
      console.warn(
        '[symharix] start:local could not pre-provision Telegram tunnel; falling back to normal bootstrap.',
      );
      if (error instanceof Error) {
        console.warn(`[symharix] ${error.message}`);
      }
      return null;
    }
  };

  const spawnServiceChild = (): void => {
    child = spawn(
      process.execPath,
      ['--env-file=.env', 'run', 'src/cli/index.ts', ...args],
      {
        cwd: projectRoot,
        env: childEnv,
        stdio: 'inherit',
      },
    );

    const spawnedChild = child;
    spawnedChild.once('error', (error) => {
      console.error('[symharix] start:local failed to launch the service process.');
      console.error(error);
      void finish(1, null);
    });
    spawnedChild.once('exit', (code, signal) => {
      if (intentionalChildStops.has(spawnedChild)) {
        return;
      }
      void finish(code, signal);
    });
  };

  const restartServiceWithFreshTunnel = async (reason: string): Promise<void> => {
    if (finished) {
      return;
    }
    if (recoveryInFlight) {
      await recoveryInFlight;
      return;
    }

    recoveryInFlight = (async () => {
      console.warn(`[symharix] start:local detected unhealthy Telegram tunnel; recovering. reason=${reason}`);
      const nextTunnelHandle = await provisionTemporaryTunnel();
      if (!nextTunnelHandle) {
        console.warn('[symharix] start:local tunnel recovery skipped; keeping the current service running.');
        return;
      }

      const previousTunnelHandle = tunnelHandle;
      const previousChild = child;
      if (previousChild && previousChild.exitCode === null) {
        intentionalChildStops.add(previousChild);
        await stopChild(previousChild);
      }

      tunnelHandle = nextTunnelHandle;
      setSymHarixEnv('SYMPHONY_PUBLIC_BASE_URL', nextTunnelHandle.publicBaseUrl, childEnv);
      if (previousTunnelHandle) {
        await previousTunnelHandle.dispose();
      }
      spawnServiceChild();
      void printTelegramStartupSummary(
        requestedPort,
        readSymHarixEnvTrimmed('SYMPHONY_PUBLIC_BASE_URL', childEnv),
        resolveTelegramStartupSummaryAttempts(childEnv),
      );
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[symharix] start:local tunnel recovery failed: ${message}`);
    }).finally(() => {
      recoveryInFlight = null;
    });

    await recoveryInFlight;
  };

  const startTelegramTunnelWatchdog = (): void => {
    if (!shouldProvisionStartLocalTunnel(childEnv)) {
      return;
    }
    const intervalMs = resolvePositiveIntegerEnv(
      childEnv,
      'SYMPHONY_TELEGRAM_TUNNEL_WATCHDOG_INTERVAL_MS',
      10_000,
    );
    const degradedPollThreshold = resolvePositiveIntegerEnv(
      childEnv,
      'SYMPHONY_TELEGRAM_TUNNEL_WATCHDOG_DEGRADED_POLLS',
      2,
    );
    let degradedPolls = 0;

    tunnelWatchdog = setInterval(() => {
      if (finished || recoveryInFlight) {
        return;
      }
      void (async () => {
        const expectedPublicBaseUrl = readSymHarixEnvTrimmed('SYMPHONY_PUBLIC_BASE_URL', childEnv);
        if (!expectedPublicBaseUrl) {
          degradedPolls = 0;
          return;
        }

        const telegram = await readTelegramManifestSnapshot(requestedPort);
        let recoveryReason = telegram
          ? getStartLocalTunnelRecoveryReason(telegram, expectedPublicBaseUrl)
          : null;
        if (!recoveryReason) {
          const tunnelProbe = await probePublicTunnelReachability(expectedPublicBaseUrl);
          recoveryReason = getStartLocalTunnelProbeRecoveryReason({
            expectedPublicBaseUrl,
            status: tunnelProbe.status,
            errorMessage: tunnelProbe.errorMessage,
          });
        }
        if (!recoveryReason) {
          degradedPolls = 0;
          return;
        }

        degradedPolls += 1;
        if (degradedPolls < degradedPollThreshold) {
          return;
        }

        degradedPolls = 0;
        await restartServiceWithFreshTunnel(recoveryReason);
      })().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[symharix] start:local tunnel watchdog check failed: ${message}`);
      });
    }, intervalMs);
    tunnelWatchdog.unref?.();
  };

  if (shouldProvisionStartLocalTunnel(childEnv)) {
    tunnelHandle = await provisionTemporaryTunnel();
    if (tunnelHandle) {
      setSymHarixEnv('SYMPHONY_PUBLIC_BASE_URL', tunnelHandle.publicBaseUrl, childEnv);
    }
  }

  spawnServiceChild();
  void printTelegramStartupSummary(
    requestedPort,
    readSymHarixEnvTrimmed('SYMPHONY_PUBLIC_BASE_URL', childEnv),
    resolveTelegramStartupSummaryAttempts(childEnv),
  );
  startTelegramTunnelWatchdog();
}

void main().catch((error) => {
  console.error('[symharix] start:local wrapper failed.');
  console.error(error);
  process.exit(1);
});
