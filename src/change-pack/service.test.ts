import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  evaluateChangePackState,
  initializeChangePack,
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

  afterEach(() => {
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
});
