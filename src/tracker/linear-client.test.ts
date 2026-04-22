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
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      requests.push(payload);
      return jsonResponse({ data: { commentCreate: { success: true } } });
    }) as unknown as typeof fetch;

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
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
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
    }) as unknown as typeof fetch;

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
      )) as unknown as typeof fetch;

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

  test('createIssue uses issueCreate mutation with explicit team and project identifiers', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      requests.push(payload);
      return jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: 'issue-456',
              identifier: 'INT-456',
              title: 'Created issue',
              description: 'desc',
              priority: 2,
              state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
              project: { id: 'project-1', name: 'Repo', slugId: 'repo' },
              labels: { nodes: [] },
              relations: { nodes: [] },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              branchName: null,
              url: 'https://linear.app/issue/INT-456',
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    const client = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });

    const result = await client.createIssue({
      title: 'Created issue',
      description: 'desc',
      teamId: 'team-1',
      projectId: 'project-1',
      stateId: 'state-1',
    });

    expect(result.success).toBe(true);
    expect(result.issue?.identifier).toBe('INT-456');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toContain('mutation CreateIssue');
    expect(requests[0]?.query).toContain('issueCreate');
    expect(requests[0]?.variables).toEqual({
      title: 'Created issue',
      description: 'desc',
      teamId: 'team-1',
      projectId: 'project-1',
      stateId: 'state-1',
    });
  });

  test('createIssue resolves Todo as the default state when stateId is omitted', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      requests.push(payload);

      if (requests.length === 1) {
        return jsonResponse({
          data: {
            project: {
              id: 'project-1',
              teams: {
                nodes: [
                  {
                    id: 'team-1',
                    states: {
                      nodes: [
                        { id: 'state-backlog', name: 'Backlog', type: 'unstarted' },
                        { id: 'state-todo', name: 'Todo', type: 'unstarted' },
                        { id: 'state-progress', name: 'In Progress', type: 'started' },
                      ],
                    },
                  },
                ],
              },
            },
          },
        });
      }

      return jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: 'issue-456',
              identifier: 'INT-456',
              title: 'Created issue',
              description: 'desc',
              priority: 0,
              state: { id: 'state-todo', name: 'Todo', type: 'unstarted' },
              project: { id: 'project-1', name: 'Test Two', slugId: 'test2' },
              labels: { nodes: [] },
              relations: { nodes: [] },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              branchName: null,
              url: 'https://linear.app/issue/INT-456',
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    const client = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });

    const result = await client.createIssue({
      title: 'Created issue',
      description: 'desc',
      teamId: 'team-1',
      projectId: 'project-1',
      stateId: null,
    });

    expect(result.success).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain('query GetProjectStatesForCreate');
    expect(requests[1]?.variables).toEqual({
      title: 'Created issue',
      description: 'desc',
      teamId: 'team-1',
      projectId: 'project-1',
      stateId: 'state-todo',
    });
  });

  test('createIssue falls back to the first non-Backlog unstarted state when Todo is absent', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      requests.push(payload);

      if (requests.length === 1) {
        return jsonResponse({
          data: {
            project: {
              id: 'project-1',
              teams: {
                nodes: [
                  {
                    id: 'team-1',
                    states: {
                      nodes: [
                        { id: 'state-backlog', name: 'Backlog', type: 'unstarted' },
                        { id: 'state-ready', name: 'Ready', type: 'unstarted' },
                        { id: 'state-progress', name: 'In Progress', type: 'started' },
                      ],
                    },
                  },
                ],
              },
            },
          },
        });
      }

      return jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: 'issue-457',
              identifier: 'INT-457',
              title: 'Created issue',
              description: 'desc',
              priority: 0,
              state: { id: 'state-ready', name: 'Ready', type: 'unstarted' },
              project: { id: 'project-1', name: 'Test Two', slugId: 'test2' },
              labels: { nodes: [] },
              relations: { nodes: [] },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              branchName: null,
              url: 'https://linear.app/issue/INT-457',
            },
          },
        },
      });
    }) as unknown as typeof fetch;

    const client = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });

    const result = await client.createIssue({
      title: 'Created issue',
      description: 'desc',
      teamId: 'team-1',
      projectId: 'project-1',
      stateId: null,
    });

    expect(result.success).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.variables).toEqual({
      title: 'Created issue',
      description: 'desc',
      teamId: 'team-1',
      projectId: 'project-1',
      stateId: 'state-ready',
    });
  });

  test('listProjects and findProjectBySlug expose project id, slug, and name', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        data: {
          projects: {
            nodes: [
              { id: 'project-1', name: 'Test Two', slugId: 'test2' },
              { id: 'project-2', name: 'Backend Core', slugId: 'backend-core' },
            ],
          },
        },
      })) as unknown as typeof fetch;

    const client = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });

    const listed = await client.listProjects();
    const resolved = await client.findProjectBySlug('backend-core');

    expect(listed.projects).toHaveLength(2);
    expect(listed.projects[0]).toEqual({
      project_id: 'project-1',
      project_slug: 'test2',
      project_name: 'Test Two',
    });
    expect(resolved.project).toEqual({
      project_id: 'project-2',
      project_slug: 'backend-core',
      project_name: 'Backend Core',
    });
  });

  test('getIssueCustomFields preserves raw review semantics while normalizing legacy values', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        data: {
          issue: {
            id: 'issue-789',
            identifier: 'INT-789',
            customFields: {
              nodes: [
                { name: 'dev_attempts', value: 2 },
                { name: 'review_round', value: '3' },
                { name: 'complexity', value: 'Medium' },
                { name: 'last_review_decision', value: 'tests' },
              ],
            },
          },
        },
      })) as unknown as typeof fetch;

    const client = new LinearClient({
      endpoint: 'https://linear.test/graphql',
      apiKey: 'token',
      projectSlugs: [],
    });

    const fields = await client.getIssueCustomFields('issue-789');

    expect(fields).toEqual({
      dev_attempts: 2,
      review_round: 3,
      complexity: 'medium',
      last_review_decision: 'request_tests',
    });
  });
});
