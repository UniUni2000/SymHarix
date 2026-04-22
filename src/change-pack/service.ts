import * as fs from 'fs/promises';
import * as path from 'path';
import { judgeComplexity } from '../hooks/dev-prompt';
import { parseCanonicalReviewReport } from '../hooks/review-prompt';
import type {
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

  const requiredCommands = params.harness?.verification?.required_commands || [];
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

  return requirements;
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
  const existingEvidence = await readJson<{ requirements?: CompletionRequirement[]; notes?: string[] }>(
    evidencePath,
    {},
  );
  const defaultRequirements = buildDefaultRequirements({ profile, harness: params.harness });
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

export async function evaluateChangePackState(params: {
  workspacePath: string;
  issue: Issue;
  mode: 'dev' | 'review';
}): Promise<ChangePackState> {
  const packPath = changePackDir(params.workspacePath);
  const files = await fs.readdir(packPath).catch(() => []);
  const brief = await readText(path.join(packPath, 'brief.md'));
  const tasksText = await readText(path.join(packPath, 'tasks.md'));
  const evidence = await readJson<{
    profile?: 'coding' | 'research' | 'ui' | 'review';
    complexity?: 'small' | 'medium' | 'large';
    requirements?: Array<CompletionRequirement & { status?: 'missing' | 'satisfied' }>;
    notes?: string[];
  }>(path.join(packPath, 'evidence.json'), {});
  const handover = await readText(path.join(params.workspacePath, '.symphony', 'HANDOVER.md'));
  const developmentLog = await readText(path.join(params.workspacePath, '.symphony', 'DEVELOPMENT_LOG.md'));
  const reviewReport = await readText(path.join(params.workspacePath, '.symphony', 'REVIEW_REPORT.md'));
  const requirements: Array<CompletionRequirement & { status: 'missing' | 'satisfied' }> = [];
  for (const item of evidence.requirements ?? []) {
    let satisfied = item.status === 'satisfied';

    if (item.key === 'handover' && handover) {
      satisfied = true;
    }
    if (item.key === 'verification' && (verificationMentioned(handover) || verificationMentioned(developmentLog))) {
      satisfied = true;
    }
    if (item.key.startsWith('artifact:')) {
      const artifactPath = item.key.slice('artifact:'.length);
      const resolvedArtifactPath = path.isAbsolute(artifactPath)
        ? artifactPath
        : path.join(params.workspacePath, artifactPath);
      satisfied = await fileExists(resolvedArtifactPath);
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
      profile: evidence.profile ?? inferProfile(params.issue, params.mode),
      complexity: evidence.complexity ?? judgeComplexity(params.issue).complexity,
      files,
      overview: brief ? normalizeOverview(brief) : null,
    },
    task_status: summarizeTaskStatus(tasksText),
    evidence_summary: {
      total_requirements: requirements.length,
      satisfied: requirements.length - missing.length,
      missing: missing.length,
      notes: evidence.notes ?? [],
    },
    missing_requirements: missing,
  };
}
