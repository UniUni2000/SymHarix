import type {
  BotAssistantDiagnostics,
  BotAssistantModelOutput,
  BotRuntimeCopilotContext,
} from './types';
import { spawn } from 'node:child_process';

export interface BotAssistantModelRequest {
  text: string;
  context: BotRuntimeCopilotContext;
}

export interface BotAssistantModel {
  decide(params: BotAssistantModelRequest): Promise<BotAssistantModelOutput>;
  getDiagnostics?(): BotAssistantDiagnostics;
}

export interface BotAssistantModelConfig {
  provider?: string | null;
  model?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  timeoutMs?: number;
}

export interface BotAssistantHttpTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface BotAssistantHttpTransportResponse {
  status: number;
  payload: unknown;
}

export interface BotAssistantHttpTransport {
  send(request: BotAssistantHttpTransportRequest): Promise<BotAssistantHttpTransportResponse>;
}

export interface BotAssistantModelOptions {
  primaryTransport?: BotAssistantHttpTransport;
  fallbackTransport?: BotAssistantHttpTransport | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function normalizeConfigValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function parsePositiveInteger(value: string | null | undefined): number | undefined {
  const normalized = normalizeConfigValue(value);
  if (!normalized) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

function buildDiagnostics(
  overrides: Partial<BotAssistantDiagnostics> = {},
): BotAssistantDiagnostics {
  const diagnostics: BotAssistantDiagnostics = {
    provider: null,
    model: null,
    configured: false,
    health: 'unconfigured',
    fallback_available: true,
    last_error_code: 'unconfigured',
    ...overrides,
  };

  if (diagnostics.last_error_message == null) {
    delete diagnostics.last_error_message;
  }

  return diagnostics;
}

function buildPromptText(params: BotAssistantModelRequest): string {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const currentLocalDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const currentLocalTime = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');

  return [
    'You are Symphony Runtime Operator Copilot.',
    'Return JSON only.',
    'You can either choose an action intent or answer a runtime/control-plane question.',
    'Allowed JSON shapes:',
    '{"intent":{"kind":"create_issue","title":"...","description":"...","project_slug":"..."}}',
    '{"intent":{"kind":"status","issue_id":"INT-31"}}',
    '{"intent":{"kind":"watch","issue_id":"INT-31","watch_preset":"default"}}',
    '{"intent":{"kind":"unwatch","issue_id":"INT-31"}}',
    '{"intent":{"kind":"stop","issue_id":"INT-31"}}',
    '{"intent":{"kind":"retry","issue_id":"INT-31"}}',
    '{"intent":{"kind":"override","issue_id":"INT-31"}}',
    '{"intent":{"kind":"rewrite","issue_id":"INT-31"}}',
    '{"intent":{"kind":"split","issue_id":"INT-31"}}',
    '{"intent":{"kind":"execute_governance_suggestion","issue_id":"INT-31","suggestion_id":"suggestion-1","suggestion_type":null,"ordinal":null}}',
    '{"intent":{"kind":"dismiss_governance_suggestion","issue_id":"INT-31","suggestion_id":null,"suggestion_type":"cleanup","ordinal":null}}',
    '{"intent":{"kind":"set_default_project","project_slug":"test2"}}',
    '{"intent":{"kind":"set_default_project","project_slug":null}}',
    '{"intent":{"kind":"show_default_project"}}',
    '{"intent":{"kind":"help"}}',
    '{"intent":{"kind":"answer_question","answer":"..."}}',
    '{"intent":{"kind":"clarify","question":"..."}}',
    'Rules:',
    '- Ground every answer strictly in runtime context below.',
    '- Do not invent project slugs, repo names, issue ids, states, PR numbers, or failures.',
    '- For write/control actions, identify the action only. The caller will ask for confirmation.',
    '- For read questions, prefer answer_question with a concise grounded answer.',
    '- If the user message is just a greeting or pleasantry like 你好/hello/hi, return answer_question with a brief greeting plus a one-line description of what Symphony can help with.',
    '- If the user asks about today\'s date or the current time, use current_local_date/current_local_time/current_local_timezone below instead of guessing.',
    '- Scope is limited to Symphony runtime, issue creation/control, repository routing, and usage help.',
    `current_local_date: ${currentLocalDate}`,
    `current_local_time: ${currentLocalTime}`,
    `current_local_timezone: ${timezone}`,
    `runtime_context: ${JSON.stringify(params.context)}`,
    `user_text: ${JSON.stringify(params.text)}`,
  ].join('\n');
}

function classifyHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return 'auth_error';
  }
  if (status === 404) {
    return 'model_not_found';
  }
  if (status >= 500) {
    return 'provider_unavailable';
  }
  return 'provider_error';
}

