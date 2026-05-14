import type {
  SupervisorApprovalMode,
  SupervisorIntakeMode,
  SupervisorPlanCard,
  SupervisorSessionState,
} from '../database/types';
import type {
  SupervisorPlanBrain,
  SupervisorPlanBrainInput,
  SupervisorPlanBrainResult,
} from './sessionService';
import { readSymHarixEnv } from '../config/env';

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 300_000;

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  const normalized = normalize(value);
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeProvider(value: string | null | undefined): 'anthropic' | 'openai' | null {
  const normalized = normalize(value)?.toLowerCase();
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

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
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
  return null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function option(value: unknown): SupervisorPlanCard['recommended_option'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.label !== 'string' || typeof record.summary !== 'string') {
    return undefined;
  }
  return {
    label: record.label.trim(),
    summary: record.summary.trim(),
  };
}

function parsePlanBrainResult(record: Record<string, unknown>): SupervisorPlanBrainResult | null {
  const planCardRecord = record.planCard && typeof record.planCard === 'object'
    ? record.planCard as Record<string, unknown>
    : record.plan_card && typeof record.plan_card === 'object'
      ? record.plan_card as Record<string, unknown>
      : null;
  const planCard: Partial<SupervisorPlanCard> = {};
  if (planCardRecord) {
    if (typeof planCardRecord.title === 'string') planCard.title = planCardRecord.title;
    if (typeof planCardRecord.user_goal === 'string') planCard.user_goal = planCardRecord.user_goal;
    planCard.in_scope = stringArray(planCardRecord.in_scope) ?? planCard.in_scope;
    planCard.out_of_scope = stringArray(planCardRecord.out_of_scope) ?? planCard.out_of_scope;
    planCard.acceptance = stringArray(planCardRecord.acceptance) ?? planCard.acceptance;
    planCard.known_risks = stringArray(planCardRecord.known_risks) ?? planCard.known_risks;
    if (typeof planCardRecord.execution_strategy === 'string') {
      planCard.execution_strategy = planCardRecord.execution_strategy;
    }
    if (typeof planCardRecord.needs_user_approval === 'boolean') {
      planCard.needs_user_approval = planCardRecord.needs_user_approval;
    }
    if (typeof planCardRecord.clarification_question === 'string' || planCardRecord.clarification_question === null) {
      planCard.clarification_question = planCardRecord.clarification_question;
    }
    if (planCardRecord.materialization_mode === 'root_only' || planCardRecord.materialization_mode === 'root_with_split_queue') {
      planCard.materialization_mode = planCardRecord.materialization_mode;
    }
    const recommended = option(planCardRecord.recommended_option);
    if (recommended) planCard.recommended_option = recommended;
    const alternate = option(planCardRecord.alternate_option);
    if (alternate || planCardRecord.alternate_option === null) {
      planCard.alternate_option = alternate ?? null;
    }
  }

  const rawIntakeMode = record.intakeMode ?? record.intake_mode;
  const rawApprovalMode = record.approvalMode ?? record.approval_mode;
  const intakeMode = (
    rawIntakeMode === 'direct_run' ||
    rawIntakeMode === 'clarify_then_plan' ||
    rawIntakeMode === 'plan_then_approve'
  ) ? rawIntakeMode as SupervisorIntakeMode : null;
  const approvalMode = (
    rawApprovalMode === 'auto' ||
    rawApprovalMode === 'explicit_user_approval' ||
    rawApprovalMode === 'explicit_reapproval'
  ) ? rawApprovalMode as SupervisorApprovalMode : null;
  const state = (
    record.state === 'drafting' ||
    record.state === 'clarifying' ||
    record.state === 'plan_ready' ||
    record.state === 'awaiting_user_approval' ||
    record.state === 'approved_for_materialization' ||
    record.state === 'materialized' ||
    record.state === 'executing' ||
    record.state === 'awaiting_user_decision' ||
    record.state === 'completed' ||
    record.state === 'cancelled'
  ) ? record.state as SupervisorSessionState : null;

  if (!intakeMode && !approvalMode && !state && Object.keys(planCard).length === 0) {
    return null;
  }

  return {
    intakeMode,
    approvalMode,
    state,
    planCard: Object.keys(planCard).length > 0 ? planCard : null,
    rationale: typeof record.rationale === 'string' ? record.rationale : null,
  };
}

