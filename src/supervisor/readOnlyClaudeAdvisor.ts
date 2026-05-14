import { AgentRunner } from '../agent/runner';
import { readSymHarixEnv } from '../config/env';
import type { PendingRuntimeRequest, RuntimeRequestResponse } from '../types';
import type {
  SupervisorAgentBackendResult,
  SupervisorAgentNormalizedInput,
} from './supervisorAgent';

export type SupervisorReadOnlyClaudeAdvisorBackend = (
  input: SupervisorAgentNormalizedInput,
) => Promise<SupervisorAgentBackendResult>;

export interface SupervisorReadOnlyClaudeAdvisor {
  advise: SupervisorReadOnlyClaudeAdvisorBackend;
  hasActiveConversation(params: SupervisorReadOnlyClaudeConversationKey): boolean;
  clearConversation(params: SupervisorReadOnlyClaudeConversationKey): Promise<number>;
  getDiagnostics(): SupervisorReadOnlyClaudeConversationDiagnostics[];
  dispose(): Promise<void>;
}

export interface SupervisorReadOnlyClaudeAdvisorRunnerConfig {
  command: string;
  timeoutMs: number;
  projectRoot?: string;
  readTimeoutMs?: number;
}

export interface SupervisorReadOnlyClaudeConversationKey {
  transport: string;
  conversationId: string;
  repoRef: string | null;
}

export interface SupervisorReadOnlyClaudeConversationDiagnostics {
  transport: string;
  conversation_id: string;
  repo_ref: string | null;
  local_path: string;
  source_commit_sha: string | null;
  started_at: string;
  last_used_at: string;
  turn_count: number;
}

export interface SupervisorReadOnlyClaudeSession {
  run(prompt: string, input: SupervisorAgentNormalizedInput): Promise<SupervisorAgentBackendResult>;
  dispose(): Promise<void> | void;
}

export type SupervisorReadOnlyClaudeSessionFactory = (
  input: SupervisorAgentNormalizedInput,
) => Promise<SupervisorReadOnlyClaudeSession>;

const READ_ONLY_ALLOWED_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoRead']);
const READ_ONLY_EXTERNAL_TOOLS = new Set(['WebFetch', 'WebSearch']);
const READ_ONLY_BLOCKED_TOOLS = new Set(['Bash', 'Write', 'Edit']);

export interface SupervisorReadOnlyClaudeConversationManagerOptions {
  createSession: SupervisorReadOnlyClaudeSessionFactory;
  now?: () => string;
}

interface SupervisorReadOnlyClaudeConversationState {
  key: SupervisorReadOnlyClaudeConversationKey;
  keyId: string;
  session: SupervisorReadOnlyClaudeSession;
  localPath: string;
  sourceCommitSha: string | null;
  startedAt: string;
  lastUsedAt: string;
  turnCount: number;
  queue: Promise<void>;
}

function normalizeConfigValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  const normalized = normalizeConfigValue(value);
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function runtimeRequestToolName(request: PendingRuntimeRequest): string | null {
  return request.summary.tool_name
    ?? (typeof request.raw.tool_name === 'string' ? request.raw.tool_name : null);
}

function permissionResponse(
  request: PendingRuntimeRequest,
  behavior: 'allow' | 'deny',
  message?: string,
): RuntimeRequestResponse {
  const toolUseID =
    typeof request.raw.tool_use_id === 'string' ? request.raw.tool_use_id : undefined;
  if (behavior === 'allow') {
    return {
      response: {
        behavior: 'allow',
        updatedInput: (request.raw.input as Record<string, unknown> | undefined) ?? {},
        ...(toolUseID ? { toolUseID } : {}),
      },
    };
  }

  return {
    response: {
      behavior: 'deny',
      message: message ?? 'Denied by read-only supervisor advisor policy.',
      ...(toolUseID ? { toolUseID } : {}),
      decisionClassification: 'user_reject',
    },
  };
}

