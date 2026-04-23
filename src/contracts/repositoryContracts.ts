import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import type {
  ConstitutionHit,
  EffectiveRepositoryHarness,
  GovernanceAssessment,
  ShadowHarnessInferenceDetails,
  Issue,
  RepositoryHarnessConfig,
  RepositoryHarnessCommandKey,
  ResolvedRepositoryConstitution,
  ResolvedRepositoryHarness,
} from '../types';
import { ShadowHarnessRepository } from '../database';

const HARNESS_FILE = '.symphony-repo.yaml';
const CONSTITUTION_FILE = '.symphony-constitution.md';
const CHANGE_PACK_EVIDENCE_FILE = path.join('.symphony', 'change-pack', 'evidence.json');
const CANONICAL_COMMAND_KEYS: RepositoryHarnessCommandKey[] = [
  'setup',
  'dev',
  'test',
  'lint',
  'build',
  'review_checks',
];
const COMMON_LEARNED_ARTIFACTS = new Set([
  'dist',
  'build',
  'coverage',
  '.next',
  'playwright-report',
]);

interface ChangePackCommandRunRecord {
  command?: string;
  command_key?: string | null;
  status?: string;
  phase?: string;
}

interface ChangePackArtifactObservationRecord {
  path?: string;
  exists?: boolean;
  non_empty?: boolean;
}

interface ChangePackRuntimeObservationRecord {
  hint_key?: string;
  status?: string;
  value?: string;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function coerceCommandMap(value: unknown): Partial<Record<RepositoryHarnessCommandKey, string>> {
  if (!isRecord(value)) {
    return {};
  }

  const commands: Partial<Record<RepositoryHarnessCommandKey, string>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === 'string' &&
      entry.trim() &&
      CANONICAL_COMMAND_KEYS.includes(key as RepositoryHarnessCommandKey)
    ) {
      commands[key as RepositoryHarnessCommandKey] = entry.trim();
    }
  }

  return commands;
}

