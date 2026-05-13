import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DefaultBotGateway } from './gateway';
import { BotFollowupRepairService } from './followupRepair';
import type { RuntimeControlPlane } from '../runtime/types';
import {
  BotTransportEventRepository,
  BotConversationPreferenceRepository,
  BotIssueFollowupRepository,
  BotFollowupMessageStateRepository,
  BotPendingActionRepository,
  SupervisorPendingActionRepository,
  SupervisorRunEventRepository,
  SupervisorRunRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
  SupervisorToolCallRepository,
  initializeSchema,
} from '../database';
import { BotCommandService } from './commandService';
import { BotSubscriptionService } from './subscriptions';
import { SupervisorAgentRuntimeService, type SupervisorModelLoop } from '../supervisor/agentRuntime';
import { SupervisorSessionService } from '../supervisor/sessionService';

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
  const originalRepair = BotFollowupRepairService.prototype.repair;
  const originalPublicBaseUrl = process.env.SYMPHONY_PUBLIC_BASE_URL;
  const originalTelegramDisableProxy = process.env.SYMPHONY_TELEGRAM_DISABLE_PROXY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    BotFollowupRepairService.prototype.repair = originalRepair;
    if (originalPublicBaseUrl === undefined) {
      delete process.env.SYMPHONY_PUBLIC_BASE_URL;
    } else {
      process.env.SYMPHONY_PUBLIC_BASE_URL = originalPublicBaseUrl;
    }
    if (originalTelegramDisableProxy === undefined) {
      delete process.env.SYMPHONY_TELEGRAM_DISABLE_PROXY;
    } else {
      process.env.SYMPHONY_TELEGRAM_DISABLE_PROXY = originalTelegramDisableProxy;
    }
  });

  test('defers bot follow-up repair after construction so startup can become responsive first', () => {
    let repairCalls = 0;
    BotFollowupRepairService.prototype.repair = function patchedRepair() {
      repairCalls += 1;
      return {
        expired_pending_actions_deleted: 0,
        descendant_followups_folded: 0,
        descendant_message_states_deleted: 0,
        descendant_pending_actions_deleted: 0,
        orphan_message_states_deleted: 0,
        orphan_delivery_states_deleted: 0,
        delivery_baselines_seeded: 0,
        terminal_message_states_resolved: 0,
        terminal_pending_actions_cancelled: 0,
        terminal_conversation_focuses_cleared: 0,
      };
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
        botToken: null,
        publicKey: null,
        operatorIds: new Set(),
      },
      undefined,
      null,
      {
        startupRepairDelayMs: 10_000,
      },
    );

    expect(repairCalls).toBe(0);
    gateway.dispose();
  });

  test('treats an active Supervisor session card as an active runtime panel', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_card: null,
      root_issue_id: 'issue-1',
      last_message_id: 'msg-1',
      last_card_key: 'session|session-1|v1|executing',
    });
    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: null,
        webhookSecret: null,
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
        supervisorSessionRepository: sessions,
        startupRepairDelayMs: 10_000,
      },
    );

    expect((gateway as any).hasActiveRuntimePanel('chat-1')).toBe(true);

    gateway.dispose();
    db.close();
  });

  test('holds the runtime issue card conversation lock until the Telegram user-reply card is delivered', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const preferences = new BotConversationPreferenceRepository(db);
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: '42',
      default_project_slug: 'test2',
    });

    const baseRuntime = createRuntimeControlPlane();
    const listeners = new Set<(event: { type: 'issue'; data: any }) => void>();
    const createdIssue = {
      ...baseRuntime.getOverview().issues[0]!,
      issue_id: 'issue-2',
      work_item_id: 'issue-2',
      identifier: 'INT-2',
      title: 'Add smoke test',
      tracker_state: 'In Progress',
      orchestrator_state: 'dev_running',
      github_repo: 'acme/repo',
      github_issue_number: 12,
      updated_at: '2026-01-01T00:00:00.000Z',
      actions: {
        can_stop: true,
        can_retry: false,
        can_override_governance: false,
        can_rewrite_governance: false,
        can_split_governance: false,
        can_open_pr: false,
      },
    };
    const runtime: RuntimeControlPlane & { emitIssue: () => void } = {
      ...baseRuntime,
      getOverview: () => ({
        ...baseRuntime.getOverview(),
        issues: [createdIssue],
      }),
      getIssue: (id: string) => ['issue-2', 'INT-2'].includes(id) ? createdIssue as any : baseRuntime.getIssue(id),
      createIssue: async (input) => ({
        accepted: true,
        status: 'accepted',
        message: `Created ${input.title}`,
        issue_id: 'issue-2',
        issue_identifier: 'INT-2',
        issue: {
          ...createdIssue,
          title: input.title,
        } as any,
      }),
      subscribe: (listener) => {
        listeners.add(listener as (event: { type: 'issue'; data: any }) => void);
        return () => listeners.delete(listener as (event: { type: 'issue'; data: any }) => void);
      },
      emitIssue: () => {
        for (const listener of listeners) {
          listener({ type: 'issue', data: createdIssue });
        }
      },
    };

    const requests: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    let releaseFirstPhoto: (() => void) | null = null;
    let markFirstPhotoStarted: (() => void) | null = null;
    const firstPhotoStarted = new Promise<void>((resolve) => {
      markFirstPhotoStarted = resolve;
    });
    const firstPhotoGate = new Promise<void>((resolve) => {
      releaseFirstPhoto = resolve;
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        body: init?.body,
      });
      if (url.includes('sendPhoto')) {
        markFirstPhotoStarted?.();
        await firstPhotoGate;
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: requests.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    process.env.SYMPHONY_TELEGRAM_DISABLE_PROXY = '1';

    const gateway = new DefaultBotGateway(
      runtime,
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
        preferencesRepository: preferences,
        followupRepository: followups,
        followupMessageStateRepository: messageStates,
        startupRepairDelayMs: 10_000,
      },
    );

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          message_id: 101,
          text: '/new Add smoke test',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    await Promise.race([
      firstPhotoStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        `sendPhoto was not called: ${requests.map((request) => request.url).join(', ')}`,
      )), 1_000)),
    ]);
    expect(requests.filter((request) => request.url.includes('sendPhoto'))).toHaveLength(1);

    runtime.emitIssue();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests.filter((request) => request.url.includes('sendPhoto'))).toHaveLength(1);
    releaseFirstPhoto?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messageStates.findByConversationIssue({
      transport: 'telegram',
      conversation_id: '42',
      issue_id: 'issue-2',
    })).toEqual(expect.objectContaining({
      message_id: '1',
      card_kind: 'runtime_issue',
      card_state: 'open',
    }));

    gateway.dispose();
    db.close();
  });

  test('does not retry Telegram photo final sends because visible sends are not idempotent', async () => {
    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: null,
        webhookSecret: null,
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
        startupRepairDelayMs: 10_000,
      },
    );
    let attempts = 0;
    (gateway as any).telegramNotifier = {
      sendMessage: async () => {
        attempts += 1;
        throw new Error('network failed after visible send');
      },
    };

    await expect((gateway as any).sendTelegramFinalMessageWithRetry(
      {
        transport: 'telegram',
        conversation_id: '42',
      },
      {
        text: 'Issue Card · INT-2',
        photo: {
          bytes: new Uint8Array([1]),
          filename: 'issue-card.png',
          content_type: 'image/png',
        },
      },
      {
        context: {
          transport: 'telegram',
          recipient: {
            transport: 'telegram',
            conversation_id: '42',
          },
          identity: {
            user_id: '9',
            display_name: 'alice',
          },
        },
        isCommand: false,
      },
    )).rejects.toThrow('network failed after visible send');
    expect(attempts).toBe(1);

    gateway.dispose();
  });

  test('runs deferred bot follow-up repair after the configured startup delay', async () => {
    let repairCalls = 0;
    BotFollowupRepairService.prototype.repair = function patchedRepair() {
      repairCalls += 1;
      return {
        expired_pending_actions_deleted: 0,
        descendant_followups_folded: 0,
        descendant_message_states_deleted: 0,
        descendant_pending_actions_deleted: 0,
        orphan_message_states_deleted: 0,
        orphan_delivery_states_deleted: 0,
        delivery_baselines_seeded: 0,
        terminal_message_states_resolved: 0,
        terminal_pending_actions_cancelled: 0,
        terminal_conversation_focuses_cleared: 0,
      };
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
        botToken: null,
        publicKey: null,
        operatorIds: new Set(),
      },
      undefined,
      null,
      {
        startupRepairDelayMs: 5,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(repairCalls).toBe(1);
    gateway.dispose();
  });

  test('reports operator-gated write access and watch presets in the manifest', () => {
    delete process.env.SYMPHONY_PUBLIC_BASE_URL;
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
      commands: ['help', 'clear', 'status', 'new', 'project', 'watch', 'unwatch', 'stop', 'retry', 'close', 'supersede', 'override', 'rewrite', 'split'],
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
      supervisor: {
        active_sessions: [],
        agent_runtime: {
          active_runs: [],
          pending_actions: [],
        },
        repo_sources: [],
        repo_advisor_sessions: [],
      },
    });

    gateway.dispose();
  });

  test('reports supervisor repo source diagnostics in the bot manifest', () => {
    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: null,
        webhookSecret: null,
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
        startupRepairDelayMs: 10_000,
        projectResolver: {
          listConfiguredRoutes: () => [
            {
              project_slug: 'test2',
              project_name: null,
              github_owner: 'UniUni2000',
              github_repo: 'test2',
              github_repo_full: 'UniUni2000/test2',
              local_path: null,
              cache_key: 'uniuni2000__test2',
              require_repo_harness: false,
            },
          ],
        } as any,
        supervisorRepoSourceResolver: {
          resolve: async () => {
            throw new Error('manifest should not sync repositories');
          },
          getDiagnostics: (routes) => routes.map((route: any) => ({
            project_slug: route.project_slug,
            repo_ref: route.github_repo_full,
            configured_local_path: route.local_path,
            analysis_path: '/tmp/workspaces/uniuni2000__test2/source',
            source_path: '/tmp/workspaces/uniuni2000__test2/source',
            commit_sha: 'abc123',
            status: 'ready',
            last_sync_error: null,
            updated_at: '2026-05-07T00:00:00.000Z',
          })),
        },
        supervisorAgentService: {
          respond: async () => null,
          getRepoConversationDiagnostics: () => [
            {
              transport: 'telegram',
              conversation_id: 'chat-1',
              repo_ref: 'UniUni2000/test2',
              local_path: '/tmp/workspaces/uniuni2000__test2/source',
              source_commit_sha: 'abc123',
              started_at: '2026-05-07T00:00:00.000Z',
              last_used_at: '2026-05-07T00:00:02.000Z',
              turn_count: 2,
            },
          ],
        },
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

    expect(gateway.getManifest().supervisor?.repo_sources).toEqual([
      {
        project_slug: 'test2',
        repo_ref: 'UniUni2000/test2',
        configured_local_path: null,
        analysis_path: '/tmp/workspaces/uniuni2000__test2/source',
        source_path: '/tmp/workspaces/uniuni2000__test2/source',
        commit_sha: 'abc123',
        status: 'ready',
        last_sync_error: null,
        updated_at: '2026-05-07T00:00:00.000Z',
      },
    ]);
    expect(gateway.getManifest().supervisor?.repo_advisor_sessions).toEqual([
      {
        transport: 'telegram',
        conversation_id: 'chat-1',
        repo_ref: 'UniUni2000/test2',
        local_path: '/tmp/workspaces/uniuni2000__test2/source',
        source_commit_sha: 'abc123',
        started_at: '2026-05-07T00:00:00.000Z',
        last_used_at: '2026-05-07T00:00:02.000Z',
        turn_count: 2,
      },
    ]);

    gateway.dispose();
  });

  test('refreshes Telegram webhook diagnostics immediately after inbound bootstrap', async () => {
    let refreshCount = 0;
    const telegramDiagnostics = {
      getSnapshot: () => ({
        webhook_url: refreshCount > 0 ? 'https://example.test/api/v1/bots/telegram/webhook' : null,
        webhook_pending_update_count: 0,
        webhook_last_error_message: null,
        webhook_last_error_at: null,
        callback_ingress_recently_ok: false,
        health: refreshCount > 0 ? 'healthy' : 'unconfigured',
      }),
      maybeRefresh: () => undefined,
      refreshNow: async () => {
        refreshCount += 1;
      },
      recordCallbackSuccess: () => undefined,
      recordCallbackFailure: () => undefined,
      recordAudit: () => undefined,
    };
    const telegramBootstrapService = {
      bootstrap: async () => ({
        enabled: true,
        publicBaseUrl: 'https://example.test',
        webhookUrl: 'https://example.test/api/v1/bots/telegram/webhook',
        usedTunnel: true,
      }),
      dispose: async () => undefined,
    };
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
        telegramDiagnostics: telegramDiagnostics as any,
        telegramBootstrapService: telegramBootstrapService as any,
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

    await gateway.initializeInboundIntegration({
      localBaseUrl: 'http://127.0.0.1:3000',
      inboundPath: '/api/v1/bots/telegram/webhook',
    });

    expect(refreshCount).toBe(1);
    expect(gateway.getManifest().transports.telegram.webhook_url).toBe('https://example.test/api/v1/bots/telegram/webhook');
    expect(gateway.getManifest().transports.telegram.public_base_url).toBe('https://example.test');
    expect(gateway.getManifest().transports.telegram.mini_app_base_url).toBe('https://example.test');
    expect(gateway.getManifest().transports.telegram.webhook_used_tunnel).toBe(true);

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
          message_id: 654,
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

  test('coalesces quick consecutive Telegram natural language messages into one assistant turn', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const modelInputs: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 202 } }), {
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
        telegramTextCoalesceDelayMs: 15,
        assistantModel: {
          decide: async (input) => {
            modelInputs.push(input.text);
            return {
              intent: {
                kind: 'answer_question',
                answer: `收到：${input.text}`,
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

    await gateway.handleTelegramWebhook(
      {
        update_id: 9001,
        message: {
          message_id: 321,
          text: '没事，随便聊聊',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );
    await gateway.handleTelegramWebhook(
      {
        update_id: 9002,
        message: {
          message_id: 322,
          text: '这个仓库咋样',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modelInputs).toEqual(['没事，随便聊聊\n这个仓库咋样']);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.reply_to_message_id).toBe(322);
    expect(String(requests[0]?.body.text)).toContain('没事，随便聊聊');
    expect(String(requests[0]?.body.text)).toContain('这个仓库咋样');

    gateway.dispose();
  });

  test('serializes consecutive Telegram natural language messages while a prior assistant turn is running', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const modelInputs: string[] = [];
    let releaseFirstTurn: (() => void) | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: requests.length + 300 } }), {
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
          decide: async (input) => {
            modelInputs.push(input.text);
            if (input.text === '这个仓库现在怎么样') {
              await new Promise<void>((resolve) => {
                releaseFirstTurn = resolve;
              });
            }
            return {
              intent: {
                kind: 'answer_question',
                answer: `回复：${input.text}`,
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

    await gateway.handleTelegramWebhook(
      {
        update_id: 9101,
        message: {
          message_id: 401,
          text: '这个仓库现在怎么样',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modelInputs).toEqual(['这个仓库现在怎么样']);

    await gateway.handleTelegramWebhook(
      {
        update_id: 9102,
        message: {
          message_id: 402,
          text: '昨天我们聊了啥',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modelInputs).toEqual(['这个仓库现在怎么样']);
    expect(requests).toHaveLength(0);

    releaseFirstTurn?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modelInputs).toEqual(['这个仓库现在怎么样', '昨天我们聊了啥']);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.reply_to_message_id).toBe(401);
    expect(requests[1]?.body.reply_to_message_id).toBe(402);
    expect(String(requests[0]?.body.text)).toContain('回复：这个仓库现在怎么样');
    expect(String(requests[1]?.body.text)).toContain('回复：昨天我们聊了啥');

    gateway.dispose();
  });

  test('sends Telegram natural language replies as native replies to the inbound message', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 202 } }), {
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
          decide: async () => ({
            intent: {
              kind: 'answer_question',
              answer: '这个仓库是一个恒星质量-光度关系计算器。',
            },
          }),
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

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          message_id: 321,
          text: '这个仓库是干啥的',
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

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('sendMessage');
    expect(requests[0]?.body.chat_id).toBe('42');
    expect(requests[0]?.body.reply_to_message_id).toBe(321);
    expect(String(requests[0]?.body.text)).toContain('恒星质量-光度关系');
    gateway.dispose();
  });

  test('wires the configured assistant model into the supervisor runtime tool router', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const supervisorRuns = new SupervisorRunRepository(db);
    const supervisorRunEvents = new SupervisorRunEventRepository(db);
    const supervisorToolCalls = new SupervisorToolCallRepository(db);
    const supervisorPendingActions = new SupervisorPendingActionRepository(db);
    const requests: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    const modelInputs: Array<{ text: string; activeIssue: string | null }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: init?.body,
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
        operatorIds: new Set(['9']),
      },
      {
        botToken: null,
        publicKey: null,
        operatorIds: new Set(),
      },
      undefined,
      null,
      {
        supervisorRunRepository: supervisorRuns,
        supervisorRunEventRepository: supervisorRunEvents,
        supervisorToolCallRepository: supervisorToolCalls,
        supervisorPendingActionRepository: supervisorPendingActions,
        assistantModel: {
          decide: async (input) => {
            modelInputs.push({
              text: input.text,
              activeIssue: input.context.overview.active_issues[0]?.identifier ?? null,
            });
            return JSON.stringify({
              intent: {
                kind: 'show_issue_card',
                issue_id: input.context.overview.active_issues[0]?.identifier ?? null,
              },
            });
          },
          getDiagnostics: () => ({
            provider: 'test',
            model: 'test-router',
            configured: true,
            health: 'healthy',
            fallback_available: true,
            last_error_code: null,
          }),
        },
      },
    );

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          text: '这个单子卡片',
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(modelInputs).toEqual([{ text: '这个单子卡片', activeIssue: 'INT-1' }]);
    expect(requests.some((request) => request.url.includes('sendPhoto'))).toBe(true);
    const run = supervisorRuns.findLatestByConversation({
      transport: 'telegram',
      conversation_id: '42',
    });
    expect(run?.active_issue_id).toBe('issue-1');
    expect(supervisorToolCalls.findByRun(run!.id).map((call) => call.tool_name)).toEqual(['show_issue_card']);

    gateway.dispose();
    db.close();
  });

  test('sends a safe recovery reply for non-command Telegram assistant failures without backend jargon', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const supervisorRuns = new SupervisorRunRepository(db);
    const supervisorRunEvents = new SupervisorRunEventRepository(db);
    const supervisorToolCalls = new SupervisorToolCallRepository(db);
    const supervisorPendingActions = new SupervisorPendingActionRepository(db);
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
    const runtime = createRuntimeControlPlane();
    const commandService = new BotCommandService(
      runtime,
      new BotSubscriptionService(runtime, {}),
      () => true,
    );
    const model: SupervisorModelLoop = async () => ({
      type: 'tool_call',
      tool: 'delete_everything',
      args: {},
      reason: 'ECONNRESET while selecting a supervisor tool.',
    });
    const supervisorRuntime = new SupervisorAgentRuntimeService({
      runtime,
      commandService,
      runs: supervisorRuns,
      events: supervisorRunEvents,
      toolCalls: supervisorToolCalls,
      pendingActions: supervisorPendingActions,
      model,
    });
    const gateway = new DefaultBotGateway(
      runtime,
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
        supervisorAgentRuntimeService: supervisorRuntime,
        supervisorRunRepository: supervisorRuns,
        supervisorRunEventRepository: supervisorRunEvents,
        supervisorToolCallRepository: supervisorToolCalls,
        supervisorPendingActionRepository: supervisorPendingActions,
      },
    );

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          text: '帮我处理一下这个项目',
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('sendMessage');
    const outboundText = String(requests[0]?.body.text);
    expect(outboundText).toContain('这个请求没有执行');
    expect(outboundText).toContain('我没有改动任何东西');
    expect(outboundText).not.toContain('Unsupported supervisor tool');
    expect(outboundText).not.toContain('Invalid args');
    expect(outboundText).not.toContain('ECONNRESET');

    gateway.dispose();
    db.close();
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

  test('sends a lightweight processing acknowledgement when Telegram text handling is slow', async () => {
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
        telegramTextProcessingAckDelayMs: 5,
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

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          message_id: 654,
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.body.text)).toContain('收到您的消息了，我这边正在思考和处理，给我点时间');
    expect(requests[0]?.body.reply_to_message_id).toBe(654);

    resolveAssistant?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toContain('editMessageText');
    expect(String(requests[1]?.body.text)).toContain('INT-1 目前还在执行中');
  });

  test('deduplicates Telegram retried text updates before sending progress or final replies', async () => {
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
        telegramTextProcessingAckDelayMs: 5,
        assistantModel: {
          decide: async () => {
            await assistantDone;
            return {
              intent: {
                kind: 'answer_question',
                answer: 'No active work right now.',
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

    const update = {
      update_id: 12345,
      message: {
        text: 'are things clean now?',
        chat: { id: 42 },
        from: { id: 9, username: 'alice' },
      },
    };
    const headers = {
      'x-telegram-bot-api-secret-token': 'secret',
    };

    const first = await gateway.handleTelegramWebhook(update, headers);
    const retry = await gateway.handleTelegramWebhook(update, headers);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true, duplicate: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.body.text)).toContain('Got your message. I am thinking it through and will reply shortly.');

    resolveAssistant?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(2);
    expect(String(requests[1]?.body.text)).toContain('No active work right now.');
  });

  test('does not send a slow acknowledgement for pure repo questions before the direct answer', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const db = new Database(':memory:');
    initializeSchema(db);
    const preferences = new BotConversationPreferenceRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: '42',
      default_project_slug: 'test2',
    });
    const projectResolver = {
      listConfiguredRoutes: () => [
        {
          project_slug: 'test2',
          project_name: null,
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          github_repo_full: 'UniUni2000/test2',
          local_path: null,
          cache_key: 'uniuni2000__test2',
          require_repo_harness: false,
        },
      ],
    } as any;
    let resolveAgent: (() => void) | null = null;
    const agentDone = new Promise<void>((resolve) => {
      resolveAgent = resolve;
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
        telegramTextProcessingAckDelayMs: 5,
        preferencesRepository: preferences,
        projectResolver,
        supervisorAgentService: {
          respond: async () => {
            await agentDone;
            return {
              mode: 'repo_answer',
              repoRef: 'UniUni2000/test2',
              answer: '仓库当前只有 README.md。',
            };
          },
        },
        assistantModel: {
          decide: async () => null,
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

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          text: '这个仓库有哪些文件？',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(0);

    resolveAgent?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('sendMessage');
    expect(String(requests[0]?.body.text)).toContain('README.md');
    gateway.dispose();
    db.close();
  });

  test('retries the final Telegram reply when ack edit and fallback send hit transient failures', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 900;
    let resolveAssistant: (() => void) | null = null;
    const assistantDone = new Promise<void>((resolve) => {
      resolveAssistant = resolve;
    });

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}'));
      requests.push({ url, body });
      if (url.includes('editMessageText')) {
        throw new Error('Telegram edit timeout');
      }
      const finalSendAttempts = requests.filter((request) =>
        request.url.includes('sendMessage') &&
        String(request.body.text).includes('最终答案')
      ).length;
      if (url.includes('sendMessage') && String(body.text).includes('最终答案') && finalSendAttempts === 1) {
        throw new Error('Telegram send timeout');
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId += 1 } }), {
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
        telegramTextProcessingAckDelayMs: 5,
        assistantModel: {
          decide: async () => {
            await assistantDone;
            return {
              intent: {
                kind: 'answer_question',
                answer: '最终答案：这个任务还在处理中。',
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests.filter((request) => request.url.includes('sendMessage'))).toHaveLength(1);

    resolveAssistant?.();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(requests.some((request) => request.url.includes('editMessageText'))).toBe(true);
    const finalSends = requests.filter((request) =>
      request.url.includes('sendMessage') &&
      String(request.body.text).includes('最终答案')
    );
    expect(finalSends).toHaveLength(2);
    gateway.dispose();
  });

  test('edits the slow-processing acknowledgement into the supervisor Plan Card instead of sending a second card', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 700;
    let resolveAssistant: (() => void) | null = null;
    const assistantDone = new Promise<void>((resolve) => {
      resolveAssistant = resolve;
    });

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      requests.push({ url: String(input), body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId += 1 } }), {
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
        telegramTextProcessingAckDelayMs: 5,
        assistantModel: {
          decide: async () => ({ intent: { kind: 'help' } }),
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
    (gateway as any).assistantService = {
      respondToText: async () => {
        await assistantDone;
        return {
          message: '<b>计划待你批准 · v1</b>\n我已理解的计划：清理残余文件。',
          format: 'telegram_html',
          action_rows: [[{ label: '批准并开始', callback_data: 'sup|session-1|approve' }]],
          session_id: 'session-1',
          material_key: 'session|session-1|v1|approval',
        };
      },
      getDiagnostics: () => ({
        provider: null,
        model: null,
        configured: false,
        health: 'unconfigured',
        fallback_available: true,
        last_error_code: 'unconfigured',
      }),
    };

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          text: '这个仓库还有文件残余，把它都清空',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('sendMessage');
    expect(String(requests[0]?.body.text)).toContain('正在读取最新仓库信息');

    resolveAssistant?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toContain('editMessageText');
    expect(requests[1]?.body.message_id).toBe('701');
    expect(String(requests[1]?.body.text)).toContain('计划待你批准');
  });

  test('waits for an in-flight slow-processing acknowledgement before delivering the Plan Card', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 800;
    let resolveAssistant: (() => void) | null = null;
    let resolveAckSend: (() => void) | null = null;
    const assistantDone = new Promise<void>((resolve) => {
      resolveAssistant = resolve;
    });
    const ackSendDone = new Promise<void>((resolve) => {
      resolveAckSend = resolve;
    });

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      requests.push({ url: String(input), body });
      if (String(input).includes('sendMessage') && String(body.text).includes('正在读取最新仓库信息')) {
        await ackSendDone;
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId += 1 } }), {
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
        telegramTextProcessingAckDelayMs: 5,
        assistantModel: {
          decide: async () => ({ intent: { kind: 'help' } }),
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
    (gateway as any).assistantService = {
      respondToText: async () => {
        await assistantDone;
        return {
          message: '<b>计划待你批准 · v1</b>\n我已理解的计划：清理残余文件。',
          format: 'telegram_html',
          action_rows: [[{ label: '批准并开始', callback_data: 'sup|session-1|approve' }]],
          session_id: 'session-1',
          material_key: 'session|session-1|v1|approval',
        };
      },
      getDiagnostics: () => ({
        provider: null,
        model: null,
        configured: false,
        health: 'unconfigured',
        fallback_available: true,
        last_error_code: 'unconfigured',
      }),
    };

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          text: '这个仓库还有文件残余，把它都清空',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('sendMessage');

    resolveAssistant?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);

    resolveAckSend?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toContain('editMessageText');
    expect(requests[1]?.body.message_id).toBe('801');
    expect(String(requests[1]?.body.text)).toContain('计划待你批准');
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
        [{ text: '强制继续开发', style: 'danger', callback_data: 'govsel|INT-2|2' }],
      ],
    });
  });

  test('sends Telegram visual issue cards as photos with three native action buttons', async () => {
    const requests: Array<{ url: string; body: FormData }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: init?.body as FormData,
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 333 } }), {
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
        text: 'INT-248 · Production Ready 计划',
        caption: '<b>INT-248 · Production Ready 计划</b>',
        format: 'telegram_html',
        media_key: 'visual|session-1|approval',
        photo: {
          bytes: new Uint8Array([137, 80, 78, 71]),
          filename: 'int-248-card.png',
          content_type: 'image/png',
        },
        action_rows: [
          [{ label: '批准并开始', style: 'success', callback_data: 'sup|session-1|approve' }],
          [
            { label: '改一下计划', callback_data: 'sup|session-1|edit' },
            { label: '打开运行视图', style: 'primary', web_app: { url: 'https://app.example.test/runtime/issues/INT-248/app' } },
          ],
        ],
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('sendPhoto');
    expect(requests[0]?.body.get('chat_id')).toBe('42');
    expect(requests[0]?.body.get('caption')).toContain('INT-248');
    expect(requests[0]?.body.get('parse_mode')).toBe('HTML');
    expect(requests[0]?.body.get('photo')).toBeInstanceOf(Blob);
    expect(JSON.parse(String(requests[0]?.body.get('reply_markup')))).toEqual({
      inline_keyboard: [
        [{ text: '批准并开始', style: 'success', callback_data: 'sup|session-1|approve' }],
        [
          { text: '改一下计划', callback_data: 'sup|session-1|edit' },
          { text: '打开运行视图', style: 'primary', web_app: { url: 'https://app.example.test/runtime/issues/INT-248/app' } },
        ],
      ],
    });

    gateway.dispose();
  });

  test('keeps the runtime view button visible when the Mini App public base URL is missing', async () => {
    delete process.env.SYMPHONY_PUBLIC_BASE_URL;
    const requests: Array<{ url: string; body: FormData }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: init?.body as FormData,
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 334 } }), {
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
        text: 'Issue Card · INT-1',
        caption: '<b>INT-1 · Gateway test</b>',
        format: 'telegram_html',
        media_key: 'issue-card|INT-1|open-fallback',
        photo: {
          bytes: new Uint8Array([137, 80, 78, 71]),
          filename: 'INT-1-card.png',
          content_type: 'image/png',
        },
        action_rows: [
          [{ label: '停止', style: 'danger', callback_data: 'rt|INT-1|stop' }],
          [
            { label: '刷新卡片', callback_data: 'rt|INT-1|refresh' },
            { label: '打开运行视图', style: 'primary', web_app: { url: '/runtime/issues/INT-1/app' } },
          ],
        ],
      },
    );

    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.body.get('reply_markup')))).toEqual({
      inline_keyboard: [
        [{ text: '停止', style: 'danger', callback_data: 'rt|INT-1|stop' }],
        [
          { text: '刷新卡片', callback_data: 'rt|INT-1|refresh' },
          { text: '打开运行视图', style: 'primary', callback_data: 'rt|INT-1|open' },
        ],
      ],
    });

    gateway.dispose();
  });

  test('handles runtime issue card buttons by refreshing the same Telegram card through supervisor runtime', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const followupMessageStates = new BotFollowupMessageStateRepository(db);
    const requests: Array<{ url: string; body: FormData | Record<string, unknown> }> = [];
    const runtimeTexts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const rawBody = init?.body;
      requests.push({
        url: String(input),
        body: rawBody instanceof FormData ? rawBody : JSON.parse(String(rawBody || '{}')),
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
        operatorIds: new Set(['9']),
      },
      {
        botToken: null,
        publicKey: null,
        operatorIds: new Set(),
      },
      undefined,
      null,
      {
        supervisorAgentRuntimeService: {
          respond: async ({ text }) => {
            runtimeTexts.push(text);
            return {
              message: 'Issue Card · INT-1',
              caption: '<b>INT-1 · Gateway test</b>',
              format: 'telegram_html',
              media_key: 'issue-card|INT-1|refresh',
              photo: {
                bytes: new Uint8Array([137, 80, 78, 71]),
                filename: 'INT-1-issue-card.png',
                content_type: 'image/png',
              },
              show_caption_above_media: false,
              issue_id: 'issue-1',
              action_rows: [
                [{ label: '打开运行视图', style: 'primary', web_app: { url: '/runtime/issues/INT-1/app' } }],
                [{ label: '刷新卡片', callback_data: 'rt|INT-1|refresh' }],
              ],
            };
          },
        } as unknown as SupervisorAgentRuntimeService,
        followupMessageStateRepository: followupMessageStates,
      },
    );
    (gateway as any).telegramPublicBaseUrl = 'https://app.example.test';

    const result = await gateway.handleTelegramWebhook(
      {
        callback_query: {
          id: 'callback-runtime-refresh',
          data: 'rt|INT-1|refresh',
          message: {
            chat: { id: 42 },
            message_id: 101,
            caption: 'old card',
          },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    expect(runtimeTexts).toEqual(['INT-1 卡片']);
    expect(requests.some((request) => request.url.includes('answerCallbackQuery'))).toBe(true);
    const edit = requests.find((request) => request.url.includes('editMessageMedia'));
    expect(edit?.body).toBeInstanceOf(FormData);
    expect((edit?.body as FormData).get('message_id')).toBe('101');
    expect(JSON.parse(String((edit?.body as FormData).get('reply_markup')))).toEqual({
      inline_keyboard: [
        [{ text: '打开运行视图', style: 'primary', web_app: { url: 'https://app.example.test/runtime/issues/INT-1/app' } }],
        [{ text: '刷新卡片', callback_data: 'rt|INT-1|refresh' }],
      ],
    });
    expect(
      followupMessageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: '42',
        issue_id: 'issue-1',
      })?.card_kind,
    ).toBe('runtime_issue');

    gateway.dispose();
    db.close();
  });

  test('answers the fallback runtime view button without editing the card when Mini App is unavailable', async () => {
    delete process.env.SYMPHONY_PUBLIC_BASE_URL;
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
        operatorIds: new Set(['9']),
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
        callback_query: {
          id: 'callback-runtime-open',
          data: 'rt|INT-1|open',
          message: {
            chat: { id: 42 },
            message_id: 101,
            caption: 'issue card',
          },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('answerCallbackQuery');
    expect(String(requests[0]?.body.text)).toContain('Mini App');
    expect(String(requests[0]?.body.text)).toContain('SYMPHONY_PUBLIC_BASE_URL');

    gateway.dispose();
  });

  test('edits Telegram visual issue cards with editMessageMedia instead of text edits', async () => {
    const requests: Array<{ url: string; body: FormData }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: init?.body as FormData,
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 444 } }), {
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

    await (gateway as any).telegramNotifier.editMessage(
      {
        transport: 'telegram',
        conversation_id: '42',
      },
      {
        provider_message_id: '101',
      },
      {
        text: 'INT-248 updated',
        caption: '<b>INT-248 · 执行中</b>',
        format: 'telegram_html',
        media_key: 'visual|session-1|executing',
        photo: {
          bytes: new Uint8Array([137, 80, 78, 71]),
          filename: 'int-248-card.png',
          content_type: 'image/png',
        },
        action_rows: [[{ label: '打开运行视图', style: 'primary', url: 'https://app.example.test/runtime/issues/INT-248/app' }]],
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('editMessageMedia');
    expect(requests[0]?.body.get('chat_id')).toBe('42');
    expect(requests[0]?.body.get('message_id')).toBe('101');
    expect(requests[0]?.body.get('photo')).toBeInstanceOf(Blob);
    expect(JSON.parse(String(requests[0]?.body.get('media')))).toEqual({
      type: 'photo',
      media: 'attach://photo',
      caption: '<b>INT-248 · 执行中</b>',
      parse_mode: 'HTML',
      show_caption_above_media: true,
    });
    expect(JSON.parse(String(requests[0]?.body.get('reply_markup')))).toEqual({
      inline_keyboard: [
        [{ text: '打开运行视图', style: 'primary', url: 'https://app.example.test/runtime/issues/INT-248/app' }],
      ],
    });

    gateway.dispose();
  });

  test('edits Telegram visual card captions with editMessageCaption when media is unchanged', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 444 } }), {
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

    await (gateway as any).telegramNotifier.editMessage(
      {
        transport: 'telegram',
        conversation_id: '42',
      },
      {
        provider_message_id: '101',
      },
      {
        text: 'INT-248 updated',
        caption: '<b>INT-248 · 等待确认</b>',
        format: 'telegram_html',
        media_key: 'visual|session-1|approval',
        action_rows: [[{ label: '打开运行视图', style: 'primary', url: 'https://app.example.test/runtime/issues/INT-248/app' }]],
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('editMessageCaption');
    expect(requests[0]?.body).toMatchObject({
      chat_id: '42',
      message_id: '101',
      caption: '<b>INT-248 · 等待确认</b>',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '打开运行视图', style: 'primary', url: 'https://app.example.test/runtime/issues/INT-248/app' }],
        ],
      },
    });

    gateway.dispose();
  });

  test('falls back to editing a media caption when a text edit targets a photo card', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.includes('editMessageText')) {
        return new Response(JSON.stringify({
          ok: false,
          description: 'Bad Request: there is no text in the message to edit',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 444 } }), {
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

    await (gateway as any).telegramNotifier.editMessage(
      {
        transport: 'telegram',
        conversation_id: '42',
      },
      {
        provider_message_id: '101',
      },
      {
        text: '<b>已处理 · INT-162</b>',
        format: 'telegram_html',
      },
    );

    expect(requests.map((request) => request.url)).toEqual([
      expect.stringContaining('editMessageText'),
      expect.stringContaining('editMessageCaption'),
    ]);
    expect(requests[1]?.body).toMatchObject({
      chat_id: '42',
      message_id: '101',
      caption: '<b>已处理 · INT-162</b>',
      parse_mode: 'HTML',
    });

    gateway.dispose();
  });

  test('handles Telegram supervisor approval callbacks by editing the same message into a materialized plan result', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const sessionEvents = new SupervisorSessionEventRepository(db);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      let body: Record<string, unknown>;
      if (init?.body instanceof FormData) {
        body = {};
        for (const [key, value] of init.body.entries()) {
          body[key] = value;
        }
      } else {
        body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      }
      requests.push({
        url: String(input),
        body,
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const baseRuntime = createRuntimeControlPlane();
    const runtime = {
      ...baseRuntime,
      createIssue: async (input) => ({
        accepted: true as const,
        status: 'accepted' as const,
        message: `Created ${input.title}`,
        issue_id: 'issue-32',
        issue_identifier: 'INT-32',
        issue: {
          ...baseRuntime.getOverview().issues[0]!,
          issue_id: 'issue-32',
          work_item_id: 'issue-32',
          identifier: 'INT-32',
          title: input.title,
          governance_root_issue_id: 'issue-32',
          governance_root_issue_identifier: 'INT-32',
        },
      }),
      getIssue: (id: string) => ['issue-32', 'INT-32'].includes(id)
        ? {
            ...baseRuntime.getOverview().issues[0]!,
            issue_id: 'issue-32',
            work_item_id: 'issue-32',
            identifier: 'INT-32',
            title: 'Materialized plan',
            governance_root_issue_id: 'issue-32',
            governance_root_issue_identifier: 'INT-32',
          }
        : null,
    } as RuntimeControlPlane;

    const supervisorService = new SupervisorSessionService(
      runtime,
      null,
      sessions,
      sessionEvents,
    );

    const session = sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: '42',
      user_id: '9',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      plan_card: {
        title: 'Refactor runtime API and rewrite Telegram copy together',
        user_goal: 'Refactor runtime API and rewrite Telegram copy together',
        in_scope: ['Refactor runtime API and rewrite Telegram copy together'],
        out_of_scope: ['Do not expand into unrelated areas.'],
        acceptance: ['Both pieces are delivered.'],
        known_risks: ['This spans multiple surfaces.'],
        execution_strategy: 'Create the root thread first.',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '按当前计划物化执行。',
        },
        alternate_option: {
          label: '改一下计划',
          summary: '先调整计划再执行。',
        },
        governance_preview: null,
      },
      last_message_id: '101',
      last_card_key: 'supervisor|session-1|approval',
    });

    const gateway = new DefaultBotGateway(
      runtime,
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
        supervisorSessionRepository: sessions,
        supervisorSessionEventRepository: sessionEvents,
        supervisorSessionService: supervisorService,
      } as any,
    );

    const result = await gateway.handleTelegramWebhook(
      {
        callback_query: {
          id: 'callback-supervisor-1',
          data: `sup|${session.id}|approve`,
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
    expect(requests.find((request) => request.url.includes('answerCallbackQuery'))?.body.text).toBe('已收到，正在处理');
    const editRequests = requests.filter((request) => request.url.includes('editMessageMedia'));
    const media = JSON.parse(String(editRequests.at(-1)?.body.media || '{}'));
    expect(media.caption).toContain('已创建');
    expect(media.caption).toContain('INT-32');
    expect(editRequests.at(-1)?.body.photo).toBeInstanceOf(Blob);
    expect(sessions.findById(session.id)?.root_issue_id).toBe('issue-32');

    gateway.dispose();
    supervisorService.dispose();
    db.close();
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

  test('binds a generic pending confirmation to the sent Telegram message and executes its confirm callback', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const pendingActions = new BotPendingActionRepository(db);
    const issue = {
      issue_id: 'issue-157',
      work_item_id: 'issue-157',
      identifier: 'INT-157',
      title: '补充 README.md 项目文档',
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      workspace_path: null,
      branch_name: 'feature/int-157',
      github_repo: 'UniUni2000/test2',
      github_issue_number: 100,
      active_pr_number: null,
      session: null,
      actions: {
        can_stop: false,
        can_retry: true,
        can_open_pr: false,
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const closeIssueCalls: Array<{ id: string; reason: string | null }> = [];
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let nextMessageId = 300;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const runtime = {
      ...createRuntimeControlPlane(),
      getOverview: () => ({
        generated_at: '2026-01-01T00:00:00.000Z',
        counts: { running: 0, retrying: 0, total: 1 },
        issues: [issue],
      }),
      getIssue: (id: string) => ['issue-157', 'INT-157'].includes(id) ? issue : null,
      closeIssue: async (id: string, request?: { reason?: string | null }) => {
        closeIssueCalls.push({ id, reason: request?.reason ?? null });
        return {
          accepted: true,
          status: 'accepted',
          message: `Closed ${id}`,
          issue_id: 'issue-157',
          issue_identifier: 'INT-157',
          governance_action: null,
        };
      },
    } as RuntimeControlPlane;

    const gateway = new DefaultBotGateway(
      runtime,
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

    await gateway.handleTelegramWebhook(
      {
        message: {
          text: '吧 157 给清理了，不再需要',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      } as any,
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pending = pendingActions.findByConversation({
      transport: 'telegram',
      conversation_id: '42',
    });
    expect(pending?.intent_kind).toBe('close_issue');
    expect(pending?.message_id).toBe('300');

    const result = await gateway.handleTelegramWebhook(
      {
        callback_query: {
          id: 'callback-confirm-generic',
          data: 'pending|confirm',
          message: {
            chat: { id: 42 },
            message_id: 300,
          },
          from: { id: 9, username: 'alice' },
        },
      } as any,
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    expect(requests.find((request) => request.url.includes('answerCallbackQuery'))?.body.text).toBe('已收到，正在执行');
    expect(
      requests.find((request) =>
        request.url.includes('editMessageText') && String(request.body.text).includes('正在执行 · INT-157'),
      ),
    ).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeIssueCalls).toEqual([
      {
        id: 'INT-157',
        reason: 'Closed stale issue from Telegram supervisor command.',
      },
    ]);

    db.close();
  });

  test('binds a supervisor runtime pending confirmation to the sent Telegram message', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const supervisorRuns = new SupervisorRunRepository(db);
    const supervisorRunEvents = new SupervisorRunEventRepository(db);
    const supervisorToolCalls = new SupervisorToolCallRepository(db);
    const supervisorPendingActions = new SupervisorPendingActionRepository(db);
    const issue = {
      issue_id: 'issue-157',
      work_item_id: 'issue-157',
      identifier: 'INT-157',
      title: '补充 README.md 项目文档',
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      workspace_path: null,
      branch_name: 'feature/int-157',
      github_repo: 'UniUni2000/test2',
      github_issue_number: 100,
      active_pr_number: null,
      session: null,
      actions: {
        can_stop: false,
        can_retry: false,
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
      return new Response(JSON.stringify({ ok: true, result: { message_id: 410 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const runtime = {
      ...createRuntimeControlPlane(),
      getOverview: () => ({
        generated_at: '2026-01-01T00:00:00.000Z',
        counts: { running: 0, retrying: 0, total: 1 },
        issues: [issue],
      }),
      getIssue: (id: string) => ['issue-157', 'INT-157'].includes(id) ? issue : null,
    } as RuntimeControlPlane;
    const commandService = new BotCommandService(
      runtime,
      new BotSubscriptionService(runtime, {}),
      () => true,
    );
    const supervisorRuntime = new SupervisorAgentRuntimeService({
      runtime,
      commandService,
      runs: supervisorRuns,
      events: supervisorRunEvents,
      toolCalls: supervisorToolCalls,
      pendingActions: supervisorPendingActions,
    });
    const gateway = new DefaultBotGateway(
      runtime,
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
        supervisorAgentRuntimeService: supervisorRuntime,
        supervisorRunRepository: supervisorRuns,
        supervisorRunEventRepository: supervisorRunEvents,
        supervisorToolCallRepository: supervisorToolCalls,
        supervisorPendingActionRepository: supervisorPendingActions,
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

    await gateway.handleTelegramWebhook(
      {
        message: {
          text: '把 157 给我关了吧',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      } as any,
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pending = supervisorPendingActions.findOpenByConversation({
      transport: 'telegram',
      conversation_id: '42',
    });
    expect(pending?.tool_name).toBe('close_issue');
    expect(pending?.telegram_message_id).toBe('410');
    expect(requests.some((request) => request.url.includes('sendMessage'))).toBe(true);

    db.close();
  });

  test('keeps the original Telegram card when an edit fails with a hard error', async () => {
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
    expect(requests.some((request) => request.url.includes('sendMessage'))).toBe(false);
    expect(
      followupMessageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: '42',
        issue_id: 'issue-2',
      })?.message_id,
    ).toBe('101');

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

  test('does not send a second Telegram error message after final outbound delivery fails', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const transportEvents = new BotTransportEventRepository(db);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      throw new Error('connection reset by peer');
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
          decide: async () => ({
            intent: {
              kind: 'answer_question',
              answer: 'There are currently no active issues.',
            },
          }),
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

    const result = await gateway.handleTelegramWebhook(
      {
        message: {
          text: 'open issues',
          chat: { id: 42 },
          from: { id: 9, username: 'alice' },
        },
      },
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests.filter((request) => request.url.includes('sendMessage'))).toHaveLength(3);
    expect(transportEvents.findAll()).toEqual([
      expect.objectContaining({
        source: 'sync_ack',
        action: 'send',
        result: 'failed',
        conversation_id: '42',
        error_message: 'connection reset by peer',
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
      undefined,
      null,
      {
        supervisorSessionService: {
          respondToAction: async () => {
            throw new Error('callback exploded');
          },
        } as any,
      },
    );

    const result = await gateway.handleTelegramWebhook(
      {
        callback_query: {
          id: 'callback-1',
          data: 'sup|session-1|approve',
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

  test('treats stale pending confirm callbacks as expired cards instead of generating an UNKNOWN governance result', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const followupMessageStates = new BotFollowupMessageStateRepository(db);
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
      undefined,
      null,
      {
        followupMessageStateRepository: followupMessageStates,
      },
    );

    const result = await gateway.handleTelegramWebhook(
      {
        callback_query: {
          id: 'callback-stale',
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
    expect(requests.find((request) => request.url.includes('answerCallbackQuery'))?.body.text).toBe('这张卡已失效');
    const editRequest = requests.find((request) => request.url.includes('editMessageText'));
    expect(String(editRequest?.body.text)).toContain('这张治理卡已经失效');
    expect(followupMessageStates.findByConversationIssue({
      transport: 'telegram',
      conversation_id: '42',
      issue_id: 'unknown',
    })).toBeNull();

    db.close();
  });

  test('does not let a stale legacy callback cancel a newer pending action from another card', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const followupMessageStates = new BotFollowupMessageStateRepository(db);
    const pendingActions = new BotPendingActionRepository(db);
    followupMessageStates.upsert({
      transport: 'telegram',
      conversation_id: '42',
      issue_id: 'issue-150',
      issue_identifier: 'INT-150',
      message_id: '265',
      card_kind: 'governance_blocked',
      card_key: 'resolved|INT-150',
      card_state: 'resolved',
    });
    pendingActions.upsert({
      transport: 'telegram',
      conversation_id: '42',
      user_id: '9',
      intent_kind: 'retry',
      normalized_payload: {
        command: 'retry',
        issue_id: 'INT-157',
      },
      summary_message: 'Action: retry\nIssue: INT-157\nReply with: 确认 / 取消',
      expires_at: new Date('2026-01-01T00:15:00.000Z'),
      status: 'pending_confirm',
      message_id: '267',
    });

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 265 } }), {
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
        followupMessageStateRepository: followupMessageStates,
        pendingActionRepository: pendingActions,
      },
    );

    const result = await gateway.handleTelegramWebhook(
      {
        callback_query: {
          id: 'callback-stale-cancel',
          data: 'pending|cancel',
          message: {
            chat: { id: 42 },
            message_id: 265,
          },
          from: { id: 9, username: 'alice' },
        },
      } as any,
      {
        'x-telegram-bot-api-secret-token': 'secret',
      },
    );

    expect(result.status).toBe(200);
    expect(requests.find((request) => request.url.includes('answerCallbackQuery'))?.body.text).toBe('这张卡已失效');
    expect(String(requests.find((request) => request.url.includes('editMessageText'))?.body.text)).toContain('这张治理卡已经失效');
    expect(
      pendingActions.findByConversation({
        transport: 'telegram',
        conversation_id: '42',
      })?.status,
    ).toBe('pending_confirm');

    db.close();
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
