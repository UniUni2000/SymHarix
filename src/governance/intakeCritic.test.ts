import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assessIntakeCritic } from './intakeCritic';
import type { FitnessSignal, GovernanceRepoSnapshot, Issue, ResolvedRepositoryRoute } from '../types';

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

function makeFitnessSignal(overrides: Partial<FitnessSignal> = {}): FitnessSignal {
  return {
    code: 'hotspot_concentration',
    summary: 'runtime is a hotspot',
    severity: 'medium',
    ...overrides,
  };
}

function makeRepoSnapshot(overrides: Partial<GovernanceRepoSnapshot> = {}): GovernanceRepoSnapshot {
  return {
    repo_key: 'UniUni2000/test2',
    recent_work_items: [],
    recent_review_events: [],
    latest_assessments: [],
    decision_memories: [],
    conflict_memories: [],
    debt_signals: [],
    active_fitness_signals: [],
    ...overrides,
  };
}

function makeRecentWorkItem(
  overrides: Partial<GovernanceRepoSnapshot['recent_work_items'][number]> = {},
): GovernanceRepoSnapshot['recent_work_items'][number] {
  return {
    work_item_id: 'wi-1',
    issue_identifier: 'INT-9',
    linear_state: 'Done',
    last_review_decision: 'APPROVE',
    touched_paths: [],
    touched_areas: ['runtime', 'server'],
    path_families: ['runtime/hub', 'server/routes'],
    boundary_edges: ['runtime<->server'],
    import_edges: [],
    architectural_target: 'runtime<->server',
    updated_at: '2026-04-22T00:00:00.000Z',
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

  test('uses repo snapshot signals to strengthen split advice and explain recent churn', async () => {
    const assessment = await assessIntakeCritic({
      issue: makeIssue({
        title: 'Add another runtime control endpoint',
        description: 'Keep extending the runtime control plane surface again.',
      }),
      route: makeRoute(),
      repositoryRoot: null,
      repoSnapshot: makeRepoSnapshot({
        conflict_memories: [
          {
            summary: 'Runtime work keeps being split before implementation.',
            detail_json: {
              kind: 'split_before_implement',
              target_area: 'runtime',
            },
            created_at: '2026-04-20T00:00:00.000Z',
          },
        ],
        debt_signals: [
          {
            signal_code: 'repeated_review_churn',
            summary: 'Runtime review keeps churning.',
            severity: 'high',
            detail_json: {
              target_area: 'runtime',
            },
            created_at: '2026-04-21T00:00:00.000Z',
          },
        ],
        active_fitness_signals: [
          makeFitnessSignal(),
          makeFitnessSignal({
            code: 'repeated_review_churn',
            summary: 'runtime review keeps churning',
            severity: 'high',
          }),
        ],
      }),
    });

    expect(assessment.decision).toBe('split_before_implement');
    expect(assessment.summary).toContain('repo');
    expect(assessment.repo_key).toBe('UniUni2000/test2');
    expect(assessment.target_area).toBe('runtime');
    expect(assessment.active_fitness_signals).toEqual(['hotspot_concentration', 'repeated_review_churn']);
    expect(assessment.related_conflict_count).toBe(1);
    expect(assessment.related_debt_signal_count).toBe(1);
  });

  test('surfaces repeated constitution phrases from repo history in the assessment detail', async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-intake-constitution-memory-'));
    fs.writeFileSync(
      path.join(repoRoot, '.symphony-constitution.md'),
      [
        '# Constitution',
        '',
        '## Forbidden Directions',
        '- keep one orchestrator-centered control plane',
      ].join('\n'),
      'utf8',
    );

    const assessment = await assessIntakeCritic({
      issue: makeIssue({
        title: 'Stop trying to keep one orchestrator-centered control plane for this side workflow',
      }),
      route: makeRoute({
        local_path: repoRoot,
      }),
      repositoryRoot: repoRoot,
      repoSnapshot: makeRepoSnapshot({
        conflict_memories: [
          {
            summary: 'Override used for orchestrator-centered control plane exception.',
            detail_json: {
              kind: 'governance_override',
              constitution_phrase: 'keep one orchestrator-centered control plane',
            },
            created_at: '2026-04-10T00:00:00.000Z',
          },
          {
            summary: 'Override used for orchestrator-centered control plane exception again.',
            detail_json: {
              kind: 'governance_override',
              constitution_phrase: 'keep one orchestrator-centered control plane',
            },
            created_at: '2026-04-11T00:00:00.000Z',
          },
          {
            summary: 'Override used for orchestrator-centered control plane exception yet again.',
            detail_json: {
              kind: 'governance_override',
              constitution_phrase: 'keep one orchestrator-centered control plane',
            },
            created_at: '2026-04-12T00:00:00.000Z',
          },
        ],
      }),
    });

    expect(assessment.decision).toBe('reject_conflicting');
    expect(assessment.repeated_constitution_phrase).toBe('keep one orchestrator-centered control plane');
  });

  test('consumes boundary_edge_churn as a formal split advisory for the repeated edge', async () => {
    const assessment = await assessIntakeCritic({
      issue: makeIssue({
        title: 'Extend the runtime status route',
        description: 'Keep wiring the same runtime flow through another server route.',
      }),
      route: makeRoute(),
      repositoryRoot: null,
      repoSnapshot: makeRepoSnapshot({
        recent_work_items: [
          makeRecentWorkItem(),
          makeRecentWorkItem({
            work_item_id: 'wi-2',
            issue_identifier: 'INT-10',
            updated_at: '2026-04-21T00:00:00.000Z',
          }),
          makeRecentWorkItem({
            work_item_id: 'wi-3',
            issue_identifier: 'INT-11',
            updated_at: '2026-04-20T00:00:00.000Z',
          }),
        ],
        active_fitness_signals: [
          makeFitnessSignal({
            code: 'boundary_edge_churn',
            summary: 'runtime<->server keeps absorbing repeated cross-surface work',
            severity: 'high',
          }),
        ],
      }),
    });

    expect(assessment.decision).toBe('split_before_implement');
    expect(assessment.summary).toContain('runtime<->server');
    expect(assessment.summary).toContain('split');
  });

  test('consumes control_path_sprawl as rewrite guidance toward consolidation', async () => {
    const assessment = await assessIntakeCritic({
      issue: makeIssue({
        title: 'Extend the runtime control endpoint',
        description: 'Keep pushing the same runtime control flow through another server entry.',
      }),
      route: makeRoute(),
      repositoryRoot: null,
      repoSnapshot: makeRepoSnapshot({
        recent_work_items: [
          makeRecentWorkItem({
            work_item_id: 'wi-4',
            path_families: ['runtime/hub', 'server/routes/control', 'bots/assistant'],
            architectural_target: 'runtime<->server',
          }),
          makeRecentWorkItem({
            work_item_id: 'wi-5',
            issue_identifier: 'INT-12',
            path_families: ['runtime/session', 'server/routes/status', 'bots/runtime'],
            architectural_target: 'runtime<->server',
            updated_at: '2026-04-21T00:00:00.000Z',
          }),
        ],
        active_fitness_signals: [
          makeFitnessSignal({
            code: 'control_path_sprawl',
            summary: 'runtime<->server is spreading across too many control-path families',
            severity: 'high',
          }),
        ],
      }),
    });

    expect(assessment.decision).toBe('accept_with_rewrite');
    expect(assessment.summary).toContain('runtime<->server');
    expect(assessment.summary).toContain('consolidation');
    expect(assessment.rewrite_title).toBeTruthy();
  });

  test('calls out the concrete architectural target when cross-surface dependency expansion is active', async () => {
    const assessment = await assessIntakeCritic({
      issue: makeIssue({
        title: 'Tighten runtime route dependency wiring',
        description: 'Extend the same runtime to server route dependency again.',
      }),
      route: makeRoute(),
      repositoryRoot: null,
      repoSnapshot: makeRepoSnapshot({
        recent_work_items: [
          makeRecentWorkItem({
            work_item_id: 'wi-6',
            import_edges: ['runtime/hub->server/routes'],
            architectural_target: 'runtime/hub->server/routes',
          }),
          makeRecentWorkItem({
            work_item_id: 'wi-7',
            issue_identifier: 'INT-13',
            import_edges: ['runtime/hub->server/routes'],
            architectural_target: 'runtime/hub->server/routes',
            updated_at: '2026-04-21T00:00:00.000Z',
          }),
        ],
        active_fitness_signals: [
          makeFitnessSignal({
            code: 'cross_surface_dependency_expansion',
            summary: 'runtime/hub->server/routes keeps expanding as a repeated cross-surface dependency',
            severity: 'high',
          }),
        ],
      }),
    });

    expect(assessment.decision).toBe('accept_with_rewrite');
    expect(assessment.summary).toContain('runtime/hub->server/routes');
    expect(assessment.summary).toContain('cross-surface dependency');
  });
});
