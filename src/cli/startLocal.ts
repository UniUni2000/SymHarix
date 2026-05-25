#!/usr/bin/env bun

import { execSync, spawn, spawnSync, type ChildProcess } from 'child_process';
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
  applyStartLocalBotSurfaceIsolation,
  applyProxyEnv,
  disableProxyEnv,
  ensureNoProxyForLocalhost,
  getStartLocalTunnelProbeRecoveryReason,
  getStartLocalTunnelRegistrationWaitReason,
  getStartLocalTunnelRecoveryReason,
  hasHttpProxyEnv,
  isEphemeralTryCloudflareUrl,
  resolveStartLocalPort,
  shouldEmitTelegramStartupSummary,
  shouldProvisionStartLocalTunnel,
  type StartLocalBotSurface,
} from './startLocalTunnel';

const projectRoot = path.resolve(__dirname, '../..');
syncSymHarixEnvAliases(process.env);

function parseStartLocalArgs(args: string[]): {
  surface: StartLocalBotSurface;
  serviceArgs: string[];
} {
  let surface: StartLocalBotSurface = 'telegram';
  const serviceArgs: string[] = [];
  const readSurface = (value: string | undefined): StartLocalBotSurface => {
    if (value === 'telegram' || value === 'feishu') {
      return value;
    }
    throw new Error(`Unsupported start bot surface: ${value ?? '(missing)'}. Use telegram or feishu.`);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--bot' || arg === '--surface') {
      surface = readSurface(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--bot=')) {
      surface = readSurface(arg.slice('--bot='.length));
      continue;
    }
    if (arg.startsWith('--surface=')) {
      surface = readSurface(arg.slice('--surface='.length));
      continue;
    }
    if (arg === '--telegram') {
      surface = 'telegram';
      continue;
    }
    if (arg === '--feishu') {
      surface = 'feishu';
      continue;
    }
    serviceArgs.push(arg);
  }

  return { surface, serviceArgs };
}

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

