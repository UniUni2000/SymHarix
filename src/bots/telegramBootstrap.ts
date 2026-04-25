import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

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
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

function buildWebhookUrl(baseUrl: string, inboundPath: string): string {
  const normalizedPath = inboundPath.startsWith('/') ? inboundPath : `/${inboundPath}`;
  return `${baseUrl}${normalizedPath}`;
}

async function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

export function createCloudflaredTunnelProvider(
  tunnelCommand: string = process.env.SYMPHONY_TELEGRAM_TUNNEL_COMMAND?.trim() || 'cloudflared',
  timeoutMs: number = 15_000,
): TelegramTunnelProvider {
  return async (localBaseUrl: string) => {
    return new Promise<TelegramTunnelHandle>((resolve, reject) => {
      let settled = false;
      const child = spawn(
        tunnelCommand,
        ['tunnel', '--url', localBaseUrl, '--no-autoupdate'],
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
        const match = chunk.match(/https:\/\/[a-z0-9.-]+trycloudflare\.com/i);
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
  private tunnelHandle: TelegramTunnelHandle | null = null;
  private activePublicBaseUrl: string | null = null;
  private activeWebhookUrl: string | null = null;
  private usedTunnel = false;

  constructor(private readonly options: TelegramWebhookBootstrapOptions) {
    this.fetcher = options.fetcher ?? defaultFetch;
    this.bootstrapMode = options.bootstrapMode ?? 'auto';
    this.tunnelProvider = options.tunnelProvider ?? createCloudflaredTunnelProvider();
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
    let usedTunnel = false;
    if (!publicBaseUrl) {
      this.tunnelHandle = await this.tunnelProvider(params.localBaseUrl);
      publicBaseUrl = normalizeBaseUrl(this.tunnelHandle.publicBaseUrl);
      usedTunnel = true;
    }

    if (!publicBaseUrl) {
      throw new Error('Telegram bootstrap could not resolve a public base URL');
    }

    const webhookUrl = buildWebhookUrl(publicBaseUrl, params.inboundPath);
    await this.callTelegram('setWebhook', {
      url: webhookUrl,
      secret_token: this.options.webhookSecret || undefined,
      allowed_updates: ['message', 'callback_query'],
    });

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
