import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DefaultBotGateway } from './gateway';
import type { RuntimeControlPlane } from '../runtime/types';
import {
  BotTransportEventRepository,
  BotFollowupMessageStateRepository,
  BotPendingActionRepository,
  initializeSchema,
} from '../database';

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
      issue: {
        issue_id: 'issue-2',
        work_item_id: 'issue-2',
        identifier: 'INT-2',
        title: input.title,
        phase: 'DEV',
        tracker_state: 'Todo',
        orchestrator_state: 'halted',
        workspace_path: null,
        branch_name: null,
        github_repo: 'acme/repo',
        github_issue_number: 12,
        active_pr_number: null,
        session: null,
        governance_status: 'advisory',
        governance_decision: 'split_before_implement',
        governance_summary: 'Split this issue before dispatch.',
        active_governance_suggestions: [
          {
            id: 'suggestion-1',
            suggestion_type: 'cleanup',
            status: 'pending',
            title: 'Create a cleanup issue',
            summary: 'Split the cleanup work into a dedicated governance issue.',
            can_execute: true,
            can_dismiss: true,
          },
        ],
        actions: {
          can_stop: false,
          can_retry: false,
          can_override_governance: true,
          can_rewrite_governance: false,
          can_split_governance: true,
          can_open_pr: false,
        },
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
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
    rewriteGovernance: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Rewrite applied for ${id}`,
      issue_id: id,
      issue_identifier: 'INT-1',
    }),
    splitGovernance: async (id: string) => ({
      accepted: true,
      status: 'accepted',
      message: `Split applied for ${id}`,
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
    const telegramDiagnostics = {
      getSnapshot: () => ({
        webhook_url: 'https://example.test/telegram',
        webhook_pending_update_count: 2,
        webhook_last_error_message: 'connection refused',
        webhook_last_error_at: '2026-01-01T00:00:00.000Z',
        callback_ingress_recently_ok: false,
        health: 'degraded',
      }),
      maybeRefresh: () => undefined,
      recordCallbackSuccess: () => undefined,
      recordCallbackFailure: () => undefined,
      recordAudit: () => undefined,
    };
    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operationsChatId: null,
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
        telegramDiagnostics: telegramDiagnostics as any,
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
          proactive_followups_supported: true,
          inline_actions_supported: true,
          operations_chat_configured: false,
          health: 'degraded',
          webhook_url: 'https://example.test/telegram',
          webhook_pending_update_count: 2,
          webhook_last_error_message: 'connection refused',
          webhook_last_error_at: '2026-01-01T00:00:00.000Z',
          callback_ingress_recently_ok: false,
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
      commands: ['help', 'status', 'new', 'project', 'watch', 'unwatch', 'stop', 'retry', 'override', 'rewrite', 'split'],
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

  test('handles Telegram webhook commands with a fast ACK and sends the reply asynchronously', async () => {
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
        operationsChatId: null,
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
    expect(requests).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('https://api.telegram.org/bottelegram-token/sendMessage');
    expect(requests[0]?.body.chat_id).toBe('42');
    expect(String(requests[0]?.body.text)).toContain('INT-1');
  });

  test('routes non-command Telegram text through the assistant path asynchronously', async () => {
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
        operationsChatId: null,
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
    expect(requests).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.body.text)).toContain('当前自然语言模型暂不可用');
    expect(String(requests[0]?.body.text)).toContain('INT-1');
  });

  test('returns Telegram webhook 200 before a slow assistant reply finishes', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let resolveAssistant: (() => void) | null = null;
    const assistantDone = new Promise<void>((resolve) => {
      resolveAssistant = resolve;
    });

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
        operationsChatId: null,
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
            await assistantDone;
            return {
              intent: {
                kind: 'answer_question',
                answer: 'INT-1 目前还在执行中。',
              },
            };
          },
          getDiagnostics: () => ({
            provider: 'test',
            model: 'test-model',
            configured: true,
            health: 'healthy',
            fallback_available: true,
            last_error_code: null,
          }),
        },
      },
    );

    const result = await Promise.race([
      gateway.handleTelegramWebhook(
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
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('telegram text webhook timed out')), 50)),
    ]);

    expect(result.status).toBe(200);
    expect(requests).toHaveLength(0);

    resolveAssistant?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.body.text)).toContain('INT-1 目前还在执行中');
  });

  test('sends Telegram inline keyboard markup when the notifier receives structured actions', async () => {
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
        operationsChatId: null,
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

    await (gateway as any).telegramNotifier.sendMessage(
      {
        transport: 'telegram',
        conversation_id: '42',
      },
      {
        text: 'Governance blocked',
        format: 'telegram_html',
        action_rows: [
          [{
            label: '按方案拆成两个任务',
            callback_data: 'govsel|INT-2|1',
          }],
          [{
            label: '强制继续开发',
            style: 'danger',
            callback_data: 'govsel|INT-2|2',
          }],
        ],
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.parse_mode).toBe('HTML');
    expect(requests[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '按方案拆成两个任务', callback_data: 'govsel|INT-2|1' }],
        [{ text: '强制继续开发', callback_data: 'govsel|INT-2|2' }],
      ],
    });
  });

  test('handles Telegram governance callbacks by editing the same card into a confirming HTML card', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const pendingActions = new BotPendingActionRepository(db);
    const followupMessageStates = new BotFollowupMessageStateRepository(db);
    followupMessageStates.upsert({
      transport: 'telegram',
      conversation_id: '42',
      issue_id: 'issue-2',
      issue_identifier: 'INT-2',
      message_id: '101',
      card_kind: 'governance_blocked',
      card_key: 'blocked',
      card_state: 'open',
    });

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
      {
        ...createRuntimeControlPlane(),
        getOverview: () => ({
          generated_at: '2026-01-01T00:00:00.000Z',
          counts: { running: 0, retrying: 0, total: 1 },
          issues: [
            {
              issue_id: 'issue-2',
              work_item_id: 'issue-2',
              identifier: 'INT-2',
              title: 'Governance blocked issue',
              phase: 'DEV',
              tracker_state: 'In Progress',
              orchestrator_state: 'halted',
              workspace_path: null,
              branch_name: 'feature/int-2',
              github_repo: 'acme/repo',
              github_issue_number: 12,
              active_pr_number: null,
              session: null,
              governance_status: 'blocked',
              governance_decision: 'split_before_implement',
              governance_summary: 'Split this issue before dispatch. Repo context (acme/repo): runtime and bots are churning together.',
              active_governance_suggestions: [],
              actions: {
                can_stop: false,
                can_retry: false,
                can_override_governance: true,
                can_rewrite_governance: false,
                can_split_governance: true,
                can_open_pr: false,
              },
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
        getIssue: (id: string) => {
          const issue = {
            issue_id: 'issue-2',
            work_item_id: 'issue-2',
            identifier: 'INT-2',
            title: 'Governance blocked issue',
            phase: 'DEV',
            tracker_state: 'In Progress',
            orchestrator_state: 'halted',
            workspace_path: null,
            branch_name: 'feature/int-2',
            github_repo: 'acme/repo',
            github_issue_number: 12,
            active_pr_number: null,
            session: null,
            governance_status: 'blocked',
            governance_decision: 'split_before_implement',
            governance_summary: 'Split this issue before dispatch. Repo context (acme/repo): runtime and bots are churning together.',
            active_governance_suggestions: [],
            actions: {
              can_stop: false,
              can_retry: false,
              can_override_governance: true,
              can_rewrite_governance: false,
              can_split_governance: true,
              can_open_pr: false,
            },
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          };
          return ['issue-2', 'INT-2'].includes(id) ? issue as any : null;
        },
      } as RuntimeControlPlane,
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operationsChatId: null,
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
        pendingActionRepository: pendingActions,
        followupMessageStateRepository: followupMessageStates,
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

    const result = await gateway.handleTelegramWebhook(
      {
        callback_query: {
          id: 'callback-1',
          data: 'govsel|INT-2|1',
          message: {
            chat: { id: 42 },
            message_id: 101,
          },
          from: { id: 9, username: 'alice' },
        },
      } as any,
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    const answer = requests.find((request) => request.url.includes('answerCallbackQuery'));
    const edit = requests.find((request) => request.url.includes('editMessageText'));
    expect(answer?.body.text).toBe('已收到，正在准备确认');
    expect(edit?.body.parse_mode).toBe('HTML');
    expect(String(edit?.body.text)).toContain('请确认 · INT-2');
    expect(edit?.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '确认执行', callback_data: 'pending|confirm' }],
        [{ text: '返回上一步', callback_data: 'pending|cancel' }],
      ],
    });
    expect(
      followupMessageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: '42',
        issue_id: 'issue-2',
      })?.card_state,
    ).toBe('confirming');

    db.close();
  });

  test('acknowledges confirm callbacks immediately and completes governance execution asynchronously on the same card', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const pendingActions = new BotPendingActionRepository(db);
    const followupMessageStates = new BotFollowupMessageStateRepository(db);
    followupMessageStates.upsert({
      transport: 'telegram',
      conversation_id: '42',
      issue_id: 'issue-2',
      issue_identifier: 'INT-2',
      message_id: '101',
      card_kind: 'governance_blocked',
      card_key: 'blocked',
      card_state: 'confirming',
    });
    pendingActions.upsert({
      transport: 'telegram',
      conversation_id: '42',
      issue_id: 'issue-2',
      user_id: '9',
      intent_kind: 'split',
      normalized_payload: {
        command: 'split',
        issue_id: 'issue-2',
      },
      summary_message: 'Action: split',
      expires_at: new Date('2026-12-31T00:15:00.000Z'),
      status: 'pending_confirm',
      message_id: '101',
      card_key: 'blocked',
    });

    let resolveSplit: (() => void) | null = null;
    const splitPromise = new Promise<void>((resolve) => {
      resolveSplit = resolve;
    });

    let currentIssue: any = {
      issue_id: 'issue-2',
      work_item_id: 'issue-2',
      identifier: 'INT-2',
      title: 'Governance blocked issue',
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      workspace_path: null,
      branch_name: 'feature/int-2',
      github_repo: 'acme/repo',
      github_issue_number: 12,
      active_pr_number: null,
      session: null,
      governance_status: 'blocked',
      governance_decision: 'split_before_implement',
      governance_summary: 'Split this issue before dispatch. Repo context (acme/repo): runtime and bots are churning together.',
      active_governance_suggestions: [],
      governance_root_issue_identifier: 'INT-2',
      governance_thread_state: 'blocked',
      governance_child_issues: [],
      next_recommended_action: '按方案拆成两个任务',
      actions: {
        can_stop: false,
        can_retry: false,
        can_override_governance: true,
        can_rewrite_governance: false,
        can_split_governance: true,
        can_open_pr: false,
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const gateway = new DefaultBotGateway(
      {
        ...createRuntimeControlPlane(),
        getOverview: () => ({
          generated_at: '2026-01-01T00:00:00.000Z',
          counts: { running: 0, retrying: 0, total: 1 },
          issues: [currentIssue],
        }),
        getIssue: (id: string) => ['issue-2', 'INT-2'].includes(id) ? currentIssue : null,
        splitGovernance: async () => {
          await splitPromise;
          currentIssue = {
            ...currentIssue,
            governance_thread_state: 'waiting_on_child',
            governance_child_issues: [{
              issue_id: 'issue-20',
              issue_identifier: 'INT-20',
              title: '[GOVERNANCE FOLLOW-UP for INT-2] Runtime cleanup',
              tracker_state: 'Todo',
              orchestrator_state: 'halted',
              governance_decision: 'accept_with_rewrite',
              governance_summary: 'INT-20 still needs a rewrite before dispatch.',
            }],
            next_recommended_action: '先处理治理子任务 INT-20',
          };
          return {
            accepted: true,
            status: 'accepted',
            message: 'Split applied for INT-2',
            issue_id: 'issue-2',
            issue_identifier: 'INT-2',
            governance_action: {
              outcome_kind: 'waiting_on_child',
              root_issue_identifier: 'INT-2',
              created_issue_identifiers: ['INT-20'],
              next_recommended_action: '先处理治理子任务 INT-20',
              user_summary: '已为 INT-2 创建治理子任务 INT-20，源单仍在等待你先处理这个子任务。',
            },
          };
        },
      } as RuntimeControlPlane,
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operationsChatId: null,
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
        pendingActionRepository: pendingActions,
        followupMessageStateRepository: followupMessageStates,
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

    const result = await Promise.race([
      gateway.handleTelegramWebhook(
        {
          callback_query: {
            id: 'callback-confirm',
            data: 'pending|confirm',
            message: {
              chat: { id: 42 },
              message_id: 101,
            },
            from: { id: 9, username: 'alice' },
          },
        } as any,
        {
          'x-telegram-bot-api-secret-token': 'secret',
        },
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('callback webhook timed out')), 50)),
    ]);

    expect(result.status).toBe(200);
    expect(requests.find((request) => request.url.includes('answerCallbackQuery'))?.body.text).toBe('已收到，正在执行');
    expect(
      requests.find((request) =>
        request.url.includes('editMessageText') && String(request.body.text).includes('正在执行 · INT-2'),
      ),
    ).toBeTruthy();
    expect(
      followupMessageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: '42',
        issue_id: 'issue-2',
      })?.card_state,
    ).toBe('executing');

    resolveSplit?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      requests.find((request) =>
        request.url.includes('editMessageText') && String(request.body.text).includes('治理子任务 INT-20'),
      ),
    ).toBeTruthy();
    expect(
      followupMessageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: '42',
        issue_id: 'issue-2',
      })?.card_state,
    ).toBe('waiting_on_child');

    db.close();
  });

  test('falls back to a new Telegram message when editing the governance card fails', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const pendingActions = new BotPendingActionRepository(db);
    const followupMessageStates = new BotFollowupMessageStateRepository(db);
    followupMessageStates.upsert({
      transport: 'telegram',
      conversation_id: '42',
      issue_id: 'issue-2',
      issue_identifier: 'INT-2',
      message_id: '101',
      card_kind: 'governance_blocked',
      card_key: 'blocked',
      card_state: 'open',
    });

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}'));
      requests.push({
        url,
        body,
      });
      if (url.includes('editMessageText')) {
        return new Response(JSON.stringify({ ok: false }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 202 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const gateway = new DefaultBotGateway(
      {
        ...createRuntimeControlPlane(),
        getOverview: () => ({
          generated_at: '2026-01-01T00:00:00.000Z',
          counts: { running: 0, retrying: 0, total: 1 },
          issues: [
            {
              issue_id: 'issue-2',
              work_item_id: 'issue-2',
              identifier: 'INT-2',
              title: 'Governance blocked issue',
              phase: 'DEV',
              tracker_state: 'In Progress',
              orchestrator_state: 'halted',
              workspace_path: null,
              branch_name: 'feature/int-2',
              github_repo: 'acme/repo',
              github_issue_number: 12,
              active_pr_number: null,
              session: null,
              governance_status: 'blocked',
              governance_decision: 'split_before_implement',
              governance_summary: 'Split this issue before dispatch. Repo context (acme/repo): runtime and bots are churning together.',
              active_governance_suggestions: [],
              actions: {
                can_stop: false,
                can_retry: false,
                can_override_governance: true,
                can_rewrite_governance: false,
                can_split_governance: true,
                can_open_pr: false,
              },
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
        getIssue: (id: string) => ['issue-2', 'INT-2'].includes(id)
          ? {
            issue_id: 'issue-2',
            work_item_id: 'issue-2',
            identifier: 'INT-2',
            title: 'Governance blocked issue',
            phase: 'DEV',
            tracker_state: 'In Progress',
            orchestrator_state: 'halted',
            workspace_path: null,
            branch_name: 'feature/int-2',
            github_repo: 'acme/repo',
            github_issue_number: 12,
            active_pr_number: null,
            session: null,
            governance_status: 'blocked',
            governance_decision: 'split_before_implement',
            governance_summary: 'Split this issue before dispatch. Repo context (acme/repo): runtime and bots are churning together.',
            active_governance_suggestions: [],
            actions: {
              can_stop: false,
              can_retry: false,
              can_override_governance: true,
              can_rewrite_governance: false,
              can_split_governance: true,
              can_open_pr: false,
            },
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          } as any
          : null,
      } as RuntimeControlPlane,
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operationsChatId: null,
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
        pendingActionRepository: pendingActions,
        followupMessageStateRepository: followupMessageStates,
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

    const result = await gateway.handleTelegramWebhook(
      {
        callback_query: {
          id: 'callback-1',
          data: 'govsel|INT-2|1',
          message: {
            chat: { id: 42 },
            message_id: 101,
          },
          from: { id: 9, username: 'alice' },
        },
      } as any,
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    expect(requests.some((request) => request.url.includes('editMessageText'))).toBe(true);
    expect(requests.some((request) => request.url.includes('sendMessage'))).toBe(true);
    expect(
      followupMessageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: '42',
        issue_id: 'issue-2',
      })?.message_id,
    ).toBe('202');

    db.close();
  });

  test('treats Telegram message-is-not-modified errors as a successful no-op edit', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}'));
      requests.push({
        url,
        body,
      });

      if (url.includes('editMessageText')) {
        return new Response(JSON.stringify({
          ok: false,
          description: 'Bad Request: message is not modified',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 202 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

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
        operationsChatId: null,
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

    const delivered = await (gateway as any).deliverTelegramCallbackMessage({
      recipient: {
        transport: 'telegram',
        conversation_id: '42',
      },
      originalMessageId: '101',
      message: {
        text: '<b>待你处理 · INT-2</b>',
        format: 'telegram_html',
      },
    });

    expect(delivered).toEqual({
      ref: {
        provider_message_id: '101',
      },
      mode: 'edited',
    });
    expect(requests.filter((request) => request.url.includes('editMessageText'))).toHaveLength(1);
    expect(requests.some((request) => request.url.includes('sendMessage'))).toBe(false);

    gateway.dispose();
  });

  test('records outbound Telegram sync-ack transport events for replay and debugging', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const transportEvents = new BotTransportEventRepository(db);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 500 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operationsChatId: null,
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
        transportEventRepository: transportEvents,
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transportEvents.findAll()).toEqual([
      expect.objectContaining({
        source: 'sync_ack',
        action: 'send',
        result: 'success',
        conversation_id: '42',
      }),
    ]);

    gateway.dispose();
    db.close();
  });

  test('reports callback failures with a toast and a fallback Telegram message', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: 'telegram-token',
        webhookSecret: 'secret',
        operationsChatId: null,
        operatorIds: new Set(),
      },
      {
        botToken: null,
        publicKey: null,
        operatorIds: new Set(),
      },
    );

    (gateway as any).assistantService.respondToText = async () => {
      throw new Error('callback exploded');
    };

    const result = await gateway.handleTelegramWebhook(
      {
        callback_query: {
          id: 'callback-1',
          data: 'pending|confirm',
          message: {
            chat: { id: 42 },
            message_id: 101,
          },
          from: { id: 9, username: 'alice' },
        },
      } as any,
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    expect(requests.find((request) => request.url.includes('answerCallbackQuery'))?.body.text).toBe('执行失败，请稍后重试');
    expect(String(requests.find((request) => request.url.includes('sendMessage'))?.body.text)).toContain('处理 Telegram 按钮时失败');
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
        operationsChatId: null,
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
        operationsChatId: null,
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
        operationsChatId: null,
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
