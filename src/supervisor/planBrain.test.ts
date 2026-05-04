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
});
