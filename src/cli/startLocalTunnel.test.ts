import { describe, expect, test } from 'bun:test';
import {
  applyStartLocalBotSurfaceIsolation,
  buildTelegramStartupSummary,
  getStartLocalTunnelProbeRecoveryReason,
  getStartLocalTunnelRegistrationWaitReason,
  getStartLocalTunnelRecoveryReason,
  resolveStartLocalPort,
  shouldEmitTelegramStartupSummary,
  shouldProvisionStartLocalTunnel,
  upsertEnvAssignment,
} from './startLocalTunnel';

describe('startLocalTunnel', () => {
  test('isolates Feishu local startup from Telegram credentials and operations chats', () => {
    const env: Record<string, string | undefined> = {
      SYMHARIX_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMPHONY_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMHARIX_TELEGRAM_OPERATIONS_CHAT_ID: 'telegram-ops',
      SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID: 'telegram-ops',
      SYMHARIX_FEISHU_APP_ID: 'cli_a',
      SYMHARIX_FEISHU_APP_SECRET: 'secret',
    };

    applyStartLocalBotSurfaceIsolation(env, 'feishu');

    expect(env.SYMHARIX_TELEGRAM_BOT_TOKEN).toBe('');
    expect(env.SYMPHONY_TELEGRAM_BOT_TOKEN).toBe('');
    expect(env.SYMHARIX_TELEGRAM_OPERATIONS_CHAT_ID).toBe('');
    expect(env.SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID).toBe('');
    expect(env.SYMHARIX_TELEGRAM_BOOTSTRAP).toBe('off');
    expect(env.SYMHARIX_FEISHU_APP_ID).toBe('cli_a');
  });

  test('isolates Telegram local startup from Feishu credentials and operations chats', () => {
    const env: Record<string, string | undefined> = {
      SYMHARIX_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMHARIX_FEISHU_APP_ID: 'cli_a',
      SYMPHONY_FEISHU_APP_ID: 'cli_a',
      SYMHARIX_FEISHU_APP_SECRET: 'secret',
      SYMPHONY_FEISHU_APP_SECRET: 'secret',
      SYMHARIX_FEISHU_OPERATIONS_CHAT_ID: 'feishu-ops',
      SYMPHONY_FEISHU_OPERATIONS_CHAT_ID: 'feishu-ops',
    };

    applyStartLocalBotSurfaceIsolation(env, 'telegram');

    expect(env.SYMHARIX_TELEGRAM_BOT_TOKEN).toBe('telegram-token');
    expect(env.SYMHARIX_FEISHU_APP_ID).toBe('');
    expect(env.SYMPHONY_FEISHU_APP_ID).toBe('');
    expect(env.SYMHARIX_FEISHU_APP_SECRET).toBe('');
    expect(env.SYMPHONY_FEISHU_APP_SECRET).toBe('');
    expect(env.SYMHARIX_FEISHU_OPERATIONS_CHAT_ID).toBe('');
    expect(env.SYMPHONY_FEISHU_OPERATIONS_CHAT_ID).toBe('');
  });

  test('provisions a temporary tunnel when Telegram bootstrap is enabled and no public base URL is configured', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMPHONY_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMPHONY_PUBLIC_BASE_URL: '',
    })).toBe(true);
  });

  test('accepts SYMHARIX aliases for tunnel provisioning config', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMHARIX_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMHARIX_PUBLIC_BASE_URL: '',
    })).toBe(true);
  });

  test('provisions a runtime tunnel for Feishu AppLink web URL mode by default', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMPHONY_FEISHU_APP_ID: 'cli_a',
      SYMPHONY_FEISHU_APP_SECRET: 'secret',
      SYMPHONY_PUBLIC_BASE_URL: '',
    }, 'feishu')).toBe(true);
  });

  test('provisions a runtime tunnel for Feishu AppLink web URL mode', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMPHONY_FEISHU_APP_ID: 'cli_a',
      SYMPHONY_FEISHU_APP_SECRET: 'secret',
      SYMPHONY_FEISHU_RUNTIME_OPEN_MODE: 'applink_web_url',
      SYMPHONY_PUBLIC_BASE_URL: '',
    }, 'feishu')).toBe(true);
  });

  test('accepts SYMHARIX aliases for Feishu runtime tunnel provisioning', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMHARIX_FEISHU_APP_ID: 'cli_a',
      SYMHARIX_FEISHU_APP_SECRET: 'secret',
      SYMHARIX_FEISHU_RUNTIME_OPEN_MODE: 'applink_web_url',
      SYMHARIX_PUBLIC_BASE_URL: '',
    }, 'feishu')).toBe(true);
  });

  test('supports explicit Feishu runtime tunnel mode for URL links', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMPHONY_FEISHU_APP_ID: 'cli_a',
      SYMPHONY_FEISHU_APP_SECRET: 'secret',
      SYMPHONY_FEISHU_RUNTIME_OPEN_MODE: 'url',
      SYMPHONY_FEISHU_RUNTIME_TUNNEL: 'on',
      SYMPHONY_PUBLIC_BASE_URL: '',
    }, 'feishu')).toBe(true);
  });

  test('skips Feishu runtime tunnel provisioning when disabled', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMPHONY_FEISHU_APP_ID: 'cli_a',
      SYMPHONY_FEISHU_APP_SECRET: 'secret',
      SYMPHONY_FEISHU_RUNTIME_OPEN_MODE: 'applink_web_url',
      SYMPHONY_FEISHU_RUNTIME_TUNNEL: 'off',
      SYMPHONY_PUBLIC_BASE_URL: '',
    }, 'feishu')).toBe(false);
  });

  test('skips temporary tunnel provisioning when a public base URL is already configured', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMPHONY_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMPHONY_PUBLIC_BASE_URL: 'https://bot.example.test',
    })).toBe(false);
  });

  test('re-provisions temporary tunnels when the configured public base URL is a stale trycloudflare url', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMPHONY_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMPHONY_PUBLIC_BASE_URL: 'https://stale-demo.trycloudflare.com',
    })).toBe(true);
  });

  test('skips temporary tunnel provisioning when Telegram bootstrap is disabled', () => {
    expect(shouldProvisionStartLocalTunnel({
      SYMPHONY_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMPHONY_TELEGRAM_BOOTSTRAP: 'off',
      SYMPHONY_PUBLIC_BASE_URL: '',
    })).toBe(false);
  });

  test('upserts an existing public base URL assignment in .env content', () => {
    const result = upsertEnvAssignment(
      'FOO=bar\nSYMPHONY_PUBLIC_BASE_URL=\nBAZ=qux\n',
      'SYMPHONY_PUBLIC_BASE_URL',
      'https://fresh.trycloudflare.com',
    );

    expect(result).toBe(
      'FOO=bar\nSYMPHONY_PUBLIC_BASE_URL=https://fresh.trycloudflare.com\nBAZ=qux\n',
    );
  });

  test('appends a missing public base URL assignment to .env content', () => {
    const result = upsertEnvAssignment(
      'FOO=bar\n',
      'SYMPHONY_PUBLIC_BASE_URL',
      'https://fresh.trycloudflare.com',
    );

    expect(result).toBe(
      'FOO=bar\nSYMPHONY_PUBLIC_BASE_URL=https://fresh.trycloudflare.com\n',
    );
  });

  test('resolves the requested local port from cli arguments before env', () => {
    expect(resolveStartLocalPort(['--port', '4123'], { PORT: '3000' })).toBe(4123);
    expect(resolveStartLocalPort(['--port=5123'], { PORT: '3000' })).toBe(5123);
  });

  test('falls back to PORT env and then to the default local port', () => {
    expect(resolveStartLocalPort([], { PORT: '4333' })).toBe(4333);
    expect(resolveStartLocalPort([], {})).toBe(3000);
  });

  test('prefers workflow server port when no cli or PORT override is present', () => {
    expect(resolveStartLocalPort([], {}, 8080)).toBe(8080);
  });

  test('builds a concise telegram startup summary with webhook url when present', () => {
    expect(buildTelegramStartupSummary({
      health: 'healthy',
      webhook_url: 'https://bot.example.test/api/v1/bots/telegram/webhook',
    })).toBe(
      'telegram: healthy webhook_url=https://bot.example.test/api/v1/bots/telegram/webhook',
    );
  });

  test('builds a concise telegram startup summary without a webhook url', () => {
    expect(buildTelegramStartupSummary({
      health: 'unconfigured',
      webhook_url: null,
    })).toBe('telegram: unhealthy webhook_url=(none)');
  });

  test('includes webhook error details in the telegram startup summary when present', () => {
    expect(buildTelegramStartupSummary({
      health: 'degraded',
      webhook_url: null,
      webhook_last_error_message: 'Failed to resolve host',
    })).toBe('telegram: unhealthy webhook_url=(none) error=Failed to resolve host');
  });

  test('waits to emit the telegram startup summary until webhook state is meaningful', () => {
    expect(shouldEmitTelegramStartupSummary({
      health: 'unconfigured',
      webhook_url: null,
      webhook_last_error_message: null,
    })).toBe(false);

    expect(shouldEmitTelegramStartupSummary({
      health: 'degraded',
      webhook_url: 'https://bot.example.test/api/v1/bots/telegram/webhook',
      webhook_last_error_message: null,
    })).toBe(true);

    expect(shouldEmitTelegramStartupSummary({
      health: 'degraded',
      webhook_url: null,
      webhook_last_error_message: 'unknown certificate verification error',
    })).toBe(true);
  });

  test('emits startup summary when webhook state is stale for the expected public base url', () => {
    expect(shouldEmitTelegramStartupSummary({
      health: 'healthy',
      webhook_url: 'https://old.trycloudflare.com/api/v1/bots/telegram/webhook',
      webhook_last_error_message: null,
      public_base_url: 'https://old.trycloudflare.com',
    }, 'https://fresh.trycloudflare.com')).toBe(true);

    expect(shouldEmitTelegramStartupSummary({
      health: 'healthy',
      webhook_url: 'https://fresh.trycloudflare.com/api/v1/bots/telegram/webhook',
      webhook_last_error_message: null,
      public_base_url: 'https://fresh.trycloudflare.com',
    }, 'https://fresh.trycloudflare.com')).toBe(true);
  });

  test('emits startup summary when webhook_url still points at the previous public base url', () => {
    expect(shouldEmitTelegramStartupSummary({
      health: 'healthy',
      webhook_url: 'https://old.trycloudflare.com/api/v1/bots/telegram/webhook',
      webhook_last_error_message: null,
      public_base_url: 'https://fresh.trycloudflare.com',
    }, 'https://fresh.trycloudflare.com')).toBe(true);
  });

  test('labels stale webhook summaries with the expected public base url', () => {
    expect(buildTelegramStartupSummary({
      health: 'healthy',
      webhook_url: 'https://old.trycloudflare.com/api/v1/bots/telegram/webhook',
      webhook_last_error_message: null,
      public_base_url: 'https://fresh.trycloudflare.com',
    }, 'https://fresh.trycloudflare.com')).toBe(
      'telegram: stale webhook_url=https://old.trycloudflare.com/api/v1/bots/telegram/webhook expected_base=https://fresh.trycloudflare.com',
    );
  });

  test('requests local tunnel recovery when Telegram reports a Cloudflare 530 webhook error', () => {
    expect(getStartLocalTunnelRecoveryReason({
      health: 'degraded',
      webhook_url: 'https://fresh.trycloudflare.com/api/v1/bots/telegram/webhook',
      webhook_last_error_message: 'Wrong response from the webhook: 530 <none>',
      webhook_pending_update_count: 1,
      public_base_url: 'https://fresh.trycloudflare.com',
    }, 'https://fresh.trycloudflare.com')).toBe(
      'telegram webhook degraded: Wrong response from the webhook: 530 <none>',
    );
  });

  test('does not request local tunnel recovery for a stable non-tunnel public URL', () => {
    expect(getStartLocalTunnelRecoveryReason({
      health: 'degraded',
      webhook_url: 'https://bot.example.test/api/v1/bots/telegram/webhook',
      webhook_last_error_message: 'Wrong response from the webhook: 530 <none>',
      webhook_pending_update_count: 1,
      public_base_url: 'https://bot.example.test',
    }, 'https://bot.example.test')).toBeNull();
  });

  test('requests local tunnel recovery when the public trycloudflare probe returns 530', () => {
    expect(getStartLocalTunnelProbeRecoveryReason({
      expectedPublicBaseUrl: 'https://fresh.trycloudflare.com',
      status: 530,
    })).toBe('public tunnel unreachable: status 530');
  });

  test('does not request probe recovery for reachable or stable non-tunnel URLs', () => {
    expect(getStartLocalTunnelProbeRecoveryReason({
      expectedPublicBaseUrl: 'https://fresh.trycloudflare.com',
      status: 200,
    })).toBeNull();
    expect(getStartLocalTunnelProbeRecoveryReason({
      expectedPublicBaseUrl: 'https://fresh.trycloudflare.com',
      status: 404,
    })).toBeNull();
    expect(getStartLocalTunnelProbeRecoveryReason({
      expectedPublicBaseUrl: 'https://bot.example.test',
      status: 530,
    })).toBeNull();
  });

  test('waits for temporary tunnel registration only on Cloudflare 530 or probe errors', () => {
    expect(getStartLocalTunnelRegistrationWaitReason({
      expectedPublicBaseUrl: 'https://fresh.trycloudflare.com',
      status: 530,
    })).toBe('public tunnel not registered yet: status 530');
    expect(getStartLocalTunnelRegistrationWaitReason({
      expectedPublicBaseUrl: 'https://fresh.trycloudflare.com',
      errorMessage: 'Could not resolve host',
    })).toBe('public tunnel not registered yet: Could not resolve host');
    expect(getStartLocalTunnelRegistrationWaitReason({
      expectedPublicBaseUrl: 'https://fresh.trycloudflare.com',
      status: 502,
    })).toBeNull();
    expect(getStartLocalTunnelRegistrationWaitReason({
      expectedPublicBaseUrl: 'https://bot.example.test',
      status: 530,
    })).toBeNull();
  });
});