function classifyThrownError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'timeout', message };
  }
  if (/timeout/i.test(message)) {
    return { code: 'timeout', message };
  }
  return { code: 'provider_unavailable', message };
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'AbortError' || /timeout/i.test(error.message);
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, any>;
  const nestedError = record.error;
  if (nestedError && typeof nestedError === 'object') {
    const nestedMessage = nestedError.message || nestedError.type;
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
  }

  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message.trim();
  }

  return null;
}

function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      message: trimmed,
    };
  }
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function shouldRetryWithFallback(status: number): boolean {
  return status === 405 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function joinAnthropicContent(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const text = value
    .filter(
      (block): block is { type?: string; text?: string } =>
        Boolean(block) &&
        typeof block === 'object' &&
        (!('type' in (block as Record<string, unknown>)) || (block as { type?: unknown }).type === 'text') &&
        'text' in (block as Record<string, unknown>) &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text?.trim() || '')
    .filter(Boolean)
    .join('\n');

  return text || null;
}

function joinOpenAIContent(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const text = value
    .filter(
      (block): block is { type?: string; text?: string } =>
        Boolean(block) &&
        typeof block === 'object' &&
        (!('type' in (block as Record<string, unknown>)) || (block as { type?: unknown }).type === 'text') &&
        'text' in (block as Record<string, unknown>) &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text?.trim() || '')
    .filter(Boolean)
    .join('\n');

  return text || null;
}

class FetchBotAssistantHttpTransport implements BotAssistantHttpTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(request: BotAssistantHttpTransportRequest): Promise<BotAssistantHttpTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      const rawBody = await response.text();
      return {
        status: response.status,
        payload: parseJsonPayload(rawBody),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

class CurlBotAssistantHttpTransport implements BotAssistantHttpTransport {
  async send(request: BotAssistantHttpTransportRequest): Promise<BotAssistantHttpTransportResponse> {
    const args = [
      '-sS',
      '-X',
      'POST',
      request.url,
      '--max-time',
      String(Math.max(1, Math.ceil(request.timeoutMs / 1000))),
      '--connect-timeout',
      String(Math.max(1, Math.ceil(Math.min(request.timeoutMs, 10_000) / 1000))),
      '--data-binary',
      '@-',
      '-w',
      '\n__HTTP_STATUS__:%{http_code}',
    ];

    for (const [key, value] of Object.entries(request.headers)) {
      args.push('-H', `${key}: ${value}`);
    }

    return new Promise((resolve, reject) => {
      const child = spawn('curl', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        reject(error);
      });
      child.on('close', (code) => {
        const marker = '\n__HTTP_STATUS__:';
        const markerIndex = stdout.lastIndexOf(marker);

        if (markerIndex === -1) {
          reject(new Error(stderr.trim() || `curl transport failed with code ${code ?? 'unknown'}`));
          return;
        }

        const rawBody = stdout.slice(0, markerIndex);
        const rawStatus = stdout.slice(markerIndex + marker.length).trim();
        const status = Number(rawStatus);

        if (!Number.isFinite(status) || status <= 0) {
          reject(new Error(stderr.trim() || `curl transport returned an invalid HTTP status: ${rawStatus}`));
          return;
        }

        if (code && code !== 0 && !rawBody.trim()) {
          reject(new Error(stderr.trim() || `curl transport failed with code ${code}`));
          return;
        }

        resolve({
          status,
          payload: parseJsonPayload(rawBody),
        });
      });

      child.stdin.on('error', () => undefined);
      child.stdin.end(request.body);
    });
  }
}

class FallbackBotAssistantHttpTransport implements BotAssistantHttpTransport {
  constructor(
    private readonly primary: BotAssistantHttpTransport,
    private readonly fallback: BotAssistantHttpTransport | null,
  ) {}

  async send(request: BotAssistantHttpTransportRequest): Promise<BotAssistantHttpTransportResponse> {
    try {
      const primaryResponse = await this.primary.send(request);
      if (this.fallback && shouldRetryWithFallback(primaryResponse.status)) {
        return this.fallback.send(request);
      }
      return primaryResponse;
    } catch (error) {
      if (!this.fallback || isTimeoutError(error)) {
        throw error;
      }
      return this.fallback.send(request);
    }
  }
}

abstract class BaseHttpBotAssistantModel implements BotAssistantModel {
  protected diagnostics: BotAssistantDiagnostics;
  protected readonly model: string;
  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;

  constructor(
    protected readonly provider: 'anthropic' | 'openai',
    config: Required<Pick<BotAssistantModelConfig, 'model' | 'apiKey' | 'baseUrl'>> & Pick<BotAssistantModelConfig, 'timeoutMs'>,
    protected readonly transport: BotAssistantHttpTransport,
  ) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    this.diagnostics = buildDiagnostics({
      provider: this.provider,
      model: this.model,
      configured: true,
      health: 'degraded',
      last_error_code: null,
    });
  }

  getDiagnostics(): BotAssistantDiagnostics {
    return { ...this.diagnostics };
  }

  async decide(params: BotAssistantModelRequest): Promise<BotAssistantModelOutput> {
    const prompt = buildPromptText(params);

    try {
      const response = await this.transport.send({
        url: this.buildUrl(),
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildRequestBody(prompt)),
        timeoutMs: this.timeoutMs,
      });

      if (!isSuccessfulStatus(response.status)) {
        const code = classifyHttpError(response.status);
        const message = extractErrorMessage(response.payload)
          || `${this.provider} request failed with status ${response.status}`;
        this.diagnostics = buildDiagnostics({
          provider: this.provider,
          model: this.model,
          configured: true,
          health: 'degraded',
          last_error_code: code,
          last_error_message: message,
        });
        return null;
      }

      const text = this.extractResponseText(response.payload);
      if (!text) {
        this.diagnostics = buildDiagnostics({
          provider: this.provider,
          model: this.model,
          configured: true,
          health: 'degraded',
          last_error_code: 'unparseable_response',
          last_error_message: 'The bot LLM response could not be parsed into text.',
        });
        return null;
      }

      this.diagnostics = buildDiagnostics({
        provider: this.provider,
        model: this.model,
        configured: true,
        health: 'healthy',
        last_error_code: null,
      });
      return text;
    } catch (error) {
      const classified = classifyThrownError(error);
      this.diagnostics = buildDiagnostics({
        provider: this.provider,
        model: this.model,
        configured: true,
        health: 'degraded',
        last_error_code: classified.code,
        last_error_message: classified.message,
      });
      return null;
    }
  }

  protected abstract buildUrl(): string;
  protected abstract buildHeaders(): Record<string, string>;
  protected abstract buildRequestBody(prompt: string): Record<string, unknown>;
  protected abstract extractResponseText(payload: unknown): string | null;
}

