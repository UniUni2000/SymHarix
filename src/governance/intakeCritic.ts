import {
  assessGovernanceForIssue,
  loadRepositoryConstitution,
  loadRepositoryHarness,
} from '../contracts/repositoryContracts';
import type {
  FitnessSignal,
  GovernanceRepoSnapshot,
  IntakeCriticAssessment,
  Issue,
  ResolvedRepositoryConstitution,
  ResolvedRepositoryHarness,
  ResolvedRepositoryRoute,
} from '../types';

const VAGUE_PATTERNS = [
  /优化一下/i,
  /改一下/i,
  /修一下/i,
  /处理一下/i,
  /看一下/i,
  /稍微改改/i,
  /就行/i,
  /\bimprove\b/i,
  /\bfix it\b/i,
  /\btidy up\b/i,
];

const SPLIT_THEMES: Array<{ key: string; matcher: RegExp; suggestion: string }> = [
  {
    key: 'runtime',
    matcher: /\bruntime\b|\bapi\b|control plane|orchestrator|调度|控制面/i,
    suggestion: '先拆出 runtime / control-plane 变更，单独完成接口或调度主链。',
  },
  {
    key: 'web',
    matcher: /\bweb\b|dashboard|page|页面|网页|ui|前端/i,
    suggestion: '把网页或 UI 改动拆成单独 issue，避免和后端调度改动绑在一起。',
  },
  {
    key: 'bot',
    matcher: /telegram|discord|bot|文案|copy|聊天端/i,
    suggestion: '把 bot / 文案 / 聊天端体验拆成独立 issue，减少跨层耦合。',
  },
  {
    key: 'cleanup',
    matcher: /cleanup|clean related files|rewrite|redesign|重做|重构|清理/i,
    suggestion: '把大规模 cleanup / redesign 单独列出来，不要和功能性交付混在同一单里。',
  },
];

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTarget(value: string | null | undefined): string {
  return normalizeText(value);
}

function buildDefaultHarness(): ResolvedRepositoryHarness {
  return {
    status: 'missing',
    path: null,
    config: null,
    inferred_from: [],
    adoption_suggested: false,
  };
}

function buildDefaultConstitution(): ResolvedRepositoryConstitution {
  return {
    status: 'missing',
    path: null,
    sections: {},
  };
}

function buildAssessment(
  base: {
    decision: IntakeCriticAssessment['decision'];
    status: IntakeCriticAssessment['status'];
    summary: string;
    constitution_hits: IntakeCriticAssessment['constitution_hits'];
  },
  extras: {
    harness: ResolvedRepositoryHarness;
    constitution: ResolvedRepositoryConstitution;
    blocksDispatch?: boolean;
    requiresOverride?: boolean;
    rewriteTitle?: string | null;
    rewriteDescription?: string | null;
    splitSuggestions?: string[];
    repoKey?: string | null;
    targetArea?: string | null;
    activeFitnessSignals?: string[];
    relatedConflictCount?: number;
    relatedDebtSignalCount?: number;
    repeatedConstitutionPhrase?: string | null;
  },
): IntakeCriticAssessment {
  return {
    ...base,
    repo_harness_status: extras.harness.status,
    constitution_status: extras.constitution.status,
    blocks_dispatch: extras.blocksDispatch ?? base.decision !== 'accept',
    requires_override: extras.requiresOverride ?? base.decision !== 'accept',
    rewrite_title: extras.rewriteTitle ?? null,
    rewrite_description: extras.rewriteDescription ?? null,
    split_suggestions: extras.splitSuggestions ?? [],
    repo_key: extras.repoKey ?? null,
    target_area: extras.targetArea ?? null,
    active_fitness_signals: extras.activeFitnessSignals ?? [],
    related_conflict_count: extras.relatedConflictCount ?? 0,
    related_debt_signal_count: extras.relatedDebtSignalCount ?? 0,
    repeated_constitution_phrase: extras.repeatedConstitutionPhrase ?? null,
  };
}

function inferTargetArea(issue: Issue): string | null {
  const areas = new Set<string>();
  const combined = normalizeText(`${issue.title}\n${issue.description ?? ''}`);

  if (/\bruntime\b|control plane|hub|sse|stream|session/i.test(combined)) {
    areas.add('runtime');
  }
  if (/\bserver\b|route|http|webhook|api\/v1/i.test(combined)) {
    areas.add('server');
  }
  if (/telegram|discord|bot|chat/i.test(combined)) {
    areas.add('bots');
  }
  if (/orchestrator|dispatch|worker|lease|scheduler/i.test(combined)) {
    areas.add('orchestrator');
  }
  if (/scripts\/|python|cli\.py|hook/i.test(combined)) {
    areas.add('python-bridge');
  }

  return areas.size > 0 ? [...areas].sort().join('+') : null;
}

