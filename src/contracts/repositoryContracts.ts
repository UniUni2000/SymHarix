import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import type {
  ConstitutionHit,
  GovernanceAssessment,
  Issue,
  RepositoryHarnessConfig,
  ResolvedRepositoryConstitution,
  ResolvedRepositoryHarness,
} from '../types';
import { ShadowHarnessRepository } from '../database';

const HARNESS_FILE = '.symphony-repo.yaml';
const CONSTITUTION_FILE = '.symphony-constitution.md';

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
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

function coerceCommandMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const commands: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      commands[key] = entry.trim();
    }
  }

  return commands;
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
      inferred_from: Array.isArray(existing.inference_details_json.inferred_from)
        ? (existing.inference_details_json.inferred_from as string[])
        : [],
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

export function suggestHarnessAdoption(params: { successfulRuns: number; failedRuns: number }): boolean {
  return params.successfulRuns >= 3 && params.failedRuns === 0;
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
