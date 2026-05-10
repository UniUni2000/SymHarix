import * as fs from 'fs/promises';
import * as path from 'path';
import { isSupervisorLiveVerifierText, judgeComplexity } from '../hooks/dev-prompt';
import { parseCanonicalReviewReport } from '../hooks/review-prompt';
import type {
  AgentTimelinePayload,
  ChangePackSummary,
  ChangePackTaskStatus,
  CompletionRequirement,
  EvidenceSummary,
  Issue,
  RepositoryHarnessConfig,
} from '../types';

export interface ChangePackState {
  summary: ChangePackSummary;
  task_status: ChangePackTaskStatus;
  evidence_summary: EvidenceSummary;
  missing_requirements: CompletionRequirement[];
}

type EvidenceCommandStatus = 'satisfied' | 'failed';
type EvidenceCommandKey =
  | 'setup'
  | 'dev'
  | 'test'
  | 'lint'
  | 'build'
  | 'review_checks';
type EvidencePhase = 'setup' | 'dev' | 'review';
type EvidenceArtifactKind =
  | 'file'
  | 'dir'
  | 'report'
  | 'screenshot'
  | 'markdown'
  | 'json'
  | 'html'
  | 'unknown';
type RuntimeHintKey = 'url' | 'ready_signal';

interface ChangePackCommandRun {
  phase: EvidencePhase;
  command: string;
  command_key: EvidenceCommandKey | null;
  status: EvidenceCommandStatus;
  source: string;
  turn: number | null;
  exit_code: number | null;
  summary: string | null;
  recorded_at: string;
}

interface ChangePackArtifactObservation {
  path: string;
  kind: EvidenceArtifactKind;
  exists: boolean;
  non_empty: boolean;
  source: string;
  turn: number | null;
  summary: string | null;
  recorded_at: string;
}

interface ChangePackRuntimeObservation {
  hint_key: RuntimeHintKey;
  status: EvidenceCommandStatus;
  value: string;
  source: string;
  turn: number | null;
  summary: string | null;
  recorded_at: string;
}

interface ChangePackEvidenceFile {
  issue_identifier?: string;
  profile?: 'coding' | 'research' | 'ui' | 'review';
  complexity?: 'small' | 'medium' | 'large';
  requirements?: Array<CompletionRequirement & {
    status?: 'missing' | 'satisfied';
    result?: unknown;
    evidence?: unknown;
  }>;
  notes?: string[];
  command_runs?: ChangePackCommandRun[];
  artifact_observations?: ChangePackArtifactObservation[];
  runtime_observations?: ChangePackRuntimeObservation[];
}

const COMMON_ARTIFACT_CANDIDATES = [
  'dist',
  'build',
  'coverage',
  '.next',
  'playwright-report',
];

function changePackDir(workspacePath: string): string {
  return path.join(workspacePath, '.symphony', 'change-pack');
}

function normalizeOverview(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, 'utf8');
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function normalizeEvidenceText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeCommand(value: unknown): string {
  return normalizeEvidenceText(value)?.replace(/\s+/g, ' ').toLowerCase() ?? '';
}

function evidenceStatusFromValue(value: unknown): EvidenceCommandStatus | null {
  const normalized = normalizeEvidenceText(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (['satisfied', 'pass', 'passed', 'success', 'successful', 'ok', 'true'].includes(normalized)) {
    return 'satisfied';
  }
  if (['failed', 'fail', 'failure', 'error', 'false'].includes(normalized)) {
    return 'failed';
  }
  return null;
}

function isSatisfiedEvidenceRecord(record: Record<string, unknown>): boolean {
  return evidenceStatusFromValue(record.status) === 'satisfied' ||
    evidenceStatusFromValue(record.result) === 'satisfied';
}

function hasStructuredRequirementEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).some((entry) => {
    if (entry === null || entry === undefined || entry === false) {
      return false;
    }
    if (typeof entry === 'string') {
      return entry.trim().length > 0;
    }
    if (Array.isArray(entry)) {
      return entry.length > 0;
    }
    if (typeof entry === 'object') {
      return Object.keys(entry).length > 0;
    }
    return true;
  });
}