export function respondToReadOnlyClaudeRuntimeRequest(
  request: PendingRuntimeRequest,
  allowExternalResearch: boolean,
): RuntimeRequestResponse {
  if (request.kind !== 'approval') {
    return {
      response: {
        action: 'cancel',
      },
    };
  }

  const toolName = runtimeRequestToolName(request);
  if (!toolName) {
    return permissionResponse(request, 'deny', 'Unknown tool request denied by read-only supervisor advisor policy.');
  }
  if (READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
    return permissionResponse(request, 'deny', `${toolName} is disabled in read-only supervisor advisor mode.`);
  }
  if (READ_ONLY_EXTERNAL_TOOLS.has(toolName)) {
    return allowExternalResearch
      ? permissionResponse(request, 'allow')
      : permissionResponse(request, 'deny', `${toolName} is disabled unless the user explicitly asks for external research.`);
  }
  if (READ_ONLY_ALLOWED_TOOLS.has(toolName)) {
    return permissionResponse(request, 'allow');
  }

  return permissionResponse(request, 'deny', `${toolName} is not part of the read-only supervisor advisor tool allowlist.`);
}

function normalizeKeyPart(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function conversationKeyFromInput(input: SupervisorAgentNormalizedInput): SupervisorReadOnlyClaudeConversationKey {
  return {
    transport: normalizeKeyPart(input.runtimeContext.transport, input.runtimeContext.source),
    conversationId: normalizeKeyPart(input.runtimeContext.conversationId, 'adhoc'),
    repoRef: input.repoRef ?? input.defaultRepoRef,
  };
}

function conversationKeyId(key: SupervisorReadOnlyClaudeConversationKey): string {
  return [
    key.transport,
    key.conversationId,
    key.repoRef ?? 'no-repo',
  ].map((part) => encodeURIComponent(part)).join(':');
}

function sourceCommitSha(input: SupervisorAgentNormalizedInput): string | null {
  return input.repoSource?.commit_sha ?? null;
}

function buildConversationPrompt(
  input: SupervisorAgentNormalizedInput,
  previousCommitSha: string | null,
): string {
  const currentCommitSha = sourceCommitSha(input);
  const refreshNotice = previousCommitSha && currentCommitSha && previousCommitSha !== currentCommitSha
    ? [
        'Repository source cache was refreshed since the last turn.',
        `Previous commit: ${previousCommitSha}`,
        `Current commit: ${currentCommitSha}`,
        'Re-read the relevant files before answering.',
      ].join('\n')
    : null;
  return [
    refreshNotice,
    buildReadOnlyClaudeAdvisorPrompt(input),
  ].filter(Boolean).join('\n');
}

export function buildReadOnlyClaudeAdvisorPrompt(input: SupervisorAgentNormalizedInput): string {
  return [
    'You are the read-only Claude Code brain for a Telegram Supervisor Agent.',
    'You may inspect the repository to answer questions, suggest plans, or recommend artifacts.',
    'You must not edit files, create commits, create issues, change session state, run installs, run formatters, run codegen, or perform destructive actions.',
    'Use only read/list/search style repository inspection. Bash, Write, and Edit are disabled.',
    input.allowExternalResearch
      ? 'The user explicitly asked for latest/external information, so WebFetch/WebSearch may be used when it materially improves the answer.'
      : 'The user did not explicitly ask for external information; do not use WebFetch or WebSearch.',
    'Prefer repository evidence over generic advice.',
    'You also receive a read-only runtime/control-plane snapshot with issue, Linear tracker, orchestrator, session, timeline, and governance facts when available.',
    'Use that snapshot to explain what an issue is doing, whether it appears stuck, and give cautious heuristic ETA language; do not claim to have queried Linear, GitHub, or runtime APIs yourself.',
    'For art, visual, UI, demo, card, or artifact requests, recommend one concrete repo-aware artifact before any implementation.',
    'Never say an issue was created or code was changed. Recommendations must wait for user approval.',
    'Return JSON only. Do not wrap the JSON in Markdown.',
    'Allowed JSON modes:',
    JSON.stringify({
      mode: 'repo_answer',
      answer: 'direct answer grounded in repository evidence',
      citations: ['relative/path.ts'],
    }),
    JSON.stringify({
      mode: 'artifact_ideation',
      title: 'short artifact title',
      recommendation: 'one concrete artifact recommendation',
      rationale: 'why this fits the repo and user request',
      next_step: 'ask for approval before implementation',
    }),
    JSON.stringify({
      mode: 'issue_recommendation',
      title: 'short issue title',
      summary: 'what should be done and why',
      next_step: 'ask for approval before creating work',
    }),
    JSON.stringify({
      mode: 'clarify',
      question: 'one focused clarification question',
    }),
    `repo_ref: ${input.repoRef ?? 'null'}`,
    `local_path: ${input.localPath ?? 'null'}`,
    `repo_source: ${JSON.stringify(input.repoSource)}`,
    `repo_profile: ${JSON.stringify(input.repoProfile)}`,
    `warm_repo_understanding: ${JSON.stringify(input.repoUnderstanding)}`,
    `runtime_context: ${JSON.stringify(input.runtimeContext)}`,
    `control_plane_snapshot: ${JSON.stringify(input.controlPlaneSnapshot ?? null)}`,
    `project_context: ${input.projectContext ?? 'null'}`,
    `user_text: ${input.normalizedUserText}`,
  ].join('\n');
}

export class SupervisorReadOnlyClaudeConversationManager implements SupervisorReadOnlyClaudeAdvisor {
  private readonly sessions = new Map<string, SupervisorReadOnlyClaudeConversationState>();
  private readonly now: () => string;

  constructor(private readonly options: SupervisorReadOnlyClaudeConversationManagerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  hasActiveConversation(params: SupervisorReadOnlyClaudeConversationKey): boolean {
    return this.sessions.has(conversationKeyId(params));
  }

  async clearConversation(params: SupervisorReadOnlyClaudeConversationKey): Promise<number> {
    const matches = [...this.sessions.values()].filter((state) => (
      state.key.transport === params.transport &&
      state.key.conversationId === params.conversationId &&
      (params.repoRef === null || state.key.repoRef === params.repoRef)
    ));
    await Promise.all(matches.map((state) => this.disposeState(state)));
    return matches.length;
  }

  getDiagnostics(): SupervisorReadOnlyClaudeConversationDiagnostics[] {
    return [...this.sessions.values()]
      .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
      .map((state) => ({
        transport: state.key.transport,
        conversation_id: state.key.conversationId,
        repo_ref: state.key.repoRef,
        local_path: state.localPath,
        source_commit_sha: state.sourceCommitSha,
        started_at: state.startedAt,
        last_used_at: state.lastUsedAt,
        turn_count: state.turnCount,
      }));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((state) => this.disposeState(state)));
  }

  async advise(input: SupervisorAgentNormalizedInput): Promise<SupervisorAgentBackendResult> {
    if (!input.localPath) {
      return {
        mode: 'clarify',
        question: '我还没有可读取的仓库 source cache。请先确认这个项目的 repositories.routing 配置是否可用。',
      };
    }

    const key = conversationKeyFromInput(input);
    const keyId = conversationKeyId(key);
    let state = this.sessions.get(keyId) ?? null;
    if (state && state.localPath !== input.localPath) {
      await this.disposeState(state);
      state = null;
    }

    if (!state) {
      const now = this.now();
      state = {
        key,
        keyId,
        session: await this.options.createSession(input),
        localPath: input.localPath,
        sourceCommitSha: sourceCommitSha(input),
        startedAt: now,
        lastUsedAt: now,
        turnCount: 0,
        queue: Promise.resolve(),
      };
      this.sessions.set(keyId, state);
    }

    const prompt = buildConversationPrompt(input, state.sourceCommitSha);
    const run = state.queue.catch(() => undefined).then(async () => {
      state!.lastUsedAt = this.now();
      const result = await state!.session.run(prompt, input);
      state!.turnCount += 1;
      state!.lastUsedAt = this.now();
      state!.sourceCommitSha = sourceCommitSha(input);
      return result;
    });
    state.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async disposeState(state: SupervisorReadOnlyClaudeConversationState): Promise<void> {
    this.sessions.delete(state.keyId);
    await state.queue.catch(() => undefined);
    await state.session.dispose();
  }
}

export function createClaudeCodeReadOnlyAdvisorSessionFactory(
  config: SupervisorReadOnlyClaudeAdvisorRunnerConfig,
): SupervisorReadOnlyClaudeSessionFactory {
  return async (input) => {
    const command = config.command.trim();
    if (!command) {
      throw new Error('Missing read-only supervisor advisor command.');
    }

    const runner = new AgentRunner({
      codexCommand: command,
      approvalPolicy: 'on-request',
      threadSandbox: 'workspace-read',
      turnSandboxPolicy: JSON.stringify({
        type: 'read-only',
        allowExternalResearch: input.allowExternalResearch,
      }),
      turnTimeoutMs: config.timeoutMs,
      readTimeoutMs: config.readTimeoutMs ?? 5_000,
      stallTimeoutMs: config.timeoutMs,
      projectRoot: config.projectRoot ?? process.cwd(),
    });
    const child = runner.launch(input.localPath);
    const { threadId } = await runner.initializeSession(child, input.localPath);
    return {
      run: async (prompt, turnInput) => {
        (runner as unknown as { options: { turnSandboxPolicy: string } }).options.turnSandboxPolicy = JSON.stringify({
          type: 'read-only',
          allowExternalResearch: turnInput.allowExternalResearch,
        });
        const result = await runner.runTurn(
          child,
          threadId,
          prompt,
          'Supervisor read-only repo advisor',
          input.localPath,
          () => undefined,
          async (request) => respondToReadOnlyClaudeRuntimeRequest(request, turnInput.allowExternalResearch),
        );
        if (!result.success) {
          throw new Error(result.error || 'Read-only supervisor advisor run failed.');
        }

        const assistantText = result.transcript
          .filter((entry) => entry.role === 'assistant' && entry.kind === 'message')
          .map((entry) => entry.text.trim())
          .filter(Boolean)
          .join('\n')
          .trim();
        if (!assistantText) {
          throw new Error('Read-only supervisor advisor returned no assistant text.');
        }
        return assistantText;
      },
      dispose: () => {
        runner.stopSession(child);
      },
    };
  };
}

export function createClaudeCodeReadOnlyAdvisorRunner(
  config: SupervisorReadOnlyClaudeAdvisorRunnerConfig,
): SupervisorReadOnlyClaudeAdvisorBackend {
  const manager = new SupervisorReadOnlyClaudeConversationManager({
    createSession: createClaudeCodeReadOnlyAdvisorSessionFactory(config),
  });
  return manager.advise.bind(manager);
}

export function createReadOnlyClaudeSupervisorAdvisorFromEnv(): SupervisorReadOnlyClaudeAdvisor | null {
  const command = normalizeConfigValue(readSymHarixEnv('SYMPHONY_SUPERVISOR_READONLY_ADVISOR_COMMAND'))
    ?? normalizeConfigValue(readSymHarixEnv('SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND'))
    ?? 'node scripts/claude-adapter.cjs';
  const timeoutMs = parsePositiveInteger(readSymHarixEnv('SYMPHONY_SUPERVISOR_READONLY_ADVISOR_TIMEOUT_MS'))
    ?? parsePositiveInteger(readSymHarixEnv('SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS'))
    ?? 120_000;
  const manager = new SupervisorReadOnlyClaudeConversationManager({
    createSession: createClaudeCodeReadOnlyAdvisorSessionFactory({
      command,
      timeoutMs,
      projectRoot: process.cwd(),
    }),
  });
  return manager;
}
