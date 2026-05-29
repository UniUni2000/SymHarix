import {
  BotMessageEditError,
  type BotMessageEditFailureKind,
  type BotRecipient,
  type BotTransportAction,
  type BotTransportMessage,
  type BotTransportMessageRef,
  type BotTransportNotifier,
} from './types';

export interface FeishuAdapterConfig {
  appId: string | null;
  appSecret: string | null;
  operationsChatId: string | null;
  operatorIds: Set<string>;
  apiBaseUrl: string;
  publicBaseUrl: string | null;
  runtimeOpenMode?: 'url' | 'applink_web_app' | 'applink_web_url' | null;
  runtimeAppLinkMode?: string | null;
  runtimeAppLinkWidth?: number | null;
  runtimeAppLinkHeight?: number | null;
  runtimeAppLinkTemplate?: string | null;
}

export interface FeishuLongConnectionHandlers {
  onMessageEvent(event: Record<string, unknown>): Promise<void> | void;
  onCardActionEvent(event: Record<string, unknown>): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
}

export interface FeishuLongConnectionClient {
  start(handlers: FeishuLongConnectionHandlers): Promise<void>;
  dispose(): Promise<void> | void;
}

export type FeishuLongConnectionFactory = (config: FeishuAdapterConfig) => FeishuLongConnectionClient;

interface FeishuAccessTokenPayload {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuApiPayload<T = unknown> {
  code?: number;
  msg?: string;
  data?: T;
}

interface FeishuSendMessageData {
  message_id?: string;
}

interface FeishuUploadImageData {
  image_key?: string;
}

interface FeishuMessagePayload {
  msg_type: 'text' | 'interactive';
  content: string;
}

const DEFAULT_FEISHU_API_BASE_URL = 'https://open.feishu.cn/open-apis';
const FEISHU_NODE_SDK_MODULE = '@larksuiteoapi/node-sdk';

export function normalizeFeishuApiBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_FEISHU_API_BASE_URL;
  }
  return trimmed.replace(/\/+$/, '');
}

function compactText(value: string | null | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeHtmlEntity(entity: string): string {
  switch (entity) {
    case '&amp;':
      return '&';
    case '&lt;':
      return '<';
    case '&gt;':
      return '>';
    case '&quot;':
      return '"';
    case '&#39;':
      return "'";
    default:
      return entity;
  }
}

function telegramHtmlToPlainText(value: string): string {
  return compactText(value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|li|ul|ol|blockquote|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, decodeHtmlEntity));
}

function feishuText(message: Pick<BotTransportMessage, 'text' | 'caption' | 'format'>): string {
  const raw = message.caption ?? message.text;
  return message.format === 'telegram_html' ? telegramHtmlToPlainText(raw) : compactText(raw);
}

function runtimeWebAppFallbackCallbackData(url: string): string | null {
  const match = url.trim().match(/^\/runtime\/issues\/([^/?#]+)\/app(?:[?#].*)?$/i);
  if (!match?.[1]) {
    return null;
  }
  let issueIdentifier = match[1];
  try {
    issueIdentifier = decodeURIComponent(issueIdentifier);
  } catch {
    return null;
  }
  if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(issueIdentifier)) {
    return null;
  }
  return `rt|${issueIdentifier.toUpperCase()}|open`;
}

function resolveFeishuActionUrl(url: string, publicBaseUrl: string | null): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/') && publicBaseUrl) {
    return `${publicBaseUrl}${trimmed}`;
  }
  return null;
}

function runtimeAppPath(rawUrl: string, absoluteUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  try {
    const parsed = new URL(absoluteUrl);
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
  } catch {
    return '/';
  }
}

function appendFeishuAppLinkWindowParams(
  params: URLSearchParams,
  config: Pick<FeishuAdapterConfig, 'runtimeAppLinkMode' | 'runtimeAppLinkWidth' | 'runtimeAppLinkHeight'>,
): void {
  const mode = config.runtimeAppLinkMode?.trim() || 'window';
  params.set('mode', mode);
  if (config.runtimeAppLinkWidth && config.runtimeAppLinkWidth > 0) {
    params.set('width', String(config.runtimeAppLinkWidth));
  }
  if (config.runtimeAppLinkHeight && config.runtimeAppLinkHeight > 0) {
    params.set('height', String(config.runtimeAppLinkHeight));
  }
}