function mergeUniqueStrings(values: Array<string | null | undefined>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function parseInferenceSources(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInferenceDetails(value: unknown): ShadowHarnessInferenceDetails {
  if (!isRecord(value)) {
    return {
      inferred_from: [],
      observed_commands: {},
      observed_artifacts: {},
      observed_runtime_hints: {},
      learning_confidence: 'low',
      successful_work_item_ids: [],
      failed_work_item_ids: [],
    };
  }

  const observedCommands: ShadowHarnessInferenceDetails['observed_commands'] = {};
  for (const [key, entry] of Object.entries(isRecord(value.observed_commands) ? value.observed_commands : {})) {
    if (!isRecord(entry) || typeof entry.command !== 'string') {
      continue;
    }
    observedCommands[key] = {
      command: entry.command.trim(),
      success_count: Number(entry.success_count ?? 0),
      failure_count: Number(entry.failure_count ?? 0),
      last_status:
        entry.last_status === 'failed' || entry.last_status === 'satisfied'
          ? entry.last_status
          : null,
      last_work_item_id: typeof entry.last_work_item_id === 'string' ? entry.last_work_item_id : null,
    };
  }

  const observedArtifacts: ShadowHarnessInferenceDetails['observed_artifacts'] = {};
  for (const [key, entry] of Object.entries(isRecord(value.observed_artifacts) ? value.observed_artifacts : {})) {
    if (isRecord(entry)) {
      observedArtifacts[key] = {
        success_count: Number(entry.success_count ?? 0),
        last_work_item_id: typeof entry.last_work_item_id === 'string' ? entry.last_work_item_id : null,
      };
      continue;
    }
    observedArtifacts[key] = {
      success_count: Number(entry ?? 0),
      last_work_item_id: null,
    };
  }

  const observedRuntimeHints: ShadowHarnessInferenceDetails['observed_runtime_hints'] = {};
  for (const [key, entry] of Object.entries(isRecord(value.observed_runtime_hints) ? value.observed_runtime_hints : {})) {
    if (!isRecord(entry) || typeof entry.value !== 'string') {
      continue;
    }
    observedRuntimeHints[key] = {
      value: entry.value.trim(),
      success_count: Number(entry.success_count ?? 0),
      failure_count: Number(entry.failure_count ?? 0),
      last_status:
        entry.last_status === 'failed' || entry.last_status === 'satisfied'
          ? entry.last_status
          : null,
      last_work_item_id: typeof entry.last_work_item_id === 'string' ? entry.last_work_item_id : null,
    };
  }

  return {
    inferred_from: parseInferenceSources(value.inferred_from),
    observed_commands: observedCommands,
    observed_artifacts: observedArtifacts,
    observed_runtime_hints: observedRuntimeHints,
    learning_confidence:
      value.learning_confidence === 'medium' || value.learning_confidence === 'high'
        ? value.learning_confidence
        : 'low',
    successful_work_item_ids: parseInferenceSources(value.successful_work_item_ids),
    failed_work_item_ids: parseInferenceSources(value.failed_work_item_ids),
  };
}

function isLearnableArtifactPath(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!normalized) {
    return false;
  }

  const [rootSegment] = normalized.split('/');
  return COMMON_LEARNED_ARTIFACTS.has(rootSegment ?? normalized);
}

function parseChangePackEvidence(value: unknown): {
  command_runs: ChangePackCommandRunRecord[];
  artifact_observations: ChangePackArtifactObservationRecord[];
  runtime_observations: ChangePackRuntimeObservationRecord[];
} {
  if (!isRecord(value)) {
    return {
      command_runs: [],
      artifact_observations: [],
      runtime_observations: [],
    };
  }

  return {
    command_runs: Array.isArray(value.command_runs)
      ? value.command_runs.filter((entry): entry is ChangePackCommandRunRecord => isRecord(entry))
      : [],
    artifact_observations: Array.isArray(value.artifact_observations)
      ? value.artifact_observations.filter((entry): entry is ChangePackArtifactObservationRecord => isRecord(entry))
      : [],
    runtime_observations: Array.isArray(value.runtime_observations)
      ? value.runtime_observations.filter((entry): entry is ChangePackRuntimeObservationRecord => isRecord(entry))
      : [],
  };
}

function learnShadowHarnessConfigFromEvidence(params: {
  baseConfig: RepositoryHarnessConfig;
  inferenceDetails: ShadowHarnessInferenceDetails;
  evidence: ReturnType<typeof parseChangePackEvidence>;
  workItemId?: string | null;
}): {
  config: RepositoryHarnessConfig;
  inferenceDetails: ShadowHarnessInferenceDetails;
  learnedFromEvidence: boolean;
} {
  const commands = { ...(params.baseConfig.commands ?? {}) };
  const verificationRequiredCommands = [...(params.baseConfig.verification?.required_commands ?? [])];
  const artifacts = [...(params.baseConfig.artifacts ?? [])];
  const runtimeHints = { ...(params.baseConfig.runtime_hints ?? {}) };
  const inferredFrom = [...params.inferenceDetails.inferred_from];
  const observedCommands = { ...params.inferenceDetails.observed_commands };
  const observedArtifacts = { ...params.inferenceDetails.observed_artifacts };
  const observedRuntimeHints = { ...params.inferenceDetails.observed_runtime_hints };
  const successfulWorkItemIds = new Set(params.inferenceDetails.successful_work_item_ids ?? []);
  const failedWorkItemIds = new Set(params.inferenceDetails.failed_work_item_ids ?? []);
  let learnedFromEvidence = false;

  for (const run of params.evidence.command_runs) {
    if (
      typeof run.command !== 'string' ||
      !run.command.trim() ||
      typeof run.command_key !== 'string' ||
      !CANONICAL_COMMAND_KEYS.includes(run.command_key as RepositoryHarnessCommandKey)
    ) {
      continue;
    }

    const key = run.command_key as RepositoryHarnessCommandKey;
    const normalizedCommand = run.command.trim();
    const previous = observedCommands[key] ?? {
      command: normalizedCommand,
      success_count: 0,
      failure_count: 0,
      last_status: null,
      last_work_item_id: null,
    };
    const status = normalizeText(String(run.status ?? '')) === 'satisfied' ? 'satisfied' : 'failed';
    if (params.workItemId) {
      if (status === 'satisfied') {
        successfulWorkItemIds.add(params.workItemId);
      } else {
        failedWorkItemIds.add(params.workItemId);
      }
    }
    const next = {
      command: previous.command || normalizedCommand,
      success_count: previous.success_count + (status === 'satisfied' ? 1 : 0),
      failure_count: previous.failure_count + (status === 'failed' ? 1 : 0),
      last_status: status,
      last_work_item_id: params.workItemId ?? null,
    } satisfies ShadowHarnessInferenceDetails['observed_commands'][string];
    observedCommands[key] = next;

    const stableCommand =
      next.success_count >= 2 &&
      next.success_count > next.failure_count;
    if (stableCommand && !commands[key]) {
      commands[key] = next.command;
      learnedFromEvidence = true;
    }
    if (stableCommand && ['test', 'lint', 'build', 'review_checks'].includes(key)) {
      verificationRequiredCommands.push(key);
    }
  }

  for (const observation of params.evidence.artifact_observations) {
    if (
      typeof observation.path !== 'string' ||
      !observation.path.trim() ||
      observation.exists !== true ||
      observation.non_empty !== true ||
      !isLearnableArtifactPath(observation.path)
    ) {
      continue;
    }

    const normalizedPath = observation.path.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    observedArtifacts[normalizedPath] = {
      success_count: (observedArtifacts[normalizedPath]?.success_count ?? 0) + 1,
      last_work_item_id: params.workItemId ?? null,
    };
    if (observedArtifacts[normalizedPath].success_count >= 2) {
      artifacts.push(normalizedPath);
      learnedFromEvidence = true;
    }
  }

  for (const observation of params.evidence.runtime_observations) {
    if (
      typeof observation.hint_key !== 'string' ||
      !['url', 'ready_signal'].includes(observation.hint_key) ||
      typeof observation.value !== 'string' ||
      !observation.value.trim()
    ) {
      continue;
    }

    const hintKey = observation.hint_key as 'url' | 'ready_signal';
    const previous = observedRuntimeHints[hintKey] ?? {
      value: observation.value.trim(),
      success_count: 0,
      failure_count: 0,
      last_status: null,
      last_work_item_id: null,
    };
    const status = normalizeText(String(observation.status ?? '')) === 'satisfied' ? 'satisfied' : 'failed';
    if (params.workItemId) {
      if (status === 'satisfied') {
        successfulWorkItemIds.add(params.workItemId);
      } else {
        failedWorkItemIds.add(params.workItemId);
      }
    }
    const next = {
      value: previous.value || observation.value.trim(),
      success_count: previous.success_count + (status === 'satisfied' ? 1 : 0),
      failure_count: previous.failure_count + (status === 'failed' ? 1 : 0),
      last_status: status,
      last_work_item_id: params.workItemId ?? null,
    } satisfies ShadowHarnessInferenceDetails['observed_runtime_hints'][string];
    observedRuntimeHints[hintKey] = next;
    const stableHint =
      next.success_count >= 2 &&
      next.success_count > next.failure_count;
    if (stableHint) {
      runtimeHints[hintKey] = next.value;
      learnedFromEvidence = true;
    }
  }

  if (
    learnedFromEvidence &&
    !inferredFrom.includes('.symphony/change-pack/evidence.json')
  ) {
    inferredFrom.push('.symphony/change-pack/evidence.json');
  }

  const learnedCommandCount = Object.entries(observedCommands)
    .filter(([, record]) => record.success_count >= 2 && record.success_count > record.failure_count)
    .length;
  const learnedArtifactCount = Object.values(observedArtifacts)
    .filter((record) => record.success_count >= 2)
    .length;
  const learnedRuntimeHintCount = Object.values(observedRuntimeHints)
    .filter((record) => record.success_count >= 2 && record.success_count > record.failure_count)
    .length;
  const failureSamples = [
    ...Object.values(observedCommands).map((record) => record.failure_count),
    ...Object.values(observedRuntimeHints).map((record) => record.failure_count),
  ].reduce((sum, count) => sum + count, 0);
  const stableCount = learnedCommandCount + learnedArtifactCount + learnedRuntimeHintCount;
  const learningConfidence =
    (successfulWorkItemIds.size >= 3) && failureSamples === 0 && failedWorkItemIds.size === 0
      ? 'high'
      : stableCount >= 2
        ? 'medium'
        : 'low';

  return {
    config: {
      ...params.baseConfig,
      commands,
      artifacts: mergeUniqueStrings(artifacts),
      verification:
        mergeUniqueStrings(verificationRequiredCommands).length > 0 ||
        coerceStringArray(params.baseConfig.verification?.required_artifacts).length > 0
          ? {
              ...(params.baseConfig.verification ?? {}),
              required_commands: (() => {
                const requiredCommands = mergeUniqueStrings(verificationRequiredCommands);
                return requiredCommands.length > 0 ? requiredCommands : undefined;
              })(),
            }
          : undefined,
      runtime_hints: Object.keys(runtimeHints).length > 0 ? runtimeHints : undefined,
    },
    inferenceDetails: {
      inferred_from: inferredFrom,
      observed_commands: observedCommands,
      observed_artifacts: observedArtifacts,
      observed_runtime_hints: observedRuntimeHints,
      learning_confidence: learningConfidence,
      successful_work_item_ids: [...successfulWorkItemIds],
      failed_work_item_ids: [...failedWorkItemIds],
    },
    learnedFromEvidence,
  };
}

function coerceHarnessConfig(value: unknown): RepositoryHarnessConfig {
  if (!isRecord(value)) {
    return {};
  }

  const verification = isRecord(value.verification)
    ? {
        required_commands: coerceStringArray(value.verification.required_commands),
        required_artifacts: coerceStringArray(value.verification.required_artifacts),
      }
    : undefined;

  return {
    profiles: coerceStringArray(value.profiles) as RepositoryHarnessConfig['profiles'],
    commands: coerceCommandMap(value.commands),
    artifacts: coerceStringArray(value.artifacts),
    verification,
    runtime_hints: isRecord(value.runtime_hints)
      ? (value.runtime_hints as RepositoryHarnessConfig['runtime_hints'])
      : undefined,
  };
}

function parseConstitutionSections(content: string): Record<string, string[]> {
  const lines = content.split(/\r?\n/);
  const sections: Record<string, string[]> = {};
  let currentSection: string | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch?.[1]) {
      currentSection = headingMatch[1].trim();
      sections[currentSection] = sections[currentSection] ?? [];
      continue;
    }

    if (!currentSection) {
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (bulletMatch?.[1]) {
      sections[currentSection].push(bulletMatch[1].trim());
    }
  }

  return sections;
}

