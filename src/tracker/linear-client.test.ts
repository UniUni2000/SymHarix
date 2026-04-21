import { afterEach, describe, expect, test } from 'bun:test';
import { LinearClient } from './linear-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LinearClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('postComment uses commentCreate mutation', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      requests.push(payload);
      return jsonResponse({ data: { commentCreate: { success: true } } });
    }) as typeof fetch;

    const client = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });

    const result = await client.postComment('issue-123', 'hello');

    expect(result).toEqual({ success: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toContain('mutation CommentCreate');
    expect(requests[0]?.query).toContain('commentCreate(input: { issueId: $issueId, body: $body })');
  });

  test('updateIssueState loads project team states and uses issueUpdate id argument', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      requests.push(payload);

      if (requests.length === 1) {
        return jsonResponse({
          data: {
            issue: {
              id: 'issue-123',
              project: {
                slugId: 'proj-1',
                teams: {
                  nodes: [
                    {
                      id: 'team-1',
                      states: {
                        nodes: [
                          { id: 'state-1', name: 'Todo', type: 'unstarted' },
                          { id: 'state-2', name: 'In Review', type: 'started' },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }

      return jsonResponse({ data: { issueUpdate: { success: true } } });
    }) as typeof fetch;

    const client = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });

    const result = await client.updateIssueState('issue-123', 'In Review');

    expect(result).toEqual({ success: true });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain('query GetIssueProject($issueId: String!)');
    expect(requests[0]?.query).toContain('teams {');
    expect(requests[1]?.query).toContain('issueUpdate(id: $issueId, input: { stateId: $stateId })');
    expect(requests[1]?.variables).toEqual({ issueId: 'issue-123', stateId: 'state-2' });
  });

  test('graphqlQuery includes response details for HTTP failures', async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        { errors: [{ message: 'Cannot query field "issueCommentCreate" on type "Mutation".' }] },
        400
      )) as typeof fetch;

    const client = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });

    const result = await client.postComment('issue-123', 'hello');

    expect(result.success).toBe(false);
    expect(result.error).toContain('status 400');
    expect(result.error).toContain('issueCommentCreate');
  });
});