function applyFeishuAppLinkTemplate(params: {
  template: string;
  appId: string | null;
  rawUrl: string;
  absoluteUrl: string;
  path: string;
}): string {
  const values: Record<string, string> = {
    appId: params.appId ?? '',
    url: params.absoluteUrl,
    rawUrl: params.rawUrl,
    path: params.path,
    encodedUrl: encodeURIComponent(params.absoluteUrl),
    encodedRawUrl: encodeURIComponent(params.rawUrl),
    encodedPath: encodeURIComponent(params.path),
  };
  return params.template.replace(/\{(appId|url|rawUrl|path|encodedUrl|encodedRawUrl|encodedPath)\}/g, (_, key: string) => values[key] ?? '');
}

function feishuRuntimeOpenUrl(
  rawUrl: string,
  absoluteUrl: string,
  config: Pick<
    FeishuAdapterConfig,
    'appId' | 'runtimeOpenMode' | 'runtimeAppLinkMode' | 'runtimeAppLinkWidth' | 'runtimeAppLinkHeight' | 'runtimeAppLinkTemplate'
  >,
): string {
  const mode = config.runtimeOpenMode ?? 'applink_web_url';
  if (mode === 'url') {
    return absoluteUrl;
  }

  const path = runtimeAppPath(rawUrl, absoluteUrl);
  const template = config.runtimeAppLinkTemplate?.trim();
  if (template) {
    return applyFeishuAppLinkTemplate({
      template,
      appId: config.appId,
      rawUrl,
      absoluteUrl,
      path,
    });
  }

  if (mode === 'applink_web_app' && config.appId) {
    const params = new URLSearchParams({
      appId: config.appId,
      path,
    });
    appendFeishuAppLinkWindowParams(params, config);
    return `https://applink.feishu.cn/client/web_app/open?${params.toString()}`;
  }

  if (mode === 'applink_web_url') {
    const params = new URLSearchParams({
      url: absoluteUrl,
    });
    appendFeishuAppLinkWindowParams(params, config);
    return `https://applink.feishu.cn/client/web_url/open?${params.toString()}`;
  }

  return absoluteUrl;
}

function feishuButtonType(style: BotTransportAction['style']): 'default' | 'primary' | 'danger' {
  if (style === 'primary' || style === 'success') {
    return 'primary';
  }
  if (style === 'danger') {
    return 'danger';
  }
  return 'default';
}

function escapeFeishuMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function feishuStatusColor(style: BotTransportAction['style']): string {
  if (style === 'success') {
    return 'green';
  }
  if (style === 'danger') {
    return 'red';
  }
  if (style === 'primary') {
    return 'blue';
  }
  return 'grey';
}

function buildFeishuCardStatus(action: BotTransportAction): Record<string, unknown> {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `<font color="${feishuStatusColor(action.style)}">**${escapeFeishuMarkdown(action.label)}**</font>`,
    },
  };
}

function buildFeishuCardAction(
  action: BotTransportAction,
  config: Pick<
    FeishuAdapterConfig,
    'appId' | 'publicBaseUrl' | 'runtimeOpenMode' | 'runtimeAppLinkMode' | 'runtimeAppLinkWidth' | 'runtimeAppLinkHeight' | 'runtimeAppLinkTemplate'
  >,
): Record<string, unknown> | null {
  if (action.disabled) {
    return null;
  }

  const button: Record<string, unknown> = {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: action.label,
    },
    type: feishuButtonType(action.style),
  };

  if (action.callback_data) {
    button.value = { callback_data: action.callback_data };
    return button;
  }

  const rawUrl = action.web_app?.url ?? action.url ?? null;
  if (!rawUrl) {
    return null;
  }

  const url = resolveFeishuActionUrl(rawUrl, config.publicBaseUrl);
  if (url) {
    button.url = action.web_app?.url
      ? feishuRuntimeOpenUrl(rawUrl, url, config)
      : url;
    return button;
  }

  const fallbackCallbackData = runtimeWebAppFallbackCallbackData(rawUrl);
  if (fallbackCallbackData) {
    button.value = { callback_data: fallbackCallbackData };
    return button;
  }

  return null;
}

