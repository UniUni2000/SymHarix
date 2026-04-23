import type {
  ConflictMemoryRecord,
  ConflictMemoryRepository,
  DebtSignalRepository,
  DecisionMemoryRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  WorkItemRepository,
} from '../database';
import type { WorkItem } from '../database/types';
import type {
  AgentTimelinePayload,
  FitnessSignal,
  GovernanceRepoSnapshot,
} from '../types';
import {
  deriveArchitecturalTarget,
  deriveBoundaryEdges,
  deriveControlPathFamilies,
  derivePathFamilies,
  deriveTouchedAreas,
} from './architectureIntelligence';
export { deriveBoundaryEdges, derivePathFamilies, deriveTouchedAreas } from './architectureIntelligence';

const TERMINAL_STATES = new Set(['done', 'cancelled', 'canceled', 'duplicate']);
const REVIEW_CHURN_DECISIONS = new Set(['REQUEST_CHANGES', 'REQUEST_TESTS', 'REJECT']);
const RETRY_OR_FAILURE_DECISIONS = new Set(['REQUEST_CHANGES', 'REQUEST_TESTS', 'REJECT', 'MERGE_BLOCKED']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function normalizeTarget(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function extractPathFromDetail(
  toolName: string | null | undefined,
  detail: Record<string, unknown> | null,
): string | null {
  if (!detail) {
    return null;
  }

  if (typeof detail.path === 'string' && detail.path.trim()) {
    return detail.path.trim();
  }

  if (
    typeof detail.summary === 'string' &&
    ['Read', 'Write', 'Edit'].includes(toolName ?? '') &&
    detail.summary.trim()
  ) {
    return detail.summary.trim();
  }

  return null;
}

export function deriveTouchedPathsFromTimeline(timeline: AgentTimelinePayload[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const entry of timeline) {
    if (entry.category !== 'tool') {
      continue;
    }

    const path = extractPathFromDetail(entry.tool_name, asRecord(entry.detail));
    if (!path || seen.has(path)) {
      continue;
    }

    seen.add(path);
    paths.push(path);
  }

  return paths;
}

export function deriveArchitectureTarget(paths: string[]): string | null {
  const touchedAreas = deriveTouchedAreas(paths);
  const pathFamilies = derivePathFamilies(paths);
  const boundaryEdges = deriveBoundaryEdges(paths);
  return deriveArchitecturalTarget({
    touchedAreas,
    pathFamilies,
    boundaryEdges,
    importEdges: [],
  });
}

function resolvePathFamiliesForWorkItem(workItem: WorkItem | null): string[] {
  return workItem && workItem.path_families.length > 0
    ? workItem.path_families
    : derivePathFamilies(workItem?.touched_paths ?? []);
}

function resolveBoundaryEdgesForWorkItem(workItem: WorkItem | null): string[] {
  return workItem && workItem.boundary_edges.length > 0
    ? workItem.boundary_edges
    : deriveBoundaryEdges(workItem?.touched_paths ?? []);
}

function resolveImportEdgesForWorkItem(workItem: WorkItem | null): string[] {
  return workItem?.import_edges ?? [];
}

function resolveArchitecturalTargetForWorkItem(workItem: WorkItem | null): string | null {
  if (!workItem) {
    return null;
  }
  if (workItem.architectural_target) {
    return workItem.architectural_target;
  }
  return deriveArchitecturalTarget({
    touchedAreas: workItem.touched_areas.length > 0 ? workItem.touched_areas : deriveTouchedAreas(workItem.touched_paths),
    pathFamilies: resolvePathFamiliesForWorkItem(workItem),
    boundaryEdges: resolveBoundaryEdgesForWorkItem(workItem),
    importEdges: resolveImportEdgesForWorkItem(workItem),
  });
}

export interface GovernanceMemoryServiceOptions {
  workItemRepository: WorkItemRepository;
  reviewEventRepository: ReviewEventRepository;
  governanceAssessmentRepository: GovernanceAssessmentRepository;
  governanceSuggestionRepository: GovernanceSuggestionRepository;
  decisionMemoryRepository: DecisionMemoryRepository;
  conflictMemoryRepository: ConflictMemoryRepository;
  debtSignalRepository: DebtSignalRepository;
}

export class GovernanceMemoryService {
  constructor(private readonly options: GovernanceMemoryServiceOptions) {}

  recordDecisionOutcome(workItemId: string): void {
    const workItem = this.options.workItemRepository.findById(workItemId);
    if (
      !workItem ||
      !['APPROVE', 'APPROVE_MINOR'].includes(workItem.last_review_decision ?? '') ||
      workItem.missing_requirements.length > 0
    ) {
      return;
    }

    const summary = `${workItem.linear_identifier} completed successfully on the repo main path.`;
    const existing = this.options.decisionMemoryRepository.findByRepoKey(workItem.github_repo);
    if (existing.some((record) => record.summary === summary)) {
      return;
    }

    this.options.decisionMemoryRepository.create({
      id: crypto.randomUUID(),
      repo_key: workItem.github_repo,
      summary,
      detail_json: {
        source_issue_identifier: workItem.linear_identifier,
        touched_paths: workItem.touched_paths,
        touched_areas: workItem.touched_areas,
        path_families: resolvePathFamiliesForWorkItem(workItem),
        boundary_edges: resolveBoundaryEdgesForWorkItem(workItem),
        import_edges: resolveImportEdgesForWorkItem(workItem),
        architectural_target: resolveArchitecturalTargetForWorkItem(workItem),
      },
    });
  }

  recordConflictOutcome(
    workItemId: string,
    input: {
      kind: 'accept_with_rewrite' | 'split_before_implement' | 'reject_conflicting' | 'governance_override';
      summary: string;
      constitution_phrase?: string | null;
      target_area?: string | null;
    },
  ): void {
    const workItem = this.options.workItemRepository.findById(workItemId);
    if (!workItem) {
      return;
    }

    const existing = this.options.conflictMemoryRepository.findByRepoKey(workItem.github_repo);
    if (
      existing.some((record) => (
        record.summary === input.summary &&
        normalizeTarget(String(record.detail_json?.kind ?? '')) === normalizeTarget(input.kind)
      ))
    ) {
      return;
    }

    this.options.conflictMemoryRepository.create({
      id: crypto.randomUUID(),
      repo_key: workItem.github_repo,
      summary: input.summary,
      detail_json: {
        kind: input.kind,
        source_issue_identifier: workItem.linear_identifier,
        constitution_phrase: input.constitution_phrase ?? null,
        target_area: input.target_area ?? resolveArchitecturalTargetForWorkItem(workItem) ?? (workItem.touched_areas.join('+') || null),
        touched_paths: workItem.touched_paths,
        touched_areas: workItem.touched_areas,
        path_families: resolvePathFamiliesForWorkItem(workItem),
        boundary_edges: resolveBoundaryEdgesForWorkItem(workItem),
        import_edges: resolveImportEdgesForWorkItem(workItem),
      },
    });
  }

  recordDebtOutcome(
    workItemId: string,
    input: {
      signal_code: string;
      summary: string;
      severity: 'low' | 'medium' | 'high';
    },
  ): void {
    const workItem = this.options.workItemRepository.findById(workItemId);
    if (!workItem) {
      return;
    }

    const existing = this.options.debtSignalRepository.findByRepoKey(workItem.github_repo);
    if (
      existing.some((record) => (
        record.signal_code === input.signal_code &&
        record.summary === input.summary
      ))
    ) {
      return;
    }

    this.options.debtSignalRepository.create({
      id: crypto.randomUUID(),
      repo_key: workItem.github_repo,
      signal_code: input.signal_code,
      summary: input.summary,
      severity: input.severity,
      detail_json: {
        source_issue_identifier: workItem.linear_identifier,
        target_area: resolveArchitecturalTargetForWorkItem(workItem),
        touched_paths: workItem.touched_paths,
        touched_areas: workItem.touched_areas,
        path_families: resolvePathFamiliesForWorkItem(workItem),
        boundary_edges: resolveBoundaryEdgesForWorkItem(workItem),
        import_edges: resolveImportEdgesForWorkItem(workItem),
      },
    });
  }

  buildRepoSnapshot(repoKey: string, activeSignals: FitnessSignal[] = []): GovernanceRepoSnapshot {
    const workItems = this.options.workItemRepository
      .findAll()
      .filter((item) => item.github_repo === repoKey);
    const reviewEvents = workItems
      .flatMap((item) => this.options.reviewEventRepository.findByWorkItemId(item.id))
      .sort((left, right) => right.created_at.getTime() - left.created_at.getTime());
    const assessments = workItems
      .flatMap((item) => this.options.governanceAssessmentRepository.findByWorkItemId(item.id))
      .sort((left, right) => right.created_at.getTime() - left.created_at.getTime());

    return {
      repo_key: repoKey,
      recent_work_items: workItems.map((item) => ({
        work_item_id: item.id,
        issue_identifier: item.linear_identifier,
        linear_state: item.linear_state,
        last_review_decision: item.last_review_decision,
        touched_paths: item.touched_paths,
        touched_areas: item.touched_areas,
        path_families: resolvePathFamiliesForWorkItem(item),
        boundary_edges: resolveBoundaryEdgesForWorkItem(item),
        import_edges: resolveImportEdgesForWorkItem(item),
        architectural_target: resolveArchitecturalTargetForWorkItem(item),
        updated_at: item.updated_at.toISOString(),
      })),
      recent_review_events: reviewEvents.map((event) => ({
        work_item_id: event.work_item_id,
        decision: event.decision,
        created_at: event.created_at.toISOString(),
      })),
      latest_assessments: assessments.map((record) => ({
        work_item_id: record.work_item_id,
        decision: record.decision,
        summary: record.summary,
        detail_json: record.detail_json,
        created_at: record.created_at.toISOString(),
      })),
      decision_memories: this.options.decisionMemoryRepository.findByRepoKey(repoKey).map((record) => ({
        summary: record.summary,
        detail_json: record.detail_json,
        created_at: record.created_at.toISOString(),
      })),
      conflict_memories: this.options.conflictMemoryRepository.findByRepoKey(repoKey).map((record) => ({
        summary: record.summary,
        detail_json: record.detail_json,
        created_at: record.created_at.toISOString(),
      })),
      debt_signals: this.options.debtSignalRepository.findByRepoKey(repoKey).map((record) => ({
        signal_code: record.signal_code,
        summary: record.summary,
        severity: record.severity,
        detail_json: record.detail_json,
        created_at: record.created_at.toISOString(),
      })),
      active_fitness_signals: activeSignals,
    };
  }
}

export interface FitnessSignalServiceOptions {
  workItemRepository: WorkItemRepository;
  reviewEventRepository: ReviewEventRepository;
  governanceAssessmentRepository: GovernanceAssessmentRepository;
}

export class FitnessSignalService {
  constructor(private readonly options: FitnessSignalServiceOptions) {}

  evaluate(repoKey: string): FitnessSignal[] {
    const workItems = this.options.workItemRepository
      .findAll()
      .filter((item) => item.github_repo === repoKey)
      .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime());
    const signals: FitnessSignal[] = [];
    const recentAssessments = workItems
      .flatMap((item) => this.options.governanceAssessmentRepository.findByWorkItemId(item.id))
      .sort((left, right) => right.created_at.getTime() - left.created_at.getTime());

    const recentCompleted = workItems
      .filter((item) => TERMINAL_STATES.has(item.linear_state.toLowerCase()))
      .slice(0, 6);
    const areaCounts = new Map<string, number>();
    const familyCounts = new Map<string, number>();
    for (const item of recentCompleted) {
      const areas = item.touched_areas.length > 0 ? item.touched_areas : deriveTouchedAreas(item.touched_paths);
      for (const area of areas) {
        areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
      }
      for (const family of resolvePathFamiliesForWorkItem(item)) {
        familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
      }
    }
    const hotspotFamily = [...familyCounts.entries()].find(([, count]) => count >= 3);
    const hotspot = hotspotFamily ?? [...areaCounts.entries()].find(([, count]) => count >= 4);
    if (hotspot) {
      signals.push({
        code: 'hotspot_concentration',
        summary: `${hotspot[0]} is absorbing repeated changes across recent completed work.`,
        severity: 'medium',
      });
    }

    const recentReviewEvents = workItems
      .flatMap((item) => this.options.reviewEventRepository.findByWorkItemId(item.id))
      .sort((left, right) => right.created_at.getTime() - left.created_at.getTime())
      .slice(0, 5);
    const churnCount = recentReviewEvents.filter((event) => REVIEW_CHURN_DECISIONS.has(event.decision)).length;
    if (churnCount >= 3) {
      signals.push({
        code: 'repeated_review_churn',
        summary: 'Recent review rounds repeatedly requested more changes.',
        severity: 'high',
      });
    }

    const retryOrFailureCount = workItems
      .filter((item) => RETRY_OR_FAILURE_DECISIONS.has(item.last_review_decision ?? ''))
      .slice(0, 8)
      .length;
    if (retryOrFailureCount >= 3) {
      signals.push({
        code: 'repeated_retry_or_merge_failure',
        summary: 'Recent work repeatedly hit retry loops or merge-blocked outcomes.',
        severity: 'high',
      });
    }

    const targetCounts = new Map<string, number>();
    for (const record of recentAssessments.filter((candidate) => (
      ['split_before_implement', 'accept_with_rewrite'].includes(candidate.decision)
    ))) {
      const target = normalizeTarget(
        typeof record.detail_json?.architectural_target === 'string'
          ? record.detail_json.architectural_target
          : String(record.detail_json?.target_area ?? ''),
      );
      if (!target) {
        continue;
      }
      targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
    }
    const recentArchitecturalTargets = workItems
      .slice(0, 8)
      .map((item) => resolveArchitecturalTargetForWorkItem(item))
      .filter((target): target is string => Boolean(target));
    for (const target of recentArchitecturalTargets) {
      const normalizedTarget = normalizeTarget(target);
      targetCounts.set(normalizedTarget, (targetCounts.get(normalizedTarget) ?? 0) + 1);
    }
    const repeatedTarget = [...targetCounts.entries()].find(([, count]) => count >= 2);
    if (repeatedTarget) {
      signals.push({
        code: 'duplicate_path_creation',
        summary: `${repeatedTarget[0]} keeps reappearing as the same cross-surface governance target.`,
        severity: 'medium',
      });
    }

    const boundaryEdgeCounts = new Map<string, number>();
    for (const item of recentCompleted) {
      for (const edge of resolveBoundaryEdgesForWorkItem(item)) {
        boundaryEdgeCounts.set(edge, (boundaryEdgeCounts.get(edge) ?? 0) + 1);
      }
    }
    const repeatedBoundaryEdge = [...boundaryEdgeCounts.entries()].find(([, count]) => count >= 3);
    if (repeatedBoundaryEdge) {
      signals.push({
        code: 'boundary_edge_churn',
        summary: `${repeatedBoundaryEdge[0]} keeps absorbing repeated cross-surface work.`,
        severity: 'high',
      });
    }

    const controlPathTargets = new Map<string, Set<string>>();
    for (const item of workItems.slice(0, 8)) {
      const architecturalTarget = resolveArchitecturalTargetForWorkItem(item);
      if (!architecturalTarget) {
        continue;
      }
      const familyBucket = controlPathTargets.get(architecturalTarget) ?? new Set<string>();
      for (const family of deriveControlPathFamilies(resolvePathFamiliesForWorkItem(item))) {
        familyBucket.add(family);
      }
      controlPathTargets.set(architecturalTarget, familyBucket);
    }
    const sprawlingTarget = [...controlPathTargets.entries()].find(([, families]) => families.size >= 3);
    if (sprawlingTarget) {
      signals.push({
        code: 'control_path_sprawl',
        summary: `${sprawlingTarget[0]} is spreading across too many control-path families.`,
        severity: 'high',
      });
    }

    const recentCompletedWithImports = recentCompleted.filter((item) => resolveImportEdgesForWorkItem(item).length > 0);
    const importEdgeCounts = new Map<string, { count: number; advisory_hits: number }>();
    for (const item of recentCompletedWithImports) {
      for (const edge of resolveImportEdgesForWorkItem(item)) {
        const bucket = importEdgeCounts.get(edge) ?? { count: 0, advisory_hits: 0 };
        bucket.count += 1;
        const advisoryHits = recentAssessments.filter((record) => (
          record.work_item_id === item.id &&
          ['split_before_implement', 'accept_with_rewrite'].includes(record.decision) &&
          normalizeTarget(
            typeof record.detail_json?.architectural_target === 'string'
              ? record.detail_json.architectural_target
              : String(record.detail_json?.target_area ?? ''),
          ) === normalizeTarget(edge)
        )).length;
        const duplicateHits = item.fitness_signals.some((signal) => signal.code === 'duplicate_path_creation') ? 1 : 0;
        bucket.advisory_hits += advisoryHits + duplicateHits;
        importEdgeCounts.set(edge, bucket);
      }
    }
    const expandingImportEdge = [...importEdgeCounts.entries()].find(([, bucket]) => (
      bucket.count >= 3 &&
      bucket.advisory_hits >= 2
    ));
    if (expandingImportEdge) {
      signals.push({
        code: 'cross_surface_dependency_expansion',
        summary: `${expandingImportEdge[0]} keeps expanding as a repeated cross-surface dependency.`,
        severity: 'high',
      });
    }

    if (workItems.some((item) => item.governance_status === 'blocked')) {
      signals.push({
        code: 'constitution_violation',
        summary: 'Recent work was blocked by a constitution or governance gate.',
        severity: 'high',
      });
    }

    return signals;
  }
}

export interface GovernanceSuggestionDraft {
  suggestion_type: 'cleanup' | 'consolidation' | 'architecture_alignment' | 'constitution_update' | 'harness_adoption';
  title: string;
  summary: string;
  detail_json: Record<string, unknown>;
}

export class GovernanceSuggestionEngine {
  generate(params: {
    repo_key: string;
    active_signals: FitnessSignal[];
    recent_conflicts: ConflictMemoryRecord[];
    latest_assessments: GovernanceRepoSnapshot['latest_assessments'];
    existing_suggestions: Array<{
      suggestion_type: string;
      detail_json: Record<string, unknown> | null;
      title: string;
    }>;
  }): GovernanceSuggestionDraft[] {
    const drafts: GovernanceSuggestionDraft[] = [];
    const activeCodes = new Set(params.active_signals.map((signal) => signal.code));

    const addDraft = (draft: GovernanceSuggestionDraft): void => {
      const target = normalizeTarget(
        typeof draft.detail_json.normalized_target === 'string'
          ? draft.detail_json.normalized_target
          : (typeof draft.detail_json.architectural_target === 'string'
            ? draft.detail_json.architectural_target
            : (typeof draft.detail_json.target_area === 'string'
              ? draft.detail_json.target_area
              : draft.title)),
      );
      const duplicate = params.existing_suggestions.some((suggestion) => (
        suggestion.suggestion_type === draft.suggestion_type &&
        normalizeTarget(
          typeof suggestion.detail_json?.normalized_target === 'string'
            ? suggestion.detail_json.normalized_target
            : (typeof suggestion.detail_json?.architectural_target === 'string'
              ? suggestion.detail_json.architectural_target
              : (typeof suggestion.detail_json?.target_area === 'string'
                ? suggestion.detail_json.target_area
                : suggestion.title)),
        ) === target
      ));
      if (!duplicate) {
        drafts.push(draft);
      }
    };

    if (
      activeCodes.has('hotspot_concentration') &&
      (activeCodes.has('repeated_review_churn') || activeCodes.has('repeated_retry_or_merge_failure'))
    ) {
      const targetArea = params.recent_conflicts.find((record) => (
        typeof record.detail_json?.architectural_target === 'string' ||
        typeof record.detail_json?.target_area === 'string'
      ))?.detail_json;
      const normalizedTarget = (typeof targetArea?.architectural_target === 'string'
        ? targetArea.architectural_target
        : (typeof targetArea?.target_area === 'string' ? targetArea.target_area : undefined)) ?? 'repo-main-path';
      addDraft({
        suggestion_type: 'cleanup',
        title: `[GOVERNANCE] Clean up ${normalizedTarget ?? params.repo_key}`,
        summary: 'Repeated churn indicates this area should be cleaned up before more feature work lands.',
        detail_json: {
          repo_key: params.repo_key,
          target_area: normalizedTarget,
          architectural_target: normalizedTarget,
          normalized_target: normalizedTarget,
          recommended_issue_title: `[GOVERNANCE] Clean up ${normalizedTarget ?? params.repo_key}`,
          recommended_issue_description: `Source repo: ${params.repo_key}\nTarget area: ${normalizedTarget}\nReason: repeated review churn or retry failures.`,
        },
      });
    }

    if (activeCodes.has('duplicate_path_creation')) {
      const targetArea = params.recent_conflicts.find((record) => (
        typeof record.detail_json?.architectural_target === 'string' ||
        typeof record.detail_json?.target_area === 'string'
      ))?.detail_json;
      const normalizedTarget = (typeof targetArea?.architectural_target === 'string'
        ? targetArea.architectural_target
        : (typeof targetArea?.target_area === 'string' ? targetArea.target_area : undefined)) ?? 'repo-main-path';
      addDraft({
        suggestion_type: 'consolidation',
        title: `[GOVERNANCE] Consolidate ${normalizedTarget ?? params.repo_key}`,
        summary: 'The same cross-surface change keeps reappearing and should be consolidated.',
        detail_json: {
          repo_key: params.repo_key,
          target_area: normalizedTarget,
          architectural_target: normalizedTarget,
          normalized_target: normalizedTarget,
          recommended_issue_title: `[GOVERNANCE] Consolidate ${normalizedTarget ?? params.repo_key}`,
          recommended_issue_description: `Source repo: ${params.repo_key}\nTarget area: ${normalizedTarget}\nReason: duplicate governance targets keep reappearing.`,
        },
      });
    }

    const constitutionPhrases = new Map<string, number>();
    for (const record of params.recent_conflicts) {
      const phrase = typeof record.detail_json?.constitution_phrase === 'string'
        ? record.detail_json.constitution_phrase
        : null;
      if (!phrase) {
        continue;
      }
      constitutionPhrases.set(phrase, (constitutionPhrases.get(phrase) ?? 0) + 1);
    }
    const repeatedPhrase = [...constitutionPhrases.entries()].find(([, count]) => count >= 3)?.[0];
    if (repeatedPhrase) {
      addDraft({
        suggestion_type: 'constitution_update',
        title: '[GOVERNANCE] Update repository constitution',
        summary: 'Repeated overrides indicate the constitution should be clarified.',
        detail_json: {
          repo_key: params.repo_key,
          section: 'Preferred Directions',
          operation: 'append_bullet',
          proposed_bullet: `Clarify how to handle repeated exceptions around: ${repeatedPhrase}.`,
          normalized_target: repeatedPhrase,
        },
      });
    }

    return drafts;
  }
}
