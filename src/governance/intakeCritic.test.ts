import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assessIntakeCritic } from './intakeCritic';
import type { Issue, ResolvedRepositoryRoute } from '../types';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'INT-1',
    title: 'Implement a focused repository change',
    description: 'Touch one path and keep the change small.',
    priority: 1,
    state: 'Todo',
    project_slug: 'proj',
    project_name: 'repo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-04-22T00:00:00.000Z'),
    updated_at: new Date('2026-04-22T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRoute(overrides: Partial<ResolvedRepositoryRoute> = {}): ResolvedRepositoryRoute {
  return {
    project_slug: 'proj',
    project_name: 'repo',
    github_owner: 'UniUni2000',
    github_repo: 'test2',
    github_repo_full: 'UniUni2000/test2',
    local_path: null,
    cache_key: 'uniuni2000__test2',
    require_repo_harness: false,
    ...overrides,
  };
}

describe('assessIntakeCritic', () => {
  let repoRoot = '';

  afterEach(() => {
    if (repoRoot) {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      repoRoot = '';
    }
  });

  test('blocks implementation when the route requires a formal repo harness but none exists', async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-intake-harness-'));

    const assessment = await assessIntakeCritic({
      issue: makeIssue(),
      route: makeRoute({
        local_path: repoRoot,
        require_repo_harness: true,
      }),
      repositoryRoot: repoRoot,
    });

    expect(assessment.decision).toBe('defer');
    expect(assessment.status).toBe('blocked');
    expect(assessment.repo_harness_status).toBe('missing');
    expect(assessment.blocks_dispatch).toBe(true);
  });

  test('rejects issues that conflict with forbidden constitution directions', async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-intake-constitution-'));
    fs.writeFileSync(
      path.join(repoRoot, '.symphony-constitution.md'),
      [
        '# Constitution',
        '',
        '## Forbidden Directions',
        '- create a second control plane from parsed stderr logs',
      ].join('\n'),
      'utf8',
    );

    const assessment = await assessIntakeCritic({
      issue: makeIssue({
        title: 'Create a second control plane from parsed stderr logs',
      }),
      route: makeRoute({
        local_path: repoRoot,
      }),
      repositoryRoot: repoRoot,
    });

    expect(assessment.decision).toBe('reject_conflicting');
    expect(assessment.status).toBe('blocked');
    expect(assessment.constitution_hits).toHaveLength(1);
    expect(assessment.blocks_dispatch).toBe(true);
  });

  test('suggests splitting broad multi-objective issues before implementation', async () => {
    const assessment = await assessIntakeCritic({
      issue: makeIssue({
        title: 'Refactor runtime API and redesign the web dashboard and rewrite Telegram copy',
        description: 'Do all three in one issue and also clean related files.',
      }),
      route: makeRoute(),
      repositoryRoot: null,
    });

    expect(assessment.decision).toBe('split_before_implement');
    expect(assessment.status).toBe('advisory');
    expect(assessment.blocks_dispatch).toBe(true);
    expect(assessment.split_suggestions.length).toBeGreaterThan(0);
  });

  test('suggests rewriting vague issue requests before implementation', async () => {
    const assessment = await assessIntakeCritic({
      issue: makeIssue({
        title: '优化一下',
        description: '稍微改改就行',
      }),
      route: makeRoute(),
      repositoryRoot: null,
    });

    expect(assessment.decision).toBe('accept_with_rewrite');
    expect(assessment.status).toBe('advisory');
    expect(assessment.blocks_dispatch).toBe(true);
    expect(assessment.rewrite_title).toBeTruthy();
  });
});
