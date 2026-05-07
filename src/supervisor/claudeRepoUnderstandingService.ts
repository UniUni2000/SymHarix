import * as cp from 'child_process';
import { promisify } from 'util';
import { AgentRunner } from '../agent/runner';
import {
  normalizeRepoUnderstandingRecord,
  type SupervisorRepoUnderstandingInput,
  type SupervisorRepoUnderstandingService,
  type SupervisorRepoUnderstandingSnapshot,
} from './repoUnderstanding';

const execFile = promisify(cp.execFile);

export interface ClaudeRepoUnderstandingRunnerInput {
  localPath: string;
  prompt: string;
}

export interface ClaudeCodeRepoUnderstandingRunnerConfig {
  command: string;
  timeoutMs: number;
  projectRoot?: string;
  readTimeoutMs?: number;
}

export interface DefaultClaudeRepoUnderstandingServiceOptions {
  findCached(input: { repoRef: string; commitSha: string }): Promise<SupervisorRepoUnderstandingSnapshot | null>;
  save(snapshot: SupervisorRepoUnderstandingSnapshot & { localPath: string | null }): Promise<void>;
  resolveCommit(localPath: string): Promise<string>;
  runClaude(input: ClaudeRepoUnderstandingRunnerInput): Promise<string>;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && hasRequiredClaudeFields(parsed as Record<string, unknown>)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to embedded-object scanning.
  }

  for (const parsed of extractParseableJsonObjects(trimmed)) {
    if (hasRequiredClaudeFields(parsed)) {
      return parsed;
    }
  }

  return null;
}

function* extractParseableJsonObjects(text: string): Generator<Record<string, unknown>> {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const candidate = extractBalancedJsonCandidate(text, start);
    if (!candidate) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        yield parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
}

