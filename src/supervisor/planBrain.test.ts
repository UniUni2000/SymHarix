import { describe, expect, test } from 'bun:test';
import { HttpSupervisorPlanBrain } from './planBrain';

describe('HttpSupervisorPlanBrain', () => {
  test('allows supervisor planning timeouts up to five minutes', () => {
    const planBrain = new HttpSupervisorPlanBrain({
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      timeoutMs: 300_000,
    });

    expect((planBrain as any).timeoutMs).toBe(300_000);
  });

  test('reports model usage and keeps repository code context in the planner prompt', async () => {
    let requestBody = '';
    const planBrain = new HttpSupervisorPlanBrain({
      provider: 'openai', model: 'planner-test', apiKey: 'test-key', baseUrl: 'https://example.test/v1',
    }, (async (_url, init) => {
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          rationale: 'Use the repository tests.',
          planCard: { affected_paths: ['src/runtime/pageClient.ts'], test_commands: ['bun test src/runtime'] },
        }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);

    const result = await planBrain.refinePlan({
      session: { supervisor_locale: 'en' },
      draft: { title: 'Planner', description: 'Improve it', project_slug: 'runtime' },
      runtimeContext: { focus_issue: null, available_projects: [] },
      repoIntelligence: null,
      repoUnderstanding: {
        repo_ref: 'acme/runtime', commit_sha: 'abc', summary: 'Runtime UI', source: 'cache', evidence_paths: ['src/runtime/pageClient.ts'],
        understanding: { project_purpose: 'Runtime', tech_stack: ['TypeScript'], key_paths: ['src/runtime/pageClient.ts'], architecture_notes: [], artifact_opportunities: [], test_commands: ['bun test src/runtime'], risks: [] },
      },
      governancePreview: null,
      deterministicPlan: { planCard: { title: 'Planner' } },
      recentEvents: [],
    } as any);

    expect(result?.diagnostics).toEqual(expect.objectContaining({
      source: 'llm', provider: 'openai', model: 'planner-test', input_tokens: 120, output_tokens: 30, total_tokens: 150,
    }));
    expect(result?.planCard?.affected_paths).toContain('src/runtime/pageClient.ts');
    expect(requestBody).toContain('repo_code_understanding');
    expect(requestBody).toContain('src/runtime/pageClient.ts');
  });

  test('returns explicit degraded diagnostics when the planner provider fails', async () => {
    const planBrain = new HttpSupervisorPlanBrain({
      provider: 'openai', model: 'planner-test', apiKey: 'test-key', baseUrl: 'https://example.test/v1',
    }, (async () => new Response('unavailable', { status: 503 })) as typeof fetch);
    const result = await planBrain.refinePlan({
      session: { supervisor_locale: 'en' }, draft: {}, runtimeContext: { focus_issue: null, available_projects: [] },
      repoIntelligence: null, repoUnderstanding: null, governancePreview: null, deterministicPlan: {}, recentEvents: [],
    } as any);
    expect(result?.diagnostics).toEqual(expect.objectContaining({
      source: 'llm_with_fallback', degraded: true, error_code: 'http_503',
    }));
  });
});