function extractAssessmentSignals(
  snapshot?: GovernanceRepoSnapshot | null,
  activeSignals?: FitnessSignal[] | null,
): string[] {
  return (activeSignals ?? snapshot?.active_fitness_signals ?? [])
    .map((signal) => signal.code)
    .filter(Boolean);
}

function countRelatedConflicts(
  snapshot: GovernanceRepoSnapshot | null | undefined,
  targetArea: string | null,
  constitutionPhrase: string | null,
): number {
  if (!snapshot) {
    return 0;
  }

  return snapshot.conflict_memories.filter((record) => {
    const recordTarget = normalizeTarget(
      typeof record.detail_json?.target_area === 'string' ? record.detail_json.target_area : null,
    );
    const recordPhrase = normalizeTarget(
      typeof record.detail_json?.constitution_phrase === 'string' ? record.detail_json.constitution_phrase : null,
    );
    return (
      (targetArea && recordTarget === normalizeTarget(targetArea)) ||
      (constitutionPhrase && recordPhrase === normalizeTarget(constitutionPhrase))
    );
  }).length;
}

function countRelatedDebtSignals(
  snapshot: GovernanceRepoSnapshot | null | undefined,
  targetArea: string | null,
): number {
  if (!snapshot) {
    return 0;
  }

  return snapshot.debt_signals.filter((record) => {
    const recordTarget = normalizeTarget(
      typeof record.detail_json?.target_area === 'string' ? record.detail_json.target_area : null,
    );
    return targetArea ? recordTarget === normalizeTarget(targetArea) : true;
  }).length;
}

function findRepeatedConstitutionPhrase(
  snapshot: GovernanceRepoSnapshot | null | undefined,
  constitutionPhrase: string | null,
): string | null {
  if (!snapshot || !constitutionPhrase) {
    return null;
  }

  const normalizedPhrase = normalizeTarget(constitutionPhrase);
  const count = snapshot.conflict_memories.filter((record) => (
    normalizeTarget(
      typeof record.detail_json?.constitution_phrase === 'string' ? record.detail_json.constitution_phrase : null,
    ) === normalizedPhrase
  )).length;

  return count >= 3 ? constitutionPhrase : null;
}

function splitTargetArea(targetArea: string | null): string[] {
  return normalizeTarget(targetArea)
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
}

function scoreWorkItemAgainstTarget(
  workItem: GovernanceRepoSnapshot['recent_work_items'][number],
  targetArea: string | null,
): number {
  const targetParts = splitTargetArea(targetArea);
  if (targetParts.length === 0) {
    return 1;
  }

  const touchedAreas = new Set(workItem.touched_areas.map((area) => normalizeTarget(area)));
  const architecturalTarget = normalizeTarget(workItem.architectural_target);
  const pathFamilies = workItem.path_families.map((family) => normalizeTarget(family));
  const boundaryEdges = workItem.boundary_edges.map((edge) => normalizeTarget(edge));
  const importEdges = workItem.import_edges.map((edge) => normalizeTarget(edge));

  let score = 0;
  for (const part of targetParts) {
    if (touchedAreas.has(part)) {
      score += 3;
    }
    if (architecturalTarget.includes(part)) {
      score += 2;
    }
    if (pathFamilies.some((family) => family.includes(part))) {
      score += 1;
    }
    if (boundaryEdges.some((edge) => edge.includes(part))) {
      score += 1;
    }
    if (importEdges.some((edge) => edge.includes(part))) {
      score += 1;
    }
  }

  return score;
}

function selectDominantValue(values: string[]): string | null {
  const counts = new Map<string, { count: number; firstIndex: number }>();
  values
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value, index) => {
      const entry = counts.get(value);
      if (entry) {
        entry.count += 1;
        return;
      }
      counts.set(value, { count: 1, firstIndex: index });
    });

  const ranked = [...counts.entries()].sort((left, right) => {
    if (right[1].count !== left[1].count) {
      return right[1].count - left[1].count;
    }
    return left[1].firstIndex - right[1].firstIndex;
  });

  return ranked[0]?.[0] ?? null;
}

