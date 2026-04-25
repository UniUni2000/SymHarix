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
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
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
});
