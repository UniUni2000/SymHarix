import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initializeSchema } from '../database/schema';
import {
  ConflictMemoryRepository,
  DebtSignalRepository,
  DecisionMemoryRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  WorkItemRepository,
} from '../database';
import type { AgentTimelinePayload, FitnessSignal } from '../types';
import { analyzeTouchedPathsArchitecture } from './architectureIntelligence';
import {
  deriveBoundaryEdges,
  derivePathFamilies,
  deriveTouchedAreas,
  deriveTouchedPathsFromTimeline,
  FitnessSignalService,
  GovernanceSuggestionEngine,
  GovernanceMemoryService,
} from './repoIntelligence';

function makeTimelineEntry(overrides: Partial<AgentTimelinePayload> = {}): AgentTimelinePayload {
  return {
    level: 'info',
    category: 'tool',
    code: 'tool_completed',
    message: 'Write completed',
    turn: 1,
    tool_name: 'Write',
    detail: {
      path: 'src/runtime/hub.ts',
      summary: 'src/runtime/hub.ts',
    },
    ...overrides,
  };
}

describe('repo intelligence helpers', () => {
  test('collects touched paths from tool timeline entries and maps them to surfaces', () => {
    const touchedPaths = deriveTouchedPathsFromTimeline([
      makeTimelineEntry(),
      makeTimelineEntry({
        tool_name: 'Read',
        detail: {
          summary: 'src/server/routes/runtime.ts',
        },
      }),
      makeTimelineEntry({
        tool_name: 'Bash',
        detail: {
          summary: 'echo hello',
        },
      }),
      makeTimelineEntry({
        tool_name: 'Write',
        detail: {
          path: 'src/runtime/hub.ts',
        },
      }),
    ]);

    expect(touchedPaths).toEqual([
      'src/runtime/hub.ts',
      'src/server/routes/runtime.ts',
    ]);
    expect(deriveTouchedAreas(touchedPaths)).toEqual(['runtime', 'server']);
    expect(derivePathFamilies(touchedPaths)).toEqual(['runtime/hub', 'server/routes']);
    expect(deriveBoundaryEdges(touchedPaths)).toEqual(['runtime<->server']);
  });

  test('analyzes touched paths into families, boundary edges, import edges, and a canonical architectural target', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-architecture-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'src', 'runtime'), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, 'src', 'server', 'routes'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, 'src', 'runtime', 'hub.ts'),
        "import { buildRuntimeRoute } from '../server/routes/runtime';\nexport const hub = buildRuntimeRoute();\n",
        'utf8',
      );
      fs.writeFileSync(
        path.join(repoRoot, 'src', 'server', 'routes', 'runtime.ts'),
        "export function buildRuntimeRoute() { return 'ok'; }\n",
        'utf8',
      );

      const analysis = await analyzeTouchedPathsArchitecture({
        workspacePath: repoRoot,
        touchedPaths: ['src/runtime/hub.ts', 'src/server/routes/runtime.ts'],
      });

      expect(analysis.path_families).toEqual(['runtime/hub', 'server/routes']);
      expect(analysis.boundary_edges).toEqual(['runtime<->server']);
      expect(analysis.import_edges).toEqual(['runtime/hub->server/routes']);
      expect(analysis.architectural_target).toBe('runtime<->server');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('GovernanceMemoryService', () => {
  let db: Database;
  let workItems: WorkItemRepository;
  let reviews: ReviewEventRepository;
  let assessments: GovernanceAssessmentRepository;
  let suggestions: GovernanceSuggestionRepository;
  let decisions: DecisionMemoryRepository;
  let conflicts: ConflictMemoryRepository;
  let debtSignals: DebtSignalRepository;
  let service: GovernanceMemoryService;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    workItems = new WorkItemRepository(db);
    reviews = new ReviewEventRepository(db);
    assessments = new GovernanceAssessmentRepository(db);
    suggestions = new GovernanceSuggestionRepository(db);
    decisions = new DecisionMemoryRepository(db);
    conflicts = new ConflictMemoryRepository(db);
    debtSignals = new DebtSignalRepository(db);
    service = new GovernanceMemoryService({
      workItemRepository: workItems,
      reviewEventRepository: reviews,
      governanceAssessmentRepository: assessments,
      governanceSuggestionRepository: suggestions,
      decisionMemoryRepository: decisions,
      conflictMemoryRepository: conflicts,
      debtSignalRepository: debtSignals,
    });
  });

  test('records decision, conflict, and debt memories from repo outcomes', () => {
    workItems.create({
      id: 'wi-1',
      linear_issue_id: 'issue-1',
      linear_identifier: 'INT-1',
      linear_title: 'Runtime refactor',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      last_review_decision: 'APPROVE_MINOR',
      missing_requirements: [],
      touched_paths: ['src/runtime/hub.ts'],
      touched_areas: ['runtime'],
    });
    workItems.create({
      id: 'wi-2',
      linear_issue_id: 'issue-2',
      linear_identifier: 'INT-2',
      linear_title: 'Rewrite runtime and bot flow',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      governance_decision: 'split_before_implement',
      governance_summary: 'Split this issue before dispatch.',
      touched_paths: ['src/runtime/hub.ts', 'src/bots/assistant.ts'],
      touched_areas: ['runtime', 'bots'],
    });
    workItems.create({
      id: 'wi-3',
      linear_issue_id: 'issue-3',
      linear_identifier: 'INT-3',
      linear_title: 'Review churn',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      last_review_decision: 'REQUEST_CHANGES',
      touched_paths: ['src/runtime/hub.ts'],
      touched_areas: ['runtime'],
    });

    service.recordDecisionOutcome('wi-1');
    service.recordConflictOutcome('wi-2', {
      kind: 'split_before_implement',
      summary: 'Split this issue before dispatch.',
    });
    service.recordDebtOutcome('wi-3', {
      signal_code: 'repeated_review_churn',
      summary: 'Runtime review keeps being sent back.',
      severity: 'high',
    });

    expect(decisions.findByRepoKey('acme/repo')).toHaveLength(1);
    expect(conflicts.findByRepoKey('acme/repo')).toHaveLength(1);
    expect(debtSignals.findByRepoKey('acme/repo')).toHaveLength(1);
  });
});