function selectArchitecturalTarget(
  snapshot: GovernanceRepoSnapshot | null | undefined,
  targetArea: string | null,
  activeFitnessSignals: string[],
): string | null {
  if (!snapshot) {
    return null;
  }

  const candidates = snapshot.recent_work_items
    .filter((workItem) => scoreWorkItemAgainstTarget(workItem, targetArea) > 0);
  const scopedItems = candidates.length > 0 ? candidates : snapshot.recent_work_items;
  const signalSet = new Set(activeFitnessSignals);

  if (signalSet.has('cross_surface_dependency_expansion')) {
    const dominantImportEdge = selectDominantValue(
      scopedItems.flatMap((workItem) => workItem.import_edges),
    );
    if (dominantImportEdge) {
      return dominantImportEdge;
    }
  }

  if (signalSet.has('boundary_edge_churn')) {
    const dominantBoundaryEdge = selectDominantValue(
      scopedItems.flatMap((workItem) => workItem.boundary_edges),
    );
    if (dominantBoundaryEdge) {
      return dominantBoundaryEdge;
    }
  }

  const dominantArchitecturalTarget = selectDominantValue(
    scopedItems
      .map((workItem) => workItem.architectural_target ?? '')
      .filter(Boolean),
  );
  if (dominantArchitecturalTarget) {
    return dominantArchitecturalTarget;
  }

  if (signalSet.has('control_path_sprawl')) {
    const dominantPathFamily = selectDominantValue(
      scopedItems.flatMap((workItem) => workItem.path_families),
    );
    if (dominantPathFamily) {
      return dominantPathFamily;
    }
  }

  return null;
}

function buildRepoAdvisorySummary(params: {
  baseSummary: string;
  repoKey: string | null;
  targetArea: string | null;
  architecturalTarget: string | null;
  activeFitnessSignals: string[];
  repeatedConstitutionPhrase: string | null;
}): string {
  const notes: string[] = [];
  const signalSet = new Set(params.activeFitnessSignals);

  if (
    params.targetArea &&
    signalSet.has('hotspot_concentration') &&
    (signalSet.has('repeated_review_churn') || signalSet.has('repeated_retry_or_merge_failure'))
  ) {
    notes.push(
      `Recent repo history shows ${params.targetArea} is already in a churn-heavy hotspot, so this change should be narrowed or split before more work lands.`,
    );
  }

  if (params.targetArea && signalSet.has('duplicate_path_creation')) {
    notes.push(
      `Recent repo history shows ${params.targetArea} keeps recreating the same cross-surface path, so prefer consolidation or rewrite instead of another parallel path.`,
    );
  }

  if (params.architecturalTarget && signalSet.has('boundary_edge_churn')) {
    notes.push(
      `Recent repo history shows boundary edge ${params.architecturalTarget} keeps churning, so split this cross-surface change before extending it again.`,
    );
  }

  if (params.architecturalTarget && signalSet.has('control_path_sprawl')) {
    notes.push(
      `Recent repo history shows ${params.architecturalTarget} is already spread across multiple control-path families, so rewrite this toward consolidation before dispatch.`,
    );
  }

  if (params.architecturalTarget && signalSet.has('cross_surface_dependency_expansion')) {
    notes.push(
      `Recent repo history shows cross-surface dependency ${params.architecturalTarget} keeps expanding, so narrow this change before adding more coupling.`,
    );
  }

  if (params.repeatedConstitutionPhrase) {
    notes.push(
      `This also repeats a recent constitution conflict phrase from repo history: "${params.repeatedConstitutionPhrase}".`,
    );
  }

  if (notes.length === 0) {
    return params.baseSummary;
  }

  return `${params.baseSummary} Repo context (${params.repoKey ?? 'unknown repo'}): ${notes.join(' ')}`;
}

function isVagueIssue(issue: Issue): boolean {
  const title = normalizeText(issue.title);
  const description = normalizeText(issue.description);
  if (!title && !description) {
    return true;
  }

  return VAGUE_PATTERNS.some((pattern) => pattern.test(title) || pattern.test(description));
}

function stripVagueLeadIn(value: string): string {
  return value
    .replace(/^(优化一下|改一下|修一下|处理一下|看一下|稍微改改)\s*/i, '')
    .replace(/\s*(就行|即可)$/i, '')
    .trim();
}

function buildRewriteTitle(issue: Issue): string {
  const cleaned = stripVagueLeadIn(issue.title.trim());
  if (!cleaned) {
    return 'Clarify the exact repository change and expected verification';
  }
  return `Concrete task: ${cleaned}`;
}

function buildRewriteDescription(issue: Issue): string {
  const currentDescription = stripVagueLeadIn(issue.description ?? '');
  return [
    'Rewrite this issue into one concrete repository task.',
    currentDescription ? `Current context: ${currentDescription}` : null,
    'Include the target area, intended user-visible outcome, and the command or artifact that proves completion.',
  ]
    .filter(Boolean)
    .join('\n');
}

