import { afterEach, describe, expect, mock, test } from 'bun:test';
import { TelegramWebhookBootstrapService } from './telegramBootstrap';

describe('TelegramWebhookBootstrapService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('registers a Telegram webhook against a configured public base URL', async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    globalThis.fetch = fetcher as typeof globalThis.fetch;

    const service = new TelegramWebhookBootstrapService({
      botToken: 'telegram-token',
      webhookSecret: 'secret',
      publicBaseUrl: 'https://bot.example.test/',
      tunnelProvider: async () => {
        throw new Error('tunnel should not be used when a public base URL is configured');
      },
    });

    const result = await service.bootstrap({
      localBaseUrl: 'http://127.0.0.1:8080',
      inboundPath: '/api/v1/bots/telegram/webhook',
    });

    expect(result).toEqual({
      enabled: true,
      publicBaseUrl: 'https://bot.example.test',
      webhookUrl: 'https://bot.example.test/api/v1/bots/telegram/webhook',
      usedTunnel: false,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.telegram.org/bottelegram-token/setWebhook',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  test('creates a tunnel automatically when no public base URL is configured and deletes the webhook on dispose', async () => {
    const fetcher = mock(async (input: string) => {
      if (input.endsWith('/setWebhook')) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      if (input.endsWith('/deleteWebhook')) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      return new Response('tunnel ready', { status: 200 });
    });
    globalThis.fetch = fetcher as typeof globalThis.fetch;

    const disposeTunnel = mock(async () => undefined);
    const service = new TelegramWebhookBootstrapService({
      botToken: 'telegram-token',
      webhookSecret: 'secret',
      publicBaseUrl: null,
      tunnelProvider: mock(async () => ({
        publicBaseUrl: 'https://autogen.trycloudflare.com',
        dispose: disposeTunnel,
      })),
    });

    const result = await service.bootstrap({
      localBaseUrl: 'http://127.0.0.1:8080',
      inboundPath: '/api/v1/bots/telegram/webhook',
    });

    expect(result).toEqual({
      enabled: true,
      publicBaseUrl: 'https://autogen.trycloudflare.com',
      webhookUrl: 'https://autogen.trycloudflare.com/api/v1/bots/telegram/webhook',
      usedTunnel: true,
    });

    await service.dispose();

    expect(disposeTunnel).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.telegram.org/bottelegram-token/deleteWebhook',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  test('retries setWebhook when the fresh tunnel host is not yet resolvable', async () => {
    let attempts = 0;
    const fetcher = mock(async (input: string) => {
      if (input.endsWith('/setWebhook')) {
        attempts += 1;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: 'Bad Request: bad webhook: Failed to resolve host: Name or service not known',
            }),
            { status: 400 },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    globalThis.fetch = fetcher as typeof globalThis.fetch;

    const service = new TelegramWebhookBootstrapService({
      botToken: 'telegram-token',
      webhookSecret: 'secret',
      publicBaseUrl: null,
      retryDelayMs: 0,
      retryAttempts: 2,
      tunnelProvider: mock(async () => ({
        publicBaseUrl: 'https://autogen.trycloudflare.com',
        dispose: async () => undefined,
      })),
    });

    const result = await service.bootstrap({
      localBaseUrl: 'http://127.0.0.1:8080',
      inboundPath: '/api/v1/bots/telegram/webhook',
    });

    expect(result).toEqual({
      enabled: true,
      publicBaseUrl: 'https://autogen.trycloudflare.com',
      webhookUrl: 'https://autogen.trycloudflare.com/api/v1/bots/telegram/webhook',
      usedTunnel: true,
    });
    expect(attempts).toBe(2);
  });

  test('waits for the public tunnel URL to become reachable before calling setWebhook', async () => {
    const calls: string[] = [];
    let probeAttempts = 0;
    const fetcher = mock(async (input: string) => {
      calls.push(input);
      if (input === 'https://autogen.trycloudflare.com') {
        probeAttempts += 1;
        if (probeAttempts < 3) {
          throw new Error('dns not ready');
        }
        return new Response('ok', { status: 200 });
      }
      if (input.endsWith('/setWebhook')) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    globalThis.fetch = fetcher as typeof globalThis.fetch;

    const service = new TelegramWebhookBootstrapService({
      botToken: 'telegram-token',
      webhookSecret: 'secret',
      publicBaseUrl: null,
      fetcher: fetcher as unknown as typeof fetch,
      retryDelayMs: 0,
      retryAttempts: 1,
      tunnelReadyDelayMs: 0,
      tunnelReadyAttempts: 3,
      tunnelProvider: mock(async () => ({
        publicBaseUrl: 'https://autogen.trycloudflare.com',
        dispose: async () => undefined,
      })),
    });

    await service.bootstrap({
      localBaseUrl: 'http://127.0.0.1:8080',
      inboundPath: '/api/v1/bots/telegram/webhook',
    });

    expect(probeAttempts).toBe(3);
    expect(calls.at(-1)).toBe('https://api.telegram.org/bottelegram-token/setWebhook');
  });

  test('treats Cloudflare 5xx tunnel probes as not ready before setting webhook', async () => {
    const calls: string[] = [];
    let probeAttempts = 0;
    const fetcher = mock(async (input: string) => {
      calls.push(input);
      if (input === 'https://autogen.trycloudflare.com') {
        probeAttempts += 1;
        if (probeAttempts === 1) {
          return new Response('cloudflare tunnel error', { status: 530 });
        }
        return new Response('not found but tunnel is reachable', { status: 404 });
      }
      if (input.endsWith('/setWebhook')) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    const service = new TelegramWebhookBootstrapService({
      botToken: 'telegram-token',
      webhookSecret: 'secret',
      publicBaseUrl: null,
      fetcher: fetcher as unknown as typeof fetch,
      retryDelayMs: 0,
      retryAttempts: 1,
      tunnelReadyDelayMs: 0,
      tunnelReadyAttempts: 2,
      tunnelProvider: mock(async () => ({
        publicBaseUrl: 'https://autogen.trycloudflare.com',
        dispose: async () => undefined,
      })),
    });

    await service.bootstrap({
      localBaseUrl: 'http://127.0.0.1:8080',
      inboundPath: '/api/v1/bots/telegram/webhook',
    });

    expect(probeAttempts).toBe(2);
    expect(calls).toEqual([
      'https://autogen.trycloudflare.com',
      'https://autogen.trycloudflare.com',
      'https://api.telegram.org/bottelegram-token/setWebhook',
    ]);
  });

  test('recreates the tunnel when a published Cloudflare URL stays unavailable', async () => {
    const calls: string[] = [];
    const disposed: string[] = [];
    const tunnelProvider = mock(async () => {
      const index = tunnelProvider.mock.calls.length;
      const publicBaseUrl = index === 1
        ? 'https://bad.trycloudflare.com'
        : 'https://good.trycloudflare.com';
      return {
        publicBaseUrl,
        dispose: async () => {
          disposed.push(publicBaseUrl);
        },
      };
    });
    const fetcher = mock(async (input: string) => {
      calls.push(input);
      if (input === 'https://bad.trycloudflare.com') {
        return new Response('cloudflare tunnel error', { status: 530 });
      }
      if (input === 'https://good.trycloudflare.com') {
        return new Response('ready', { status: 200 });
      }
      if (input.endsWith('/setWebhook')) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });

    const service = new TelegramWebhookBootstrapService({
      botToken: 'telegram-token',
      webhookSecret: 'secret',
      publicBaseUrl: null,
      fetcher: fetcher as unknown as typeof fetch,
      retryDelayMs: 0,
      retryAttempts: 2,
      tunnelReadyDelayMs: 0,
      tunnelReadyAttempts: 1,
      tunnelProvider,
    });

    const result = await service.bootstrap({
      localBaseUrl: 'http://127.0.0.1:8080',
      inboundPath: '/api/v1/bots/telegram/webhook',
    });

    expect(result.webhookUrl).toBe('https://good.trycloudflare.com/api/v1/bots/telegram/webhook');
    expect(disposed).toEqual(['https://bad.trycloudflare.com']);
    expect(calls).toEqual([
      'https://bad.trycloudflare.com',
      'https://good.trycloudflare.com',
      'https://api.telegram.org/bottelegram-token/setWebhook',
    ]);
  });
});