function buildFeishuCard(params: {
  message: BotTransportMessage;
  imageKey?: string | null;
  config: FeishuAdapterConfig;
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  const content = feishuText(params.message);
  const imageElement = params.imageKey
    ? {
        tag: 'img',
        img_key: params.imageKey,
        alt: {
          tag: 'plain_text',
          content: params.message.photo?.filename || 'SymHarix card',
        },
      }
    : null;

  if (imageElement && params.message.show_caption_above_media === false) {
    elements.push(imageElement);
  }
  if (content) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content,
      },
    });
  }
  if (imageElement && params.message.show_caption_above_media !== false) {
    elements.push(imageElement);
  }

  const rows = params.message.action_rows
    ?? (params.message.actions?.length ? params.message.actions.map((action) => [action]) : []);
  for (const row of rows) {
    const statusItems = row
      .filter((action) => action.disabled)
      .map((action) => buildFeishuCardStatus(action));
    elements.push(...statusItems);

    const actions = row
      .map((action) => buildFeishuCardAction(action, params.config))
      .filter((action): action is Record<string, unknown> => action !== null);
    if (actions.length > 0) {
      elements.push({
        tag: 'action',
        actions,
      });
    }
  }

  if (elements.length === 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: ' ',
      },
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
      enable_forward: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: 'SymHarix',
      },
    },
    elements,
  };
}

function classifyFeishuEditFailure(code: number | null, message: string | null): BotMessageEditFailureKind {
  const normalized = (message ?? '').toLowerCase();
  if (/not modified|same content|no change|not change/.test(normalized)) {
    return 'not_modified';
  }
  if (code === 230030 || /message.*not.*found|invalid.*message|record not found/.test(normalized)) {
    return 'message_not_found';
  }
  return 'hard_failure';
}

