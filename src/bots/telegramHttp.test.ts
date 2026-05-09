import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createDefaultTelegramApiFetch, createTelegramApiFetch, createTelegramProxyAwareFetch } from './telegramHttp';

describe('createTelegramApiFetch', () => {
  const originalEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    SYMPHONY_TELEGRAM_DISABLE_PROXY: process.env.SYMPHONY_TELEGRAM_DISABLE_PROXY,
  };

  afterEach(() => {
    process.env.HTTP_PROXY = originalEnv.HTTP_PROXY;
    process.env.HTTPS_PROXY = originalEnv.HTTPS_PROXY;
    process.env.http_proxy = originalEnv.http_proxy;
    process.env.https_proxy = originalEnv.https_proxy;
    process.env.SYMPHONY_TELEGRAM_DISABLE_PROXY = originalEnv.SYMPHONY_TELEGRAM_DISABLE_PROXY;
  });

  test('falls back when Bun fetch hits a Telegram certificate verification error', async () => {
    const primaryFetch = mock(async () => {
      throw new Error('unknown certificate verification error');
    });
    const fallbackFetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const telegramFetch = createTelegramApiFetch(
      primaryFetch as unknown as typeof fetch,
      fallbackFetch as unknown as typeof fetch,
    );

    const response = await telegramFetch('https://api.telegram.org/bottoken/getWebhookInfo');

    expect(response.status).toBe(200);
    expect(primaryFetch).toHaveBeenCalledTimes(1);
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
  });

  test('does not fall back for non Telegram URLs', async () => {
    const primaryFetch = mock(async () => {
      throw new Error('unknown certificate verification error');
    });
    const fallbackFetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const telegramFetch = createTelegramApiFetch(
      primaryFetch as unknown as typeof fetch,
      fallbackFetch as unknown as typeof fetch,
    );

    await expect(telegramFetch('https://example.com')).rejects.toThrow('unknown certificate verification error');
    expect(fallbackFetch).toHaveBeenCalledTimes(0);
  });

  test('falls back for Telegram network errors', async () => {
    const primaryFetch = mock(async () => {
      throw new Error('connection reset by peer');
    });
    const fallbackFetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const telegramFetch = createTelegramApiFetch(
      primaryFetch as unknown as typeof fetch,
      fallbackFetch as unknown as typeof fetch,
    );

    const response = await telegramFetch('https://api.telegram.org/bottoken/getWebhookInfo');

    expect(response.status).toBe(200);
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
  });

  test('does not retry visible Telegram send methods after an ambiguous network error', async () => {
    const primaryFetch = mock(async () => {
      throw new Error('connection reset by peer');
    });
    const fallbackFetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const telegramFetch = createTelegramApiFetch(
      primaryFetch as unknown as typeof fetch,
      fallbackFetch as unknown as typeof fetch,
    );

    await expect(telegramFetch('https://api.telegram.org/bottoken/sendMessage', {
      method: 'POST',
      body: JSON.stringify({ chat_id: '1', text: 'hello' }),
    })).rejects.toThrow('connection reset by peer');
    expect(primaryFetch).toHaveBeenCalledTimes(1);
    expect(fallbackFetch).toHaveBeenCalledTimes(0);
  });

  test('does not fall back for unrelated Telegram fetch errors', async () => {
    const primaryFetch = mock(async () => {
      throw new Error('request body is invalid');
    });
    const fallbackFetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const telegramFetch = createTelegramApiFetch(
      primaryFetch as unknown as typeof fetch,
      fallbackFetch as unknown as typeof fetch,
    );

    await expect(telegramFetch('https://api.telegram.org/bottoken/getWebhookInfo')).rejects.toThrow('request body is invalid');
    expect(fallbackFetch).toHaveBeenCalledTimes(0);
  });

  test('proxy disable flag still lets non-Telegram requests use the normal fetch chain', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
    process.env.SYMPHONY_TELEGRAM_DISABLE_PROXY = '1';

    const originalFetch = globalThis.fetch;
    const runtimeFetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    globalThis.fetch = runtimeFetch as unknown as typeof fetch;

    const fetcher = createDefaultTelegramApiFetch();
    const response = await fetcher('https://example.com');

    expect(response.status).toBe(200);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    globalThis.fetch = originalFetch;
  });

  test('proxy-aware Telegram fetch falls back to the direct chain when a read-only Telegram request times out', async () => {
    const proxyFetch = mock(async () => {
      throw new Error('curl: (28) Connection timed out after 15004 milliseconds');
    });
    const fallbackFetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const telegramFetch = createTelegramProxyAwareFetch(
      proxyFetch as unknown as typeof fetch,
      fallbackFetch as unknown as typeof fetch,
    );

    const response = await telegramFetch('https://api.telegram.org/bottoken/getWebhookInfo');

    expect(response.status).toBe(200);
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
  });

  test('proxy-aware Telegram fetch does not hide non-network proxy transport errors', async () => {
    const proxyFetch = mock(async () => {
      throw new Error('request body is invalid');
    });
    const fallbackFetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const telegramFetch = createTelegramProxyAwareFetch(
      proxyFetch as unknown as typeof fetch,
      fallbackFetch as unknown as typeof fetch,
    );

    await expect(telegramFetch('https://api.telegram.org/bottoken/sendMessage')).rejects.toThrow('request body is invalid');
    expect(fallbackFetch).toHaveBeenCalledTimes(0);
  });
});