function issueText(issue: Issue): string {
  return normalizeText(`${issue.title}\n${issue.description || ''}`);
}

function collectConstitutionHits(
  issue: Issue,
  section: string,
  phrases: string[],
): ConstitutionHit[] {
  const haystack = issueText(issue);
  return phrases
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .filter((phrase) => haystack.includes(normalizeText(phrase)))
    .map((phrase) => ({ section, phrase }));
}

export async function loadRepositoryHarness(workspacePath: string): Promise<ResolvedRepositoryHarness> {
  const filePath = path.join(workspacePath, HARNESS_FILE);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = yaml.parse(content);
    return {
      status: 'formal',
      path: filePath,
      config: coerceHarnessConfig(parsed),
      inferred_from: [HARNESS_FILE],
      adoption_suggested: false,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      return {
        status: 'missing',
        path: null,
        config: null,
        inferred_from: [],
        adoption_suggested: false,
      };
    }

    throw error;
  }
}

export async function loadRepositoryConstitution(workspacePath: string): Promise<ResolvedRepositoryConstitution> {
  const filePath = path.join(workspacePath, CONSTITUTION_FILE);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return {
      status: 'present',
      path: filePath,
      sections: parseConstitutionSections(content),
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === 'ENOENT') {
      return {
        status: 'missing',
        path: null,
        sections: {},
      };
    }

    throw error;
  }
}

