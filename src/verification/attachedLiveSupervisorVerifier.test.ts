import { describe, expect, test } from 'bun:test';
import { verifyAttachedLiveSupervisor, verifyAttachedLiveSupervisorMatrix } from './attachedLiveSupervisorVerifier';

describe('verifyAttachedLiveSupervisor', () => {
  test('enters through Telegram webhook and never creates issues through the runtime API directly', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let now = 0;
    let manifestPolls = 0;
    let overviewPolls = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const normalizedUrl = String(url);
      calls.push({ url: normalizedUrl, init });

      if (normalizedUrl.endsWith('/api/v1/bots/manifest')) {
        manifestPolls += 1;
        return Response.json({
          success: true,
          data: {
            transports: {
              telegram: { health: 'healthy' },
            },
            supervisor: {
              active_sessions: manifestPolls < 2
                ? []
                : [{
                    session_id: 'session-live',
                    transport: 'telegram',
                    conversation_id: '7570067877',
                    state: manifestPolls < 3 ? 'awaiting_user_approval' : 'executing',
                    active_decision_kind: manifestPolls < 3 ? 'plan_approval' : null,
                    title: 'Supervisor attached live E2E verifier-test',
                    repo_ref: 'test2',
                    root_issue_id: manifestPolls < 3 ? null : 'issue-live',
                    updated_at: '2026-01-01T00:00:00.000Z',
                  }],
            },
          },
        });
      }

      if (normalizedUrl.endsWith('/api/v1/bots/telegram/webhook')) {
        return Response.json({ ok: true });
      }

      if (normalizedUrl.endsWith('/api/v1/runtime/overview')) {
        overviewPolls += 1;
        return Response.json({
          success: true,
          data: {
            generated_at: '2026-01-01T00:00:00.000Z',
            counts: { running: 1, retrying: 0, total: 1 },
            issues: overviewPolls < 2
              ? []
              : [{
                  issue_id: 'issue-live',
                  identifier: 'INT-99',
                  title: 'Renamed supervisor plan',
                  created_at: '2026-01-01T00:00:01.000Z',
                  updated_at: '2026-01-01T00:00:01.000Z',
                  github_repo: 'UniUni2000/test2',
                  branch_name: 'feature/int-99',
                  active_pr_number: 99,
                  github_issue_number: 98,
                  supervisor_session_state: 'executing',
                }],
          },
        });
      }

      if (normalizedUrl.endsWith('/api/v1/runtime/issues/issue-live')) {
        return Response.json({
          success: true,
          data: {
            issue_id: 'issue-live',
            identifier: 'INT-99',
            title: 'Supervisor attached live E2E verifier-test',
            orchestrator_state: 'completed',
            delivery_state: 'completed',
            delivery_summary: 'completed',
            github_repo: 'UniUni2000/test2',
            branch_name: 'feature/int-99',
            active_pr_number: 99,
            github_issue_number: 98,
            supervisor_session_state: 'completed',
          },
        });
      }

      throw new Error(`unexpected fetch ${normalizedUrl}`);
    }) as typeof fetch;

    const result = await verifyAttachedLiveSupervisor({
      serverUrl: 'http://localhost:3000',
      projectSlug: 'test2',
      telegramChatId: '7570067877',
      titleSuffix: 'verifier-test',
      timeoutMs: 30_000,
      fetchImpl,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      webhookSecret: 'secret',
    });

    expect(result.success).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/api/v1/runtime/issues') && call.init?.method === 'POST')).toBe(false);
    const webhookTexts = calls
      .filter((call) => call.url.endsWith('/api/v1/bots/telegram/webhook'))
      .map((call) => JSON.parse(String(call.init?.body)).message.text);
    expect(webhookTexts[0]).toContain('新开线程');
    expect(webhookTexts).toContain('批准并开始');
  });

  test('fails fast when the Telegram request materializes before a Plan Card approval', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let now = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const normalizedUrl = String(url);
      calls.push({ url: normalizedUrl, init });

      if (normalizedUrl.endsWith('/api/v1/bots/manifest')) {
        return Response.json({
          success: true,
          data: {
            transports: {
              telegram: { health: 'healthy' },
            },
            supervisor: {
              active_sessions: [{
                session_id: 'session-live',
                transport: 'telegram',
                conversation_id: '7570067877',
                state: 'executing',
                active_decision_kind: null,
                title: 'Supervisor attached live E2E verifier-premature',
                repo_ref: 'test2',
                root_issue_id: 'issue-live',
                updated_at: '2026-01-01T00:00:01.000Z',
              }],
            },
          },
        });
      }

      if (normalizedUrl.endsWith('/api/v1/bots/telegram/webhook')) {
        return Response.json({ ok: true });
      }

      throw new Error(`unexpected fetch ${normalizedUrl}`);
    }) as typeof fetch;

    const result = await verifyAttachedLiveSupervisor({
      serverUrl: 'http://localhost:3000',
      projectSlug: 'test2',
      telegramChatId: '7570067877',
      titleSuffix: 'verifier-premature',
      timeoutMs: 30_000,
      fetchImpl,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      webhookSecret: 'secret',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('materialized before Telegram Plan Card approval');
    const webhookTexts = calls
      .filter((call) => call.url.endsWith('/api/v1/bots/telegram/webhook'))
      .map((call) => JSON.parse(String(call.init?.body)).message.text);
    expect(webhookTexts).not.toContain('批准并开始');
  });

  test('uses governed split wording for the governed split scenario', async () => {
    const webhookTexts: string[] = [];
    let now = 0;
    let manifestPolls = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const normalizedUrl = String(url);
      if (normalizedUrl.endsWith('/api/v1/bots/manifest')) {
        manifestPolls += 1;
        return Response.json({
          success: true,
          data: {
            transports: { telegram: { health: 'healthy' } },
            supervisor: {
              active_sessions: manifestPolls < 2
                ? []
                : [{
                    session_id: 'session-split',
                    transport: 'telegram',
                    conversation_id: '7570067877',
                    state: manifestPolls < 3 ? 'awaiting_user_approval' : 'executing',
                    active_decision_kind: manifestPolls < 3 ? 'plan_approval' : null,
                    title: 'governed-split verifier-split',
                    repo_ref: 'test2',
                    root_issue_id: manifestPolls < 3 ? null : 'issue-split',
                    updated_at: '2026-01-01T00:00:00.000Z',
                  }],
            },
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/bots/telegram/webhook')) {
        webhookTexts.push(JSON.parse(String(init?.body)).message.text);
        return Response.json({ ok: true });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/overview')) {
        return Response.json({
          success: true,
          data: {
            generated_at: '2026-01-01T00:00:00.000Z',
            counts: { running: 1, retrying: 0, total: 1 },
            issues: [{
              issue_id: 'issue-split',
              identifier: 'INT-101',
              title: 'governed-split verifier-split',
              created_at: '2026-01-01T00:00:01.000Z',
              updated_at: '2026-01-01T00:00:01.000Z',
              github_repo: 'UniUni2000/test2',
              branch_name: 'feature/int-101',
              supervisor_session_state: 'executing',
            }],
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/issues/issue-split')) {
        return Response.json({
          success: true,
          data: {
            issue_id: 'issue-split',
            identifier: 'INT-101',
            title: 'governed-split verifier-split',
            orchestrator_state: 'completed',
            delivery_state: 'completed',
            delivery_summary: 'completed',
            github_repo: 'UniUni2000/test2',
            branch_name: 'feature/int-101',
            supervisor_session_state: 'completed',
            governance_child_queue: [
              { issue_identifier: 'INT-102', queue_state: 'current' },
              { issue_identifier: 'INT-103', queue_state: 'queued' },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch ${normalizedUrl}`);
    }) as typeof fetch;

    const result = await verifyAttachedLiveSupervisor({
      serverUrl: 'http://localhost:3000',
      projectSlug: 'test2',
      telegramChatId: '7570067877',
      titleSuffix: 'verifier-split',
      supervisorLiveScenario: 'governed_split',
      timeoutMs: 30_000,
      fetchImpl,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      webhookSecret: 'secret',
    });

    expect(result.success).toBe(true);
    expect(webhookTexts[0]).toContain('拆成两个顺序子任务');
    expect(webhookTexts[0]).toContain('root + child queue');
  });

  test('uses a concrete committable marker path for destructive cleanup verification', async () => {
    const webhookTexts: string[] = [];
    let now = 0;
    let manifestPolls = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const normalizedUrl = String(url);
      if (normalizedUrl.endsWith('/api/v1/bots/manifest')) {
        manifestPolls += 1;
        return Response.json({
          success: true,
          data: {
            transports: { telegram: { health: 'healthy' } },
            supervisor: {
              active_sessions: manifestPolls < 2
                ? []
                : [{
                    session_id: 'session-destructive',
                    transport: 'telegram',
                    conversation_id: '7570067877',
                    state: manifestPolls < 3 ? 'awaiting_user_approval' : 'executing',
                    active_decision_kind: manifestPolls < 3 ? 'plan_approval' : null,
                    title: 'destructive cleanup verifier-destructive',
                    repo_ref: 'test2',
                    root_issue_id: manifestPolls < 3 ? null : 'issue-destructive',
                    updated_at: '2026-01-01T00:00:00.000Z',
                  }],
            },
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/bots/telegram/webhook')) {
        webhookTexts.push(JSON.parse(String(init?.body)).message.text);
        return Response.json({ ok: true });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/overview')) {
        return Response.json({
          success: true,
          data: {
            generated_at: '2026-01-01T00:00:00.000Z',
            counts: { running: 1, retrying: 0, total: 1 },
            issues: [{
              issue_id: 'issue-destructive',
              identifier: 'INT-108',
              title: 'destructive cleanup verifier-destructive',
              created_at: '2026-01-01T00:00:01.000Z',
              updated_at: '2026-01-01T00:00:01.000Z',
              github_repo: 'UniUni2000/test2',
              branch_name: 'feature/int-108',
              supervisor_session_state: 'executing',
            }],
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/issues/issue-destructive')) {
        return Response.json({
          success: true,
          data: {
            issue_id: 'issue-destructive',
            identifier: 'INT-108',
            title: 'destructive cleanup verifier-destructive',
            orchestrator_state: 'completed',
            delivery_state: 'completed',
            delivery_summary: 'completed',
            github_repo: 'UniUni2000/test2',
            branch_name: 'feature/int-108',
            supervisor_session_state: 'completed',
          },
        });
      }
      throw new Error(`unexpected fetch ${normalizedUrl}`);
    }) as typeof fetch;

    const result = await verifyAttachedLiveSupervisor({
      serverUrl: 'http://localhost:3000',
      projectSlug: 'test2',
      telegramChatId: '7570067877',
      titleSuffix: 'verifier-destructive',
      supervisorLiveScenario: 'destructive_cleanup',
      timeoutMs: 30_000,
      fetchImpl,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      webhookSecret: 'secret',
    });

    expect(result.success).toBe(true);
    expect(webhookTexts[0]).toContain('docs/supervisor-live-cleanup-approval-verifier-destructive.md');
    expect(webhookTexts[0]).toContain('不要把最终交付文件放在 .symphony/');
    expect(webhookTexts[0]).toContain('不要拆分');
    expect(webhookTexts[0]).toContain('不要创建 child queue');
    expect(webhookTexts[0]).toContain('不要扫描全仓');
  });

  test('fails the governed split scenario when completion has no root child queue', async () => {
    let now = 0;
    let manifestPolls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const normalizedUrl = String(url);
      if (normalizedUrl.endsWith('/api/v1/bots/manifest')) {
        manifestPolls += 1;
        return Response.json({
          success: true,
          data: {
            transports: { telegram: { health: 'healthy' } },
            supervisor: {
              active_sessions: manifestPolls < 2
                ? []
                : [{
                    session_id: 'session-no-split',
                    transport: 'telegram',
                    conversation_id: '7570067877',
                    state: manifestPolls < 3 ? 'awaiting_user_approval' : 'executing',
                    active_decision_kind: manifestPolls < 3 ? 'plan_approval' : null,
                    title: 'governed-split verifier-no-split',
                    repo_ref: 'test2',
                    root_issue_id: manifestPolls < 3 ? null : 'issue-no-split',
                    updated_at: '2026-01-01T00:00:00.000Z',
                  }],
            },
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/bots/telegram/webhook')) {
        return Response.json({ ok: true });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/overview')) {
        return Response.json({
          success: true,
          data: {
            generated_at: '2026-01-01T00:00:00.000Z',
            counts: { running: 0, retrying: 0, total: 1 },
            issues: [{
              issue_id: 'issue-no-split',
              identifier: 'INT-104',
              title: 'governed-split verifier-no-split',
              created_at: '2026-01-01T00:00:01.000Z',
              updated_at: '2026-01-01T00:00:01.000Z',
              github_repo: 'UniUni2000/test2',
              branch_name: 'feature/int-104',
              supervisor_session_state: 'completed',
            }],
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/issues/issue-no-split')) {
        return Response.json({
          success: true,
          data: {
            issue_id: 'issue-no-split',
            identifier: 'INT-104',
            title: 'governed-split verifier-no-split',
            orchestrator_state: 'completed',
            delivery_state: 'completed',
            delivery_summary: 'completed without children',
            github_repo: 'UniUni2000/test2',
            branch_name: 'feature/int-104',
            supervisor_session_state: 'completed',
            governance_child_queue: [],
          },
        });
      }
      throw new Error(`unexpected fetch ${normalizedUrl}`);
    }) as typeof fetch;

    const result = await verifyAttachedLiveSupervisor({
      serverUrl: 'http://localhost:3000',
      projectSlug: 'test2',
      telegramChatId: '7570067877',
      titleSuffix: 'verifier-no-split',
      supervisorLiveScenario: 'governed_split',
      timeoutMs: 30_000,
      fetchImpl,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      webhookSecret: 'secret',
    });

    expect(result.success).toBe(false);
    expect(result.failure_code).toBe('missing_split_child_queue');
  });

  test('accepts governed split completion when the root thread is resolved and all children completed', async () => {
    let now = 0;
    let manifestPolls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const normalizedUrl = String(url);
      if (normalizedUrl.endsWith('/api/v1/bots/manifest')) {
        manifestPolls += 1;
        return Response.json({
          success: true,
          data: {
            transports: { telegram: { health: 'healthy' } },
            supervisor: {
              active_sessions: manifestPolls < 2
                ? []
                : [{
                    session_id: 'session-split-resolved',
                    transport: 'telegram',
                    conversation_id: '7570067877',
                    state: manifestPolls < 3 ? 'awaiting_user_approval' : 'completed',
                    active_decision_kind: manifestPolls < 3 ? 'plan_approval' : null,
                    title: 'governed-split verifier-resolved',
                    repo_ref: 'test2',
                    root_issue_id: manifestPolls < 3 ? null : 'issue-split-resolved',
                    updated_at: '2026-01-01T00:00:00.000Z',
                  }],
            },
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/bots/telegram/webhook')) {
        return Response.json({ ok: true });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/overview')) {
        return Response.json({
          success: true,
          data: {
            generated_at: '2026-01-01T00:00:00.000Z',
            counts: { running: 0, retrying: 0, total: 1 },
            issues: [{
              issue_id: 'issue-split-resolved',
              identifier: 'INT-105',
              title: 'governed-split verifier-resolved',
              created_at: '2026-01-01T00:00:01.000Z',
              updated_at: '2026-01-01T00:00:01.000Z',
              github_repo: 'UniUni2000/test2',
              branch_name: null,
              supervisor_session_state: 'completed',
            }],
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/issues/issue-split-resolved')) {
        return Response.json({
          success: true,
          data: {
            issue_id: 'issue-split-resolved',
            identifier: 'INT-105',
            title: 'governed-split verifier-resolved',
            orchestrator_state: 'halted',
            delivery_state: null,
            delivery_summary: 'all children completed',
            github_repo: 'UniUni2000/test2',
            branch_name: null,
            supervisor_session_state: 'completed',
            governance_thread_state: 'resolved',
            governance_child_queue: [
              { issue_identifier: 'INT-106', queue_state: 'completed' },
              { issue_identifier: 'INT-107', queue_state: 'completed' },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch ${normalizedUrl}`);
    }) as typeof fetch;

    const result = await verifyAttachedLiveSupervisor({
      serverUrl: 'http://localhost:3000',
      projectSlug: 'test2',
      telegramChatId: '7570067877',
      titleSuffix: 'verifier-resolved',
      supervisorLiveScenario: 'governed_split',
      timeoutMs: 30_000,
      fetchImpl,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      webhookSecret: 'secret',
    });

    expect(result.success).toBe(true);
  });

  test('continues waiting when delivery_failed is paired with retry_scheduled and later completes', async () => {
    let now = 0;
    let manifestPolls = 0;
    let issuePolls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const normalizedUrl = String(url);
      if (normalizedUrl.endsWith('/api/v1/bots/manifest')) {
        manifestPolls += 1;
        return Response.json({
          success: true,
          data: {
            transports: { telegram: { health: 'healthy' } },
            supervisor: {
              active_sessions: manifestPolls < 2
                ? []
                : [{
                    session_id: 'session-retry',
                    transport: 'telegram',
                    conversation_id: '7570067877',
                    state: manifestPolls < 3 ? 'awaiting_user_approval' : 'executing',
                    active_decision_kind: manifestPolls < 3 ? 'plan_approval' : null,
                    title: 'Supervisor attached live E2E verifier-retry',
                    repo_ref: 'test2',
                    root_issue_id: manifestPolls < 3 ? null : 'issue-retry',
                    updated_at: '2026-01-01T00:00:00.000Z',
                  }],
            },
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/bots/telegram/webhook')) {
        return Response.json({ ok: true });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/overview')) {
        return Response.json({
          success: true,
          data: {
            generated_at: '2026-01-01T00:00:00.000Z',
            counts: { running: 0, retrying: 1, total: 1 },
            issues: [{
              issue_id: 'issue-retry',
              identifier: 'INT-102',
              title: 'Supervisor attached live E2E verifier-retry',
              created_at: '2026-01-01T00:00:01.000Z',
              updated_at: '2026-01-01T00:00:01.000Z',
              github_repo: 'UniUni2000/test2',
              branch_name: 'feature/int-102',
              supervisor_session_state: 'executing',
            }],
          },
        });
      }
      if (normalizedUrl.endsWith('/api/v1/runtime/issues/issue-retry')) {
        issuePolls += 1;
        return Response.json({
          success: true,
          data: issuePolls < 2
            ? {
                issue_id: 'issue-retry',
                identifier: 'INT-102',
                title: 'Supervisor attached live E2E verifier-retry',
                orchestrator_state: 'retry_scheduled',
                delivery_state: 'delivery_failed',
                delivery_summary: 'Temporary delivery failure; retry is queued.',
                github_repo: 'UniUni2000/test2',
                branch_name: 'feature/int-102',
                supervisor_session_state: 'executing',
              }
            : {
                issue_id: 'issue-retry',
                identifier: 'INT-102',
                title: 'Supervisor attached live E2E verifier-retry',
                orchestrator_state: 'completed',
                delivery_state: 'completed',
                delivery_summary: 'completed after retry',
                github_repo: 'UniUni2000/test2',
                branch_name: 'feature/int-102',
                supervisor_session_state: 'completed',
              },
        });
      }
      throw new Error(`unexpected fetch ${normalizedUrl}`);
    }) as typeof fetch;

    const result = await verifyAttachedLiveSupervisor({
      serverUrl: 'http://localhost:3000',
      projectSlug: 'test2',
      telegramChatId: '7570067877',
      titleSuffix: 'verifier-retry',
      timeoutMs: 30_000,
      fetchImpl,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      webhookSecret: 'secret',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('completed');
    expect(issuePolls).toBeGreaterThanOrEqual(2);
  });

  test('matrix runs every requested supervisor scenario through Telegram', async () => {
    const scenarios: string[] = [];
    const results = await verifyAttachedLiveSupervisorMatrix({
      serverUrl: 'http://localhost:3000',
      projectSlug: 'test2',
      telegramChatId: '7570067877',
      titleSuffix: 'matrix-test',
      scenarios: ['simple', 'destructive_cleanup'],
      verifier: async (input) => {
        scenarios.push(input.supervisorLiveScenario ?? 'simple');
        return {
          success: true,
          message: 'ok',
          project_slug: input.projectSlug,
          issue_id: `issue-${input.supervisorLiveScenario}`,
          issue_identifier: 'INT-1',
          github_repo: null,
          branch_name: null,
          pull_request_number: null,
          review_decision: null,
          failure_code: null,
          duration_ms: 1,
          checkpoints: [],
          diagnostics: null,
          last_timeline_message: null,
        };
      },
    });

    expect(results.success).toBe(true);
    expect(scenarios).toEqual(['simple', 'destructive_cleanup']);
    expect(results.results).toHaveLength(2);
  });
});
