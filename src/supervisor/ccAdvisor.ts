import type { RepoProfile } from './repoProfileService';

export interface SupervisorCcAdvisorInput {
  repoRef: string;
  localPath: string | null;
  userText: string;
  repoProfile: RepoProfile | null;
  projectContext: string | null;
}

export interface SupervisorCcAdvisorNormalizedInput extends SupervisorCcAdvisorInput {
  normalizedUserText: string;
  prompt: string;
}

export type SupervisorCcAdvisorResult =
  | {
      mode: 'repo_answer';
      answer: string;
      citations?: string[];
    }
  | {
      mode: 'issue_draft';
      title: string;
      body: string;
    }
  | {
      mode: 'clarify';
      question: string;
    };

export interface SupervisorCcAdvisor {
  advise(input: SupervisorCcAdvisorInput): Promise<SupervisorCcAdvisorResult | null>;
}

export type SupervisorCcAdvisorBackendResult =
  | string
  | Record<string, unknown>
  | null
  | undefined;

export type SupervisorCcAdvisorBackend = (
  input: SupervisorCcAdvisorNormalizedInput,
) => Promise<SupervisorCcAdvisorBackendResult>;

export interface DefaultSupervisorCcAdvisorOptions {
  analyze: SupervisorCcAdvisorBackend;
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

function buildPrompt(input: SupervisorCcAdvisorInput, normalizedUserText: string): string {
  return [
    'You are the top-level Supervisor Agent for Telegram chat.',
    'Be natural, helpful, and conversational first. You can chat normally, help the user think, answer repo questions, and draft work when useful.',
    'Allowed modes: repo_answer, issue_draft, clarify.',
    'Do not mutate the repository, create issues, or change session state.',
    'Use repo context when possible, but do not let issue/governance noise dominate ordinary conversation.',
    'If the user is just talking, advising, brainstorming, or asking for understanding, prefer a natural repo_answer over forcing issue_draft or clarify.',
    'If the user clearly wants work to be created, produce a polished issue_draft and assume the configured default project unless the request explicitly points elsewhere.',
    'When answering repo questions, prioritize what the repository appears to do, how it is structured, likely strengths/weaknesses, and concrete suggestions.',
    `repo_ref: ${input.repoRef}`,
    `local_path: ${input.localPath ?? 'null'}`,
    `project_context: ${input.projectContext ?? 'null'}`,
    `repo_profile: ${JSON.stringify(input.repoProfile)}`,
    `user_text: ${normalizedUserText}`,
    'Return JSON only.',
  ].join('\n');
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

function parseResult(value: SupervisorCcAdvisorBackendResult): SupervisorCcAdvisorResult | null {
  const record = typeof value === 'string'
    ? readJsonObject(value)
    : value && typeof value === 'object'
      ? value
      : null;

  if (!record) {
    return null;
  }

  if (record.mode === 'repo_answer') {
    const answer = nonBlankString(record.answer);
    if (!answer) {
      return null;
    }
    return {
      mode: 'repo_answer',
      answer,
      citations: toStringArray(record.citations),
    };
  }

  if (record.mode === 'issue_draft') {
    const title = nonBlankString(record.title);
    const body = nonBlankString(record.body);
    if (!title || !body) {
      return null;
    }
    return {
      mode: 'issue_draft',
      title,
      body,
    };
  }

  if (record.mode === 'clarify') {
    const question = nonBlankString(record.question);
    if (!question) {
      return null;
    }
    return {
      mode: 'clarify',
      question,
    };
  }

  return null;
}

export class DefaultSupervisorCcAdvisor implements SupervisorCcAdvisor {
  constructor(private readonly options: DefaultSupervisorCcAdvisorOptions) {}

  async advise(input: SupervisorCcAdvisorInput): Promise<SupervisorCcAdvisorResult | null> {
    const normalizedUserText = normalizeUserText(input.userText);
    if (!normalizedUserText) {
      return null;
    }

    const normalizedInput: SupervisorCcAdvisorNormalizedInput = {
      ...input,
      normalizedUserText,
      prompt: buildPrompt(input, normalizedUserText),
    };

    const rawResult = await this.options.analyze(normalizedInput);
    return parseResult(rawResult);
  }
}

export function createSupervisorCcAdvisorFromEnv(
  fetchImpl: typeof fetch = fetch,
): SupervisorCcAdvisor | null {
  const provider = normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_CC_PROVIDER)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_LLM_PROVIDER)
    ?? normalizeConfigValue(process.env.SYMPHONY_BOT_LLM_PROVIDER);
  const model = normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_CC_MODEL)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_LLM_MODEL)
    ?? normalizeConfigValue(process.env.SYMPHONY_BOT_LLM_MODEL);
  const apiKey = normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_CC_API_KEY)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_LLM_API_KEY)
    ?? normalizeConfigValue(process.env.SYMPHONY_BOT_LLM_API_KEY);
  const normalizedProvider = normalizeProvider(provider);
  const baseUrl = normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_CC_BASE_URL)
    ?? normalizeConfigValue(process.env.SYMPHONY_SUPERVISOR_LLM_BASE_URL)
    ?? normalizeConfigValue(process.env.SYMPHONY_BOT_LLM_BASE_URL)
    ?? (normalizedProvider === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : normalizedProvider === 'openai'
        ? 'https://api.openai.com/v1'
        : null);
  const timeoutMs = parsePositiveInteger(process.env.SYMPHONY_SUPERVISOR_CC_TIMEOUT_MS)
    ?? parsePositiveInteger(process.env.SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS)
    ?? parsePositiveInteger(process.env.SYMPHONY_BOT_LLM_TIMEOUT_MS)
    ?? 45_000;

  if (!normalizedProvider || !model || !apiKey || !baseUrl) {
    return null;
  }

  const url = normalizedProvider === 'anthropic'
    ? `${baseUrl.replace(/\/$/, '')}/messages`
    : `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  return new DefaultSupervisorCcAdvisor({
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
        const text = normalizedProvider === 'anthropic'
          ? textFromAnthropic(payload)
          : textFromOpenAI(payload);
        return text ?? null;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