async function inferHarnessFromPackageJson(workspacePath: string): Promise<RepositoryHarnessConfig | null> {
  try {
    const packageJsonPath = path.join(workspacePath, 'package.json');
    const content = await fs.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts || {};
    const commands: Record<string, string> = {};
    for (const key of ['setup', 'dev', 'test', 'lint', 'build']) {
      if (typeof scripts[key] === 'string' && scripts[key].trim()) {
        commands[key] = scripts[key].trim();
      }
    }

    if (Object.keys(commands).length === 0) {
      return null;
    }

    const requiredCommands = ['test', 'build', 'lint'].filter((key) => Boolean(commands[key]));
    return {
      profiles: ['coding'],
      commands,
      verification: {
        required_commands: requiredCommands.length > 0 ? requiredCommands : undefined,
      },
    };
  } catch {
    return null;
  }
}

async function inferHarnessFromPython(workspacePath: string): Promise<RepositoryHarnessConfig | null> {
  const pyprojectPath = path.join(workspacePath, 'pyproject.toml');
  const requirementsPath = path.join(workspacePath, 'requirements.txt');
  const testsPath = path.join(workspacePath, 'tests');

  try {
    await fs.access(pyprojectPath);
  } catch {
    try {
      await fs.access(requirementsPath);
    } catch {
      return null;
    }
  }

  const commands: Record<string, string> = {};
  try {
    await fs.access(testsPath);
    commands.test = 'pytest';
  } catch {
    // no-op
  }

  return {
    profiles: ['coding'],
    commands,
    verification: {
      required_commands: commands.test ? ['test'] : undefined,
    },
  };
}

