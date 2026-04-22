import { describe, expect, test } from 'bun:test';
import { parseVerifyLiveLifecycleArgs } from './cli';

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