class AnthropicBotAssistantModel extends BaseHttpBotAssistantModel {
  protected buildUrl(): string {
    return `${this.baseUrl}/messages`;
  }

  protected buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  protected buildRequestBody(prompt: string): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: 700,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };
  }

  protected extractResponseText(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    return joinAnthropicContent((payload as Record<string, unknown>).content);
  }
}

class OpenAICompatibleBotAssistantModel extends BaseHttpBotAssistantModel {
  protected buildUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  protected buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  protected buildRequestBody(prompt: string): Record<string, unknown> {
    return {
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };
  }

  protected extractResponseText(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const choices = (payload as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return null;
    }

    const message = choices[0] && typeof choices[0] === 'object'
      ? (choices[0] as Record<string, unknown>).message
      : null;
    if (!message || typeof message !== 'object') {
      return null;
    }

    return joinOpenAIContent((message as Record<string, unknown>).content);
  }
}

class UnconfiguredBotAssistantModel implements BotAssistantModel {
  private readonly diagnostics: BotAssistantDiagnostics;

  constructor(reason = 'unconfigured') {
    this.diagnostics = buildDiagnostics({
      last_error_code: reason,
    });
  }

  async decide(): Promise<BotAssistantModelOutput> {
    return null;
  }

  getDiagnostics(): BotAssistantDiagnostics {
    return { ...this.diagnostics };
  }
}