async function inferHarnessFromCargo(workspacePath: string): Promise<RepositoryHarnessConfig | null> {
  try {
    await fs.access(path.join(workspacePath, 'Cargo.toml'));
  } catch {
    return null;
  }

  return {
    profiles: ['coding'],
    commands: {
      build: 'cargo build',
      test: 'cargo test',
    },
    verification: {
      required_commands: ['test'],
    },
  };
}

export async function inferShadowHarness(params: {
  workspacePath: string;
  repoKey: string;
  repository: ShadowHarnessRepository;
}): Promise<ResolvedRepositoryHarness> {
  const existing = params.repository.findByRepoKey(params.repoKey);
  if (existing) {
    return {
      status: 'shadow',
      path: null,
      config: existing.config_json,
      inferred_from: existing.inference_details_json.inferred_from,
      adoption_suggested: Boolean(existing.adoption_suggested_at),
    };
  }

  const candidates = [
    { name: 'package.json', config: await inferHarnessFromPackageJson(params.workspacePath) },
    { name: 'pyproject.toml', config: await inferHarnessFromPython(params.workspacePath) },
    { name: 'Cargo.toml', config: await inferHarnessFromCargo(params.workspacePath) },
  ].filter((candidate) => candidate.config);

  const config = (candidates[0]?.config ?? {}) as RepositoryHarnessConfig;
  const inferredFrom = candidates.map((candidate) => candidate.name);
  const stored = params.repository.upsert({
    repo_key: params.repoKey,
    source: 'shadow',
    config_json: config,
    inference_details_json: {
      inferred_from: inferredFrom,
      observed_commands: {},
      observed_artifacts: {},
      observed_runtime_hints: {},
      learning_confidence: 'low',
      successful_work_item_ids: [],
      failed_work_item_ids: [],
    },
  });

  return {
    status: 'shadow',
    path: null,
    config: stored.config_json,
    inferred_from: inferredFrom,
    adoption_suggested: Boolean(stored.adoption_suggested_at),
  };
}

