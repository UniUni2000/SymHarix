import { describe, expect, mock, test } from 'bun:test';
import { createTelegramApiFetch } from './telegramHttp';

describe('createTelegramApiFetch', () => {
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
});
