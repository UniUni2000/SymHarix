import { describe, expect, test } from 'bun:test';
import {
  discoverLinearProjects,
  probeGitHubRepository,
  runConfigurationDoctor,
  type ConfigurationDoctorInput,
} from './configureDoctor';

const input: ConfigurationDoctorInput = {
  linearApiKey: 'linear-secret',
  linearProjectSlug: 'project-a',
  githubToken: 'github-secret',
  githubOwner: 'acme',
  githubRepo: 'web-app',
  runtimeProvider: 'deepseek',
  runtimeApiKey: 'model-secret',
  usesOpenCodeAuth: false,
  telegramToken: '123:telegram-secret',
  feishuAppId: 'cli_app',
  feishuAppSecret: 'feishu-secret',
};

function successfulFetch(requests: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = resource instanceof Request ? resource.url : String(resource);
    requests.push({ url, init });
    if (url.includes('linear.app')) {
      return Response.json({
        data: {
          projects: { nodes: [{ id: 'project-1', name: 'Project A', slugId: 'project-a' }] },
        },
      });
    }
    if (url.includes('api.github.com')) {
      return Response.json({ permissions: { push: true } });
    }
    if (url.includes('api.deepseek.com')) {
      return Response.json({ data: [] });
    }
    if (url.includes('api.telegram.org')) {
      return Response.json({ ok: true, result: { username: 'symharix_test_bot' } });
    }
    if (url.includes('open.feishu.cn')) {
      return Response.json({ code: 0, tenant_access_token: 'temporary-token' });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

describe('configuration doctor', () => {
  test('explains invalid, unauthorized, and unselected GitHub credentials precisely', async () => {
    const statuses = [401, 403, 404];
    const expected = ['无效', 'SSO', '没有选择'];

    for (const [index, status] of statuses.entries()) {
      const result = await probeGitHubRepository({
        token: `secret-${status}`,
        owner: 'acme',
        repo: 'web-app',
      }, {
        fetchImpl: (async () => new Response(null, { status })) as typeof fetch,
      });
      expect(result.status).toBe('fail');
      expect(result.detail).toContain(expected[index]!);
      expect(result.detail).not.toContain(`secret-${status}`);
    }
  });

  test('discovers Linear projects without exposing the credential', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await discoverLinearProjects('linear-secret', { fetchImpl: successfulFetch(requests) });

    expect(result).toEqual({
      ok: true,
      projects: [{ id: 'project-1', name: 'Project A', slug: 'project-a' }],
    });
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe('linear-secret');
    expect(requests[0]?.url).not.toContain('linear-secret');
  });

  test('validates every configured service through read-only endpoints', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const results = await runConfigurationDoctor(input, { fetchImpl: successfulFetch(requests) });

    expect(results.map((result) => result.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(requests.some((request) => /chat\/completions|responses/.test(request.url))).toBe(false);
    expect(requests.find((request) => request.url.includes('github'))?.init?.method).toBeUndefined();
    expect(requests.find((request) => request.url.includes('feishu'))?.init?.method).toBe('POST');
  });

  test('reports missing write access and defers OpenCode auth to the explicit paid smoke test', async () => {
    const fetchImpl = (async (resource: string | URL | Request) => {
      const url = resource instanceof Request ? resource.url : String(resource);
      if (url.includes('linear.app')) {
        return Response.json({
          data: {
            projects: { nodes: [{ id: 'project-1', name: 'Project A', slugId: 'project-a' }] },
          },
        });
      }
      if (url.includes('api.github.com')) return Response.json({ permissions: { push: false } });
      return new Response(null, { status: 401 });
    }) as typeof fetch;

    const results = await runConfigurationDoctor({
      ...input,
      usesOpenCodeAuth: true,
      runtimeApiKey: '',
      telegramToken: '',
      feishuAppId: '',
      feishuAppSecret: '',
    }, { fetchImpl });

    expect(results.find((result) => result.label === 'GitHub')?.status).toBe('fail');
    expect(results.find((result) => result.label === '模型凭据')?.status).toBe('skip');
    expect(results.find((result) => result.label === '模型凭据')?.detail).toContain('runtime:smoke');
  });

  test('rejects a fixed Telegram public URL when Telegram registered a different webhook', async () => {
    const fetchImpl = (async (resource: string | URL | Request) => {
      const url = resource instanceof Request ? resource.url : String(resource);
      if (url.endsWith('/getMe')) {
        return Response.json({ ok: true, result: { username: 'symharix_test_bot' } });
      }
      if (url.endsWith('/getWebhookInfo')) {
        return Response.json({
          ok: true,
          result: { url: 'https://stale.example.com/api/v1/bots/telegram/webhook', pending_update_count: 0 },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const results = await runConfigurationDoctor({
      ...input,
      linearApiKey: '',
      githubToken: '',
      usesOpenCodeAuth: true,
      runtimeApiKey: '',
      telegramPublicBaseUrl: 'https://runtime.example.com',
      feishuAppId: '',
      feishuAppSecret: '',
    }, { fetchImpl });

    const telegram = results.find((result) => result.label === 'Telegram');
    expect(telegram?.status).toBe('fail');
    expect(telegram?.detail).toContain('预期为 https://runtime.example.com/api/v1/bots/telegram/webhook');
  });

  test('reports recent Telegram delivery errors and a growing pending backlog', async () => {
    const fetchImpl = (async (resource: string | URL | Request) => {
      const url = resource instanceof Request ? resource.url : String(resource);
      if (url.endsWith('/getMe')) {
        return Response.json({ ok: true, result: { username: 'symharix_test_bot' } });
      }
      if (url.endsWith('/getWebhookInfo')) {
        return Response.json({
          ok: true,
          result: {
            url: 'https://runtime.example.com/api/v1/bots/telegram/webhook',
            pending_update_count: 7,
            last_error_message: 'Wrong response from the webhook: 502 Bad Gateway',
            last_error_date: Math.floor(Date.now() / 1000),
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const results = await runConfigurationDoctor({
      ...input,
      linearApiKey: '',
      githubToken: '',
      usesOpenCodeAuth: true,
      runtimeApiKey: '',
      telegramPublicBaseUrl: 'https://runtime.example.com',
      feishuAppId: '',
      feishuAppSecret: '',
    }, { fetchImpl });

    const telegram = results.find((result) => result.label === 'Telegram');
    expect(telegram?.status).toBe('fail');
    expect(telegram?.detail).toContain('pending=7');
    expect(telegram?.detail).toContain('502 Bad Gateway');
  });
});