function mergeUniqueStrings(values: unknown[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeEvidenceText(value);
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function inferPhase(commandKey: EvidenceCommandKey | null): EvidencePhase {
  if (commandKey === 'setup') {
    return 'setup';
  }
  if (commandKey === 'review_checks') {
    return 'review';
  }
  return 'dev';
}

function normalizeCommandKey(value: unknown, command: string, harness?: RepositoryHarnessConfig | null): EvidenceCommandKey | null {
  const normalized = normalizeEvidenceText(value);
  if (normalized && ['setup', 'dev', 'test', 'lint', 'build', 'review_checks'].includes(normalized)) {
    return normalized as EvidenceCommandKey;
  }
  return command ? inferCommandKey(command, harness) : null;
}

function inferArtifactKind(candidatePath: string, isDirectory: boolean): EvidenceArtifactKind {
  if (isDirectory) {
    return 'dir';
  }

  const normalized = candidatePath.trim().toLowerCase();
  if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) {
    return 'markdown';
  }
  if (normalized.endsWith('.json')) {
    return 'json';
  }
  if (normalized.endsWith('.html') || normalized.endsWith('.htm')) {
    return 'html';
  }
  if (/\.(png|jpg|jpeg|webp|gif)$/i.test(normalized)) {
    return 'screenshot';
  }
  if (/report/i.test(normalized)) {
    return 'report';
  }
  if (/\.[^./]+$/i.test(normalized)) {
    return 'file';
  }
  return 'unknown';
}

async function getArtifactState(resolvedPath: string): Promise<{
  exists: boolean;
  non_empty: boolean;
  kind: EvidenceArtifactKind;
}> {
  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(resolvedPath);
      return {
        exists: true,
        non_empty: entries.length > 0,
        kind: inferArtifactKind(resolvedPath, true),
      };
    }
    return {
      exists: true,
      non_empty: stat.size > 0,
      kind: inferArtifactKind(resolvedPath, false),
    };
  } catch {
    return {
      exists: false,
      non_empty: false,
      kind: inferArtifactKind(resolvedPath, false),
    };
  }
}

function artifactNeedsNonEmpty(
  profile: ChangePackEvidenceFile['profile'],
  kind: EvidenceArtifactKind,
): boolean {
  if (profile === 'research') {
    return ['markdown', 'json', 'html'].includes(kind);
  }
  if (profile === 'ui') {
    return ['screenshot', 'html', 'report', 'dir'].includes(kind);
  }
  return false;
}

function asHintValue(value: string | string[] | undefined, key: RuntimeHintKey): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim());
    return first?.trim() ?? null;
  }
  return key === 'url' || key === 'ready_signal' ? null : null;
}

function normalizeArtifactObservationPath(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  const record = normalizeEvidenceRecord(value);
  return normalizeEvidenceText(record?.path) ?? normalizeEvidenceText(record?.file);
}

function normalizeRuntimeObservationValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEvidenceRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function inferCommandKey(
  command: string,
  harness?: RepositoryHarnessConfig | null,
): EvidenceCommandKey | null {
  const normalized = normalizeCommand(command);
  for (const [key, configuredCommand] of Object.entries(harness?.commands ?? {})) {
    if (typeof configuredCommand !== 'string') {
      continue;
    }
    if (normalizeCommand(configuredCommand) === normalized) {
      return key as EvidenceCommandKey;
    }
  }

  if (
    /\b(pytest|vitest|jest|bun test|npm test|pnpm test|cargo test|go test)\b/.test(normalized) ||
    /\btest\b/.test(normalized)
  ) {
    return 'test';
  }
  if (
    /\b(eslint|biome check|ruff check|flake8)\b/.test(normalized) ||
    /\blint\b/.test(normalized)
  ) {
    return 'lint';
  }
  if (
    /\b(build|tsc|next build|vite build|cargo build)\b/.test(normalized)
  ) {
    return 'build';
  }
  if (
    /\b(next dev|vite|npm run dev|pnpm dev|bun run dev)\b/.test(normalized) ||
    /\bdev\b/.test(normalized)
  ) {
    return 'dev';
  }
  if (
    /\breview[_ -]?checks\b/.test(normalized) ||
    (normalized.includes('review') && normalized.includes('check'))
  ) {
    return 'review_checks';
  }
  if (
    /\b(setup|install|bootstrap|bun install|npm install|pnpm install)\b/.test(normalized)
  ) {
    return 'setup';
  }

  return null;
}

function dedupeCommandRuns(runs: ChangePackCommandRun[]): ChangePackCommandRun[] {
  const deduped: ChangePackCommandRun[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const key = [
      run.phase,
      normalizeCommand(run.command),
      run.command_key ?? '',
      run.status,
      run.source,
      String(run.turn ?? ''),
    ].join('::');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(run);
  }
  return deduped;
}

