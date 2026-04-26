import { describe, expect, test } from 'bun:test';
import { parseVerifyLiveLifecycleArgs, parseVerifyLiveSupervisorArgs } from './cli';

describe('parseVerifyLiveLifecycleArgs', () => {
  test('parses the required project slug plus optional flags', () => {
    const parsed = parseVerifyLiveLifecycleArgs([
      '--project-slug',
      'test2',
      '--timeout-ms',
      '45000',
      '--json',
      '--title-suffix',
      'nightly',
    ]);

    expect(parsed).toEqual({
      ok: true,
      command: {
        projectSlug: 'test2',
        timeoutMs: 45000,
        json: true,
        titleSuffix: 'nightly',
      },
    });
  });

  test('fails closed when project slug is missing', () => {
    const parsed = parseVerifyLiveLifecycleArgs(['--json']);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('--project-slug');
  });
});

describe('parseVerifyLiveSupervisorArgs', () => {
  test('marks the live verification command as a supervisor scenario', () => {
    const parsed = parseVerifyLiveSupervisorArgs([
      '--project-slug',
      'test2',
      '--json',
    ]);

    expect(parsed).toEqual({
      ok: true,
      command: {
        projectSlug: 'test2',
        timeoutMs: null,
        json: true,
        titleSuffix: 'supervisor-e2e',
        supervisorScenario: true,
      },
    });
  });
});
