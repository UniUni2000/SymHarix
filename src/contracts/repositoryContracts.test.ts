import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeSchema } from '../database/schema';
import { ShadowHarnessRepository } from '../database';
import {
  assessGovernanceForIssue,
  inferShadowHarness,
  loadRepositoryConstitution,
  loadRepositoryHarness,
  suggestHarnessAdoption,
} from './repositoryContracts';
import type { Issue } from '../types';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'INT-1',
    title: 'Implement API cleanup command',
    description: 'Add a cleanup command for the CLI.',
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

describe('repositoryContracts', () => {
  let tempRoot: string;
  let db: Database;

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('loads formal repo harness and constitution files from the workspace root', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-contracts-'));
    fs.writeFileSync(
      path.join(tempRoot, '.symphony-repo.yaml'),
      [
        'profiles:',
        '  - coding',
        'commands:',
        '  test: bun test',
        'verification:',
        '  required_commands:',
        '    - test',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempRoot, '.symphony-constitution.md'),
      [
        '# Repo Constitution',
        '',
        '## Main Path',
        '- Keep CLI orchestration centralized.',
        '',
        '## Forbidden Directions',
        '- duplicate runtime control paths',
      ].join('\n'),
      'utf8',
    );

    const harness = await loadRepositoryHarness(tempRoot);
    const constitution = await loadRepositoryConstitution(tempRoot);

    expect(harness.status).toBe('formal');
    expect(harness.path).toBe(path.join(tempRoot, '.symphony-repo.yaml'));
    expect(harness.config?.commands?.test).toBe('bun test');
    expect(constitution.status).toBe('present');
    expect(constitution.sections['Forbidden Directions']).toEqual(['duplicate runtime control paths']);
  });

  test('infers and persists a shadow harness from package.json scripts', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-shadow-harness-'));
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({
        name: 'demo',
        scripts: {
          dev: 'bun run dev',
          test: 'bun test',
          lint: 'bunx eslint .',
        },
      }),
      'utf8',
    );

    db = new Database(':memory:');
    initializeSchema(db);
    const repository = new ShadowHarnessRepository(db);

    const shadowHarness = await inferShadowHarness({
      workspacePath: tempRoot,
      repoKey: 'acme/repo',
      repository: repository,
    });

    expect(shadowHarness.status).toBe('shadow');
    expect(shadowHarness.config?.commands?.test).toBe('bun test');
    expect(repository.findByRepoKey('acme/repo')?.config_json.commands?.dev).toBe('bun run dev');
  });

  test('assesses governance hits from constitution forbidden directions', () => {
    const issue = makeIssue({
      title: 'Add duplicate runtime control paths for bots',
      description: 'Introduce a second runtime path just for chat bots.',
    });

    const assessment = assessGovernanceForIssue({
      issue,
      constitution: {
        status: 'present',
        path: '/tmp/.symphony-constitution.md',
        sections: {
          'Forbidden Directions': ['duplicate runtime control paths'],
        },
      },
    });

    expect(assessment.decision).toBe('reject_conflicting');
    expect(assessment.status).toBe('blocked');
    expect(assessment.constitution_hits).toHaveLength(1);
  });

  test('suggests harness adoption only after repeated successful runs', () => {
    expect(suggestHarnessAdoption({ successfulRuns: 2, failedRuns: 0 })).toBe(false);
    expect(suggestHarnessAdoption({ successfulRuns: 3, failedRuns: 0 })).toBe(true);
    expect(suggestHarnessAdoption({ successfulRuns: 3, failedRuns: 1 })).toBe(false);
  });
});
