import { afterEach, describe, expect, test } from 'bun:test';
import { DefaultBotGateway } from './gateway';
import type { RuntimeControlPlane } from '../runtime/types';

function createRuntimeControlPlane(): RuntimeControlPlane {
  return {
    getOverview: () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: {
        running: 0,
        retrying: 0,
        total: 1,
      },
      issues: [
        {
          issue_id: 'issue-1',
          work_item_id: 'issue-1',
          identifier: 'INT-1',
          title: 'Gateway test',
          phase: 'DEV',
          tracker_state: 'Todo',
          orchestrator_state: 'discovering',
          workspace_path: null,
          branch_name: null,
          github_repo: null,
          github_issue_number: null,
          active_pr_number: null,
          session: null,
          actions: {
            can_stop: false,
            can_retry: true,
            can_open_pr: false,
          },
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    getIssue: (id: string) =>
      ['issue-1', 'INT-1'].includes(id) ? createRuntimeControlPlane().getOverview().issues[0] ?? null : null,
    getTimeline: () => [],
    getHistoryView: () => ({
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      digest: {
        headline: 'INT-1 · DEV · Todo',
        detail: 'No live session yet.',
        history_blurb: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      entries: [],
    }),
    createIssue: async (input) => ({
      accepted: true,
      status: 'accepted',
      message: `Created ${input.title}`,
      issue_id: 'issue-2',
      issue_identifier: 'INT-2',
      issue: null,
    }),
    stopIssue: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Stopping ${id}`,
      issue_id: id,
      issue_identifier: 'INT-1',
    }),
    retryIssue: async (id: string) => ({
      accepted: true,
      status: 'queued',
      message: `Queued ${id}`,
      issue_id: id,
      issue_identifier: 'INT-1',
    }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: () => () => undefined,
  };
}

describe('DefaultBotGateway', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('reports operator-gated write access and watch presets in the manifest', () => {
    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operatorIds: new Set(['1001']),
      },
      {
        botToken: 'discord-token',
        publicKey: 'discord-public-key',
        operatorIds: new Set(['2002']),
      },
      undefined,
      null,
      {
        assistantModel: {
          decide: async () => null,
          getDiagnostics: () => ({
            provider: null,
            model: null,
            configured: false,
            health: 'unconfigured',
            fallback_available: true,
            last_error_code: 'unconfigured',
          }),
        },
      },
    );

    expect(gateway.getManifest()).toEqual({
      transports: {
        telegram: {
          enabled: true,
          inbound_enabled: true,
          outbound_enabled: true,
          watch_supported: true,
          write_requires_operator: true,
          inbound_path: '/api/v1/bots/telegram/webhook',
        },
        discord: {
          enabled: true,
          inbound_enabled: true,
          outbound_enabled: true,
          watch_supported: true,
          write_requires_operator: true,
          inbound_path: '/api/v1/bots/discord/interactions',
        },
      },
      commands: ['help', 'status', 'new', 'project', 'watch', 'unwatch', 'stop', 'retry'],
      watch_presets: ['default', 'verbose', 'failures', 'status'],
      assistant: {
        provider: null,
        model: null,
        configured: false,
        health: 'unconfigured',
        fallback_available: true,
        last_error_code: 'unconfigured',
      },
      natural_language_enabled: true,
    });

    gateway.dispose();
  });

  test('handles Telegram webhook commands and sends a reply through Telegram sendMessage', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operatorIds: new Set(),
      },
      {
        botToken: null,
        publicKey: null,
        operatorIds: new Set(),
      },
    );

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          text: '/status INT-1',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('https://api.telegram.org/bottelegram-token/sendMessage');
    expect(requests[0]?.body.chat_id).toBe('42');
    expect(String(requests[0]?.body.text)).toContain('INT-1');
  });

  test('routes non-command Telegram text through the assistant path', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operatorIds: new Set(),
      },
      {
        botToken: null,
        publicKey: null,
        operatorIds: new Set(),
      },
      undefined,
      null,
      {
        assistantModel: {
          decide: async () => {
            throw new Error('bot llm unavailable');
          },
        },
      },
    );

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          text: 'INT-1 现在怎么样了',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.body.text)).toContain('当前自然语言模型暂不可用');
    expect(String(requests[0]?.body.text)).toContain('INT-1');
  });

  test('rejects Telegram webhook calls with an invalid secret', async () => {
    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operatorIds: new Set(),
      },
      {
        botToken: null,
        publicKey: null,
        operatorIds: new Set(),
      },
    );

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          text: '/status INT-1',
          chat: { id: 42 },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'wrong-secret',
      },
    );

    expect(result.status).toBe(401);
    expect(result.body.error).toBe('Invalid Telegram webhook secret');
  });

  test('handles Discord ping and slash commands with a verifier', async () => {
    const verifier = {
      verify: async () => true,
    };

    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: null,
        webhookSecret: null,
        operatorIds: new Set(),
      },
      {
        botToken: 'discord-token',
        publicKey: 'discord-public-key',
        operatorIds: new Set(),
      },
      verifier,
    );

    const ping = await gateway.handleDiscordInteraction(
      JSON.stringify({ type: 1 }),
      {
        'x-signature-ed25519': 'sig',
        'x-signature-timestamp': 'ts',
      },
    );
    expect(ping.status).toBe(200);
    expect(ping.body.type).toBe(1);

    const status = await gateway.handleDiscordInteraction(
      JSON.stringify({
        type: 2,
        channel_id: 'channel-1',
        data: {
          name: 'status',
          options: [{ name: 'issue', value: 'INT-1' }],
        },
        user: {
          id: 'user-1',
          username: 'alice',
        },
      }),
      {
        'x-signature-ed25519': 'sig',
        'x-signature-timestamp': 'ts',
      },
    );
    expect(status.status).toBe(200);
    expect(status.body.type).toBe(4);
    expect(String((status.body.data as Record<string, unknown>).content)).toContain('INT-1');
  });

  test('rejects Discord interactions with an invalid signature', async () => {
    const verifier = {
      verify: async () => false,
    };

    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: null,
        webhookSecret: null,
        operatorIds: new Set(),
      },
      {
        botToken: 'discord-token',
        publicKey: 'discord-public-key',
        operatorIds: new Set(),
      },
      verifier,
    );

    const response = await gateway.handleDiscordInteraction(
      JSON.stringify({ type: 1 }),
      {
        'x-signature-ed25519': 'bad-sig',
        'x-signature-timestamp': 'ts',
      },
    );

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Invalid Discord signature');
  });

  test('rejects invalid Discord JSON payloads after signature verification', async () => {
    const verifier = {
      verify: async () => true,
    };

    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: null,
        webhookSecret: null,
        operatorIds: new Set(),
      },
      {
        botToken: 'discord-token',
        publicKey: 'discord-public-key',
        operatorIds: new Set(),
      },
      verifier,
    );

    const response = await gateway.handleDiscordInteraction(
      '{not-json',
      {
        'x-signature-ed25519': 'sig',
        'x-signature-timestamp': 'ts',
      },
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Invalid Discord interaction payload');
  });
});
