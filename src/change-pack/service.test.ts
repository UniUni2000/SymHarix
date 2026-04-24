import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {
  collectRuntimeObservations,
  collectWorkspaceArtifactObservations,
  evaluateChangePackState,
  initializeChangePack,
  recordChangePackEvidence,
} from './service';
import type { Issue } from '../types';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'INT-1',
    title: 'Write a hello world python script',
    description: 'Output hello world and add a tiny test.',
    priority: 1,
    state: 'In Progress',
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

describe('changePackService', () => {
  let workspacePath: string;
  let server: http.Server | null = null;

  afterEach(() => {
    server?.close();
    server = null;
    if (workspacePath) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  test('initializes a lightweight change pack for small issues', async () => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-change-pack-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });

    await initializeChangePack({
      workspacePath,
      issue: makeIssue(),
      profile: 'coding',
      governanceSummary: 'No governance blockers detected.',
    });

    expect(fs.existsSync(path.join(workspacePath, '.symphony', 'change-pack', 'brief.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.symphony', 'change-pack', 'tasks.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.symphony', 'change-pack', 'evidence.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.symphony', 'change-pack', 'governance.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.symphony', 'change-pack', 'spec.md'))).toBe(false);
  });

  test('reports missing requirements until required artifacts are present', async () => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-change-pack-state-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });

    await initializeChangePack({
      workspacePath,
      issue: makeIssue(),
      profile: 'coding',
      governanceSummary: 'No governance blockers detected.',
    });

    let state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });
    expect(state.missing_requirements.some((item) => item.key === 'handover')).toBe(true);

    fs.writeFileSync(
      path.join(workspacePath, '.symphony', 'HANDOVER.md'),
      '# Handover: INT-1\n\n## 开发摘要\nImplemented.\n\n## 测试情况\n- 单元测试: PASS\n',
      'utf8',
    );

    state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });
    expect(state.missing_requirements.some((item) => item.key === 'handover')).toBe(false);
  });

  test('tracks harness-required artifacts as evidence-based completion requirements', async () => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-change-pack-artifacts-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });

    await initializeChangePack({
      workspacePath,
      issue: makeIssue({
        title: 'Collect recent events into a markdown report',
        description: 'Save the result to reports/weekly-summary.md',
      }),
      profile: 'research',
      harness: {
        verification: {
          required_artifacts: ['reports/weekly-summary.md'],
        },
      },
      governanceSummary: 'No governance blockers detected.',
    });

    let state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });

    expect(state.missing_requirements.some((item) => item.key === 'artifact:reports/weekly-summary.md')).toBe(true);

    fs.mkdirSync(path.join(workspacePath, 'reports'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'reports', 'weekly-summary.md'),
      '# Weekly Summary\n\nCollected evidence.\n',
      'utf8',
    );

    state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });

    expect(state.missing_requirements.some((item) => item.key === 'artifact:reports/weekly-summary.md')).toBe(false);
  });

  test('records command evidence from observed runs and uses it to satisfy command requirements', async () => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-change-pack-commands-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });

    await initializeChangePack({
      workspacePath,
      issue: makeIssue(),
      profile: 'coding',
      harness: {
        commands: {
          test: 'bun test',
          lint: 'bunx eslint .',
        },
        verification: {
          required_commands: ['test', 'lint'],
        },
      },
      governanceSummary: 'No governance blockers detected.',
    });

    await recordChangePackEvidence({
      workspacePath,
      harness: {
        commands: {
          test: 'bun test',
          lint: 'bunx eslint .',
        },
      },
      commandRuns: [
        {
          command: 'bun test',
          status: 'satisfied',
          source: 'timeline',
          turn: 1,
          exit_code: 0,
          summary: 'bun test passed',
        },
        {
          command: 'bunx eslint .',
          status: 'failed',
          source: 'timeline',
          turn: 1,
          exit_code: 1,
          summary: 'eslint found one error',
        },
      ],
    });

    const state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });

    expect(state.missing_requirements.some((item) => item.key === 'command:test')).toBe(false);
    expect(state.missing_requirements.some((item) => item.key === 'command:lint')).toBe(true);

    const evidence = JSON.parse(
      fs.readFileSync(path.join(workspacePath, '.symphony', 'change-pack', 'evidence.json'), 'utf8'),
    ) as {
      command_runs?: Array<{
        command_key?: string | null;
        status?: string;
        exit_code?: number | null;
        summary?: string | null;
      }>;
    };

    expect(evidence.command_runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command_key: 'test',
        status: 'satisfied',
        exit_code: 0,
        summary: 'bun test passed',
      }),
      expect.objectContaining({
        command_key: 'lint',
        status: 'failed',
        exit_code: 1,
        summary: 'eslint found one error',
      }),
    ]));
  });

  test('requires non-empty research artifacts before completion evidence is satisfied', async () => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-change-pack-research-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });

    await initializeChangePack({
      workspacePath,
      issue: makeIssue({
        title: 'Collect recent events into a markdown report',
        description: 'Save the result to reports/weekly-summary.md',
      }),
      profile: 'research',
      harness: {
        verification: {
          required_artifacts: ['reports/weekly-summary.md'],
        },
      },
      governanceSummary: 'No governance blockers detected.',
    });

    fs.mkdirSync(path.join(workspacePath, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'reports', 'weekly-summary.md'), '', 'utf8');
    await recordChangePackEvidence({
      workspacePath,
      artifactObservations: [
        {
          path: 'reports/weekly-summary.md',
          kind: 'markdown',
          exists: true,
          non_empty: false,
          source: 'workspace',
          turn: 1,
          summary: 'markdown report exists but is empty',
        },
      ],
    });

    let state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });

    expect(state.missing_requirements.some((item) => item.key === 'artifact:reports/weekly-summary.md')).toBe(true);

    fs.writeFileSync(
      path.join(workspacePath, 'reports', 'weekly-summary.md'),
      '# Weekly Summary\n\nCollected evidence.\n',
      'utf8',
    );
    await recordChangePackEvidence({
      workspacePath,
      artifactObservations: [
        {
          path: 'reports/weekly-summary.md',
          kind: 'markdown',
          exists: true,
          non_empty: true,
          source: 'workspace',
          turn: 2,
          summary: 'markdown report is present and non-empty',
        },
      ],
    });

    state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });

    expect(state.missing_requirements.some((item) => item.key === 'artifact:reports/weekly-summary.md')).toBe(false);
  });

  test('collects runtime hint observations and exposes v2 evidence counters for ui flows', async () => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-change-pack-ui-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'artifacts'), { recursive: true });

    server = http.createServer((_request, response) => {
      response.statusCode = 200;
      response.end('ok');
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    await initializeChangePack({
      workspacePath,
      issue: makeIssue({
        title: 'Build a small runtime status page',
        description: 'Ship dist/index.html and a screenshot artifact.',
      }),
      profile: 'ui',
      harness: {
        commands: {
          build: 'bun run build',
          lint: 'bunx eslint .',
        },
        verification: {
          required_commands: ['build'],
          required_artifacts: ['dist/index.html', 'artifacts/home.png'],
        },
        runtime_hints: {
          url: `http://127.0.0.1:${port}`,
          ready_signal: 'server ready',
        },
      },
      governanceSummary: 'No governance blockers detected.',
    });

    fs.writeFileSync(path.join(workspacePath, 'dist', 'index.html'), '<html><body>ready</body></html>', 'utf8');
    fs.writeFileSync(path.join(workspacePath, 'artifacts', 'home.png'), 'png-bytes', 'utf8');
    fs.writeFileSync(
      path.join(workspacePath, '.symphony', 'DEVELOPMENT_LOG.md'),
      '# Development Log\n\nserver ready\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspacePath, '.symphony', 'HANDOVER.md'),
      '# Handover\n\nBuilt the UI and captured the artifacts.\n',
      'utf8',
    );

    const artifactObservations = await collectWorkspaceArtifactObservations({
      workspacePath,
      harness: {
        verification: {
          required_artifacts: ['dist/index.html', 'artifacts/home.png'],
        },
      },
    });
    const runtimeObservations = await collectRuntimeObservations({
      workspacePath,
      harness: {
        runtime_hints: {
          url: `http://127.0.0.1:${port}`,
          ready_signal: 'server ready',
        },
      },
      turn: 2,
      timeline: [],
    });

    await recordChangePackEvidence({
      workspacePath,
      harness: {
        commands: {
          build: 'bun run build',
          lint: 'bunx eslint .',
        },
      },
      commandRuns: [
        {
          command: 'bun run build',
          command_key: 'build',
          status: 'satisfied',
          source: 'timeline',
          turn: 2,
          exit_code: 0,
          summary: 'build completed',
        },
        {
          command: 'bunx eslint .',
          command_key: 'lint',
          status: 'failed',
          source: 'timeline',
          turn: 2,
          exit_code: 1,
          summary: 'lint still has one warning promoted to error',
        },
      ],
      artifactObservations,
      runtimeObservations,
    });

    const state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });

    expect(state.missing_requirements.some((item) => item.key === 'artifact:dist/index.html')).toBe(false);
    expect(state.missing_requirements.some((item) => item.key === 'artifact:artifacts/home.png')).toBe(false);
    expect(state.missing_requirements.some((item) => item.key === 'runtime:url')).toBe(false);
    expect(state.evidence_summary.successful_commands).toEqual(['build']);
    expect(state.evidence_summary.failed_commands).toEqual(['lint']);
    expect(state.evidence_summary.observed_artifacts).toEqual(expect.arrayContaining([
      'dist/index.html',
      'artifacts/home.png',
    ]));
    expect(state.evidence_summary.runtime_checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hint_key: 'url',
        status: 'satisfied',
      }),
      expect.objectContaining({
        hint_key: 'ready_signal',
        status: 'satisfied',
      }),
    ]));
  });

  test('ignores malformed artifact and runtime observations instead of throwing during evidence recording', async () => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-change-pack-malformed-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony'), { recursive: true });

    await initializeChangePack({
      workspacePath,
      issue: makeIssue(),
      profile: 'ui',
      harness: {
        verification: {
          required_artifacts: ['dist/index.html'],
        },
        runtime_hints: {
          url: 'http://localhost:3000',
        },
      },
      governanceSummary: 'No governance blockers detected.',
    });

    await expect(recordChangePackEvidence({
      workspacePath,
      artifactObservations: [
        {
          path: 'dist/index.html',
          kind: 'html',
          exists: true,
          non_empty: true,
          source: 'workspace',
        },
        {
          path: '' as unknown as string,
          kind: 'html',
          exists: false,
          non_empty: false,
          source: 'workspace',
        },
        {
          path: undefined as unknown as string,
          kind: 'unknown',
          exists: false,
          non_empty: false,
          source: 'workspace',
        },
      ],
      runtimeObservations: [
        {
          hint_key: 'url',
          status: 'satisfied',
          value: 'http://localhost:3000',
          source: 'cli_postprocess',
        },
        {
          hint_key: 'ready_signal',
          status: 'failed',
          value: '' as unknown as string,
          source: 'cli_postprocess',
        },
        {
          hint_key: 'ready_signal',
          status: 'failed',
          value: undefined as unknown as string,
          source: 'cli_postprocess',
        },
      ],
    })).resolves.toEqual({
      commandRunsAdded: 0,
      artifactObservationsAdded: 1,
      runtimeObservationsAdded: 1,
    });

    const state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });

    expect(state.evidence_summary.observed_artifacts).toEqual(['dist/index.html']);
    expect(state.evidence_summary.runtime_checks).toEqual([
      expect.objectContaining({
        hint_key: 'url',
        status: 'satisfied',
        value: 'http://localhost:3000',
      }),
    ]);
  });

  test('ignores malformed persisted observations when appending new evidence and evaluating state', async () => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-change-pack-persisted-malformed-'));
    fs.mkdirSync(path.join(workspacePath, '.symphony', 'change-pack'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, '.symphony', 'change-pack', 'evidence.json'),
      JSON.stringify({
        requirements: [
          {
            key: 'artifact:reports/weekly-summary.md',
            label: 'Collect weekly summary',
            reason: 'Need a report artifact.',
            kind: 'artifact',
          },
        ],
        artifact_observations: [
          {
            path: null,
            kind: 'markdown',
            exists: true,
            non_empty: true,
            source: 'workspace',
          },
        ],
        runtime_observations: [
          {
            hint_key: 'ready_signal',
            status: 'satisfied',
            value: null,
            source: 'workspace',
          },
        ],
      }),
      'utf8',
    );

    await expect(recordChangePackEvidence({
      workspacePath,
      artifactObservations: [
        {
          path: 'reports/weekly-summary.md',
          kind: 'markdown',
          exists: true,
          non_empty: true,
          source: 'workspace',
          turn: 1,
          summary: 'weekly summary exists',
        },
      ],
      runtimeObservations: [
        {
          hint_key: 'ready_signal',
          status: 'satisfied',
          value: 'verification complete',
          source: 'workspace',
          turn: 1,
          summary: 'ready signal found',
        },
      ],
    })).resolves.toEqual({
      commandRunsAdded: 0,
      artifactObservationsAdded: 1,
      runtimeObservationsAdded: 1,
    });

    const state = await evaluateChangePackState({
      workspacePath,
      issue: makeIssue(),
      mode: 'dev',
    });

    expect(state.evidence_summary.observed_artifacts).toContain('reports/weekly-summary.md');
    expect(state.evidence_summary.runtime_checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hint_key: 'ready_signal',
        status: 'satisfied',
        value: 'verification complete',
      }),
    ]));
  });
});