export class FeishuNotifier implements BotTransportNotifier {
  private tenantToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: FeishuAdapterConfig,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async sendMessage(recipient: BotRecipient, message: BotTransportMessage): Promise<BotTransportMessageRef> {
    const payload = await this.buildMessagePayload(message);
    const response = await this.callFeishu<FeishuSendMessageData>(
      `/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        body: JSON.stringify({
          receive_id: recipient.conversation_id,
          msg_type: payload.msg_type,
          content: payload.content,
        }),
      },
    );

    return {
      provider_message_id: String(response.message_id ?? ''),
    };
  }

  async editMessage(
    _recipient: BotRecipient,
    messageRef: BotTransportMessageRef,
    message: BotTransportMessage,
  ): Promise<BotTransportMessageRef> {
    const payload = await this.buildMessagePayload(message);
    const isInteractiveCard = payload.msg_type === 'interactive';
    try {
      await this.callFeishu(
        `/im/v1/messages/${encodeURIComponent(messageRef.provider_message_id)}`,
        {
          method: isInteractiveCard ? 'PATCH' : 'PUT',
          body: JSON.stringify(isInteractiveCard
            ? { content: payload.content }
            : {
                msg_type: payload.msg_type,
                content: payload.content,
              }),
        },
      );
      return messageRef;
    } catch (error) {
      if (error instanceof FeishuApiError) {
        throw new BotMessageEditError(
          classifyFeishuEditFailure(error.code, error.message),
          `Feishu editMessage failed with code ${error.code ?? 'unknown'}: ${error.message}`,
          null,
          error.message,
        );
      }
      throw error;
    }
  }

  private async buildMessagePayload(message: BotTransportMessage): Promise<FeishuMessagePayload> {
    const shouldUseCard = Boolean(
      message.force_card ||
      message.photo ||
      message.caption ||
      message.actions?.length ||
      message.action_rows?.length,
    );
    if (!shouldUseCard) {
      return {
        msg_type: 'text',
        content: JSON.stringify({ text: feishuText(message) }),
      };
    }

    const imageKey = message.photo?.bytes
      ? await this.uploadImage(message.photo.bytes, message.photo.content_type, message.photo.filename)
      : null;
    return {
      msg_type: 'interactive',
      content: JSON.stringify(buildFeishuCard({
        message,
        imageKey,
        config: this.config,
      })),
    };
  }

  private async uploadImage(bytes: Uint8Array, contentType?: string | null, filename?: string | null): Promise<string> {
    const form = new FormData();
    form.set('image_type', 'message');
    form.set(
      'image',
      new Blob([bytes], { type: contentType || 'image/png' }),
      filename || 'symharix-card.png',
    );

    const response = await this.callFeishu<FeishuUploadImageData>('/im/v1/images', {
      method: 'POST',
      body: form,
    });
    if (!response.image_key) {
      throw new Error('Feishu image upload response did not include image_key');
    }
    return response.image_key;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt - Date.now() > 60_000) {
      return this.tenantToken.value;
    }
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Feishu app id/secret are not configured');
    }

    const response = await this.fetcher(`${this.config.apiBaseUrl}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });
    if (!response.ok) {
      throw new Error(`Feishu tenant_access_token request failed with status ${response.status}`);
    }
    const payload = await response.json() as FeishuAccessTokenPayload;
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Feishu tenant_access_token request failed: ${payload.msg || payload.code || 'unknown error'}`);
    }

    const expiresInSeconds = Number.isFinite(payload.expire) && payload.expire ? payload.expire : 7_200;
    this.tenantToken = {
      value: payload.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, expiresInSeconds - 60) * 1000,
    };
    return this.tenantToken.value;
  }

  private async callFeishu<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const token = await this.getTenantAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json; charset=utf-8');
    }

    const response = await this.fetcher(`${this.config.apiBaseUrl}${path}`, {
      ...init,
      headers,
    });
    const raw = await response.text();
    let payload: FeishuApiPayload<T> | null = null;
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as FeishuApiPayload<T>;
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      throw new FeishuApiError(null, `HTTP ${response.status}${raw ? `: ${raw}` : ''}`);
    }
    if (!payload) {
      return undefined as T;
    }
    if ((payload.code ?? 0) !== 0) {
      throw new FeishuApiError(payload.code ?? null, payload.msg || 'unknown Feishu API error');
    }
    return (payload.data ?? undefined) as T;
  }
}

class FeishuApiError extends Error {
  constructor(
    public readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'FeishuApiError';
  }
}

export class DefaultFeishuLongConnectionClient implements FeishuLongConnectionClient {
  private wsClient: unknown = null;

  constructor(private readonly config: FeishuAdapterConfig) {}

  async start(handlers: FeishuLongConnectionHandlers): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Feishu app id/secret are not configured');
    }

    let Lark: Record<string, any>;
    try {
      Lark = await import(FEISHU_NODE_SDK_MODULE);
    } catch (error) {
      throw new Error(
        `Feishu long connection requires ${FEISHU_NODE_SDK_MODULE}. Run bun install, then start again.`,
        { cause: error },
      );
    }

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        const event = data && typeof data === 'object' && !Array.isArray(data)
          ? data as Record<string, unknown>
          : {};
        await handlers.onMessageEvent(event);
      },
      'card.action.trigger': async (data: unknown) => {
        const event = data && typeof data === 'object' && !Array.isArray(data)
          ? data as Record<string, unknown>
          : {};
        return await handlers.onCardActionEvent(event);
      },
    });

    const clientConfig = {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel?.info,
    };
    this.wsClient = new Lark.WSClient(clientConfig);
    await Promise.resolve((this.wsClient as { start: (params: unknown) => unknown }).start({ eventDispatcher }));
  }

  async dispose(): Promise<void> {
    const client = this.wsClient as {
      stop?: () => unknown;
      close?: () => unknown;
    } | null;
    this.wsClient = null;
    if (client?.stop) {
      await Promise.resolve(client.stop());
      return;
    }
    if (client?.close) {
      await Promise.resolve(client.close());
    }
  }
}

export function createDefaultFeishuLongConnectionClient(config: FeishuAdapterConfig): FeishuLongConnectionClient {
  return new DefaultFeishuLongConnectionClient(config);
}
