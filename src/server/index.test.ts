/**
 * Tests for the minimal symharix HTTP server
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SymHarixServer, shouldLogAccessRequest } from './index';
import { initializeSchema, dropAllTables } from '../database/schema';
import {
  AgentRunRepository,
  ReviewEventRepository,
  WorkItemRepository,
} from '../database';
import type { RuntimeControlPlane } from '../runtime/types';
import type { BotGateway } from '../bots/types';
import { createRuntimeAccessController } from './runtimeAccess';
import { clearTelegramThemePreferences, getTelegramThemePreference } from '../bots/telegramThemePreference';

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('SymHarixServer', () => {
  let db: Database;
  let server: SymHarixServer;
  let runtimeControlPlane: RuntimeControlPlane;
  let botGateway: BotGateway;
  let createIssueCalls: Array<Record<string, unknown>> = [];
  let stopIssueCalls: string[] = [];
  let retryIssueCalls: string[] = [];
  let overrideGovernanceCalls: string[] = [];
  let rewriteGovernanceCalls: string[] = [];
  let splitGovernanceCalls: string[] = [];
  let executeGovernanceSuggestionCalls: Array<{ issueId: string; suggestionId: string }> = [];
  let dismissGovernanceSuggestionCalls: Array<{ issueId: string; suggestionId: string }> = [];
  let telegramWebhookCalls = 0;
  let discordInteractionCalls = 0;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    return server.getApp().request(path, init);
  }

  beforeAll(() => {
    db = new Database(':memory:');
    initializeSchema(db);

    runtimeControlPlane = {
      getOverview: () => ({
        generated_at: '2026-01-01T00:00:00.000Z',
        counts: {
          running: 1,
          retrying: 0,
          total: 1,
        },
        issues: [
          {
            issue_id: 'linear-rt-1',
            work_item_id: 'linear-rt-1',
            identifier: 'INT-RT-1',
            title: 'Runtime view',
            phase: 'DEV',
            tracker_state: 'In Progress',
            orchestrator_state: 'dev_running',
            workspace_path: '/tmp/workspaces/INT-RT-1',
            branch_name: 'feature/int-rt-1',
            github_repo: 'acme/repo',
            github_issue_number: 91,
            active_pr_number: 33,
            session: {
              session_id: 'thread-1-turn-1',
              turn_count: 1,
              stage: 'coding',
              last_event: 'timeline',
              last_message: 'Using Read',
              started_at: '2026-01-01T00:00:00.000Z',
              last_event_at: '2026-01-01T00:01:00.000Z',
              tokens: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
              },
              recent_tools: [],
              recent_files: [],
            },
            actions: {
              can_stop: true,
              can_retry: false,
              can_override_governance: true,
              can_rewrite_governance: true,
              can_split_governance: true,
              can_open_pr: true,
            },
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      getIssue: (id: string) =>
        id === 'linear-rt-1' || id === 'INT-RT-1'
          ? runtimeControlPlane.getOverview().issues[0] ?? null
          : null,
      getTimeline: () => [
        {
          id: 'evt-1',
          issue_id: 'linear-rt-1',
          issue_identifier: 'INT-RT-1',
          timestamp: '2026-01-01T00:01:00.000Z',
          level: 'info',
          category: 'tool',
          code: 'tool_started',
          message: 'Using Read',
          turn: 1,
          tool_name: 'Read',
          detail: {
            path: '/tmp/workspaces/INT-RT-1/app.py',
          },
        },
      ],
      getHistoryView: () => ({
        issue_id: 'linear-rt-1',
        issue_identifier: 'INT-RT-1',
        digest: {
          headline: 'INT-RT-1 · DEV · In Progress',
          detail: 'Live coding session with Read activity.',
          history_blurb: 'Latest review: none',
          updated_at: '2026-01-01T00:01:00.000Z',
        },
        entries: [
          {
            id: 'hist-1',
            issue_id: 'linear-rt-1',
            issue_identifier: 'INT-RT-1',
            source: 'agent_run',
            title: 'Dev run completed',
            summary: 'Implemented runtime view.',
            timestamp: '2026-01-01T00:01:00.000Z',
            detail: null,
          },
        ],
      }),
      createIssue: async (input) => {
        createIssueCalls.push(input as Record<string, unknown>);
        return {
          accepted: true,
          status: 'accepted',
          message: 'Created INT-RT-2',
          issue_id: 'linear-rt-2',
          issue_identifier: 'INT-RT-2',
          issue: null,
        };
      },
      stopIssue: async (id: string) => {
        stopIssueCalls.push(id);
        return {
          accepted: true,
          status: 'accepted',
          message: `Stopping ${id}`,
          issue_id: id,
          issue_identifier: 'INT-RT-1',
        };
      },
      retryIssue: async (id: string) => {
        retryIssueCalls.push(id);
        return {
          accepted: true,
          status: 'queued',
          message: `Queued ${id}`,
          issue_id: id,
          issue_identifier: 'INT-RT-1',
        };
      },
      overrideGovernance: async (id: string) => {
        overrideGovernanceCalls.push(id);
        return {
          accepted: true,
          status: 'accepted',
          message: `Override approved for ${id}`,
          issue_id: id,
          issue_identifier: 'INT-RT-1',
        };
      },
      rewriteGovernance: async (id: string) => {
        rewriteGovernanceCalls.push(id);
        return {
          accepted: true,
          status: 'accepted',
          message: `Rewrite applied for ${id}`,
          issue_id: id,
          issue_identifier: 'INT-RT-1',
        };
      },
      splitGovernance: async (id: string) => {
        splitGovernanceCalls.push(id);
        return {
          accepted: true,
          status: 'accepted',
          message: `Split applied for ${id}`,
          issue_id: id,
          issue_identifier: 'INT-RT-1',
        };
      },
      executeGovernanceSuggestion: async (id: string, suggestionId: string) => {
        executeGovernanceSuggestionCalls.push({ issueId: id, suggestionId });
        return {
          accepted: true,
          status: 'accepted',
          message: `Executed ${suggestionId} for ${id}`,
          issue_id: id,
          issue_identifier: 'INT-RT-1',
        };
      },
      dismissGovernanceSuggestion: async (id: string, suggestionId: string) => {
        dismissGovernanceSuggestionCalls.push({ issueId: id, suggestionId });
        return {
          accepted: true,
          status: 'accepted',
          message: `Dismissed ${suggestionId} for ${id}`,
          issue_id: id,
          issue_identifier: 'INT-RT-1',
        };
      },
      createStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: snapshot\\ndata: {"generated_at":"2026-01-01T00:00:00.000Z","counts":{"running":1,"retrying":0,"total":1},"issues":[]}\\n\\n',
              ),
            );
          },
        }),
      subscribe: () => () => undefined,
    };

    botGateway = {
      getManifest: () => ({
        transports: {
          telegram: {
            enabled: true,
            inbound_enabled: true,
            outbound_enabled: true,
            watch_supported: true,
            write_requires_operator: false,
            inbound_path: '/api/v1/bots/telegram/webhook',
          },
          discord: {
            enabled: true,
            inbound_enabled: true,
            outbound_enabled: true,
            watch_supported: true,
            write_requires_operator: false,
            inbound_path: '/api/v1/bots/discord/interactions',
          },
        },
        commands: ['help', 'status', 'new', 'watch', 'unwatch', 'stop', 'retry', 'close', 'supersede', 'override', 'rewrite', 'split'],
        watch_presets: ['default', 'verbose', 'failures', 'status'],
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      }),
      handleTelegramWebhook: async () => {
        telegramWebhookCalls += 1;
        return {
          ok: true,
          status: 200,
          body: { ok: true },
        };
      },
      handleDiscordInteraction: async () => {
        discordInteractionCalls += 1;
        return {
          status: 200,
          body: { type: 4, data: { content: 'pong', flags: 64 } },
        };
      },
      dispose: () => undefined,
    };

    server = new SymHarixServer(db, {
      port: 0,
      hostname: '127.0.0.1',
      corsOrigins: ['*'],
    }, runtimeControlPlane, botGateway);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    dropAllTables(db);
    initializeSchema(db);
    clearTelegramThemePreferences();
    createIssueCalls = [];
    stopIssueCalls = [];
    retryIssueCalls = [];
    overrideGovernanceCalls = [];
    rewriteGovernanceCalls = [];
    splitGovernanceCalls = [];
    executeGovernanceSuggestionCalls = [];
    dismissGovernanceSuggestionCalls = [];
    telegramWebhookCalls = 0;
    discordInteractionCalls = 0;
  });

  test('GET / returns minimal server info', async () => {
    const response = await request('/');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.endpoints.health).toBe('/api/v1/health');
    expect(payload.data.endpoints.workItems).toBe('/api/v1/work-items');
    expect(payload.data.endpoints.runtimeOverview).toBe('/api/v1/runtime/overview');
    expect(payload.data.endpoints.runtimeManifest).toBe('/api/v1/runtime/manifest');
    expect(payload.data.endpoints.runtimeApp).toBe('/runtime');
    expect(payload.data.endpoints.botsManifest).toBe('/api/v1/bots/manifest');
  });

  test('GET /api/v1/health returns health status', async () => {
    const response = await request('/api/v1/health');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.status).toBeDefined();
    expect(payload.data.checks.database).toBe(true);
  });

  test('GET /api/v1/health does not degrade only because the heap is near its current allocation', async () => {
    const originalMemoryUsage = process.memoryUsage;
    Object.defineProperty(process, 'memoryUsage', {
      configurable: true,
      value: () => ({
        rss: 96 * 1024 * 1024,
        heapTotal: 100,
        heapUsed: 95,
        external: 0,
        arrayBuffers: 0,
      }),
    });

    try {
      const response = await request('/api/v1/health');
      const payload = await readJson<any>(response);
      expect(payload.data.status).toBe('healthy');
      expect(payload.data.checks.memory).toBe(true);
    } finally {
      Object.defineProperty(process, 'memoryUsage', {
        configurable: true,
        value: originalMemoryUsage,
      });
    }
  });

  test('GET /api/v1/work-items returns control-plane work items', async () => {
    const workItemRepo = new WorkItemRepository(db);
    workItemRepo.create({
      id: 'wi-1',
      linear_issue_id: 'linear-1',
      linear_identifier: 'INT-1',
      linear_title: 'Control plane item',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      github_issue_number: 501,
      active_pr_number: 77,
      orchestrator_state: 'review_running',
    });

    const response = await request('/api/v1/work-items');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].linear_identifier).toBe('INT-1');
  });

  test('GET /api/v1/work-items/:id returns a specific work item', async () => {
    const workItemRepo = new WorkItemRepository(db);
    workItemRepo.create({
      id: 'wi-2',
      linear_issue_id: 'linear-2',
      linear_identifier: 'INT-2',
      linear_title: 'Specific work item',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
    });

    const response = await request('/api/v1/work-items/wi-2');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.id).toBe('wi-2');
  });

  test('GET /api/v1/work-items/:id/runs returns agent runs', async () => {
    const workItemRepo = new WorkItemRepository(db);
    const agentRunRepo = new AgentRunRepository(db);

    workItemRepo.create({
      id: 'wi-3',
      linear_issue_id: 'linear-3',
      linear_identifier: 'INT-3',
      linear_title: 'Runs item',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
    });
    agentRunRepo.create({
      id: 'run-1',
      work_item_id: 'wi-3',
      agent_type: 'dev',
      phase: 'dev',
      input_summary: 'GitHub context',
    });

    const response = await request('/api/v1/work-items/wi-3/runs');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].id).toBe('run-1');
  });

  test('GET /api/v1/work-items/:id/reviews returns review history', async () => {
    const workItemRepo = new WorkItemRepository(db);
    const reviewEventRepo = new ReviewEventRepository(db);

    workItemRepo.create({
      id: 'wi-4',
      linear_issue_id: 'linear-4',
      linear_identifier: 'INT-4',
      linear_title: 'Reviews item',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      active_pr_number: 88,
    });
    reviewEventRepo.create({
      id: 'review-1',
      work_item_id: 'wi-4',
      pr_number: 88,
      review_round: 1,
      decision: 'REQUEST_CHANGES',
      summary_md: 'Please add tests',
    });

    const response = await request('/api/v1/work-items/wi-4/reviews');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].decision).toBe('REQUEST_CHANGES');
  });

  test('GET /runtime serves the lightweight runtime page', async () => {
    const response = await request('/runtime');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const html = await response.text();
    expect(html).toContain('symharix Runtime');
    expect(html).toContain('Command Deck');
    expect(html).toContain('Access token');
    expect(html).toContain('New Issue');
    expect(html).toContain('Hot queue');
    expect(html).toContain('High-signal timeline');
    expect(html).toContain('Focus inspector');
    expect(html).toContain('/api/v1/runtime/overview');
  });

  test('GET /runtime includes root-thread pause and handoff inspector semantics', async () => {
    const response = await request('/runtime');
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('Root-thread pause');
    expect(html).toContain('Expected handoff');
    expect(html).toContain('Queued children');
    expect(html).toContain('governance_pause_reason');
    expect(html).toContain('governance_expected_handoff');
    expect(html).toContain('governance_queued_child_identifiers');
  });

  test('GET /runtime includes supervisor session planning semantics', async () => {
    const response = await request('/runtime');
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('Supervisor plan');
    expect(html).toContain('Session state');
    expect(html).toContain('supervisor_plan_summary');
    expect(html).toContain('supervisor_session_state');
  });

  test('GET /runtime/issues/:id/app serves the Telegram Mini App issue cockpit', async () => {
    const response = await request('/runtime/issues/INT-RT-1/app');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const html = await response.text();
    expect(html).toContain('telegram-web-app.js');
    expect(html).toContain('SymHarix');
    expect(html).toContain('issue cockpit');
    expect(html).toContain('INT-RT-1');
    expect(html).toContain('/api/v1/runtime/issues/INT-RT-1');
    expect(html).toContain('/api/v1/runtime/issues/INT-RT-1/timeline');
    expect(html).toContain('/api/v1/runtime/issues/INT-RT-1/history');
    expect(html).toContain('实时事件流');
    expect(html).toContain('当前轮次目标');
    expect(html).toContain('Agent 进度');
    expect(html).toContain('关键节点');
    expect(html).toContain('risk_delta');
    expect(html).toContain('agent_recent_progress');
    expect(html).toContain('riskDelta');
    expect(html).toContain('agentRecentProgress');
    expect(html).toContain('milestones');
    expect(html).toContain('子任务队列');
  });

  test('GET /api/v1/runtime/overview returns runtime snapshot data', async () => {
    const response = await request('/api/v1/runtime/overview');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.counts.running).toBe(1);
    expect(payload.data.issues[0].identifier).toBe('INT-RT-1');
  });

  test('GET /api/v1/runtime/issues/:id returns a runtime issue view', async () => {
    const response = await request('/api/v1/runtime/issues/INT-RT-1');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.issue_id).toBe('linear-rt-1');
    expect(payload.data.identifier).toBe('INT-RT-1');
  });

  test('POST /api/v1/runtime/telegram/theme-preference stores Telegram theme preference', async () => {
    const response = await request('/api/v1/runtime/telegram/theme-preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: '8552378102',
        theme: 'dark',
      }),
    });

    expect(response.status).toBe(200);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.theme).toBe('dark');
    expect(getTelegramThemePreference('8552378102')).toBe('dark');
  });

  test('POST /api/v1/runtime/issues creates a runtime issue', async () => {
    const response = await request('/api/v1/runtime/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Create from web',
        description: 'desc',
        team_id: 'team-1',
        project_slug: 'test2',
        project_id: 'project-1',
        state_id: 'state-1',
      }),
    });

    expect(response.status).toBe(201);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.issue_identifier).toBe('INT-RT-2');
    expect(createIssueCalls).toHaveLength(1);
    expect(createIssueCalls[0]?.project_slug).toBe('test2');
  });

  test('POST /api/v1/runtime/issues rejects missing title', async () => {
    const response = await request('/api/v1/runtime/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'desc only',
      }),
    });

    expect(response.status).toBe(400);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe('title is required');
  });

  test('POST /api/v1/runtime/issues/:id/stop proxies stop control actions', async () => {
    const response = await request('/api/v1/runtime/issues/linear-rt-1/stop', {
      method: 'POST',
    });

    expect(response.status).toBe(202);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.message).toContain('Stopping linear-rt-1');
    expect(stopIssueCalls).toEqual(['linear-rt-1']);
  });

  test('POST /api/v1/runtime/issues/:id/retry proxies retry control actions', async () => {
    const response = await request('/api/v1/runtime/issues/INT-RT-1/retry', {
      method: 'POST',
    });

    expect(response.status).toBe(202);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.message).toContain('Queued INT-RT-1');
    expect(retryIssueCalls).toEqual(['INT-RT-1']);
  });

  test('POST /api/v1/runtime/issues/:id/governance/override proxies governance override actions', async () => {
    const response = await request('/api/v1/runtime/issues/INT-RT-1/governance/override', {
      method: 'POST',
    });

    expect(response.status).toBe(202);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.message).toContain('Override approved');
    expect(overrideGovernanceCalls).toEqual(['INT-RT-1']);
  });

  test('POST /api/v1/runtime/issues/:id/governance/rewrite proxies governance rewrite actions', async () => {
    const response = await request('/api/v1/runtime/issues/INT-RT-1/governance/rewrite', {
      method: 'POST',
    });

    expect(response.status).toBe(202);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.message).toContain('Rewrite applied');
    expect(rewriteGovernanceCalls).toEqual(['INT-RT-1']);
  });

  test('POST /api/v1/runtime/issues/:id/governance/split proxies governance split actions', async () => {
    const response = await request('/api/v1/runtime/issues/INT-RT-1/governance/split', {
      method: 'POST',
    });

    expect(response.status).toBe(202);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.message).toContain('Split applied');
    expect(splitGovernanceCalls).toEqual(['INT-RT-1']);
  });

  test('POST /api/v1/runtime/issues/:id/governance/suggestions/:suggestionId/execute proxies suggestion execution', async () => {
    const response = await request('/api/v1/runtime/issues/INT-RT-1/governance/suggestions/suggestion-1/execute', {
      method: 'POST',
    });

    expect(response.status).toBe(202);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.message).toContain('Executed');
    expect(executeGovernanceSuggestionCalls).toEqual([
      { issueId: 'INT-RT-1', suggestionId: 'suggestion-1' },
    ]);
  });

  test('POST /api/v1/runtime/issues/:id/governance/suggestions/:suggestionId/dismiss proxies suggestion dismissal', async () => {
    const response = await request('/api/v1/runtime/issues/INT-RT-1/governance/suggestions/suggestion-1/dismiss', {
      method: 'POST',
    });

    expect(response.status).toBe(202);
    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.message).toContain('Dismissed');
    expect(dismissGovernanceSuggestionCalls).toEqual([
      { issueId: 'INT-RT-1', suggestionId: 'suggestion-1' },
    ]);
  });

  test('GET /api/v1/runtime/stream returns SSE snapshot', async () => {
    const response = await request('/api/v1/runtime/stream');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();
    const text = new TextDecoder().decode(chunk?.value);
    expect(text).toContain('event: snapshot');
  });

  test('GET /api/v1/runtime/manifest returns access and feature flags', async () => {
    const response = await request('/api/v1/runtime/manifest');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.features.history_replay).toBe(true);
    expect(payload.data.features.subscription_preferences).toBe(true);
    expect(payload.data.access.viewer_role).toBe('operator');
  });

  test('GET /api/v1/runtime/issues/:id/history returns replay history', async () => {
    const response = await request('/api/v1/runtime/issues/INT-RT-1/history');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.digest.headline).toContain('INT-RT-1');
    expect(payload.data.entries[0].title).toContain('Dev run');
  });

  test('GET /api/v1/bots/manifest returns thin adapter capabilities', async () => {
    const response = await request('/api/v1/bots/manifest');
    expect(response.status).toBe(200);

    const payload = await readJson<any>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.transports.telegram.inbound_path).toBe('/api/v1/bots/telegram/webhook');
    expect(payload.data.transports.telegram.watch_supported).toBe(true);
    expect(payload.data.transports.telegram.write_requires_operator).toBe(false);
    expect(payload.data.transports.discord.outbound_enabled).toBe(true);
    expect(payload.data.transports.discord.write_requires_operator).toBe(false);
    expect(payload.data.commands).toContain('watch');
    expect(payload.data.watch_presets).toEqual(['default', 'verbose', 'failures', 'status']);
    expect(payload.data.assistant.configured).toBe(false);
    expect(payload.data.assistant.health).toBe('unconfigured');
    expect(payload.data.assistant.fallback_available).toBe(true);
  });

  test('access logger skips noisy tunnel and manifest health probes', () => {
    expect(shouldLogAccessRequest('GET', '/')).toBe(false);
    expect(shouldLogAccessRequest('GET', '/api/v1/bots/manifest')).toBe(false);
    expect(shouldLogAccessRequest('POST', '/api/v1/bots/telegram/webhook')).toBe(true);
  });

  test('POST /api/v1/bots/telegram/webhook proxies Telegram updates to the bot gateway', async () => {
    const response = await request('/api/v1/bots/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          text: '/status',
          chat: { id: 123 },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(telegramWebhookCalls).toBe(1);
  });

  test('POST /api/v1/bots/discord/interactions proxies Discord interactions to the bot gateway', async () => {
    const response = await request('/api/v1/bots/discord/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 1 }),
    });

    expect(response.status).toBe(200);
    const payload = await readJson<any>(response);
    expect(payload.type).toBe(4);
    expect(discordInteractionCalls).toBe(1);
  });

  test('start bootstraps bot inbound integration against the local server URL', async () => {
    const bootstrapCalls: Array<{ localBaseUrl: string; inboundPath?: string }> = [];
    const bootstrapGateway: BotGateway = {
      getManifest: () => ({
        transports: {
          telegram: {
            enabled: true,
            inbound_enabled: true,
            outbound_enabled: true,
            watch_supported: true,
            write_requires_operator: false,
            inbound_path: '/api/v1/bots/telegram/webhook',
          },
          discord: {
            enabled: false,
            inbound_enabled: false,
            outbound_enabled: false,
            watch_supported: false,
            write_requires_operator: false,
            inbound_path: '/api/v1/bots/discord/interactions',
          },
        },
        commands: ['help'],
        watch_presets: ['default'],
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: null,
        },
      }) as any,
      initializeInboundIntegration: async (params) => {
        bootstrapCalls.push(params);
      },
      handleTelegramWebhook: async () => ({ ok: true, status: 200, body: { ok: true } }),
      handleDiscordInteraction: async () => ({ status: 200, body: { ok: true } }),
    };

    const startedServer = new SymHarixServer(
      db,
      { port: 0 },
      null,
      bootstrapGateway,
      createRuntimeAccessController(),
    );

    try {
      await startedServer.start();
      expect(bootstrapCalls).toHaveLength(1);
      expect(bootstrapCalls[0]?.localBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(bootstrapCalls[0]?.inboundPath).toBe('/api/v1/bots/telegram/webhook');
    } finally {
      await startedServer.stop();
    }
  });

  test('POST runtime mutations require a write token when runtime access is protected', async () => {
    const protectedServer = new (SymHarixServer as any)(
      db,
      {
        port: 0,
        hostname: '127.0.0.1',
        corsOrigins: ['*'],
      },
      runtimeControlPlane,
      botGateway,
      createRuntimeAccessController({ writeToken: 'secret-token' }),
    );

    const denied = await protectedServer.getApp().request('/api/v1/runtime/issues/INT-RT-1/retry', {
      method: 'POST',
    });
    expect(denied.status).toBe(403);

    const allowed = await protectedServer.getApp().request('/api/v1/runtime/issues/INT-RT-1/retry', {
      method: 'POST',
      headers: {
        'x-symphony-runtime-token': 'secret-token',
      },
    });
    expect(allowed.status).toBe(202);
  });
});