export async function strengthenShadowHarnessFromWorkspace(params: {
  workspacePath: string;
  repoKey: string;
  repository: ShadowHarnessRepository;
  workItemId?: string | null;
}): Promise<ResolvedRepositoryHarness> {
  let existing = params.repository.findByRepoKey(params.repoKey);
  if (!existing) {
    await inferShadowHarness(params);
    existing = params.repository.findByRepoKey(params.repoKey);
  }

  if (!existing) {
    return {
      status: 'missing',
      path: null,
      config: null,
      inferred_from: [],
      adoption_suggested: false,
    };
  }

  let parsedEvidence: ReturnType<typeof parseChangePackEvidence> | null = null;
  try {
    const rawEvidence = await fs.readFile(path.join(params.workspacePath, CHANGE_PACK_EVIDENCE_FILE), 'utf8');
    parsedEvidence = parseChangePackEvidence(JSON.parse(rawEvidence));
  } catch {
    parsedEvidence = null;
  }

  if (!parsedEvidence) {
    return {
      status: 'shadow',
      path: null,
      config: existing.config_json,
      inferred_from: existing.inference_details_json.inferred_from,
      adoption_suggested: Boolean(existing.adoption_suggested_at),
    };
  }

  const learned = learnShadowHarnessConfigFromEvidence({
    baseConfig: existing.config_json,
    inferenceDetails: existing.inference_details_json,
    evidence: parsedEvidence,
    workItemId: params.workItemId,
  });
  const updated = params.repository.upsert({
    repo_key: existing.repo_key,
    source: existing.source,
    config_json: learned.config,
    inference_details_json: learned.inferenceDetails,
    successful_runs: existing.successful_runs,
    failed_runs: existing.failed_runs,
    adoption_suggested_at: existing.adoption_suggested_at,
  });

  return {
    status: 'shadow',
    path: null,
    config: updated.config_json,
    inferred_from: updated.inference_details_json.inferred_from,
    adoption_suggested: Boolean(updated.adoption_suggested_at),
  };
}

export function suggestHarnessAdoption(params: { successfulRuns: number; failedRuns: number }): boolean {
  return params.successfulRuns >= 3 && params.failedRuns === 0;
}

export function buildEffectiveRepositoryHarness(
  harness: ResolvedRepositoryHarness,
): EffectiveRepositoryHarness {
  const baseConfig = harness.config ?? {};
  const commands = coerceCommandMap(baseConfig.commands);
  const requiredCommands = coerceStringArray(baseConfig.verification?.required_commands);
  const requiredArtifacts = coerceStringArray(baseConfig.verification?.required_artifacts);
  const derivedRequiredCommands = requiredCommands.length > 0
    ? requiredCommands
    : CANONICAL_COMMAND_KEYS
      .filter((key) => ['test', 'lint', 'build'].includes(key))
      .filter((key) => Boolean(commands[key]))
      .map((key) => key);
  const verification = derivedRequiredCommands.length > 0 || requiredArtifacts.length > 0
    ? {
        required_commands: derivedRequiredCommands.length > 0 ? derivedRequiredCommands : undefined,
        required_artifacts: requiredArtifacts.length > 0 ? requiredArtifacts : undefined,
      }
    : undefined;

  return {
    source: harness.status,
    config: {
      profiles: baseConfig.profiles,
      commands,
      artifacts: baseConfig.artifacts,
      verification,
      runtime_hints: baseConfig.runtime_hints,
    },
    has_verification_requirements:
      (verification?.required_commands?.length ?? 0) > 0 ||
      (verification?.required_artifacts?.length ?? 0) > 0,
  };
}

export function assessGovernanceForIssue(params: {
  issue: Issue;
  constitution: ResolvedRepositoryConstitution;
}): GovernanceAssessment {
  if (params.constitution.status !== 'present') {
    return {
      decision: 'accept',
      status: 'degraded',
      summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
      constitution_hits: [],
    };
  }

  const forbiddenHits = collectConstitutionHits(
    params.issue,
    'Forbidden Directions',
    params.constitution.sections['Forbidden Directions'] || [],
  );

  if (forbiddenHits.length > 0) {
    return {
      decision: 'reject_conflicting',
      status: 'blocked',
      summary: 'This issue conflicts with one or more forbidden directions in the project constitution.',
      constitution_hits: forbiddenHits,
    };
  }

  return {
    decision: 'accept',
    status: 'clear',
    summary: 'No constitution blockers detected.',
    constitution_hits: [],
  };
}
