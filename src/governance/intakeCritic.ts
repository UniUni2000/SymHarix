import {
  assessGovernanceForIssue,
  loadRepositoryConstitution,
  loadRepositoryHarness,
} from '../contracts/repositoryContracts';
import type {
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
  };
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

  if (constitutionAssessment.decision === 'reject_conflicting') {
    return buildAssessment(constitutionAssessment, {
      harness,
      constitution,
      blocksDispatch: true,
      requiresOverride: true,
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
      },
    );
  }

  if (shouldSplitIssue(params.issue)) {
    return buildAssessment(
      {
        decision: 'split_before_implement',
        status: 'advisory',
        summary: 'This issue spans multiple objectives across different parts of the system. Please split it before dispatch.',
        constitution_hits: constitutionAssessment.constitution_hits,
      },
      {
        harness,
        constitution,
        blocksDispatch: true,
        requiresOverride: true,
        splitSuggestions: collectSplitSuggestions(params.issue),
      },
    );
  }

  if (isVagueIssue(params.issue)) {
    return buildAssessment(
      {
        decision: 'accept_with_rewrite',
        status: 'advisory',
        summary: 'This issue is too vague to dispatch safely. Rewrite it into one concrete, verifiable task first.',
        constitution_hits: constitutionAssessment.constitution_hits,
      },
      {
        harness,
        constitution,
        blocksDispatch: true,
        requiresOverride: true,
        rewriteTitle: buildRewriteTitle(params.issue),
        rewriteDescription: buildRewriteDescription(params.issue),
      },
    );
  }

  return buildAssessment(constitutionAssessment, {
    harness,
    constitution,
    blocksDispatch: false,
    requiresOverride: false,
  });
}