function buildPrompt(input: SupervisorPlanBrainInput): string {
  const englishOutput = input.session.supervisor_locale === 'en';
  return [
    'You are the planning brain for SymHarix Supervisor Plane.',
    'The user is talking in Telegram. Act like a careful senior engineer helping them turn a rough request into an executable plan.',
    englishOutput
      ? 'Return JSON only. The original user request is English, so write all user-facing planCard text in English.'
      : 'Return JSON only. The original user request contains Chinese, so write all user-facing planCard text in Chinese.',
    'Allowed JSON shape:',
    '{"intakeMode":"direct_run|clarify_then_plan|plan_then_approve","approvalMode":"auto|explicit_user_approval","state":"clarifying|plan_ready|awaiting_user_approval","rationale":"...","planCard":{"title":"...","user_goal":"...","in_scope":["..."],"out_of_scope":["..."],"acceptance":["..."],"known_risks":["..."],"execution_strategy":"...","needs_user_approval":true,"clarification_question":null,"materialization_mode":"root_only|root_with_split_queue","recommended_option":{"label":"...","summary":"..."},"alternate_option":{"label":"...","summary":"..."}}}',
    'Rules:',
    '- Small single-surface tasks may be auto approved only when acceptance is clear.',
    '- Cleanup/delete requests need explicit approval unless the user gave a narrow safe target.',
    '- Multi-objective or cross-surface requests should become root_with_split_queue.',
    '- Do not split simple lifecycle work. A focused cleanup/delete/reset request (including emptying one repository, deleting one folder, then testing/reviewing/delivering) stays root_only unless the user explicitly asks for child tasks, multi-agent work, or independent implementation deliverables.',
    '- If repo is unknown, ask one concrete repo clarification question.',
    '- Preserve the deterministic plan unless you can make it clearer, safer, or more user-aligned.',
    '',
    `draft: ${JSON.stringify(input.draft)}`,
    `deterministic_plan: ${JSON.stringify(input.deterministicPlan)}`,
    `repo_intelligence: ${JSON.stringify(input.repoIntelligence)}`,
    `governance_preview: ${JSON.stringify(input.governancePreview)}`,
    `recent_session_events: ${JSON.stringify(input.recentEvents.map((event) => ({
      kind: event.event_kind,
      payload: event.payload_json,
      created_at: event.created_at.toISOString(),
    })))}`,
    `runtime_focus: ${JSON.stringify(input.runtimeContext.focus_issue ?? null)}`,
    `available_projects: ${JSON.stringify(input.runtimeContext.available_projects)}`,
  ].join('\n');
}

export class HttpSupervisorPlanBrain implements SupervisorPlanBrain {
  private readonly provider: 'anthropic' | 'openai';
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    config: {
      provider: string;
      model: string;
      apiKey: string;
      baseUrl: string;
      timeoutMs?: number | null;
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const provider = normalizeProvider(config.provider);
    if (!provider) {
      throw new Error(`Unsupported supervisor LLM provider: ${config.provider}`);
    }
    this.provider = provider;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, config.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }

  async refinePlan(input: SupervisorPlanBrainInput): Promise<SupervisorPlanBrainResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const prompt = buildPrompt(input);
      const response = await this.fetchImpl(this.buildUrl(), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(prompt)),
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json().catch(() => null);
      const text = this.provider === 'anthropic'
        ? textFromAnthropic(payload)
        : textFromOpenAI(payload);
      const parsed = text ? extractJsonObject(text) : null;
      return parsed ? parsePlanBrainResult(parsed) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUrl(): string {
    return this.provider === 'anthropic'
      ? `${this.baseUrl}/messages`
      : `${this.baseUrl}/chat/completions`;
  }

  private buildHeaders(): Record<string, string> {
    return this.provider === 'anthropic'
      ? {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        }
      : {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        };
  }

  private buildBody(prompt: string): Record<string, unknown> {
    if (this.provider === 'anthropic') {
      return {
        model: this.model,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      };
    }
    return {
      model: this.model,
      temperature: 0,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    };
  }
}

export function createSupervisorPlanBrainFromEnv(fetchImpl: typeof fetch = fetch): SupervisorPlanBrain | null {
  const provider = normalize(readSymHarixEnv('SYMPHONY_SUPERVISOR_LLM_PROVIDER'))
    ?? normalize(readSymHarixEnv('SYMPHONY_BOT_LLM_PROVIDER'));
  const model = normalize(readSymHarixEnv('SYMPHONY_SUPERVISOR_LLM_MODEL'))
    ?? normalize(readSymHarixEnv('SYMPHONY_BOT_LLM_MODEL'));
  const apiKey = normalize(readSymHarixEnv('SYMPHONY_SUPERVISOR_LLM_API_KEY'))
    ?? normalize(readSymHarixEnv('SYMPHONY_BOT_LLM_API_KEY'));
  const normalizedProvider = normalizeProvider(provider);
  const baseUrl = normalize(readSymHarixEnv('SYMPHONY_SUPERVISOR_LLM_BASE_URL'))
    ?? normalize(readSymHarixEnv('SYMPHONY_BOT_LLM_BASE_URL'))
    ?? (normalizedProvider === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : normalizedProvider === 'openai'
        ? 'https://api.openai.com/v1'
        : null);

  if (!provider || !model || !apiKey || !baseUrl) {
    return null;
  }

  return new HttpSupervisorPlanBrain({
    provider,
    model,
    apiKey,
    baseUrl,
    timeoutMs: parsePositiveInteger(readSymHarixEnv('SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS'))
      ?? DEFAULT_TIMEOUT_MS,
  }, fetchImpl);
}