export function createBotAssistantModel(
  config: BotAssistantModelConfig,
  fetchImpl: typeof fetch = fetch,
  options: BotAssistantModelOptions = {},
): BotAssistantModel {
  const provider = normalizeProvider(config.provider);
  const model = normalizeConfigValue(config.model);
  const apiKey = normalizeConfigValue(config.apiKey);
  const baseUrl = normalizeConfigValue(config.baseUrl)
    || (provider === 'anthropic' ? 'https://api.anthropic.com/v1' : provider === 'openai' ? 'https://api.openai.com/v1' : null);

  if (!provider || !model || !apiKey || !baseUrl) {
    return new UnconfiguredBotAssistantModel('unconfigured');
  }

  const fetchTransport = new FetchBotAssistantHttpTransport(fetchImpl);
  const primaryTransport = options.primaryTransport ?? new CurlBotAssistantHttpTransport();
  const fallbackTransport = options.fallbackTransport === undefined
    ? fetchTransport
    : options.fallbackTransport;
  const transport = new FallbackBotAssistantHttpTransport(
    primaryTransport,
    fallbackTransport,
  );

  if (provider === 'anthropic') {
    return new AnthropicBotAssistantModel(provider, {
      model,
      apiKey,
      baseUrl,
      timeoutMs: config.timeoutMs,
    }, transport);
  }

  return new OpenAICompatibleBotAssistantModel(provider, {
    model,
    apiKey,
    baseUrl,
    timeoutMs: config.timeoutMs,
  }, transport);
}

export function createBotAssistantModelFromEnv(fetchImpl: typeof fetch = fetch): BotAssistantModel {
  const transportMode = normalizeConfigValue(process.env.SYMPHONY_BOT_LLM_HTTP_TRANSPORT)?.toLowerCase() ?? 'fetch';
  const fetchTransport = new FetchBotAssistantHttpTransport(fetchImpl);
  const curlTransport = new CurlBotAssistantHttpTransport();
  const transportOptions: BotAssistantModelOptions =
    transportMode === 'auto' || transportMode === 'curl_fetch_fallback'
      ? { primaryTransport: curlTransport, fallbackTransport: fetchTransport }
      : transportMode === 'curl'
        ? { primaryTransport: curlTransport, fallbackTransport: null }
        : { primaryTransport: fetchTransport, fallbackTransport: null };

  return createBotAssistantModel({
    provider: process.env.SYMPHONY_BOT_LLM_PROVIDER ?? null,
    model: process.env.SYMPHONY_BOT_LLM_MODEL ?? null,
    apiKey: process.env.SYMPHONY_BOT_LLM_API_KEY ?? null,
    baseUrl: process.env.SYMPHONY_BOT_LLM_BASE_URL ?? null,
    timeoutMs: parsePositiveInteger(process.env.SYMPHONY_BOT_LLM_TIMEOUT_MS),
  }, fetchImpl, transportOptions);
}