describe('FitnessSignalService and GovernanceSuggestionEngine', () => {
  let db: Database;
  let workItems: WorkItemRepository;
  let reviews: ReviewEventRepository;
  let assessments: GovernanceAssessmentRepository;
  let suggestions: GovernanceSuggestionRepository;
  let decisions: DecisionMemoryRepository;
  let conflicts: ConflictMemoryRepository;
  let debtSignals: DebtSignalRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    workItems = new WorkItemRepository(db);
    reviews = new ReviewEventRepository(db);
    assessments = new GovernanceAssessmentRepository(db);
    suggestions = new GovernanceSuggestionRepository(db);
    decisions = new DecisionMemoryRepository(db);
    conflicts = new ConflictMemoryRepository(db);
    debtSignals = new DebtSignalRepository(db);
  });

  test('evaluates repo fitness signals from recent work item and review history', () => {
    for (let index = 0; index < 6; index += 1) {
      workItems.create({
        id: `wi-${index}`,
        linear_issue_id: `issue-${index}`,
        linear_identifier: `INT-${index}`,
        linear_title: `Runtime work ${index}`,
        linear_state: 'Done',
        github_repo: 'acme/repo',
        touched_paths: index < 4 ? ['src/runtime/hub.ts'] : ['src/server/routes/runtime.ts'],
        touched_areas: index < 4 ? ['runtime'] : ['server'],
      });
    }

    workItems.create({
      id: 'wi-retry-1',
      linear_issue_id: 'retry-1',
      linear_identifier: 'INT-R1',
      linear_title: 'Merge blocked work',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      last_review_decision: 'MERGE_BLOCKED',
      touched_paths: ['src/runtime/hub.ts'],
      touched_areas: ['runtime'],
    });
    workItems.create({
      id: 'wi-retry-2',
      linear_issue_id: 'retry-2',
      linear_identifier: 'INT-R2',
      linear_title: 'Retry work 2',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      last_review_decision: 'REQUEST_TESTS',
      touched_paths: ['src/runtime/hub.ts'],
      touched_areas: ['runtime'],
    });
    workItems.create({
      id: 'wi-retry-3',
      linear_issue_id: 'retry-3',
      linear_identifier: 'INT-R3',
      linear_title: 'Retry work 3',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      last_review_decision: 'REQUEST_CHANGES',
      touched_paths: ['src/runtime/hub.ts'],
      touched_areas: ['runtime'],
    });

    for (let round = 1; round <= 3; round += 1) {
      reviews.create({
        id: `review-${round}`,
        work_item_id: 'wi-retry-1',
        pr_number: 42,
        review_round: round,
        decision: round === 3 ? 'REJECT' : 'REQUEST_CHANGES',
        summary_md: `Review round ${round}`,
      });
    }

    assessments.create({
      id: 'assessment-1',
      work_item_id: 'wi-retry-1',
      issue_id: 'retry-1',
      decision: 'split_before_implement',
      status: 'advisory',
      summary: 'Split runtime and bot work.',
      constitution_hits_json: [],
      detail_json: {
        target_area: 'runtime+bots',
      },
    });
    assessments.create({
      id: 'assessment-2',
      work_item_id: 'wi-retry-2',
      issue_id: 'retry-2',
      decision: 'split_before_implement',
      status: 'advisory',
      summary: 'Split runtime and bot work again.',
      constitution_hits_json: [],
      detail_json: {
        target_area: 'runtime+bots',
      },
    });

    const service = new FitnessSignalService({
      workItemRepository: workItems,
      reviewEventRepository: reviews,
      governanceAssessmentRepository: assessments,
    });

    const signals = service.evaluate('acme/repo');

    expect(signals.map((signal) => signal.code)).toEqual(expect.arrayContaining([
      'hotspot_concentration',
      'repeated_review_churn',
      'repeated_retry_or_merge_failure',
      'duplicate_path_creation',
    ]));
  });

  test('detects repeated cross-surface architecture targets from touched paths', () => {
    workItems.create({
      id: 'wi-edge-1',
      linear_issue_id: 'edge-1',
      linear_identifier: 'INT-E1',
      linear_title: 'Runtime/server boundary change 1',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      touched_paths: [
        'src/runtime/hub.ts',
        'src/server/routes/runtime.ts',
      ],
      touched_areas: ['runtime', 'server'],
    });
    workItems.create({
      id: 'wi-edge-2',
      linear_issue_id: 'edge-2',
      linear_identifier: 'INT-E2',
      linear_title: 'Runtime/server boundary change 2',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      touched_paths: [
        'src/runtime/sessionStore.ts',
        'src/server/routes/runtime.ts',
      ],
      touched_areas: ['runtime', 'server'],
    });

    const service = new FitnessSignalService({
      workItemRepository: workItems,
      reviewEventRepository: reviews,
      governanceAssessmentRepository: assessments,
    });

    const signals = service.evaluate('acme/repo');
    const duplicatePath = signals.find((signal) => signal.code === 'duplicate_path_creation');

    expect(duplicatePath?.summary).toContain('runtime<->server');
  });

  test('evaluates v2 architecture fitness signals from boundary, family, and import-edge history', () => {
    workItems.create({
      id: 'wi-arch-1',
      linear_issue_id: 'arch-1',
      linear_identifier: 'INT-A1',
      linear_title: 'Runtime/server edge 1',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      touched_paths: ['src/runtime/hub.ts', 'src/server/routes/runtime.ts'],
      touched_areas: ['runtime', 'server'],
      path_families: ['runtime/hub', 'server/routes'],
      boundary_edges: ['runtime<->server'],
      import_edges: ['runtime/hub->server/routes'],
      architectural_target: 'runtime<->server',
    });
    workItems.create({
      id: 'wi-arch-2',
      linear_issue_id: 'arch-2',
      linear_identifier: 'INT-A2',
      linear_title: 'Runtime/server edge 2',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      touched_paths: ['src/runtime/sessionStore.ts', 'src/server/routes/runtime.ts'],
      touched_areas: ['runtime', 'server'],
      path_families: ['runtime/sessionStore', 'server/routes'],
      boundary_edges: ['runtime<->server'],
      import_edges: ['runtime/hub->server/routes'],
      architectural_target: 'runtime<->server',
    });
    workItems.create({
      id: 'wi-arch-3',
      linear_issue_id: 'arch-3',
      linear_identifier: 'INT-A3',
      linear_title: 'Runtime/server edge 3',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      touched_paths: ['src/runtime/stream.ts', 'src/server/routes/runtime.ts'],
      touched_areas: ['runtime', 'server'],
      path_families: ['runtime/stream', 'server/routes'],
      boundary_edges: ['runtime<->server'],
      import_edges: ['runtime/hub->server/routes'],
      architectural_target: 'runtime<->server',
    });

    assessments.create({
      id: 'arch-assessment-1',
      work_item_id: 'wi-arch-1',
      issue_id: 'arch-1',
      decision: 'split_before_implement',
      status: 'advisory',
      summary: 'Split this cross-surface dependency before implementation.',
      constitution_hits_json: [],
      detail_json: {
        architectural_target: 'runtime/hub->server/routes',
      },
    });
    assessments.create({
      id: 'arch-assessment-2',
      work_item_id: 'wi-arch-2',
      issue_id: 'arch-2',
      decision: 'accept_with_rewrite',
      status: 'advisory',
      summary: 'Rewrite this dependency change into a narrower step.',
      constitution_hits_json: [],
      detail_json: {
        architectural_target: 'runtime/hub->server/routes',
      },
    });

    const service = new FitnessSignalService({
      workItemRepository: workItems,
      reviewEventRepository: reviews,
      governanceAssessmentRepository: assessments,
    });

    const signals = service.evaluate('acme/repo');

    expect(signals.map((signal) => signal.code)).toEqual(expect.arrayContaining([
      'boundary_edge_churn',
      'control_path_sprawl',
      'cross_surface_dependency_expansion',
    ]));
    expect(signals.find((signal) => signal.code === 'boundary_edge_churn')?.summary).toContain('runtime<->server');
    expect(signals.find((signal) => signal.code === 'control_path_sprawl')?.summary).toContain('runtime<->server');
    expect(signals.find((signal) => signal.code === 'cross_surface_dependency_expansion')?.summary).toContain(
      'runtime/hub->server/routes',
    );
  });

  test('generates cleanup, consolidation, and constitution update suggestions from repo snapshot', () => {
    conflicts.create({
      id: 'conflict-1',
      repo_key: 'acme/repo',
      summary: 'Runtime and bot work keeps being split.',
      detail_json: {
        kind: 'split_before_implement',
        target_area: 'runtime+bots',
      },
      created_at: new Date('2026-04-01T00:00:00.000Z'),
    });
    conflicts.create({
      id: 'conflict-2',
      repo_key: 'acme/repo',
      summary: 'Runtime and bot work keeps being split again.',
      detail_json: {
        kind: 'split_before_implement',
        target_area: 'runtime+bots',
      },
      created_at: new Date('2026-04-05T00:00:00.000Z'),
    });
    conflicts.create({
      id: 'conflict-3',
      repo_key: 'acme/repo',
      summary: 'Manual override keeps getting used for constitution mismatch.',
      detail_json: {
        kind: 'governance_override',
        constitution_phrase: 'keep one orchestrator-centered control plane',
      },
      created_at: new Date('2026-04-06T00:00:00.000Z'),
    });
    conflicts.create({
      id: 'conflict-4',
      repo_key: 'acme/repo',
      summary: 'Manual override keeps getting used for constitution mismatch again.',
      detail_json: {
        kind: 'governance_override',
        constitution_phrase: 'keep one orchestrator-centered control plane',
      },
      created_at: new Date('2026-04-07T00:00:00.000Z'),
    });
    conflicts.create({
      id: 'conflict-5',
      repo_key: 'acme/repo',
      summary: 'Manual override keeps getting used for constitution mismatch yet again.',
      detail_json: {
        kind: 'governance_override',
        constitution_phrase: 'keep one orchestrator-centered control plane',
      },
      created_at: new Date('2026-04-08T00:00:00.000Z'),
    });

    const engine = new GovernanceSuggestionEngine();
    const signals: FitnessSignal[] = [
      { code: 'hotspot_concentration', summary: 'runtime is a hotspot', severity: 'medium' },
      { code: 'repeated_review_churn', summary: 'runtime reviews keep churning', severity: 'high' },
      { code: 'duplicate_path_creation', summary: 'runtime+bots keeps splitting', severity: 'medium' },
    ];

    const suggestionsToCreate = engine.generate({
      repo_key: 'acme/repo',
      active_signals: signals,
      recent_conflicts: conflicts.findByRepoKey('acme/repo'),
      latest_assessments: [],
      existing_suggestions: [],
    });

    expect(suggestionsToCreate.map((item) => item.suggestion_type)).toEqual(expect.arrayContaining([
      'cleanup',
      'consolidation',
      'constitution_update',
    ]));
    expect(
      suggestionsToCreate.find((item) => item.suggestion_type === 'constitution_update')?.detail_json,
    ).toMatchObject({
      section: 'Preferred Directions',
      operation: 'append_bullet',
    });
  });
});
