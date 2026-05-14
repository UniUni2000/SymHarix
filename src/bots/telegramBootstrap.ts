import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createDefaultTelegramApiFetch } from './telegramHttp';
import { readSymHarixEnv } from '../config/env';

export interface TelegramTunnelHandle {
  publicBaseUrl: string;
  dispose: () => Promise<void> | void;
}

export type TelegramTunnelProvider = (localBaseUrl: string) => Promise<TelegramTunnelHandle>;

export interface TelegramWebhookBootstrapResult {
  enabled: boolean;
  publicBaseUrl: string | null;
  webhookUrl: string | null;
  usedTunnel: boolean;
}

export interface TelegramWebhookBootstrapOptions {
  botToken: string | null;
  webhookSecret: string | null;
  publicBaseUrl?: string | null;
  bootstrapMode?: 'auto' | 'off';
  tunnelProvider?: TelegramTunnelProvider;
  fetcher?: typeof fetch;
  retryDelayMs?: number;
  retryAttempts?: number;
  webhookRetryDelayMs?: number;
  webhookRetryAttempts?: number;
  tunnelReadyDelayMs?: number;
  tunnelReadyAttempts?: number;
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

function isTryCloudflareUrl(value: string | null | undefined): boolean {
  return Boolean(value && /^https:\/\/[a-z0-9.-]+trycloudflare\.com$/i.test(value));
}

function buildWebhookUrl(baseUrl: string, inboundPath: string): string {
  const normalizedPath = inboundPath.startsWith('/') ? inboundPath : `/${inboundPath}`;
  return `${baseUrl}${normalizedPath}`;
}

async function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return createDefaultTelegramApiFetch()(input, init);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveIntegerEnv(name: string): number | null {
  const parsed = Number.parseInt(readSymHarixEnv(name) || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isRetryableTunnelWebhookError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /setWebhook failed/i.test(message) && /failed to resolve host|host.*not known|dns|timed out|connection reset|fetch failed|network error/i.test(message);
}

export function createCloudflaredTunnelProvider(
  tunnelCommand: string = readSymHarixEnv('SYMPHONY_TELEGRAM_TUNNEL_COMMAND')?.trim() || 'cloudflared',
  timeoutMs: number = 15_000,
): TelegramTunnelProvider {
  return async (localBaseUrl: string) => {
    return new Promise<TelegramTunnelHandle>((resolve, reject) => {
      let settled = false;
      const protocol = readSymHarixEnv('SYMPHONY_TELEGRAM_TUNNEL_PROTOCOL')?.trim() || 'http2';
      const child = spawn(
        tunnelCommand,
        ['tunnel', '--url', localBaseUrl, '--protocol', protocol, '--no-autoupdate'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        },
      );

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        callback();
      };

      const tryExtractUrl = (chunk: string): void => {
        const match = chunk.match(/https:\/\/(?!api\.)[a-z0-9.-]+trycloudflare\.com/i);
        if (!match?.[0]) {
          return;
        }
        const publicBaseUrl = normalizeBaseUrl(match[0]);
        if (!publicBaseUrl) {
          return;
        }
        finish(() => {
          resolve({
            publicBaseUrl,
            dispose: async () => {
              await terminateChild(child);
            },
          });
        });
      };

      child.stdout.on('data', (chunk) => tryExtractUrl(String(chunk)));
      child.stderr.on('data', (chunk) => tryExtractUrl(String(chunk)));

      child.once('error', (error) => {
        finish(() => reject(error));
      });
      child.once('exit', (code, signal) => {
        finish(() => reject(new Error(
          `cloudflared tunnel exited before publishing a URL (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        )));
      });

      const timeoutHandle = setTimeout(() => {
        finish(() => {
          void terminateChild(child);
          reject(new Error(`Timed out waiting for ${tunnelCommand} to publish a public URL`));
        });
      }, timeoutMs);
    });
  };
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 2_000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

export class TelegramWebhookBootstrapService {
  private readonly fetcher: typeof fetch;
  private readonly bootstrapMode: 'auto' | 'off';
  private readonly tunnelProvider: TelegramTunnelProvider;
  private readonly retryDelayMs: number;
  private readonly retryAttempts: number;
  private readonly webhookRetryDelayMs: number;
  private readonly webhookRetryAttempts: number;
  private readonly tunnelReadyDelayMs: number;
  private readonly tunnelReadyAttempts: number;
  private tunnelHandle: TelegramTunnelHandle | null = null;
  private activePublicBaseUrl: string | null = null;
  private activeWebhookUrl: string | null = null;
  private usedTunnel = false;

  constructor(private readonly options: TelegramWebhookBootstrapOptions) {
    this.fetcher = options.fetcher ?? defaultFetch;
    this.bootstrapMode = options.bootstrapMode ?? 'auto';
    this.tunnelProvider = options.tunnelProvider ?? createCloudflaredTunnelProvider();
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_500);
    this.retryAttempts = Math.max(1, options.retryAttempts ?? 3);
    this.webhookRetryDelayMs = Math.max(
      0,
      options.webhookRetryDelayMs
        ?? options.retryDelayMs
        ?? parsePositiveIntegerEnv('SYMPHONY_TELEGRAM_WEBHOOK_RETRY_DELAY_MS')
        ?? 5_000,
    );
    this.webhookRetryAttempts = Math.max(
      1,
      options.webhookRetryAttempts
        ?? options.retryAttempts
        ?? parsePositiveIntegerEnv('SYMPHONY_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS')
        ?? 30,
    );
    this.tunnelReadyDelayMs = Math.max(0, options.tunnelReadyDelayMs ?? 1_000);
    this.tunnelReadyAttempts = Math.max(1, options.tunnelReadyAttempts ?? 10);
  }

  async bootstrap(params: {
    localBaseUrl: string;
    inboundPath: string;
  }): Promise<TelegramWebhookBootstrapResult> {
    if (!this.options.botToken || this.bootstrapMode === 'off') {
      return {
        enabled: false,
        publicBaseUrl: null,
        webhookUrl: null,
        usedTunnel: false,
      };
    }

    if (this.activePublicBaseUrl && this.activeWebhookUrl) {
      return {
        enabled: true,
        publicBaseUrl: this.activePublicBaseUrl,
        webhookUrl: this.activeWebhookUrl,
        usedTunnel: this.usedTunnel,
      };
    }

    let publicBaseUrl = normalizeBaseUrl(this.options.publicBaseUrl);
    const configuredTryCloudflare = Boolean(publicBaseUrl && isTryCloudflareUrl(publicBaseUrl));
    const usedTunnel = !publicBaseUrl || configuredTryCloudflare;
    if (!publicBaseUrl) {
      publicBaseUrl = await this.createReachableTunnel(params.localBaseUrl);
    }

    if (configuredTryCloudflare && publicBaseUrl) {
      try {
        await this.waitForTunnelReachability(publicBaseUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[telegram-bootstrap] Public trycloudflare URL probe failed; continuing with Telegram setWebhook retry: ${message}`,
        );
      }
    }

    if (!publicBaseUrl) {
      throw new Error('Telegram bootstrap could not resolve a public base URL');
    }

    const webhookUrl = buildWebhookUrl(publicBaseUrl, params.inboundPath);
    await this.setWebhookWithRetry(webhookUrl, usedTunnel);

    this.activePublicBaseUrl = publicBaseUrl;
    this.activeWebhookUrl = webhookUrl;
    this.usedTunnel = usedTunnel;

    return {
      enabled: true,
      publicBaseUrl,
      webhookUrl,
      usedTunnel,
    };
  }

  async dispose(): Promise<void> {
    if (this.activeWebhookUrl && this.usedTunnel && this.options.botToken) {
      try {
        await this.callTelegram('deleteWebhook', {
          drop_pending_updates: false,
        });
      } catch {
        // Best-effort cleanup; do not block shutdown on Telegram ingress cleanup.
      }
    }

    if (this.tunnelHandle) {
      await this.tunnelHandle.dispose();
    }
    this.tunnelHandle = null;
    this.activePublicBaseUrl = null;
    this.activeWebhookUrl = null;
    this.usedTunnel = false;
  }

  private async createReachableTunnel(localBaseUrl: string): Promise<string> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      let tunnelHandle: TelegramTunnelHandle;
      try {
        tunnelHandle = await this.tunnelProvider(localBaseUrl);
      } catch (error) {
        lastError = error;
        if (attempt >= this.retryAttempts) {
          break;
        }
        await sleep(this.retryDelayMs);
        continue;
      }
      const publicBaseUrl = normalizeBaseUrl(tunnelHandle.publicBaseUrl);
      if (!publicBaseUrl) {
        await tunnelHandle.dispose();
        throw new Error('Telegram tunnel provider returned an empty public URL');
      }

      try {
        await this.waitForTunnelReachability(publicBaseUrl);
        this.tunnelHandle = tunnelHandle;
        return publicBaseUrl;
      } catch (error) {
        lastError = error;
        await tunnelHandle.dispose();
        if (attempt >= this.retryAttempts) {
          break;
        }
        await sleep(this.retryDelayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Telegram bootstrap could not create a reachable tunnel');
  }

  private async setWebhookWithRetry(webhookUrl: string, usedTunnel: boolean): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.webhookRetryAttempts; attempt += 1) {
      try {
        await this.callTelegram('setWebhook', {
          url: webhookUrl,
          secret_token: this.options.webhookSecret || undefined,
          allowed_updates: ['message', 'callback_query'],
        });
        return;
      } catch (error) {
        lastError = error;
        const shouldRetry = usedTunnel
          && attempt < this.webhookRetryAttempts
          && isRetryableTunnelWebhookError(error);
        if (!shouldRetry) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[telegram-bootstrap] setWebhook failed; retrying ${attempt}/${this.webhookRetryAttempts}: ${message}`,
        );
        await sleep(this.webhookRetryDelayMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async waitForTunnelReachability(publicBaseUrl: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.tunnelReadyAttempts; attempt += 1) {
      try {
        const response = await this.fetcher(publicBaseUrl, {
          method: 'GET',
        });
        if (response.status >= 500) {
          throw new Error(`Telegram tunnel URL is not ready yet (status ${response.status})`);
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= this.tunnelReadyAttempts) {
          break;
        }
        await sleep(this.tunnelReadyDelayMs);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Timed out waiting for Telegram tunnel URL to become reachable: ${publicBaseUrl}`);
  }

  private async callTelegram(method: 'setWebhook' | 'deleteWebhook', payload: Record<string, unknown>): Promise<void> {
    if (!this.options.botToken) {
      throw new Error('Telegram bot token is not configured');
    }

    const response = await this.fetcher(
      `https://api.telegram.org/bot${this.options.botToken}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );

    if (response.ok) {
      return;
    }

    const body = await response.text().catch(() => '');
    throw new Error(`Telegram ${method} failed with status ${response.status}: ${body}`);
  }
}