function collectSplitSuggestions(issue: Issue): string[] {
  const combined = normalizeText(`${issue.title}\n${issue.description ?? ''}`);
  const suggestions = SPLIT_THEMES
    .filter((theme) => theme.matcher.test(combined))
    .map((theme) => theme.suggestion);

  if (suggestions.length > 0) {
    return suggestions;
  }

  return [
    `将 ${issue.identifier} 拆成 2-3 张单，每张单只覆盖一个目标和一套完成证据。`,
  ];
}

function shouldSplitIssue(issue: Issue): boolean {
  const combined = normalizeText(`${issue.title}\n${issue.description ?? ''}`);
  const matchedThemes = SPLIT_THEMES.filter((theme) => theme.matcher.test(combined));
  const conjunctionCount = (combined.match(/\band\b|同时|并且|以及|再|还要|另外/gi) ?? []).length;

  if (matchedThemes.length >= 3) {
    return true;
  }

  return matchedThemes.length >= 2 && conjunctionCount >= 2;
}

export async function assessIntakeCritic(params: {
  issue: Issue;
  route: ResolvedRepositoryRoute;
  repositoryRoot: string | null;
  resolvedHarness?: ResolvedRepositoryHarness | null;
  resolvedConstitution?: ResolvedRepositoryConstitution | null;
  repoSnapshot?: GovernanceRepoSnapshot | null;
  activeFitnessSignals?: FitnessSignal[] | null;
}): Promise<IntakeCriticAssessment> {
  const harness =
    params.resolvedHarness ??
    (params.repositoryRoot ? await loadRepositoryHarness(params.repositoryRoot) : buildDefaultHarness());
  const constitution =
    params.resolvedConstitution ??
    (params.repositoryRoot
      ? await loadRepositoryConstitution(params.repositoryRoot)
      : buildDefaultConstitution());

  const constitutionAssessment = assessGovernanceForIssue({
    issue: params.issue,
    constitution,
  });
  const repoKey = params.repoSnapshot?.repo_key ?? params.route.github_repo_full;
  const targetArea = inferTargetArea(params.issue);
  const activeFitnessSignals = extractAssessmentSignals(params.repoSnapshot, params.activeFitnessSignals);
  const architecturalTarget = selectArchitecturalTarget(
    params.repoSnapshot,
    targetArea,
    activeFitnessSignals,
  );
  const repeatedConstitutionPhrase = findRepeatedConstitutionPhrase(
    params.repoSnapshot,
    constitutionAssessment.constitution_hits[0]?.phrase ?? null,
  );
  const relatedConflictCount = countRelatedConflicts(
    params.repoSnapshot,
    targetArea,
    constitutionAssessment.constitution_hits[0]?.phrase ?? null,
  );
  const relatedDebtSignalCount = countRelatedDebtSignals(params.repoSnapshot, targetArea);
  const churnHeavyHotspot =
    activeFitnessSignals.includes('hotspot_concentration') &&
    (
      activeFitnessSignals.includes('repeated_review_churn') ||
      activeFitnessSignals.includes('repeated_retry_or_merge_failure')
    );
  const boundaryEdgeChurn = activeFitnessSignals.includes('boundary_edge_churn');
  const controlPathSprawl = activeFitnessSignals.includes('control_path_sprawl');
  const crossSurfaceDependencyExpansion = activeFitnessSignals.includes('cross_surface_dependency_expansion');
  const duplicatePathPressure = activeFitnessSignals.includes('duplicate_path_creation');

  if (constitutionAssessment.decision === 'reject_conflicting') {
    return buildAssessment({
      ...constitutionAssessment,
      summary: buildRepoAdvisorySummary({
        baseSummary: constitutionAssessment.summary,
        repoKey,
        targetArea,
        architecturalTarget,
        activeFitnessSignals,
        repeatedConstitutionPhrase,
      }),
    }, {
      harness,
      constitution,
      blocksDispatch: true,
      requiresOverride: true,
      repoKey,
      targetArea,
      activeFitnessSignals,
      relatedConflictCount,
      relatedDebtSignalCount,
      repeatedConstitutionPhrase,
    });
  }

  if (params.route.require_repo_harness && harness.status !== 'formal') {
    return buildAssessment(
      {
        decision: 'defer',
        status: 'blocked',
        summary: `${params.issue.identifier} requires a formal .symphony-repo.yaml before dispatch can continue.`,
        constitution_hits: constitutionAssessment.constitution_hits,
      },
      {
        harness,
        constitution,
        blocksDispatch: true,
        requiresOverride: true,
        repoKey,
        targetArea,
        activeFitnessSignals,
        relatedConflictCount,
        relatedDebtSignalCount,
        repeatedConstitutionPhrase,
      },
    );
  }

  if (shouldSplitIssue(params.issue) || (Boolean(targetArea) && churnHeavyHotspot)) {
    return buildAssessment(
      {
        decision: 'split_before_implement',
        status: 'advisory',
        summary: buildRepoAdvisorySummary({
          baseSummary: shouldSplitIssue(params.issue)
            ? 'This issue spans multiple objectives across different parts of the system. Please split it before dispatch.'
            : 'This repo area is already churning heavily. Split or narrow the request before dispatch so cleanup can happen on a clearer path.',
          repoKey,
          targetArea,
          architecturalTarget,
          activeFitnessSignals,
          repeatedConstitutionPhrase,
        }),
        constitution_hits: constitutionAssessment.constitution_hits,
      },
      {
        harness,
        constitution,
        blocksDispatch: true,
        requiresOverride: true,
        splitSuggestions: shouldSplitIssue(params.issue)
          ? collectSplitSuggestions(params.issue)
          : [
              `先把 ${targetArea ?? 'this repo area'} 的 cleanup / narrowing 单独拆出来，再做新的 surface 扩张。`,
            ],
        repoKey,
        targetArea,
        activeFitnessSignals,
        relatedConflictCount,
        relatedDebtSignalCount,
        repeatedConstitutionPhrase,
      },
    );
  }

  if (boundaryEdgeChurn) {
    return buildAssessment(
      {
        decision: 'split_before_implement',
        status: 'advisory',
        summary: buildRepoAdvisorySummary({
          baseSummary: architecturalTarget
            ? `The repeated architectural edge ${architecturalTarget} should be split before implementation.`
            : 'The repeated architectural boundary should be split before implementation.',
          repoKey,
          targetArea,
          architecturalTarget,
          activeFitnessSignals,
          repeatedConstitutionPhrase,
        }),
        constitution_hits: constitutionAssessment.constitution_hits,
      },
      {
        harness,
        constitution,
        blocksDispatch: true,
        requiresOverride: true,
        splitSuggestions: [
          `先把 ${architecturalTarget ?? targetArea ?? 'this cross-surface boundary'} 的 cleanup / interface narrowing 单独拆出来，再继续新的 surface 扩张。`,
        ],
        repoKey,
        targetArea,
        activeFitnessSignals,
        relatedConflictCount,
        relatedDebtSignalCount,
        repeatedConstitutionPhrase,
      },
    );
  }

  if (
    isVagueIssue(params.issue) ||
    (Boolean(targetArea) && duplicatePathPressure && relatedConflictCount > 0) ||
    controlPathSprawl ||
    crossSurfaceDependencyExpansion
  ) {
    return buildAssessment(
      {
        decision: 'accept_with_rewrite',
        status: 'advisory',
        summary: buildRepoAdvisorySummary({
          baseSummary: isVagueIssue(params.issue)
            ? 'This issue is too vague to dispatch safely. Rewrite it into one concrete, verifiable task first.'
            : controlPathSprawl
              ? `This request should be rewritten toward consolidation before dispatch because ${architecturalTarget ?? 'the current control path'} is already sprawling across multiple entry families.`
              : crossSurfaceDependencyExpansion
                ? `This request should be rewritten before dispatch because ${architecturalTarget ?? 'the current cross-surface dependency'} keeps expanding.`
            : 'This request should be rewritten toward consolidation before dispatch because the same repo target keeps reappearing.',
          repoKey,
          targetArea,
          architecturalTarget,
          activeFitnessSignals,
          repeatedConstitutionPhrase,
        }),
        constitution_hits: constitutionAssessment.constitution_hits,
      },
      {
        harness,
        constitution,
        blocksDispatch: true,
        requiresOverride: true,
        rewriteTitle: buildRewriteTitle(params.issue),
        rewriteDescription: buildRewriteDescription(params.issue),
        repoKey,
        targetArea,
        activeFitnessSignals,
        relatedConflictCount,
        relatedDebtSignalCount,
        repeatedConstitutionPhrase,
      },
    );
  }

  return buildAssessment(constitutionAssessment, {
    harness,
    constitution,
    blocksDispatch: false,
    requiresOverride: false,
    repoKey,
    targetArea,
    activeFitnessSignals,
    relatedConflictCount,
    relatedDebtSignalCount,
    repeatedConstitutionPhrase,
  });
}
