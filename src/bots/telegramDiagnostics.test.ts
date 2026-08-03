import { describe, expect, test } from 'bun:test';
import { DefaultTelegramWebhookDiagnosticsService } from './telegramDiagnostics';

function webhookInfo(result: Record<string, unknown>): Response {
  return Response.json({ ok: true, result });
}

describe('DefaultTelegramWebhookDiagnosticsService', () => {
  test('does not keep a webhook degraded forever because Telegram retains an old error', async () => {
    const now = Date.parse('2026-08-03T06:00:00.000Z');
    const service = new DefaultTelegramWebhookDiagnosticsService(
      'telegram-token',
      (async () => webhookInfo({
        url: 'https://bot.example.test/api/v1/bots/telegram/webhook',
        pending_update_count: 0,
        last_error_message: 'Wrong response from the webhook: 530',
        last_error_date: Math.floor((now - 60 * 60 * 1000) / 1000),
      })) as typeof fetch,
      { now: () => now },
    );

    await service.refreshNow();

    expect(service.getSnapshot()).toMatchObject({
      health: 'healthy',
      webhook_error_recent: false,
      diagnostics_error_message: null,
    });
  });

  test('degrades on recent delivery errors and a sustained pending backlog', async () => {
    const now = Date.parse('2026-08-03T06:00:00.000Z');
    const recentError = new DefaultTelegramWebhookDiagnosticsService(
      'telegram-token',
      (async () => webhookInfo({
        url: 'https://bot.example.test/api/v1/bots/telegram/webhook',
        pending_update_count: 1,
        last_error_message: 'Connection timed out',
        last_error_date: Math.floor((now - 30_000) / 1000),
      })) as typeof fetch,
      { now: () => now },
    );
    await recentError.refreshNow();
    expect(recentError.getSnapshot()).toMatchObject({
      health: 'degraded',
      webhook_error_recent: true,
    });

    const backlog = new DefaultTelegramWebhookDiagnosticsService(
      'telegram-token',
      (async () => webhookInfo({
        url: 'https://bot.example.test/api/v1/bots/telegram/webhook',
        pending_update_count: 5,
      })) as typeof fetch,
      { now: () => now, pendingUpdateThreshold: 5 },
    );
    await backlog.refreshNow();
    expect(backlog.getSnapshot().health).toBe('degraded');
  });

  test('separates diagnostics network failures from Telegram delivery errors', async () => {
    let fail = false;
    const service = new DefaultTelegramWebhookDiagnosticsService(
      'telegram-token',
      (async () => {
        if (fail) throw new Error('network unavailable');
        return webhookInfo({
          url: 'https://bot.example.test/api/v1/bots/telegram/webhook',
          pending_update_count: 0,
        });
      }) as typeof fetch,
    );
    await service.refreshNow();
    fail = true;
    await service.refreshNow();

    expect(service.getSnapshot()).toMatchObject({
      health: 'degraded',
      webhook_url: 'https://bot.example.test/api/v1/bots/telegram/webhook',
      webhook_last_error_message: null,
      diagnostics_error_message: 'network unavailable',
    });
  });

  test('records any authenticated webhook update as recent ingress', () => {
    let now = Date.parse('2026-08-03T06:00:00.000Z');
    const service = new DefaultTelegramWebhookDiagnosticsService(
      'telegram-token',
      (async () => webhookInfo({})) as typeof fetch,
      { now: () => now },
    );

    service.recordIngressSuccess();
    expect(service.getSnapshot().webhook_ingress_recently_ok).toBe(true);
    now += 16 * 60 * 1000;
    expect(service.getSnapshot().webhook_ingress_recently_ok).toBe(false);
  });
});
