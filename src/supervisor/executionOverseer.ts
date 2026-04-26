import type { SupervisorPlanCard, SupervisorSessionRecord } from '../database/types';
import type { RuntimeIssueView } from '../runtime/types';
import type { SupervisorMilestone } from './types';

export type SupervisorOversightDecision = 'continue' | 'ask_user' | 'report' | 'complete';

export interface SupervisorOversightAssessment {
  decision: SupervisorOversightDecision;
  reason: string;
  dev_instruction: string | null;
  user_summary: string | null;
  active_decision_kind: 'delivery_failure' | 'scope_change' | 'governance_decision' | null;
  key: string;
  source?: 'deterministic' | 'llm';
  fallback_reason?: string | null;
}

export interface SupervisorExecutionOverseer {
  assess(input: {
    session: SupervisorSessionRecord;
    issue: RuntimeIssueView;
    milestone: SupervisorMilestone | null;
  }): SupervisorOversightAssessment | null | Promise<SupervisorOversightAssessment | null>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

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

function compact(value: string | null | undefined, maxLength = 220): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
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

function summarizePlan(planCard: SupervisorPlanCard | null): string {
  if (!planCard) {
    return '按当前计划推进。';
  }

  const acceptance = planCard.acceptance?.length
    ? `验收标准：${planCard.acceptance.join('；')}`
    : '验收标准：结果可验证。';
  const scope = planCard.in_scope?.length
    ? `范围：${planCard.in_scope.join('；')}`
    : `范围：${planCard.title}`;

  return `${scope}。${acceptance}。`;
}

function buildContinueInstruction(
  session: SupervisorSessionRecord,
  issue: RuntimeIssueView,
  milestone: SupervisorMilestone | null,
): string {
  const plan = summarizePlan(session.plan_card);
  const current = issue.governance_current_child
    ? `当前只推进子任务 ${issue.governance_current_child.issue_identifier}：${issue.governance_current_child.title}。`
    : `当前推进 ${issue.identifier}：${issue.title}。`;
  const milestoneSummary = compact(milestone?.summary ?? issue.delivery_summary ?? issue.next_recommended_action);

  return [
    current,
    plan,
    milestoneSummary ? `最新进展：${milestoneSummary}。` : null,
    '下一轮请像架构师复核一样先确认是否仍符合计划范围，再做最小可验证推进；如果发现范围漂移、误删风险或交付阻塞，不要静默吸收，明确停下来等待 supervisor/user 决策。',
  ].filter(Boolean).join('\n');
}

export class DefaultSupervisorExecutionOverseer implements SupervisorExecutionOverseer {
  assess(input: {
    session: SupervisorSessionRecord;
    issue: RuntimeIssueView;
    milestone: SupervisorMilestone | null;
  }): SupervisorOversightAssessment | null {
    const { session, issue, milestone } = input;
    if (!milestone) {
      return null;
    }

    const baseKey = [
      'oversight',
      session.id,
      session.plan_version,
      milestone.key,
    ].join('|');

    if (milestone.kind === 'completed') {
      return {
        decision: 'complete',
        reason: 'root_issue_completed',
        dev_instruction: null,
        user_summary: milestone.summary ?? '计划线程已完成。',
        active_decision_kind: null,
        key: baseKey,
        source: 'deterministic',
        fallback_reason: null,
      };
    }

    if (milestone.kind === 'cancelled') {
      return {
        decision: 'report',
        reason: 'root_issue_cancelled',
        dev_instruction: null,
        user_summary: milestone.summary ?? '计划线程已取消。',
        active_decision_kind: null,
        key: baseKey,
        source: 'deterministic',
        fallback_reason: null,
      };
    }

    if (
      milestone.kind === 'delivery_failed' ||
      milestone.kind === 'child_failed' ||
      milestone.kind === 'requires_user_decision'
    ) {
      const summary = compact(
        milestone.summary ??
        issue.delivery_summary ??
        issue.governance_summary ??
        '执行遇到需要人工判断的节点。',
        260,
      );
      return {
        decision: 'ask_user',
        reason: milestone.kind,
        dev_instruction: null,
        user_summary: summary || '执行遇到需要人工判断的节点。',
        active_decision_kind: milestone.kind === 'requires_user_decision'
          ? 'governance_decision'
          : 'delivery_failure',
        key: baseKey,
        source: 'deterministic',
        fallback_reason: null,
      };
    }

    return {
      decision: 'continue',
      reason: milestone.kind,
      dev_instruction: buildContinueInstruction(session, issue, milestone),
      user_summary: compact(milestone.summary ?? issue.next_recommended_action ?? '监督判断：继续推进当前计划。'),
      active_decision_kind: null,
      key: baseKey,
      source: 'deterministic',
      fallback_reason: null,
    };
  }
}

function parseDecision(value: unknown): SupervisorOversightDecision | null {
  return value === 'continue' ||
    value === 'ask_user' ||
    value === 'report' ||
    value === 'complete'
    ? value
    : null;
}

function parseDecisionKind(value: unknown): SupervisorOversightAssessment['active_decision_kind'] | undefined {
  if (value === null) {
    return null;
  }
  return value === 'delivery_failure' ||
    value === 'scope_change' ||
    value === 'governance_decision'
    ? value
    : undefined;
}

function parseModelAssessment(
  record: Record<string, unknown>,
  fallback: SupervisorOversightAssessment | null,
): Omit<SupervisorOversightAssessment, 'key'> | null {
  const decision = parseDecision(record.decision);
  if (!decision) {
    return null;
  }
  const reason = compact(typeof record.reason === 'string' ? record.reason : fallback?.reason, 120);
  if (!reason) {
    return null;
  }
  const activeDecisionKind = parseDecisionKind(record.active_decision_kind);
  if (activeDecisionKind === undefined) {
    return null;
  }
  const devInstruction = typeof record.dev_instruction === 'string'
    ? compact(record.dev_instruction, 1_600)
    : null;
  const userSummary = typeof record.user_summary === 'string'
    ? compact(record.user_summary, 500)
    : null;

  return {
    decision,
    reason,
    dev_instruction: decision === 'continue' ? devInstruction : null,
    user_summary: userSummary,
    active_decision_kind: decision === 'ask_user'
      ? activeDecisionKind ?? fallback?.active_decision_kind ?? 'delivery_failure'
      : null,
  };
}

function shouldGuardAgainstModelContinue(milestone: SupervisorMilestone | null): boolean {
  return milestone?.kind === 'delivery_failed' ||
    milestone?.kind === 'child_failed' ||
    milestone?.kind === 'requires_user_decision';
}

function buildOverseerPrompt(input: {
  session: SupervisorSessionRecord;
  issue: RuntimeIssueView;
  milestone: SupervisorMilestone;
  deterministic: SupervisorOversightAssessment | null;
}): string {
  const { session, issue, milestone, deterministic } = input;
  return [
    'You are the execution overseer for Symphony Supervisor Plane.',
    'Act like a senior architect supervising a dev agent, similar to how a human would guide Claude Code.',
    'You do not execute tools. You decide the next supervision move and produce one concise instruction for the dev agent when safe.',
    'Return JSON only. Prefer Chinese for user_summary; dev_instruction may be Chinese and should be concrete.',
    'Allowed JSON shape:',
    '{"decision":"continue|ask_user|report|complete","reason":"short_machine_reason","dev_instruction":"... or null","user_summary":"... or null","active_decision_kind":"delivery_failure|scope_change|governance_decision|null","confidence":0.0}',
    'Rules:',
    '- If the milestone indicates delivery_failed, child_failed, or requires_user_decision, do not choose continue unless the provided facts prove it is already recovered.',
    '- If continuing, give the dev agent a precise next move: what to inspect, what not to change, what proof to produce.',
    '- If scope drift, deletion risk, product ambiguity, or external delivery failure exists, choose ask_user.',
    '- Keep user_summary calm and high signal; do not mention internal boilerplate like missing constitution unless it materially blocks work.',
    '',
    `session: ${JSON.stringify({
      id: session.id,
      state: session.state,
      repo_ref: session.repo_ref,
      plan_version: session.plan_version,
      plan_card: session.plan_card,
      delivery_state: session.delivery_state,
      delivery_summary: session.delivery_summary,
      active_decision_kind: session.active_decision_kind,
      last_material_outcome: session.last_material_outcome,
    })}`,
    `issue: ${JSON.stringify({
      issue_id: issue.issue_id,
      identifier: issue.identifier,
      title: issue.title,
      phase: issue.phase,
      tracker_state: issue.tracker_state,
      orchestrator_state: issue.orchestrator_state,
      github_repo: issue.github_repo,
      branch_name: issue.branch_name,
      active_pr_number: issue.active_pr_number,
      governance_thread_state: issue.governance_thread_state,
      current_child: issue.governance_current_child,
      child_queue: issue.governance_child_queue,
      next_recommended_action: issue.next_recommended_action,
      delivery_state: issue.delivery_state,
      delivery_code: issue.delivery_code,
      delivery_summary: issue.delivery_summary,
    })}`,
    `milestone: ${JSON.stringify(milestone)}`,
    `deterministic_fallback: ${JSON.stringify(deterministic)}`,
  ].join('\n');
}

export class HttpSupervisorExecutionOverseer implements SupervisorExecutionOverseer {
  private readonly provider: 'anthropic' | 'openai';
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fallback = new DefaultSupervisorExecutionOverseer();

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
      throw new Error(`Unsupported supervisor overseer provider: ${config.provider}`);
    }
    this.provider = provider;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeoutMs = Math.max(1_000, Math.min(120_000, config.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }

  async assess(input: {
    session: SupervisorSessionRecord;
    issue: RuntimeIssueView;
    milestone: SupervisorMilestone | null;
  }): Promise<SupervisorOversightAssessment | null> {
    const deterministic = this.fallback.assess(input) as SupervisorOversightAssessment | null;
    if (!input.milestone) {
      return deterministic;
    }

    try {
      const prompt = buildOverseerPrompt({
        session: input.session,
        issue: input.issue,
        milestone: input.milestone,
        deterministic,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.buildUrl(), {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(this.buildBody(prompt)),
          signal: controller.signal,
        });
        if (!response.ok) {
          return this.withFallbackKey(deterministic, 'http_error');
        }
        const payload = await response.json().catch(() => null);
        const text = this.provider === 'anthropic'
          ? textFromAnthropic(payload)
          : textFromOpenAI(payload);
        const parsed = text ? extractJsonObject(text) : null;
        const modelAssessment = parsed ? parseModelAssessment(parsed, deterministic) : null;
        if (!modelAssessment) {
          return this.withFallbackKey(deterministic, 'invalid_model_output');
        }
        if (
          shouldGuardAgainstModelContinue(input.milestone) &&
          modelAssessment.decision === 'continue' &&
          deterministic?.decision === 'ask_user'
        ) {
          return {
            ...deterministic,
            key: `${deterministic.key}|guarded:model_continue`,
            source: 'deterministic',
            fallback_reason: 'guarded_model_continue',
          };
        }
        return {
          ...modelAssessment,
          key: `${deterministic?.key ?? [
            'oversight',
            input.session.id,
            input.session.plan_version,
            input.milestone.key,
          ].join('|')}|llm:${this.model}`,
          source: 'llm',
          fallback_reason: null,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return this.withFallbackKey(deterministic, 'exception');
    }
  }

  private withFallbackKey(
    assessment: SupervisorOversightAssessment | null,
    reason: string,
  ): SupervisorOversightAssessment | null {
    return assessment
      ? {
          ...assessment,
          key: `${assessment.key}|fallback:${reason}`,
          source: 'deterministic',
          fallback_reason: reason,
        }
      : null;
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
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      };
    }
    return {
      model: this.model,
      temperature: 0,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    };
  }
}

export function createSupervisorExecutionOverseerFromEnv(
  fetchImpl: typeof fetch = fetch,
): SupervisorExecutionOverseer {
  const provider = normalize(process.env.SYMPHONY_SUPERVISOR_OVERSEER_PROVIDER)
    ?? normalize(process.env.SYMPHONY_SUPERVISOR_LLM_PROVIDER)
    ?? normalize(process.env.SYMPHONY_BOT_LLM_PROVIDER);
  const model = normalize(process.env.SYMPHONY_SUPERVISOR_OVERSEER_MODEL)
    ?? normalize(process.env.SYMPHONY_SUPERVISOR_LLM_MODEL)
    ?? normalize(process.env.SYMPHONY_BOT_LLM_MODEL);
  const apiKey = normalize(process.env.SYMPHONY_SUPERVISOR_OVERSEER_API_KEY)
    ?? normalize(process.env.SYMPHONY_SUPERVISOR_LLM_API_KEY)
    ?? normalize(process.env.SYMPHONY_BOT_LLM_API_KEY);
  const normalizedProvider = normalizeProvider(provider);
  const baseUrl = normalize(process.env.SYMPHONY_SUPERVISOR_OVERSEER_BASE_URL)
    ?? normalize(process.env.SYMPHONY_SUPERVISOR_LLM_BASE_URL)
    ?? normalize(process.env.SYMPHONY_BOT_LLM_BASE_URL)
    ?? (normalizedProvider === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : normalizedProvider === 'openai'
        ? 'https://api.openai.com/v1'
        : null);

  if (!provider || !model || !apiKey || !baseUrl) {
    return new DefaultSupervisorExecutionOverseer();
  }

  return new HttpSupervisorExecutionOverseer({
    provider,
    model,
    apiKey,
    baseUrl,
    timeoutMs: parsePositiveInteger(process.env.SYMPHONY_SUPERVISOR_OVERSEER_TIMEOUT_MS)
      ?? parsePositiveInteger(process.env.SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS)
      ?? DEFAULT_TIMEOUT_MS,
  }, fetchImpl);
}