function normalizeEvidenceCommandRuns(
  value: unknown,
  harness?: RepositoryHarnessConfig | null,
): ChangePackCommandRun[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = normalizeEvidenceRecord(item);
    const command = normalizeEvidenceText(record?.command);
    if (!record || !command) {
      return [];
    }

    const status = evidenceStatusFromValue(record.status) ?? evidenceStatusFromValue(record.result);
    if (!status) {
      return [];
    }

    const commandKey = normalizeCommandKey(record.command_key, command, harness);
    return [{
      phase: (
        record.phase === 'setup' || record.phase === 'dev' || record.phase === 'review'
          ? record.phase
          : inferPhase(commandKey)
      ) as EvidencePhase,
      command,
      command_key: commandKey,
      status,
      source: normalizeEvidenceText(record.source) ?? 'legacy_evidence',
      turn: typeof record.turn === 'number' ? record.turn : null,
      exit_code: typeof record.exit_code === 'number' ? record.exit_code : null,
      summary: normalizeEvidenceText(record.summary) ?? normalizeEvidenceText(record.output),
      recorded_at: normalizeEvidenceText(record.recorded_at) ?? new Date().toISOString(),
    }];
  });
}

function dedupeArtifactObservations(
  observations: ChangePackArtifactObservation[],
): ChangePackArtifactObservation[] {
  const deduped: ChangePackArtifactObservation[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    const normalizedPath = normalizeArtifactObservationPath(observation.path);
    if (!normalizedPath) {
      continue;
    }
    const key = [
      normalizedPath,
      observation.kind,
      String(observation.exists),
      String(observation.non_empty),
      observation.source,
      String(observation.turn ?? ''),
    ].join('::');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...observation,
      path: normalizedPath,
    });
  }
  return deduped;
}

function normalizeEvidenceArtifactObservations(value: unknown): ChangePackArtifactObservation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = normalizeEvidenceRecord(item);
    const normalizedPath = normalizeArtifactObservationPath(record);
    if (!record || !normalizedPath) {
      return [];
    }

    const kind = (
      record.kind === 'file' ||
      record.kind === 'dir' ||
      record.kind === 'report' ||
      record.kind === 'screenshot' ||
      record.kind === 'markdown' ||
      record.kind === 'json' ||
      record.kind === 'html' ||
      record.kind === 'unknown'
    )
      ? record.kind
      : inferArtifactKind(normalizedPath, false);
    const exists = typeof record.exists === 'boolean'
      ? record.exists
      : Boolean(record.status && !/missing|failed|absent/i.test(String(record.status)));
    const nonEmpty = typeof record.non_empty === 'boolean'
      ? record.non_empty
      : exists && (
          typeof record.size === 'number' && record.size > 0 ||
          typeof record.size_lines === 'number' && record.size_lines > 0 ||
          evidenceStatusFromValue(record.result) === 'satisfied' ||
          /written|present|created/i.test(String(record.status ?? ''))
        );

    return [{
      path: normalizedPath,
      kind,
      exists,
      non_empty: nonEmpty,
      source: normalizeEvidenceText(record.source) ?? 'legacy_evidence',
      turn: typeof record.turn === 'number' ? record.turn : null,
      summary: normalizeEvidenceText(record.summary) ?? normalizeEvidenceText(record.status),
      recorded_at: normalizeEvidenceText(record.recorded_at) ?? new Date().toISOString(),
    }];
  });
}

function dedupeRuntimeObservations(
  observations: ChangePackRuntimeObservation[],
): ChangePackRuntimeObservation[] {
  const deduped: ChangePackRuntimeObservation[] = [];
  const seen = new Set<string>();
  for (const observation of observations) {
    const normalizedValue = normalizeRuntimeObservationValue(observation.value);
    if (!normalizedValue) {
      continue;
    }
    const key = [
      observation.hint_key,
      observation.status,
      normalizedValue,
      observation.source,
      String(observation.turn ?? ''),
    ].join('::');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...observation,
      value: normalizedValue,
    });
  }
  return deduped;
}

export function collectTimelineCommandRuns(params: {
  timeline: AgentTimelinePayload[];
  harness?: RepositoryHarnessConfig | null;
}): ChangePackCommandRun[] {
  const runs: ChangePackCommandRun[] = [];

  for (const entry of params.timeline) {
    if (
      entry.category !== 'tool' ||
      entry.tool_name !== 'Bash' ||
      (entry.code !== 'tool_completed' && entry.code !== 'tool_failed')
    ) {
      continue;
    }

    const commandPreview = typeof entry.detail?.command_preview === 'string'
      ? entry.detail.command_preview.trim()
      : null;
    if (!commandPreview) {
      continue;
    }

    runs.push({
      phase: inferPhase(inferCommandKey(commandPreview, params.harness)),
      command: commandPreview,
      command_key: inferCommandKey(commandPreview, params.harness),
      status: entry.code === 'tool_failed' ? 'failed' : 'satisfied',
      source: 'timeline',
      turn: entry.turn,
      exit_code: typeof entry.detail?.exit_code === 'number' ? entry.detail.exit_code : null,
      summary: typeof entry.detail?.summary === 'string' ? entry.detail.summary.trim() : null,
      recorded_at: new Date().toISOString(),
    });
  }

  return dedupeCommandRuns(runs);
}