function extractBalancedJsonCandidate(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function fallbackSnapshot(params: {
  repoRef: string;
  commitSha: string;
  risk: string;
  summary: string;
}): SupervisorRepoUnderstandingSnapshot {
  return {
    repo_ref: params.repoRef,
    commit_sha: params.commitSha,
    summary: params.summary,
    understanding: {
      project_purpose: 'Unknown until Claude Code repo understanding is available.',
      tech_stack: [],
      key_paths: [],
      architecture_notes: [],
      artifact_opportunities: [],
      test_commands: [],
      risks: [params.risk],
    },
    evidence_paths: [],
    source: 'fallback',
  };
}

function hasRequiredClaudeFields(record: Record<string, unknown>): boolean {
  return typeof record.summary === 'string'
    && record.summary.trim().length > 0
    && typeof record.project_purpose === 'string'
    && record.project_purpose.trim().length > 0;
}

export function buildRepoUnderstandingPrompt(repoRef: string): string {
  return [
    'READ-ONLY repository understanding task.',
    'Do not edit files, create commits, create issues, run destructive commands, or change repository state.',
    'For command use, only read/list/inspect commands are allowed.',
    'Do not run installs, formatters, codegen, snapshot-writing tests, git writes, network side effects, or external side effects.',
    'Inspect code, README, manifests, scripts, docs, and tests only as needed.',
    'Understand enough to advise a Telegram supervisor about programming questions, artifact creation, and safe implementation planning.',
    'Return JSON only. Do not wrap the JSON in Markdown.',
    'Use this exact JSON shape:',
    JSON.stringify({
      summary: 'short repository summary',
      project_purpose: 'what this project is for',
      tech_stack: ['frameworks, languages, runtimes, databases'],
      key_paths: ['important files or directories'],
      architecture_notes: ['important control flow and boundaries'],
      artifact_opportunities: ['useful artifacts or product surfaces to suggest'],
      test_commands: ['focused validation commands'],
      risks: ['repo-specific implementation risks'],
      evidence_paths: ['paths that support the analysis'],
    }),
    `repo_ref: ${repoRef}`,
  ].join('\n');
}

export class DefaultClaudeRepoUnderstandingService implements SupervisorRepoUnderstandingService {
  constructor(private readonly options: DefaultClaudeRepoUnderstandingServiceOptions) {}

  async understand(input: SupervisorRepoUnderstandingInput): Promise<SupervisorRepoUnderstandingSnapshot> {
    if (!input.localPath) {
      return fallbackSnapshot({
        repoRef: input.repoRef,
        commitSha: 'unknown',
        summary: 'No local repository path is configured yet.',
        risk: 'missing local_path prevents Claude Code repo understanding.',
      });
    }

    const commitSha = await this.options.resolveCommit(input.localPath);
    const canPersistSnapshot = commitSha !== 'unknown';
    if (canPersistSnapshot && !input.forceRefresh) {
      const cached = await this.options.findCached({ repoRef: input.repoRef, commitSha });
      if (cached) {
        return cached;
      }
    }

    if (input.cacheOnly) {
      return fallbackSnapshot({
        repoRef: input.repoRef,
        commitSha,
        summary: 'No cached repo understanding is available yet.',
        risk: 'cache-only repo understanding lookup did not find a ready snapshot.',
      });
    }

    const raw = await this.options.runClaude({
      localPath: input.localPath,
      prompt: buildRepoUnderstandingPrompt(input.repoRef),
    });
    const parsed = parseJsonObject(raw);
    if (!parsed || !hasRequiredClaudeFields(parsed)) {
      return fallbackSnapshot({
        repoRef: input.repoRef,
        commitSha,
        summary: 'Claude repo understanding output was unusable.',
        risk: 'invalid/unparseable Claude repo understanding output prevented a successful repo understanding snapshot.',
      });
    }

    const normalized = normalizeRepoUnderstandingRecord(parsed);
    const snapshot: SupervisorRepoUnderstandingSnapshot = {
      repo_ref: input.repoRef,
      commit_sha: commitSha,
      summary: normalized.summary,
      understanding: normalized.understanding,
      evidence_paths: normalized.evidence_paths,
      source: 'claude_code',
    };

    if (canPersistSnapshot) {
      await this.options.save({ ...snapshot, localPath: input.localPath });
    }
    return snapshot;
  }
}

export async function resolveGitCommit(localPath: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['-C', localPath, 'rev-parse', 'HEAD']);
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createClaudeCodeRepoUnderstandingRunner(
  config: ClaudeCodeRepoUnderstandingRunnerConfig,
): (input: ClaudeRepoUnderstandingRunnerInput) => Promise<string> {
  return async (input) => {
    const command = config.command.trim();
    if (!command) {
      throw new Error('Missing Claude repo understanding command.');
    }

    const runner = new AgentRunner({
      codexCommand: command,
      approvalPolicy: 'on-request',
      threadSandbox: 'workspace-read',
      turnSandboxPolicy: JSON.stringify({ type: 'read-only' }),
      turnTimeoutMs: config.timeoutMs,
      readTimeoutMs: config.readTimeoutMs ?? 5_000,
      stallTimeoutMs: config.timeoutMs,
      projectRoot: config.projectRoot ?? process.cwd(),
    });
    const child = runner.launch(input.localPath);
    try {
      const { threadId } = await runner.initializeSession(child, input.localPath);
      const result = await runner.runTurn(
        child,
        threadId,
        input.prompt,
        'Supervisor repo understanding',
        input.localPath,
        () => undefined,
      );
      if (!result.success) {
        throw new Error(result.error || 'Claude repo understanding run failed.');
      }

      const assistantText = result.transcript
        .filter((entry) => entry.role === 'assistant' && entry.kind === 'message')
        .map((entry) => entry.text.trim())
        .filter(Boolean)
        .join('\n')
        .trim();
      if (!assistantText) {
        throw new Error('Claude repo understanding returned no assistant text.');
      }
      return assistantText;
    } finally {
      runner.stopSession(child);
    }
  };
}
