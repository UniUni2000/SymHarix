import type { ResolvedRepositoryRoute } from '../types';
import type { RepoProfile, RepoProfileService } from './repoProfileService';
import type {
  SupervisorRepoUnderstandingService,
  SupervisorRepoUnderstandingSnapshot,
} from './repoUnderstanding';
import {
  createReadOnlyClaudeSupervisorAdvisorFromEnv,
  type SupervisorReadOnlyClaudeAdvisorBackend,
  type SupervisorReadOnlyClaudeConversationDiagnostics,
} from './readOnlyClaudeAdvisor';
import type {
  SupervisorRepoSourceResolver,
  SupervisorRepoSourceSnapshot,
} from './repoSourceResolver';
import { isSupervisorControlPlaneQuestion } from '../bots/controlPlaneIntent';

export interface SupervisorAgentRuntimeContext {
  source: 'telegram_chat' | 'slash_command' | 'inline_action';
  transport?: string;
  conversationId?: string;
  defaultProjectSlug: string | null;
  activeIssueId: string | null;
}

export interface SupervisorControlPlaneSnapshot {
  default_project_slug: string | null;
  available_projects: Array<{
    project_slug: string;
    github_repo_full: string | null;
  }>;
  overview: {
    running: number;
    retrying: number;
    total: number;
    active_issues: Array<Record<string, unknown>>;
  };
  focus_issue: Record<string, unknown> | null;
  watch_subscriptions: Array<Record<string, unknown>>;
}

export interface SupervisorAgentInput {
  localPath: string | null;
  repoRef: string | null;
  defaultRepoRef: string | null;
  userText: string;
  projectContext: string | null;
  runtimeContext: SupervisorAgentRuntimeContext;
  controlPlaneSnapshot?: SupervisorControlPlaneSnapshot | null;
  route?: ResolvedRepositoryRoute | null;
  forceReadOnlyClaude?: boolean;
}

export interface SupervisorAgentNormalizedInput extends SupervisorAgentInput {
  repoRef: string | null;
  normalizedUserText: string;
  repoProfile: RepoProfile | null;
  repoUnderstanding: SupervisorRepoUnderstandingSnapshot | null;
  repoSource: SupervisorRepoSourceSnapshot | null;
  allowExternalResearch: boolean;
  prompt: string;
}

export type SupervisorAgentResult =
  | {
      mode: 'chat_reply';
      repoRef: string | null;
      message: string;
    }
  | {
      mode: 'repo_answer';
      repoRef: string | null;
      answer: string;
      citations?: string[];
    }
  | {
      mode: 'issue_recommendation';
      repoRef: string | null;
      title: string;
      summary: string;
      nextStep: string;
    }
  | {
      mode: 'artifact_ideation';
      repoRef: string | null;
      title: string;
      recommendation: string;
      rationale: string;
      nextStep: string;
    }
  | {
      mode: 'handoff_to_session';
      repoRef: string | null;
      handoffMessage: string;
      suggestedTitle?: string;
      suggestedBody?: string;
      projectSlug?: string;
    }
  | {
      mode: 'clarify';
      repoRef: string | null;
      question: string;
    };

export interface SupervisorAgentService {
  respond(input: SupervisorAgentInput): Promise<SupervisorAgentResult | null>;
  hasActiveRepoConversation?(params: {
    transport: string;
    conversationId: string;
    repoRef: string | null;
  }): boolean;
  clearRepoConversation?(params: {
    transport: string;
    conversationId: string;
    repoRef: string | null;
  }): Promise<number>;
  getRepoConversationDiagnostics?(): SupervisorReadOnlyClaudeConversationDiagnostics[];
  disposeRepoConversations?(): Promise<void> | void;
}

export type SupervisorAgentBackendResult =
  | string
  | Record<string, unknown>
  | null
  | undefined;

export type SupervisorAgentBackend = (
  input: SupervisorAgentNormalizedInput,
) => Promise<SupervisorAgentBackendResult>;

export interface DefaultSupervisorAgentServiceOptions {
  analyze: SupervisorAgentBackend;
  resolveRepoProfile: RepoProfileService['resolve'];
  resolveRepoUnderstanding?: SupervisorRepoUnderstandingService['understand'];
  resolveRepoSource?: SupervisorRepoSourceResolver['resolve'];
  adviseWithReadOnlyClaude?: SupervisorReadOnlyClaudeAdvisorBackend;
  hasActiveRepoConversation?: NonNullable<SupervisorAgentService['hasActiveRepoConversation']>;
  clearRepoConversation?: NonNullable<SupervisorAgentService['clearRepoConversation']>;
  getRepoConversationDiagnostics?: NonNullable<SupervisorAgentService['getRepoConversationDiagnostics']>;
  disposeRepoConversations?: NonNullable<SupervisorAgentService['disposeRepoConversations']>;
}

function normalizeConfigValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeProvider(value: string | null | undefined): 'anthropic' | 'openai' | null {
  const normalized = normalizeConfigValue(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (['anthropic', 'claude'].includes(normalized)) {
    return 'anthropic';
  }
  if (['openai', 'openai-compatible', 'openai_compatible'].includes(normalized)) {
    return 'openai';
  }
  return null;
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  const normalized = normalizeConfigValue(value);
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeUserText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function shouldUseReadOnlyClaudeForText(value: string): boolean {
  if (isSupervisorControlPlaneQuestion(value)) {
    return false;
  }
  const normalized = value.toLowerCase();
  const englishTriggers = [
    /\b(repo|repository|codebase|files?|folders?|directory|directories)\b/,
    /\b(source code|architecture|artifact|visual|ui|demo|page|component|design|image|plan card|api|docs?|documentation)\b/,
    /\b(create|build|make|draw|design|generate)\b.{0,40}\b(artifact|visual|ui|demo|page|component|image|card)\b/,
    /\b(latest|official|web|internet|documentation)\b/,
    /\b(issue|ticket)\b/,
    /\b[A-Z][A-Z0-9]+-\d+\b.*\b(stuck|blocked|status|progress|eta|finish|done|running|doing)\b/i,
    /\b(stuck|blocked|status|progress|eta|finish|done|running|doing)\b.*\b[A-Z][A-Z0-9]+-\d+\b/i,
    /\b(?:readme|dockerfile|makefile|package\.json|tsconfig\.json|bun\.lockb?)\b/i,
    /(?:^|[\s"'`])[\w@./-]+\.(?:md|ts|tsx|js|jsx|mjs|cjs|json|py|png|jpg|jpeg|svg|yml|yaml|toml|txt|css|scss|html)(?:$|[\s"'`,，。?？!！:：])/i,
    /(?:^|[\s"'`])[\w@./-]+\/[\w@./-]+(?:$|[\s"'`,，。?？!！:：])/i,
  ];
  const chineseTriggers = [
    /代码|仓库|文件|目录/,
    /项目.{0,24}(代码|结构|架构|页面|组件|视觉|艺术|产物|演示|卡片|图片|海报|设计|原型|用途|干啥|做什么)/,
    /(创建|生成|做|画|设计).{0,24}(页面|组件|视觉|艺术|产物|演示|卡片|图片|海报|原型)/,
    /最新|官方文档|联网|查资料|资料|API/,
    /(提|建|开|创建|推荐|建议).{0,20}issue|issue.{0,20}(提|建|开|创建|推荐|建议)/i,
    /\b[A-Z][A-Z0-9]+-\d+\b.*(卡在哪|卡住|为什么没跑|为什么没开始|正在开发|正在做|预计|多久|什么时候完成|进度|状态)/i,
  ];
  return englishTriggers.some((pattern) => pattern.test(normalized))
    || chineseTriggers.some((pattern) => pattern.test(value));
}

function shouldAllowExternalResearch(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\b(latest|official docs?|official documentation|web|internet|search|look up|api docs?)\b/.test(normalized)
    || /最新|官方文档|联网|查资料|网上|搜索|资料/.test(value);
}

function readJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function nonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildPrompt(input: {
  repoRef: string | null;
  localPath: string | null;
  projectContext: string | null;
  userText: string;
  runtimeContext: SupervisorAgentRuntimeContext;
  controlPlaneSnapshot?: SupervisorControlPlaneSnapshot | null;
  repoProfile: RepoProfile | null;
  repoUnderstanding: SupervisorRepoUnderstandingSnapshot | null;
  repoSource: SupervisorRepoSourceSnapshot | null;
  allowExternalResearch: boolean;
}): string {
  return [
    'You are the top-level Supervisor Agent for Telegram supervisor chat.',
    'Bias toward natural conversation first, repo understanding second, and issue or workflow routing only when it is actually appropriate.',
    'Act like a capable general agent: chat naturally, answer repo questions, recommend work, or hand off to a session when the user is clearly ready.',
    'Allowed modes: chat_reply, repo_answer, issue_recommendation, artifact_ideation, handoff_to_session, clarify.',
    'When the user asks to create art, UI, visual cards, demos, pages, or artifacts, use repo_understanding to recommend one concrete artifact path before creating work.',
    'Do not mutate the repository, create issues, or change session state.',
    `repo_ref: ${input.repoRef ?? 'null'}`,
    `local_path: ${input.localPath ?? 'null'}`,
    `project_context: ${input.projectContext ?? 'null'}`,
    `runtime_context: ${JSON.stringify(input.runtimeContext)}`,
    `control_plane_snapshot: ${JSON.stringify(input.controlPlaneSnapshot ?? null)}`,
    `repo_source: ${JSON.stringify(input.repoSource)}`,
    `allow_external_research: ${input.allowExternalResearch}`,
    `repo_profile: ${JSON.stringify(input.repoProfile)}`,
    `repo_understanding: ${JSON.stringify(input.repoUnderstanding)}`,
    `user_text: ${input.userText}`,
    'Return JSON only.',
  ].join('\n');
}

function parseResult(
  value: SupervisorAgentBackendResult,
  repoRef: string | null,
): SupervisorAgentResult | null {
  const record = typeof value === 'string'
    ? readJsonObject(value)
    : value && typeof value === 'object'
      ? value
      : null;

  if (!record) {
    return null;
  }

  if (record.mode === 'chat_reply') {
    const message = nonBlankString(record.message);
    if (!message) {
      return null;
    }
    return {
      mode: 'chat_reply',
      repoRef,
      message,
    };
  }

  if (record.mode === 'repo_answer') {
    const answer = nonBlankString(record.answer);
    if (!answer) {
      return null;
    }
    return {
      mode: 'repo_answer',
      repoRef,
      answer,
      citations: toStringArray(record.citations),
    };
  }

  if (record.mode === 'issue_recommendation') {
    const title = nonBlankString(record.title);
    const summary = nonBlankString(record.summary);
    const nextStep = nonBlankString(record.next_step ?? record.nextStep);
    if (!title || !summary || !nextStep) {
      return null;
    }
    return {
      mode: 'issue_recommendation',
      repoRef,
      title,
      summary,
      nextStep,
    };
  }

  if (record.mode === 'artifact_ideation') {
    const title = nonBlankString(record.title);
    const recommendation = nonBlankString(record.recommendation);
    const rationale = nonBlankString(record.rationale);
    const nextStep = nonBlankString(record.next_step ?? record.nextStep);
    if (!title || !recommendation || !rationale || !nextStep) {
      return null;
    }
    return {
      mode: 'artifact_ideation',
      repoRef,
      title,
      recommendation,
      rationale,
      nextStep,
    };
  }

  if (record.mode === 'handoff_to_session') {
    const handoffMessage = nonBlankString(record.handoff_message ?? record.handoffMessage);
    if (!handoffMessage) {
      return null;
    }
    const suggestedTitle = nonBlankString(record.suggested_title ?? record.suggestedTitle) ?? undefined;
    const suggestedBody = nonBlankString(record.suggested_body ?? record.suggestedBody) ?? undefined;
    const projectSlug = nonBlankString(record.project_slug ?? record.projectSlug) ?? undefined;
    return {
      mode: 'handoff_to_session',
      repoRef,
      handoffMessage,
      suggestedTitle,
      suggestedBody,
      projectSlug,
    };
  }

  if (record.mode === 'clarify') {
    const question = nonBlankString(record.question);
    if (!question) {
      return null;
    }
    return {
      mode: 'clarify',
      repoRef,
      question,
    };
  }

  return null;
}

function repoProfileFallbackAnswer(
  repoRef: string | null,
  profile: RepoProfile | null,
): SupervisorAgentResult | null {
  if (!repoRef || !profile) {
    return null;
  }

  const details = [
    profile.signals.readme_title ? `README: ${profile.signals.readme_title}` : null,
    profile.project_type !== 'unknown' ? `类型：${profile.project_type}` : null,
    profile.tech_stack.length > 0 ? `技术栈：${profile.tech_stack.join(', ')}` : null,
    profile.key_paths.length > 0 ? `关键路径：${profile.key_paths.slice(0, 5).join(', ')}` : null,
  ].filter(Boolean);

  return {
    mode: 'repo_answer',
    repoRef,
    answer: [
      `${repoRef} 主要是：${profile.summary}`,
      ...details,
    ].join('\n'),
    citations: profile.key_paths.length > 0
      ? profile.key_paths.slice(0, 5)
      : undefined,
  };
}

export class DefaultSupervisorAgentService implements SupervisorAgentService {
  constructor(private readonly options: DefaultSupervisorAgentServiceOptions) {}

  hasActiveRepoConversation(params: {
    transport: string;
    conversationId: string;
    repoRef: string | null;
  }): boolean {
    return this.options.hasActiveRepoConversation?.(params) ?? false;
  }

  clearRepoConversation(params: {
    transport: string;
    conversationId: string;
    repoRef: string | null;
  }): Promise<number> {
    return this.options.clearRepoConversation?.(params) ?? Promise.resolve(0);
  }

  getRepoConversationDiagnostics(): SupervisorReadOnlyClaudeConversationDiagnostics[] {
    return this.options.getRepoConversationDiagnostics?.() ?? [];
  }

  disposeRepoConversations(): Promise<void> | void {
    return this.options.disposeRepoConversations?.();
  }

  async respond(input: SupervisorAgentInput): Promise<SupervisorAgentResult | null> {
    const normalizedUserText = normalizeUserText(input.userText);
    if (!normalizedUserText) {
      return null;
    }

    const resolvedRepoRef = input.repoRef ?? input.defaultRepoRef;
    const needsReadOnlyClaude = Boolean(input.forceReadOnlyClaude)
      || shouldUseReadOnlyClaudeForText(normalizedUserText);
    const allowExternalResearch = shouldAllowExternalResearch(normalizedUserText);
    let resolvedLocalPath = input.localPath;
    let repoSource: SupervisorRepoSourceSnapshot | null = null;

    if (
      needsReadOnlyClaude &&
      input.route &&
      this.options.resolveRepoSource
    ) {
      repoSource = await this.options.resolveRepoSource(input.route).catch(() => null);
      if (repoSource?.status === 'ready' && repoSource.analysis_path) {
        resolvedLocalPath = repoSource.analysis_path;
      }
    }

    const repoProfile = resolvedRepoRef
      ? await this.options.resolveRepoProfile({
          repoRef: resolvedRepoRef,
          localPath: resolvedLocalPath,
        })
      : null;
    const repoUnderstanding = resolvedRepoRef && this.options.resolveRepoUnderstanding
      ? await this.options.resolveRepoUnderstanding({
          repoRef: resolvedRepoRef,
          localPath: resolvedLocalPath,
          forceRefresh: false,
          cacheOnly: needsReadOnlyClaude && this.options.adviseWithReadOnlyClaude
            ? true
            : !needsReadOnlyClaude,
        }).catch(() => null)
      : null;

    const normalizedInput: SupervisorAgentNormalizedInput = {
      ...input,
      localPath: resolvedLocalPath,
      repoRef: resolvedRepoRef,
      normalizedUserText,
      repoProfile,
      repoUnderstanding,
      repoSource,
      allowExternalResearch,
      prompt: buildPrompt({
        repoRef: resolvedRepoRef,
        localPath: resolvedLocalPath,
        projectContext: input.projectContext,
        userText: normalizedUserText,
        runtimeContext: input.runtimeContext,
        controlPlaneSnapshot: input.controlPlaneSnapshot ?? null,
        repoProfile,
        repoUnderstanding,
        repoSource,
        allowExternalResearch,
      }),
    };

    const usedReadOnlyAdvisor = Boolean(needsReadOnlyClaude && this.options.adviseWithReadOnlyClaude);
    const rawResult = usedReadOnlyAdvisor
      ? await this.options.adviseWithReadOnlyClaude(normalizedInput)
      : await this.options.analyze(normalizedInput);
    const parsedResult = parseResult(rawResult, resolvedRepoRef);
    if (parsedResult) {
      return parsedResult;
    }
    return usedReadOnlyAdvisor
      ? repoProfileFallbackAnswer(resolvedRepoRef, repoProfile)
      : null;
  }
}

function textFromAnthropic(payload: unknown): string | null {
  const content = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).content
    : null;
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((block) => (
      block &&
      typeof block === 'object' &&
      typeof (block as Record<string, unknown>).text === 'string'
        ? String((block as Record<string, unknown>).text)
        : ''
    ))
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || null;
}

function textFromOpenAI(payload: unknown): string | null {
  const choices = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).choices
    : null;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const message = choices[0] && typeof choices[0] === 'object'
    ? (choices[0] as Record<string, unknown>).message
    : null;
  const content = message && typeof message === 'object'
    ? (message as Record<string, unknown>).content
    : null;

  if (typeof content === 'string') {
    return content.trim() || null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter(
      (block): block is { type?: string; text?: string } =>
        Boolean(block) &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text?.trim() || '')
    .filter(Boolean)
    .join('\n');

  return text || null;
}

export function createSupervisorAgentFromEnv(
  repoProfileService: RepoProfileService,
  fetchImpl: typeof fetch = fetch,
  repoUnderstandingService: SupervisorRepoUnderstandingService | null = null,
  repoSourceResolver: SupervisorRepoSourceResolver | null = null,
): SupervisorAgentService | null {
  const readOnlyAdvisor = repoSourceResolver
    ? createReadOnlyClaudeSupervisorAdvisorFromEnv()
    : null;
  const provider = normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_AGENT_PROVIDER)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_CC_PROVIDER)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_LLM_PROVIDER)
    ?? normalizeConfigValue(process.env.SYMPHONY_BOT_LLM_PROVIDER);
  const model = normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_AGENT_MODEL)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_CC_MODEL)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_LLM_MODEL)
    ?? normalizeConfigValue(process.env.SYMPHONY_BOT_LLM_MODEL);
  const apiKey = normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_AGENT_API_KEY)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_CC_API_KEY)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_LLM_API_KEY)
    ?? normalizeConfigValue(process.env.SYMPHONY_BOT_LLM_API_KEY);
  const normalizedProvider = normalizeProvider(provider);
  const baseUrl = normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_AGENT_BASE_URL)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_CC_BASE_URL)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_LLM_BASE_URL)
    ?? normalizeConfigValue(process.env.SYMPHONY_BOT_LLM_BASE_URL)
    ?? (normalizedProvider === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : normalizedProvider === 'openai'
        ? 'https://api.openai.com/v1'
        : null);
  const timeoutMs = parsePositiveInteger(process.env.SYMPHONY_SUPERVISOR_AGENT_TIMEOUT_MS)
    ?? parsePositiveInteger(process.env.SYMPHONY_SUPERVISOR_CC_TIMEOUT_MS)
    ?? parsePositiveInteger(process.env.SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS)
    ?? parsePositiveInteger(process.env.SYMPHONY_BOT_LLM_TIMEOUT_MS)
    ?? 45_000;

  if (!normalizedProvider || !model || !apiKey || !baseUrl) {
    if (!readOnlyAdvisor) {
      return null;
    }
    return new DefaultSupervisorAgentService({
      resolveRepoProfile: repoProfileService.resolve.bind(repoProfileService),
      resolveRepoUnderstanding: repoUnderstandingService?.understand.bind(repoUnderstandingService),
      resolveRepoSource: repoSourceResolver?.resolve.bind(repoSourceResolver),
      adviseWithReadOnlyClaude: readOnlyAdvisor.advise.bind(readOnlyAdvisor),
      hasActiveRepoConversation: readOnlyAdvisor.hasActiveConversation.bind(readOnlyAdvisor),
      clearRepoConversation: readOnlyAdvisor.clearConversation.bind(readOnlyAdvisor),
      getRepoConversationDiagnostics: readOnlyAdvisor.getDiagnostics.bind(readOnlyAdvisor),
      disposeRepoConversations: readOnlyAdvisor.dispose.bind(readOnlyAdvisor),
      analyze: async () => null,
    });
  }

  const url = normalizedProvider === 'anthropic'
    ? `${baseUrl.replace(/\/$/, '')}/messages`
    : `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  return new DefaultSupervisorAgentService({
    resolveRepoProfile: repoProfileService.resolve.bind(repoProfileService),
    resolveRepoUnderstanding: repoUnderstandingService?.understand.bind(repoUnderstandingService),
    resolveRepoSource: repoSourceResolver?.resolve.bind(repoSourceResolver),
    adviseWithReadOnlyClaude: readOnlyAdvisor?.advise.bind(readOnlyAdvisor),
    hasActiveRepoConversation: readOnlyAdvisor?.hasActiveConversation.bind(readOnlyAdvisor),
    clearRepoConversation: readOnlyAdvisor?.clearConversation.bind(readOnlyAdvisor),
    getRepoConversationDiagnostics: readOnlyAdvisor?.getDiagnostics.bind(readOnlyAdvisor),
    disposeRepoConversations: readOnlyAdvisor?.dispose.bind(readOnlyAdvisor),
    analyze: async (input) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: normalizedProvider === 'anthropic'
            ? {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              }
            : {
                'content-type': 'application/json',
                authorization: `Bearer ${apiKey}`,
              },
          body: JSON.stringify(
            normalizedProvider === 'anthropic'
              ? {
                  model,
                  max_tokens: 900,
                  messages: [{ role: 'user', content: input.prompt }],
                }
              : {
                  model,
                  temperature: 0,
                  max_tokens: 900,
                  messages: [{ role: 'user', content: input.prompt }],
                },
          ),
          signal: controller.signal,
        });

        if (!response.ok) {
          return null;
        }

        const payload = await response.json().catch(() => null);
        return normalizedProvider === 'anthropic'
          ? textFromAnthropic(payload)
          : textFromOpenAI(payload);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