export async function collectWorkspaceArtifactObservations(params: {
  workspacePath: string;
  harness?: RepositoryHarnessConfig | null;
}): Promise<ChangePackArtifactObservation[]> {
  const candidatePaths = mergeUniqueStrings([
    ...(params.harness?.verification?.required_artifacts ?? []),
    ...(params.harness?.artifacts ?? []),
    ...COMMON_ARTIFACT_CANDIDATES,
  ]);
  const observations: ChangePackArtifactObservation[] = [];

  for (const candidate of candidatePaths) {
    const resolvedPath = path.isAbsolute(candidate)
      ? candidate
      : path.join(params.workspacePath, candidate);
    const artifactState = await getArtifactState(resolvedPath);
    if (!artifactState.exists) {
      continue;
    }
    observations.push({
      path: candidate,
      kind: artifactState.kind,
      exists: true,
      non_empty: artifactState.non_empty,
      source: 'workspace',
      turn: null,
      summary: artifactState.non_empty
        ? `${candidate} exists and is non-empty`
        : `${candidate} exists but is empty`,
      recorded_at: new Date().toISOString(),
    });
  }

  return dedupeArtifactObservations(observations);
}

async function probeUrl(url: string): Promise<ChangePackRuntimeObservation> {
  const attempt = async (method: 'HEAD' | 'GET'): Promise<Response> => {
    return fetch(url, {
      method,
      signal: AbortSignal.timeout(5000),
    });
  };

  try {
    let response = await attempt('HEAD');
    if (!response.ok) {
      response = await attempt('GET');
    }
    if (response.ok) {
      return {
        hint_key: 'url',
        status: 'satisfied',
        value: url,
        source: 'cli_postprocess',
        turn: null,
        summary: `URL probe succeeded with ${response.status}`,
        recorded_at: new Date().toISOString(),
      };
    }
    return {
      hint_key: 'url',
      status: 'failed',
      value: url,
      source: 'cli_postprocess',
      turn: null,
      summary: `URL probe returned ${response.status}`,
      recorded_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      hint_key: 'url',
      status: 'failed',
      value: url,
      source: 'cli_postprocess',
      turn: null,
      summary: `URL probe failed: ${(error as Error).message}`,
      recorded_at: new Date().toISOString(),
    };
  }
}

export async function collectRuntimeObservations(params: {
  workspacePath: string;
  harness?: RepositoryHarnessConfig | null;
  turn?: number | null;
  timeline?: AgentTimelinePayload[];
}): Promise<ChangePackRuntimeObservation[]> {
  const observations: ChangePackRuntimeObservation[] = [];
  const url = asHintValue(params.harness?.runtime_hints?.url, 'url');
  if (url) {
    const observation = await probeUrl(url);
    observations.push({
      ...observation,
      turn: params.turn ?? observation.turn,
    });
  }

  const readySignal = asHintValue(params.harness?.runtime_hints?.ready_signal, 'ready_signal');
  if (readySignal) {
    const developmentLog = await readText(path.join(params.workspacePath, '.symphony', 'DEVELOPMENT_LOG.md'));
    const handover = await readText(path.join(params.workspacePath, '.symphony', 'HANDOVER.md'));
    const timelineHaystack = (params.timeline ?? [])
      .map((entry) => `${entry.message} ${typeof entry.detail?.summary === 'string' ? entry.detail.summary : ''}`.trim())
      .join('\n');
    const haystack = [timelineHaystack, developmentLog, handover]
      .filter((value): value is string => Boolean(value))
      .join('\n')
      .toLowerCase();
    const matched = haystack.includes(readySignal.toLowerCase());
    observations.push({
      hint_key: 'ready_signal',
      status: matched ? 'satisfied' : 'failed',
      value: readySignal,
      source: 'cli_postprocess',
      turn: params.turn ?? null,
      summary: matched
        ? 'Ready signal found in recent timeline or workspace logs'
        : 'Ready signal not found in recent timeline or workspace logs',
      recorded_at: new Date().toISOString(),
    });
  }

  return dedupeRuntimeObservations(observations);
}