async function configureStartLocalProxyEnv(
  env: Record<string, string | undefined>,
  label = 'Telegram',
): Promise<void> {
  const proxyMode = readSymHarixEnvTrimmed('SYMPHONY_PROXY_MODE', env)?.toLowerCase() || 'auto';
  if (proxyMode === 'off') {
    if (label === 'Telegram') {
      setSymHarixEnv('SYMPHONY_TELEGRAM_DISABLE_PROXY', '1', env);
    }
    console.log(
      `[symharix] start:local ${label} proxy disabled by SYMHARIX_PROXY_MODE=off (legacy SYMPHONY_PROXY_MODE also accepted)`,
    );
    return;
  }

  if (label === 'Telegram') {
    deleteSymHarixEnv('SYMPHONY_TELEGRAM_DISABLE_PROXY', env);
  }

  const configuredProxy = readSymHarixEnvTrimmed('SYMPHONY_PROXY_URL', env);
  if (configuredProxy) {
    applyProxyEnv(env, configuredProxy);
    ensureNoProxyForLocalhost(env);
    console.log(
      `[symharix] start:local using ${label} proxy from SYMHARIX_PROXY_URL (legacy SYMPHONY_PROXY_URL also accepted): ${configuredProxy}`,
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
    console.log(`[symharix] start:local using existing HTTP_PROXY/HTTPS_PROXY for ${label}`);
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
    console.log(`[symharix] start:local detected local ${label} proxy: ${detectedProxy}`);
  } else {
    ensureNoProxyForLocalhost(env);
    console.log(`[symharix] start:local no local ${label} proxy detected; continuing without proxy`);
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

function resolvePositiveIntegerEnvAny(
  env: Record<string, string | undefined>,
  names: string[],
  fallback: number,
): number {
  for (const name of names) {
    const parsed = Number.parseInt(readSymHarixEnv(name, env) || '', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function isQuickTunnelRateLimitedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /quick tunnel|trycloudflare|cloudflare tunnel/i.test(message)
    && /429|too many requests|error code:\s*1015/i.test(message);
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

function probePublicTunnelReachabilityWithCurl(
  publicBaseUrl: string,
  env: Record<string, string | undefined>,
): {
  status: number | null;
  errorMessage: string | null;
} {
  const result = spawnSync(
    'curl',
    [
      '-sS',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '--max-time',
      '5',
      '--connect-timeout',
      '5',
      publicBaseUrl,
    ],
    {
      env,
      encoding: 'utf8',
    },
  );

  const rawStatus = result.stdout.trim();
  const status = /^\d{3}$/.test(rawStatus) && rawStatus !== '000'
    ? Number.parseInt(rawStatus, 10)
    : null;
  if (status !== null) {
    return { status, errorMessage: null };
  }

  const stderr = result.stderr.trim();
  const errorMessage = stderr
    || result.error?.message
    || (rawStatus === '000' ? 'curl could not reach public tunnel' : null);
  return { status: null, errorMessage };
}

async function probePublicTunnelReachabilityFromEnv(
  publicBaseUrl: string,
  env: Record<string, string | undefined>,
): Promise<{
  status: number | null;
  errorMessage: string | null;
}> {
  if (hasHttpProxyEnv(env)) {
    const curlProbe = probePublicTunnelReachabilityWithCurl(publicBaseUrl, env);
    if (curlProbe.status !== null || curlProbe.errorMessage) {
      return curlProbe;
    }
  }
  return probePublicTunnelReachability(publicBaseUrl);
}

async function waitForTemporaryTunnelRegistration(
  publicBaseUrl: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const attempts = resolvePositiveIntegerEnvAny(
    env,
    ['SYMPHONY_FEISHU_TUNNEL_READY_ATTEMPTS', 'SYMPHONY_TUNNEL_READY_ATTEMPTS'],
    60,
  );
  const delayMs = resolvePositiveIntegerEnvAny(
    env,
    ['SYMPHONY_FEISHU_TUNNEL_READY_DELAY_MS', 'SYMPHONY_TUNNEL_READY_DELAY_MS'],
    1000,
  );
  let lastReason: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probe = await probePublicTunnelReachabilityFromEnv(publicBaseUrl, env);
    const waitReason = getStartLocalTunnelRegistrationWaitReason({
      expectedPublicBaseUrl: publicBaseUrl,
      status: probe.status,
      errorMessage: probe.errorMessage,
    });
    if (!waitReason) {
      return;
    }
    lastReason = waitReason;
    if (attempt < attempts) {
      if (attempt === 1 || attempt % 5 === 0) {
        console.log(`[symharix] start:local waiting for temporary tunnel registration (${attempt}/${attempts}): ${waitReason}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(lastReason ?? `Timed out waiting for temporary tunnel registration: ${publicBaseUrl}`);
}

async function waitForLocalServiceStartup(
  port: number,
  env: Record<string, string | undefined>,
): Promise<void> {
  const attempts = resolvePositiveIntegerEnvAny(
    env,
    ['SYMPHONY_START_LOCAL_SERVICE_READY_ATTEMPTS'],
    60,
  );
  const delayMs = resolvePositiveIntegerEnvAny(
    env,
    ['SYMPHONY_START_LOCAL_SERVICE_READY_DELAY_MS'],
    500,
  );
  const url = `http://127.0.0.1:${port}/api/v1/runtime/overview`;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`local service did not become reachable at ${url}: ${lastError ?? 'unknown error'}`);
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

function printFeishuStartupSummary(expectedPublicBaseUrl?: string | null): void {
  const publicBaseUrl = expectedPublicBaseUrl?.trim() || null;
  console.log('[symharix] feishu: long connection mode enabled; no public webhook URL is required.');
  if (publicBaseUrl) {
    const tunnelNote = isEphemeralTryCloudflareUrl(publicBaseUrl)
      ? 'temporary tunnel, runtime links only'
      : 'runtime links';
    console.log(`[symharix] feishu: public Mini App base enabled (${tunnelNote}): ${publicBaseUrl}`);
  } else {
    console.log('[symharix] feishu: Mini App links are local-only; mobile Feishu clients need SYMHARIX_PUBLIC_BASE_URL or SYMHARIX_FEISHU_RUNTIME_TUNNEL=on.');
  }
  console.log('[symharix] feishu: configure Feishu Open Platform Events and Callbacks to use persistent connection.');
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
  const parsedStartArgs = parseStartLocalArgs(process.argv.slice(2));
  const botSurface = parsedStartArgs.surface;
  const args = parsedStartArgs.serviceArgs;
  const childEnv = { ...process.env } as Record<string, string | undefined>;
  syncSymHarixEnvAliases(childEnv);
  applyStartLocalBotSurfaceIsolation(childEnv, botSurface);
  const workflowPath = resolveWorkflowPath();
  const workflowLoad = loadWorkflow(workflowPath);
  const workflowServerPort = workflowLoad.success
    ? buildServiceConfig(workflowLoad.definition!).serverPort
    : null;
  const requestedPort = resolveStartLocalPort(args, childEnv, workflowServerPort);

  stopExistingSymHarixnessIfNeeded(requestedPort);
  if (botSurface === 'telegram' && readSymHarixEnvTrimmed('SYMPHONY_TELEGRAM_BOT_TOKEN', childEnv)) {
    await configureStartLocalProxyEnv(childEnv);
    configureStartLocalTelegramRetryEnv(childEnv);
  } else if (botSurface === 'feishu') {
    if (shouldProvisionStartLocalTunnel(childEnv, botSurface)) {
      await configureStartLocalProxyEnv(childEnv, 'Feishu runtime tunnel');
      if (
        !readSymHarixEnvTrimmed('SYMPHONY_TUNNEL_PROTOCOL', childEnv)
        && !readSymHarixEnvTrimmed('SYMPHONY_FEISHU_TUNNEL_PROTOCOL', childEnv)
      ) {
        setSymHarixEnv('SYMPHONY_FEISHU_TUNNEL_PROTOCOL', 'auto', childEnv);
        console.log(
          '[symharix] start:local using Feishu runtime tunnel protocol auto (set SYMHARIX_FEISHU_TUNNEL_PROTOCOL to override)',
        );
      }
    }
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

  const provisionTemporaryTunnel = async (options: {
    waitUntilReachable?: boolean;
  } = {}): Promise<TelegramTunnelHandle | null> => {
    const waitUntilReachable = options.waitUntilReachable ?? botSurface === 'feishu';
    const maxAttempts = resolvePositiveIntegerEnvAny(
      childEnv,
      botSurface === 'feishu'
        ? ['SYMPHONY_FEISHU_TUNNEL_RETRY_ATTEMPTS', 'SYMPHONY_TUNNEL_RETRY_ATTEMPTS', 'SYMPHONY_TELEGRAM_TUNNEL_RETRY_ATTEMPTS']
        : ['SYMPHONY_TUNNEL_RETRY_ATTEMPTS', 'SYMPHONY_TELEGRAM_TUNNEL_RETRY_ATTEMPTS'],
      3,
    );
    const retryDelayMs = resolvePositiveIntegerEnvAny(
      childEnv,
      botSurface === 'feishu'
        ? ['SYMPHONY_FEISHU_TUNNEL_RETRY_DELAY_MS', 'SYMPHONY_TUNNEL_RETRY_DELAY_MS', 'SYMPHONY_TELEGRAM_TUNNEL_RETRY_DELAY_MS']
        : ['SYMPHONY_TUNNEL_RETRY_DELAY_MS', 'SYMPHONY_TELEGRAM_TUNNEL_RETRY_DELAY_MS'],
      1500,
    );
    const tunnelTimeoutMs = resolvePositiveIntegerEnvAny(
      childEnv,
      botSurface === 'feishu'
        ? ['SYMPHONY_FEISHU_TUNNEL_TIMEOUT_MS', 'SYMPHONY_TUNNEL_TIMEOUT_MS', 'SYMPHONY_TELEGRAM_TUNNEL_TIMEOUT_MS']
        : ['SYMPHONY_TUNNEL_TIMEOUT_MS', 'SYMPHONY_TELEGRAM_TUNNEL_TIMEOUT_MS'],
      botSurface === 'feishu' ? 45_000 : 15_000,
    );
    let lastError: unknown = null;
    try {
      console.log(`[symharix] start:local provisioning temporary ${botSurface} tunnel...`);
      const localBaseUrl = `http://127.0.0.1:${requestedPort}`;
      const tunnelProvider = createCloudflaredTunnelProvider(undefined, tunnelTimeoutMs, childEnv);
      let nextTunnelHandle: TelegramTunnelHandle | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const candidateTunnelHandle = await tunnelProvider(localBaseUrl);
          if (botSurface === 'feishu' && waitUntilReachable) {
            try {
              await waitForTemporaryTunnelRegistration(candidateTunnelHandle.publicBaseUrl, childEnv);
            } catch (error) {
              await candidateTunnelHandle.dispose();
              throw error;
            }
          }
          nextTunnelHandle = candidateTunnelHandle;
          break;
        } catch (error) {
          lastError = error;
          if (isQuickTunnelRateLimitedError(error)) {
            console.warn(
              '[symharix] start:local Cloudflare Quick Tunnel is rate limited; skipping immediate retries to avoid extending the limit window.',
            );
            throw error;
          }
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

      console.log(`[symharix] start:local ${botSurface} tunnel ready: ${nextTunnelHandle.publicBaseUrl}`);
      console.log('[symharix] start:local using temporary tunnel only for this process; .env was not modified.');
      return nextTunnelHandle;
    } catch (error) {
      console.warn(
        `[symharix] start:local could not pre-provision ${botSurface} tunnel; falling back to normal startup.`,
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
      if (reason.startsWith('initial ')) {
        console.log(`[symharix] start:local preparing ${botSurface} tunnel. reason=${reason}`);
      } else {
        console.warn(`[symharix] start:local detected unhealthy ${botSurface} tunnel; recovering. reason=${reason}`);
      }
      if (botSurface === 'feishu') {
        await waitForLocalServiceStartup(requestedPort, childEnv);
      }
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
      const expectedPublicBaseUrl = readSymHarixEnvTrimmed('SYMPHONY_PUBLIC_BASE_URL', childEnv);
      if (botSurface === 'telegram') {
        void printTelegramStartupSummary(
          requestedPort,
          expectedPublicBaseUrl,
          resolveTelegramStartupSummaryAttempts(childEnv),
        );
      } else {
        if (expectedPublicBaseUrl) {
          try {
            await waitForLocalServiceStartup(requestedPort, childEnv);
            await waitForTemporaryTunnelRegistration(expectedPublicBaseUrl, childEnv);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[symharix] feishu: public Mini App tunnel is not reachable yet; runtime links may fail until it recovers. reason=${message}`);
          }
        }
        printFeishuStartupSummary(expectedPublicBaseUrl);
      }
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[symharix] start:local tunnel recovery failed: ${message}`);
    }).finally(() => {
      recoveryInFlight = null;
    });

    await recoveryInFlight;
  };

  const startTunnelWatchdog = (): void => {
    if (botSurface !== 'telegram') {
      return;
    }
    if (!shouldProvisionStartLocalTunnel(childEnv, botSurface)) {
      return;
    }
    const intervalMs = resolvePositiveIntegerEnvAny(
      childEnv,
      ['SYMPHONY_TUNNEL_WATCHDOG_INTERVAL_MS', 'SYMPHONY_TELEGRAM_TUNNEL_WATCHDOG_INTERVAL_MS'],
      10_000,
    );
    const degradedPollThreshold = resolvePositiveIntegerEnvAny(
      childEnv,
      ['SYMPHONY_TUNNEL_WATCHDOG_DEGRADED_POLLS', 'SYMPHONY_TELEGRAM_TUNNEL_WATCHDOG_DEGRADED_POLLS'],
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

        let recoveryReason: string | null = null;
        if (botSurface === 'telegram') {
          const telegram = await readTelegramManifestSnapshot(requestedPort);
          recoveryReason = telegram
            ? getStartLocalTunnelRecoveryReason(telegram, expectedPublicBaseUrl)
            : null;
        }
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

  const needsStartLocalTunnel = shouldProvisionStartLocalTunnel(childEnv, botSurface);
  if (needsStartLocalTunnel && (botSurface === 'telegram' || botSurface === 'feishu')) {
    tunnelHandle = await provisionTemporaryTunnel({
      waitUntilReachable: botSurface !== 'feishu',
    });
    if (tunnelHandle) {
      setSymHarixEnv('SYMPHONY_PUBLIC_BASE_URL', tunnelHandle.publicBaseUrl, childEnv);
    }
  }

  spawnServiceChild();
  let expectedPublicBaseUrl = readSymHarixEnvTrimmed('SYMPHONY_PUBLIC_BASE_URL', childEnv);
  if (botSurface === 'telegram') {
    void printTelegramStartupSummary(
      requestedPort,
      expectedPublicBaseUrl,
      resolveTelegramStartupSummaryAttempts(childEnv),
    );
  } else if (botSurface === 'feishu' && tunnelHandle && expectedPublicBaseUrl) {
    void (async () => {
      try {
        await waitForLocalServiceStartup(requestedPort, childEnv);
        await waitForTemporaryTunnelRegistration(expectedPublicBaseUrl, childEnv);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[symharix] feishu: public Mini App tunnel is not reachable yet; runtime links may fail until it recovers. reason=${message}`);
      }
      printFeishuStartupSummary(expectedPublicBaseUrl);
    })();
  } else {
    printFeishuStartupSummary(expectedPublicBaseUrl);
  }
  startTunnelWatchdog();
}

void main().catch((error) => {
  console.error('[symharix] start:local wrapper failed.');
  console.error(error);
  process.exit(1);
});
