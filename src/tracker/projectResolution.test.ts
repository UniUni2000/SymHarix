import { afterEach, describe, expect, test } from 'bun:test';
import { LinearClient } from './linear-client';
import { TrackerProjectResolutionService } from './projectResolution';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TrackerProjectResolutionService', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('resolves a configured project_slug to a Linear project id and repo mapping', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        data: {
          projects: {
            nodes: [
              { id: 'project-1', name: 'Test Two', slugId: 'test2' },
              { id: 'project-2', name: 'Other', slugId: 'other' },
            ],
          },
        },
      })) as unknown as typeof fetch;

    const tracker = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });
    const service = new TrackerProjectResolutionService(tracker, {
      test2: {
        github_owner: 'UniUni2000',
        github_repo: 'test2',
        local_path: null,
      },
    });

    const result = await service.resolveProjectSlug('test2');

    expect(result.project).toEqual({
      project_id: 'project-1',
      project_slug: 'test2',
      project_name: 'Test Two',
    });
    expect(result.route?.github_repo_full).toBe('UniUni2000/test2');
    expect(result.error).toBeUndefined();
  });

  test('fails closed when project_slug is not configured in repositories.routing', async () => {
    const tracker = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });
    const service = new TrackerProjectResolutionService(tracker, {
      test2: {
        github_owner: 'UniUni2000',
        github_repo: 'test2',
        local_path: null,
      },
    });

    const result = await service.resolveProjectSlug('missing-project');

    expect(result.project).toBeNull();
    expect(result.error).toContain('missing-project');
    expect(result.error).toContain('test2');
  });

  test('returns a clear error when workflow routing exists but Linear has no matching project', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        data: {
          projects: {
            nodes: [{ id: 'project-9', name: 'Other', slugId: 'other' }],
          },
        },
      })) as unknown as typeof fetch;

    const tracker = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });
    const service = new TrackerProjectResolutionService(tracker, {
      test2: {
        github_owner: 'UniUni2000',
        github_repo: 'test2',
        local_path: null,
      },
    });

    const result = await service.resolveProjectSlug('test2');

    expect(result.project).toBeNull();
    expect(result.error).toContain('test2');
    expect(result.error).toContain('Linear');
  });
});