export async function recordChangePackEvidence(params: {
  workspacePath: string;
  harness?: RepositoryHarnessConfig | null;
  commandRuns?: Array<{
    phase?: EvidencePhase;
    command: string;
    command_key?: string | null;
    status: EvidenceCommandStatus;
    source: string;
    turn?: number | null;
    exit_code?: number | null;
    summary?: string | null;
    recorded_at?: string;
  }>;
  artifactObservations?: Array<{
    path: string;
    kind?: EvidenceArtifactKind;
    exists: boolean;
    non_empty?: boolean;
    source: string;
    turn?: number | null;
    summary?: string | null;
    recorded_at?: string;
  }>;
  runtimeObservations?: Array<{
    hint_key: RuntimeHintKey;
    status: EvidenceCommandStatus;
    value: string;
    source: string;
    turn?: number | null;
    summary?: string | null;
    recorded_at?: string;
  }>;
  notes?: string[];
}): Promise<{
  commandRunsAdded: number;
  artifactObservationsAdded: number;
  runtimeObservationsAdded: number;
}> {
  await fs.mkdir(changePackDir(params.workspacePath), { recursive: true });
  const evidencePath = path.join(changePackDir(params.workspacePath), 'evidence.json');
  const existing = await readJson<ChangePackEvidenceFile>(evidencePath, {});
  const existingCommandRuns = normalizeEvidenceCommandRuns(existing.command_runs, params.harness);
  const existingArtifactObservations = normalizeEvidenceArtifactObservations(existing.artifact_observations)
    .map((observation) => {
      const normalizedPath = normalizeArtifactObservationPath(observation)!;
      return {
        ...observation,
        path: normalizedPath,
        kind: observation.kind ?? inferArtifactKind(normalizedPath, false),
        non_empty: observation.non_empty ?? false,
      };
    });
  const existingRuntimeObservations = (existing.runtime_observations ?? [])
    .filter((observation) => Boolean(normalizeRuntimeObservationValue(observation?.value)))
    .map((observation) => ({
      ...observation,
      value: normalizeRuntimeObservationValue(observation.value)!,
    }));

  const normalizedCommandRuns = (params.commandRuns ?? [])
    .filter((run) => Boolean(normalizeEvidenceText(run.command)))
    .map((run) => {
      const inferredCommandKey = (
        typeof run.command_key === 'string' && run.command_key.trim()
          ? run.command_key.trim()
          : inferCommandKey(run.command, params.harness)
      ) as EvidenceCommandKey | null;
      return {
        phase: run.phase ?? inferPhase(inferredCommandKey),
        command: normalizeEvidenceText(run.command)!,
        command_key: inferredCommandKey,
        status: run.status,
        source: run.source,
        turn: run.turn ?? null,
        exit_code: typeof run.exit_code === 'number' ? run.exit_code : null,
        summary: typeof run.summary === 'string' ? run.summary.trim() : null,
        recorded_at: run.recorded_at ?? new Date().toISOString(),
      };
    });

  const normalizedArtifactObservations = (params.artifactObservations ?? [])
    .filter((observation) => Boolean(normalizeArtifactObservationPath(observation.path)))
    .map((observation) => {
      const normalizedPath = normalizeArtifactObservationPath(observation.path)!;
      return {
        path: normalizedPath,
        kind: observation.kind ?? inferArtifactKind(normalizedPath, false),
        exists: observation.exists,
        non_empty: observation.non_empty ?? false,
        source: observation.source,
        turn: observation.turn ?? null,
        summary: typeof observation.summary === 'string' ? observation.summary.trim() : null,
        recorded_at: observation.recorded_at ?? new Date().toISOString(),
      };
    });
  const normalizedRuntimeObservations = (params.runtimeObservations ?? [])
    .filter((observation) => Boolean(normalizeRuntimeObservationValue(observation.value)))
    .map((observation) => ({
      hint_key: observation.hint_key,
      status: observation.status,
      value: normalizeRuntimeObservationValue(observation.value)!,
      source: observation.source,
      turn: observation.turn ?? null,
      summary: typeof observation.summary === 'string' ? observation.summary.trim() : null,
      recorded_at: observation.recorded_at ?? new Date().toISOString(),
    }));

  const mergedCommandRuns = dedupeCommandRuns([
    ...existingCommandRuns,
    ...normalizedCommandRuns,
  ]);
  const mergedArtifactObservations = dedupeArtifactObservations([
    ...existingArtifactObservations,
    ...normalizedArtifactObservations,
  ]);
  const mergedRuntimeObservations = dedupeRuntimeObservations([
    ...existingRuntimeObservations,
    ...normalizedRuntimeObservations,
  ]);

  await fs.writeFile(
    evidencePath,
    JSON.stringify(
      {
        ...existing,
        notes: mergeUniqueStrings([...(existing.notes ?? []), ...(params.notes ?? [])]),
        command_runs: mergedCommandRuns,
        artifact_observations: mergedArtifactObservations,
        runtime_observations: mergedRuntimeObservations,
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    commandRunsAdded: Math.max(0, mergedCommandRuns.length - existingCommandRuns.length),
    artifactObservationsAdded: Math.max(0, mergedArtifactObservations.length - existingArtifactObservations.length),
    runtimeObservationsAdded: Math.max(0, mergedRuntimeObservations.length - existingRuntimeObservations.length),
  };
}

function inferProfile(issue: Issue, mode?: 'dev' | 'review'): 'coding' | 'research' | 'ui' | 'review' {
  if (mode === 'review') {
    return 'review';
  }

  const combined = `${issue.title} ${issue.description || ''}`.toLowerCase();
  if (/(research|collect|summary|summarize|调研|搜集|汇总)/i.test(combined)) {
    return 'research';
  }
  if (/(ui|page|screen|landing|frontend|界面|页面)/i.test(combined)) {
    return 'ui';
  }
  return 'coding';
}

function buildDefaultRequirements(params: {
  profile: 'coding' | 'research' | 'ui' | 'review';
  issue: Issue;
  mode?: 'dev' | 'review';
  harness?: RepositoryHarnessConfig | null;
}): CompletionRequirement[] {
  const requirements: CompletionRequirement[] = [];

  if (params.profile === 'review') {
    requirements.push({
      key: 'review_report',
      label: 'Write canonical .symphony/REVIEW_REPORT.md',
      reason: 'Review completion requires a canonical review report.',
      kind: 'review',
    });
    return requirements;
  }

  requirements.push({
    key: 'handover',
    label: 'Write .symphony/HANDOVER.md',
    reason: 'Completion requires a handover artifact.',
    kind: 'artifact',
  });

  if (isSupervisorLiveVerifierText(`${params.issue.title}\n${params.issue.description || ''}`)) {
    requirements.push({
      key: 'verification',
      label: 'Record narrow supervisor live marker verification',
      reason: 'Live verifier marker tasks only require proof that the requested marker file and handoff exist.',
      kind: 'verification',
    });
    return requirements;
  }

  const requiredCommands = (params.harness?.verification?.required_commands || [])
    .filter((commandName) => !isReviewOnlyCommandRequirement(`command:${commandName}`, params.mode));
  if (requiredCommands.length > 0) {
    for (const commandName of requiredCommands) {
      requirements.push({
        key: `command:${commandName}`,
        label: `Record successful ${commandName} verification`,
        reason: `Completion requires evidence that ${commandName} succeeded.`,
        kind: 'verification',
      });
    }
  } else {
    requirements.push({
      key: 'verification',
      label: 'Record verification evidence in .symphony/change-pack/evidence.json',
      reason: 'Need explicit proof-of-work before ending the turn.',
      kind: 'verification',
    });
  }

  for (const artifactPath of params.harness?.verification?.required_artifacts || []) {
    requirements.push({
      key: `artifact:${artifactPath}`,
      label: `Produce required artifact ${artifactPath}`,
      reason: `Completion requires the artifact ${artifactPath} to exist.`,
      kind: 'artifact',
    });
  }

  if (params.profile === 'ui' && asHintValue(params.harness?.runtime_hints?.url, 'url')) {
    requirements.push({
      key: 'runtime:url',
      label: 'Record a successful runtime URL probe',
      reason: 'UI completion requires evidence that the configured runtime URL responded.',
      kind: 'verification',
    });
  }

  return requirements;
}

function isReviewOnlyCommandRequirement(key: string, mode?: 'dev' | 'review'): boolean {
  return mode === 'dev' && key === 'command:review_checks';
}

export async function initializeChangePack(params: {
  workspacePath: string;
  issue: Issue;
  profile?: 'coding' | 'research' | 'ui' | 'review';
  mode?: 'dev' | 'review';
  harness?: RepositoryHarnessConfig | null;
  governanceSummary: string;
}): Promise<void> {
  const profile = params.profile ?? inferProfile(params.issue, params.mode);
  const complexity = judgeComplexity(params.issue).complexity;
  const packPath = changePackDir(params.workspacePath);

  await fs.mkdir(packPath, { recursive: true });

  await ensureFile(
    path.join(packPath, 'brief.md'),
    [
      `# Brief: ${params.issue.identifier}`,
      '',
      `- Profile: ${profile}`,
      `- Complexity: ${complexity}`,
      `- Goal: ${params.issue.title}`,
      params.issue.description ? `- Details: ${params.issue.description}` : null,
    ].filter(Boolean).join('\n'),
  );

  await ensureFile(
    path.join(packPath, 'tasks.md'),
    [
      `# Tasks: ${params.issue.identifier}`,
      '',
      '- [ ] Understand the requested outcome and target files',
      '- [ ] Implement the smallest correct change or artifact',
      '- [ ] Satisfy the required verification evidence',
      '- [ ] Write the final handover or review artifact',
    ].join('\n'),
  );

  await ensureFile(
    path.join(packPath, 'governance.md'),
    [
      `# Governance: ${params.issue.identifier}`,
      '',
      params.governanceSummary,
    ].join('\n'),
  );

  const evidencePath = path.join(packPath, 'evidence.json');
  const existingEvidence = await readJson<ChangePackEvidenceFile>(
    evidencePath,
    {},
  );
  const defaultRequirements = buildDefaultRequirements({
    profile,
    issue: params.issue,
    mode: params.mode,
    harness: params.harness,
  });
  const existingRequirements = new Map(
    (existingEvidence.requirements ?? []).map((requirement) => [requirement.key, requirement]),
  );
  const requirements = defaultRequirements.map((requirement) => ({
    ...requirement,
    ...(existingRequirements.get(requirement.key) ?? {}),
    key: requirement.key,
    label: requirement.label,
    reason: requirement.reason,
    kind: requirement.kind,
  }));
  for (const requirement of existingEvidence.requirements ?? []) {
    if (isReviewOnlyCommandRequirement(requirement.key, params.mode)) {
      continue;
    }
    if (!requirements.some((candidate) => candidate.key === requirement.key)) {
      requirements.push(requirement);
    }
  }
  await fs.writeFile(
    evidencePath,
    JSON.stringify(
      {
        issue_identifier: params.issue.identifier,
        profile,
        complexity,
        requirements,
        notes: existingEvidence.notes ?? [],
        command_runs: existingEvidence.command_runs ?? [],
        artifact_observations: existingEvidence.artifact_observations ?? [],
        runtime_observations: existingEvidence.runtime_observations ?? [],
      },
      null,
      2,
    ),
    'utf8',
  );

  if (complexity !== 'small') {
    await ensureFile(path.join(packPath, 'proposal.md'), `# Proposal: ${params.issue.identifier}\n`);
    await ensureFile(path.join(packPath, 'spec.md'), `# Spec: ${params.issue.identifier}\n`);
    await ensureFile(path.join(packPath, 'design.md'), `# Design: ${params.issue.identifier}\n`);
    await ensureFile(path.join(packPath, 'alternatives.md'), `# Alternatives: ${params.issue.identifier}\n`);
  }
}

function summarizeTaskStatus(content: string | null): ChangePackTaskStatus {
  if (!content) {
    return { total: 0, completed: 0, open: 0 };
  }

  const total = (content.match(/^- \[[ xX]\]/gm) || []).length;
  const completed = (content.match(/^- \[[xX]\]/gm) || []).length;
  return {
    total,
    completed,
    open: Math.max(0, total - completed),
  };
}

function verificationMentioned(text: string | null): boolean {
  if (!text) {
    return false;
  }

  return /test.*pass|tests passed|单元测试:\s*pass|verification complete|验证通过/i.test(text);
}

function summarizeCommandForEvidence(run: ChangePackCommandRun): string {
  return run.command_key ?? normalizeCommand(run.command);
}

async function isArtifactRequirementSatisfied(params: {
  workspacePath: string;
  artifactPath: string;
  profile: ChangePackEvidenceFile['profile'];
  observations: ChangePackArtifactObservation[];
}): Promise<boolean> {
  const normalizedArtifactPath = params.artifactPath.trim();
  const matchingObservations = params.observations
    .filter((observation) => normalizeArtifactObservationPath(observation.path) === normalizedArtifactPath);
  if (matchingObservations.some((observation) => (
    observation.exists &&
    (artifactNeedsNonEmpty(params.profile, observation.kind) ? observation.non_empty : true)
  ))) {
    return true;
  }

  const resolvedArtifactPath = path.isAbsolute(normalizedArtifactPath)
    ? normalizedArtifactPath
    : path.join(params.workspacePath, normalizedArtifactPath);
  const artifactState = await getArtifactState(resolvedArtifactPath);
  if (!artifactState.exists) {
    return false;
  }
  return artifactNeedsNonEmpty(params.profile, artifactState.kind)
    ? artifactState.non_empty
    : true;
}

export async function evaluateChangePackState(params: {
  workspacePath: string;
  issue: Issue;
  mode: 'dev' | 'review';
}): Promise<ChangePackState> {
  const packPath = changePackDir(params.workspacePath);
  const files = await fs.readdir(packPath).catch(() => []);
  const brief = await readText(path.join(packPath, 'brief.md'));
  const tasksText = await readText(path.join(packPath, 'tasks.md'));
  const evidence = await readJson<ChangePackEvidenceFile>(path.join(packPath, 'evidence.json'), {});
  const handover = await readText(path.join(params.workspacePath, '.symphony', 'HANDOVER.md'));
  const developmentLog = await readText(path.join(params.workspacePath, '.symphony', 'DEVELOPMENT_LOG.md'));
  const reviewReport = await readText(path.join(params.workspacePath, '.symphony', 'REVIEW_REPORT.md'));
  const commandRuns = normalizeEvidenceCommandRuns(evidence.command_runs);
  const successfulCommandRuns = commandRuns.filter((run) => run.status === 'satisfied');
  const failedCommandRuns = commandRuns.filter((run) => run.status === 'failed');
  const artifactObservations = normalizeEvidenceArtifactObservations(evidence.artifact_observations);
  const runtimeObservations = evidence.runtime_observations ?? [];
  const profile = evidence.profile ?? inferProfile(params.issue, params.mode);
  const requirements: Array<CompletionRequirement & { status: 'missing' | 'satisfied' }> = [];
  for (const item of evidence.requirements ?? []) {
    if (isReviewOnlyCommandRequirement(item.key, params.mode)) {
      continue;
    }
    let satisfied = item.status === 'satisfied' || isSatisfiedEvidenceRecord(item as Record<string, unknown>);

    if (item.kind === 'verification' && hasStructuredRequirementEvidence(item.evidence)) {
      satisfied = true;
    }
    if (item.key === 'handover' && handover) {
      satisfied = true;
    }
    if (
      item.key === 'verification' &&
      (
        verificationMentioned(handover) ||
        verificationMentioned(developmentLog) ||
        successfulCommandRuns.some((run) => !['setup', 'dev'].includes(run.command_key ?? ''))
      )
    ) {
      satisfied = true;
    }
    if (item.key.startsWith('command:')) {
      const requiredKey = item.key.slice('command:'.length);
      satisfied = satisfied || successfulCommandRuns.some((run) => (
        run.command_key === requiredKey ||
        normalizeCommand(run.command) === normalizeCommand(requiredKey)
      ));
    }
    if (item.key.startsWith('artifact:')) {
      const artifactPath = item.key.slice('artifact:'.length);
      satisfied = satisfied || await isArtifactRequirementSatisfied({
        workspacePath: params.workspacePath,
        artifactPath,
        profile,
        observations: artifactObservations,
      });
    }
    if (item.key === 'runtime:url') {
      satisfied = runtimeObservations.some((observation) => (
        observation.hint_key === 'url' &&
        observation.status === 'satisfied'
      ));
    }
    if (item.key === 'review_report' && reviewReport && parseCanonicalReviewReport(reviewReport)) {
      satisfied = true;
    }

    requirements.push({
      key: item.key,
      label: item.label,
      reason: item.reason,
      kind: item.kind,
      status: satisfied ? 'satisfied' : 'missing',
    });
  }

  const missing = requirements
    .filter((item) => item.status !== 'satisfied')
    .map(({ status: _status, ...item }) => item);

  return {
    summary: {
      profile,
      complexity: evidence.complexity ?? judgeComplexity(params.issue).complexity,
      files,
      overview: brief ? normalizeOverview(brief) : null,
    },
    task_status: summarizeTaskStatus(tasksText),
    evidence_summary: {
      total_requirements: requirements.length,
      satisfied: requirements.length - missing.length,
      missing: missing.length,
      successful_commands: mergeUniqueStrings(successfulCommandRuns.map(summarizeCommandForEvidence)),
      failed_commands: mergeUniqueStrings(failedCommandRuns.map(summarizeCommandForEvidence)),
      observed_artifacts: mergeUniqueStrings(
        artifactObservations
          .filter((observation) => observation.exists && observation.non_empty)
          .map((observation) => observation.path),
      ),
      runtime_checks: runtimeObservations.map((observation) => ({
        hint_key: observation.hint_key,
        status: observation.status,
        value: observation.value,
      })),
      notes: evidence.notes ?? [],
    },
    missing_requirements: missing,
  };
}
