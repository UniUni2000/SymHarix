import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeSchema } from '../database/schema';
import { ShadowHarnessRepository } from '../database';
import {
  assessGovernanceForIssue,
  buildEffectiveRepositoryHarness,
  inferShadowHarness,
  strengthenShadowHarnessFromWorkspace,
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

  test('builds an effective harness from canonical command keys and derives verification commands', () => {
    const effective = buildEffectiveRepositoryHarness({
      status: 'formal',
      path: '/tmp/.symphony-repo.yaml',
      config: {
        profiles: ['coding'],
        commands: {
          setup: 'bun install',
          test: 'bun test',
          lint: 'bunx eslint .',
          build: 'bun run build',
          deploy: 'bun run deploy',
        },
        runtime_hints: {
          url: 'http://localhost:3000',
        },
      },
      inferred_from: ['.symphony-repo.yaml'],
      adoption_suggested: false,
    });

    expect(effective.source).toBe('formal');
    expect(effective.config.commands).toEqual({
      setup: 'bun install',
      test: 'bun test',
      lint: 'bunx eslint .',
      build: 'bun run build',
    });
    expect(effective.config.verification?.required_commands).toEqual(['test', 'lint', 'build']);
    expect(effective.config.runtime_hints).toEqual({
      url: 'http://localhost:3000',
    });
    expect(effective.has_verification_requirements).toBe(true);
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

  test('strengthens a shadow harness from successful change-pack evidence', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-shadow-learn-'));
    const workspaceOne = path.join(tempRoot, 'run-1');
    const workspaceTwo = path.join(tempRoot, 'run-2');
    fs.mkdirSync(path.join(workspaceOne, '.symphony', 'change-pack'), { recursive: true });
    fs.mkdirSync(path.join(workspaceTwo, '.symphony', 'change-pack'), { recursive: true });
    fs.mkdirSync(path.join(workspaceOne, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(workspaceTwo, 'dist'), { recursive: true });

    const writeEvidence = (workspacePath: string, workItemId: string): void => {
      fs.writeFileSync(
        path.join(workspacePath, '.symphony', 'change-pack', 'evidence.json'),
        JSON.stringify(
          {
            command_runs: [
              {
                command: 'bun test',
                command_key: 'test',
                status: 'satisfied',
                source: 'timeline',
                turn: 1,
                exit_code: 0,
                summary: 'tests passed',
                recorded_at: '2026-04-23T00:00:00.000Z',
              },
              {
                command: 'bun run build',
                command_key: 'build',
                status: 'satisfied',
                source: 'timeline',
                turn: 1,
                exit_code: 0,
                summary: 'build passed',
                recorded_at: '2026-04-23T00:00:01.000Z',
              },
            ],
            artifact_observations: [
              {
                path: 'dist',
                kind: 'dir',
                exists: true,
                non_empty: true,
                source: 'workspace',
                turn: 1,
                summary: 'dist directory exists',
                recorded_at: '2026-04-23T00:00:03.000Z',
              },
            ],
            runtime_observations: [
              {
                hint_key: 'url',
                status: 'satisfied',
                value: 'http://localhost:3000',
                source: 'cli_postprocess',
                turn: 1,
                summary: 'url responded successfully',
                recorded_at: '2026-04-23T00:00:04.000Z',
              },
              {
                hint_key: 'ready_signal',
                status: 'satisfied',
                value: 'server ready',
                source: 'cli_postprocess',
                turn: 1,
                summary: 'ready signal found in log',
                recorded_at: '2026-04-23T00:00:05.000Z',
              },
            ],
            notes: [workItemId],
          },
          null,
          2,
        ),
        'utf8',
      );
    };
    writeEvidence(workspaceOne, 'wi-success-1');
    writeEvidence(workspaceTwo, 'wi-success-2');

    db = new Database(':memory:');
    initializeSchema(db);
    const repository = new ShadowHarnessRepository(db);

    await inferShadowHarness({
      workspacePath: workspaceOne,
      repoKey: 'acme/repo',
      repository,
    });

    const firstPass = await strengthenShadowHarnessFromWorkspace({
      workspacePath: workspaceOne,
      repoKey: 'acme/repo',
      repository,
      workItemId: 'wi-success-1',
    });
    expect(firstPass.status).toBe('shadow');
    expect(firstPass.config?.commands?.test).toBeUndefined();
    expect(firstPass.config?.verification?.required_commands).toBeUndefined();
    expect(repository.findByRepoKey('acme/repo')?.inference_details_json).toMatchObject({
      learning_confidence: 'low',
      observed_commands: {
        test: expect.objectContaining({
          success_count: 1,
          failure_count: 0,
          last_status: 'satisfied',
          last_work_item_id: 'wi-success-1',
        }),
      },
    });

    const strengthened = await strengthenShadowHarnessFromWorkspace({
      workspacePath: workspaceTwo,
      repoKey: 'acme/repo',
      repository,
      workItemId: 'wi-success-2',
    });

    expect(strengthened.status).toBe('shadow');
    expect(strengthened.config?.commands?.test).toBe('bun test');
    expect(strengthened.config?.commands?.build).toBe('bun run build');
    expect(strengthened.config?.verification?.required_commands).toEqual(['test', 'build']);
    expect(strengthened.config?.artifacts).toContain('dist');
    expect(strengthened.config?.runtime_hints).toEqual({
      url: 'http://localhost:3000',
      ready_signal: 'server ready',
    });
    expect(strengthened.inferred_from).toEqual(expect.arrayContaining([
      '.symphony/change-pack/evidence.json',
    ]));
    expect(repository.findByRepoKey('acme/repo')?.inference_details_json).toMatchObject({
      learning_confidence: 'medium',
      observed_runtime_hints: {
        url: expect.objectContaining({
          success_count: 2,
          failure_count: 0,
        }),
      },
    });
  });

  test('records failed learning samples and blocks unstable commands from promotion', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-shadow-failure-'));
    const workspaceOne = path.join(tempRoot, 'run-success');
    const workspaceTwo = path.join(tempRoot, 'run-failure');
    fs.mkdirSync(path.join(workspaceOne, '.symphony', 'change-pack'), { recursive: true });
    fs.mkdirSync(path.join(workspaceTwo, '.symphony', 'change-pack'), { recursive: true });

    fs.writeFileSync(
      path.join(workspaceOne, '.symphony', 'change-pack', 'evidence.json'),
      JSON.stringify(
        {
          command_runs: [
            {
              command: 'bun test',
              command_key: 'test',
              status: 'satisfied',
              source: 'timeline',
              turn: 1,
              exit_code: 0,
              summary: 'tests passed',
              recorded_at: '2026-04-23T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceTwo, '.symphony', 'change-pack', 'evidence.json'),
      JSON.stringify(
        {
          command_runs: [
            {
              command: 'bun test',
              command_key: 'test',
              status: 'failed',
              source: 'timeline',
              turn: 1,
              exit_code: 1,
              summary: 'tests failed',
              recorded_at: '2026-04-23T00:10:00.000Z',
            },
          ],
          runtime_observations: [
            {
              hint_key: 'url',
              status: 'failed',
              value: 'http://localhost:3000',
              source: 'cli_postprocess',
              turn: 1,
              summary: 'url did not respond',
              recorded_at: '2026-04-23T00:11:00.000Z',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    db = new Database(':memory:');
    initializeSchema(db);
    const repository = new ShadowHarnessRepository(db);

    await inferShadowHarness({
      workspacePath: workspaceOne,
      repoKey: 'acme/repo',
      repository,
    });
    await strengthenShadowHarnessFromWorkspace({
      workspacePath: workspaceOne,
      repoKey: 'acme/repo',
      repository,
      workItemId: 'wi-success',
    });
    const strengthened = await strengthenShadowHarnessFromWorkspace({
      workspacePath: workspaceTwo,
      repoKey: 'acme/repo',
      repository,
      workItemId: 'wi-failure',
    });

    expect(strengthened.config?.commands?.test).toBeUndefined();
    expect(repository.findByRepoKey('acme/repo')?.inference_details_json).toMatchObject({
      learning_confidence: 'low',
      observed_commands: {
        test: expect.objectContaining({
          success_count: 1,
          failure_count: 1,
          last_status: 'failed',
          last_work_item_id: 'wi-failure',
        }),
      },
      observed_runtime_hints: {
        url: expect.objectContaining({
          success_count: 0,
          failure_count: 1,
        }),
      },
    });
  });

  test('skips malformed artifact and runtime observations while strengthening a shadow harness', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-shadow-malformed-'));
    const workspace = path.join(tempRoot, 'run-malformed');
    fs.mkdirSync(path.join(workspace, '.symphony', 'change-pack'), { recursive: true });

    fs.writeFileSync(
      path.join(workspace, '.symphony', 'change-pack', 'evidence.json'),
      JSON.stringify(
        {
          command_runs: [
            {
              command: 'bun test',
              command_key: 'test',
              status: 'satisfied',
              source: 'timeline',
              turn: 1,
              exit_code: 0,
              summary: 'tests passed',
              recorded_at: '2026-04-23T00:00:00.000Z',
            },
          ],
          artifact_observations: [
            {
              path: '',
              kind: 'dir',
              exists: true,
              non_empty: true,
              source: 'workspace',
            },
            {
              exists: true,
              non_empty: true,
              source: 'workspace',
            },
          ],
          runtime_observations: [
            {
              hint_key: 'url',
              status: 'failed',
              value: '',
              source: 'cli_postprocess',
            },
            {
              hint_key: 'ready_signal',
              status: 'satisfied',
              source: 'cli_postprocess',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    db = new Database(':memory:');
    initializeSchema(db);
    const repository = new ShadowHarnessRepository(db);

    await inferShadowHarness({
      workspacePath: workspace,
      repoKey: 'acme/repo',
      repository,
    });

    await expect(strengthenShadowHarnessFromWorkspace({
      workspacePath: workspace,
      repoKey: 'acme/repo',
      repository,
      workItemId: 'wi-malformed',
    })).resolves.toMatchObject({
      status: 'shadow',
    });

    expect(repository.findByRepoKey('acme/repo')?.inference_details_json).toMatchObject({
      observed_commands: {
        test: expect.objectContaining({
          success_count: 1,
        }),
      },
    });
  });
});
