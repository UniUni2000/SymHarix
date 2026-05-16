import { BotAssistantService } from './assistant';
import { BotCommandService } from './commandService';
import { BotFollowupService } from './followups';
import { BotFollowupRepairService } from './followupRepair';
import {
  buildGovernanceBlockedMessage,
  buildGovernanceCardKey,
  buildGovernanceConfirmingMessage,
  buildGovernanceExecutingMessage,
  buildGovernanceFailedMessage,
  buildGovernanceResolvedMessage,
  buildGovernanceWaitingOnChildMessage,
  isGovernanceBlockedIssue,
} from './governanceCards';
import { resolveGovernanceQuickActionByOrdinal, type GovernanceQuickActionSpec } from './governanceQuickActions';
import { BotSubscriptionService } from './subscriptions';
import { isTerminalIssue } from './issueVisibility';
import { RuntimeIssueCardLock } from './runtimeIssueCardLock';
import {
  BotConversationFocusRepository,
  BotFollowupDeliveryStateRepository,
  BotFollowupMessageStateRepository,
  BotConversationPreferenceRepository,
  BotIssueFollowupRepository,
  BotPendingActionRepository,
  ConflictMemoryRepository,
  DebtSignalRepository,
  DecisionMemoryRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  ShadowHarnessRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
  SupervisorJobRepository,
  SupervisorMemoryRepository,
  SupervisorRepoUnderstandingRepository,
  RepoClaudeConversationRepository,
  SupervisorPendingActionRepository,
  SupervisorRunEventRepository,
  SupervisorRunRepository,
  SupervisorToolCallRepository,
  BotTransportEventRepository,
  BotWatchSubscriptionRepository,
  WorkItemRepository,
} from '../database';
import type { RuntimeActionResult, RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import type { Database } from 'bun:sqlite';
import type { BotFollowupCardKind, SupervisorRepoUnderstanding, SupervisorSessionState } from '../database/types';
import type {
  BotManifest,
  BotCommandContext,
  BotCommandRequest,
  BotCommandResponse,
  BotGateway,
  BotMessageEditFailureKind,
  BotRecipient,
  BotTransportMessageRef,
  BotTransportMessage,
  BotTransportNotifier,
  TelegramCallbackAuditRecord,
} from './types';
import { BotMessageEditError, getBotMessageEditFailureKind } from './types';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { createBotAssistantModelFromEnv, type BotAssistantModel } from './model';
import {
  DefaultTelegramWebhookDiagnosticsService,
  type TelegramWebhookDiagnosticsService,
} from './telegramDiagnostics';
import { TelegramWebhookBootstrapService } from './telegramBootstrap';
import { readSymHarixEnv, syncSymHarixEnvAliases } from '../config/env';
import { createDefaultTelegramApiFetch } from './telegramHttp';
import { logger } from '../logging';
import { SupervisorSessionService, type SupervisorPlanBrain } from '../supervisor/sessionService';
import type { SupervisorRepoIntelligenceResolver } from '../supervisor/repoIntelligence';
import { DefaultSupervisorRepoIntelligenceResolver } from '../supervisor/repoIntelligence';
import { SupervisorWorker } from '../supervisor/worker';
import { SupervisorSessionCardLock } from '../supervisor/sessionCardLock';
import { SupervisorJobLoop } from '../supervisor/jobLoop';
import { SupervisorDevConversationService } from '../supervisor/devConversation';
import { SupervisorSessionRepairService } from '../supervisor/sessionRepair';
import { createSupervisorPlanBrainFromEnv } from '../supervisor/planBrain';
import {
  createSupervisorExecutionOverseerFromEnv,
  type SupervisorExecutionOverseer,
} from '../supervisor/executionOverseer';
import {
  createSupervisorCcAdvisorFromEnv,
  type SupervisorCcAdvisor,
} from '../supervisor/ccAdvisor';
import { inferRuntimeLocaleFromText, type RuntimeLocale } from '../i18n/locale';
import {
  createSupervisorAgentFromEnv,
  shouldUseReadOnlyClaudeForText,
  type SupervisorAgentService,
} from '../supervisor/supervisorAgent';
import {
  createSupervisorRepoSourceResolver,
  type SupervisorRepoSourceResolver,
} from '../supervisor/repoSourceResolver';
import type {
  SupervisorRepoUnderstandingService,
  SupervisorRepoUnderstandingSnapshot,
} from '../supervisor/repoUnderstanding';

function isEnglishRuntimeIssue(issue: RuntimeIssueView | null | undefined): boolean {
  return issue?.supervisor_locale === 'en';
}

function issueRuntimeLocale(issue: RuntimeIssueView | null | undefined): RuntimeLocale | null {
  return issue?.supervisor_locale === 'en' || issue?.supervisor_locale === 'zh'
    ? issue.supervisor_locale
    : null;
}

function textForLocale(locale: RuntimeLocale | null | undefined, zh: string, en: string): string {
  return locale === 'en' ? en : zh;
}

function textForIssueLocale(issue: RuntimeIssueView | null | undefined, zh: string, en: string): string {
  return isEnglishRuntimeIssue(issue) ? en : zh;
}
import {
  createClaudeCodeRepoUnderstandingRunner,
  DefaultClaudeRepoUnderstandingService,
  resolveGitCommit,
} from '../supervisor/claudeRepoUnderstandingService';
import { DefaultRepoProfileService } from '../supervisor/repoProfileService';
import { GovernanceMemoryService } from '../governance/repoIntelligence';
import { SupervisorAgentRuntimeService, createSupervisorToolRouterModel } from '../supervisor/agentRuntime';
import { SupervisorClaudeRuntimeService, type SupervisorClaudeRuntimeHandle } from '../supervisor/claudeRuntime';
import {
  SUPERVISOR_CONTEXT_TOOL_NAMES,
  SupervisorContextBroker,
  type SupervisorContextToolName,
} from '../supervisor/contextBroker';
import {
  SUPERVISOR_ORCHESTRATOR_TOOL_NAMES,
  SupervisorOrchestratorBroker,
  type SupervisorOrchestratorToolName,
} from '../supervisor/orchestratorBroker';

interface TelegramUpdate {
  update_id?: number | string;
  message?: {
    message_id?: number | string;
    text?: string;
    chat?: { id: number | string };
    from?: { id: number | string; username?: string; first_name?: string; last_name?: string };
  };
  edited_message?: TelegramUpdate['message'];
  callback_query?: {
    id?: string;
    data?: string;
    message?: {
      chat?: { id: number | string };
      message_id?: number | string;
      text?: string;
      caption?: string;
    };
    from?: { id: number | string; username?: string; first_name?: string; last_name?: string };
  };
}

interface PendingTelegramTextResponse {
  context: BotCommandContext;
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
}

interface QueuedTelegramTextResponse {
  context: BotCommandContext;
  texts: string[];
}

function getPendingActionRequestIssueId(
  pendingAction: NonNullable<ReturnType<BotPendingActionRepository['findByConversationIssue']>>,
): string | null {
  const request = pendingAction.normalized_payload as BotCommandRequest;
  return request.issue_id?.trim() || null;
}

function hasPendingConfirmationButtons(response: Pick<BotCommandResponse, 'actions' | 'action_rows'>): boolean {
  const actions = [
    ...(response.actions ?? []),
    ...((response.action_rows ?? []).flat()),
  ];
  return actions.some((action) => (
    action.callback_data === 'pending|confirm' ||
    action.callback_data === 'pending|cancel'
  ));
}

function runtimeIssueCardStateForResponse(
  response: Pick<BotCommandResponse, 'actions' | 'action_rows'>,
  issue: RuntimeIssueView | null,
): 'open' | 'confirming' | 'waiting_on_child' {
  if (hasPendingConfirmationButtons(response)) {
    return 'confirming';
  }
  return issue?.governance_thread_state === 'waiting_on_child'
    ? 'waiting_on_child'
    : 'open';
}

interface DiscordInteractionOption {
  name: string;
  type?: number;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
}

interface DiscordInteraction {
  type: number;
  channel_id?: string;
  data?: {
    name?: string;
    options?: DiscordInteractionOption[];
  };
  member?: {
    user?: {
      id?: string;
      username?: string;
      global_name?: string | null;
    };
  };
  user?: {
    id?: string;
    username?: string;
    global_name?: string | null;
  };
}

interface TelegramAdapterConfig {
  botToken: string | null;
  webhookSecret: string | null;
  operationsChatId: string | null;
  operatorIds: Set<string>;
}

interface DiscordAdapterConfig {
  botToken: string | null;
  publicKey: string | null;
  operatorIds: Set<string>;
}

type TelegramCallbackKind =
  | 'select_governance_action'
  | 'confirm_pending'
  | 'cancel_pending'
  | 'supervisor_action'
  | 'runtime_action'
  | 'unknown';
type TelegramRuntimeAction = 'refresh' | 'retry' | 'stop' | 'close' | 'open';
type TelegramCallbackDeliveryMode = 'edited' | 'sent_fallback' | 'kept_original';

function telegramCallbackDeliveryResult(mode: TelegramCallbackDeliveryMode): TelegramCallbackAuditRecord['result'] {
  if (mode === 'edited') {
    return 'edited';
  }
  if (mode === 'sent_fallback') {
    return 'sent_fallback';
  }
  return 'failed';
}

interface DiscordRequestVerifier {
  verify(params: {
    rawBody: string;
    signature: string | null;
    timestamp: string | null;
    publicKey: string | null;
  }): Promise<boolean>;
}

function getHeaderValue(headers: Headers | Record<string, string | undefined>, key: string): string | null {
  if (headers instanceof Headers) {
    return headers.get(key);
  }

  const normalizedKey = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(headers)) {
    if (candidateKey.toLowerCase() === normalizedKey) {
      return value ?? null;
    }
  }

  return null;
}

type TelegramInlineKeyboardButton = {
  text: string;
  style?: 'primary' | 'success' | 'danger';
  callback_data?: string;
  url?: string;
  web_app?: {
    url: string;
  };
};

function normalizePublicBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

function isTelegramClearRepoConversationCommand(text: string): boolean {
  return /^\/clear(?:@[\w_]+)?(?:\s|$)/i.test(text.trim());
}

function resolveTelegramActionUrl(url: string, publicBaseUrl: string | null): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  if (/^(https?:\/\/|tg:\/\/)/i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/') && publicBaseUrl) {
    return `${publicBaseUrl}${trimmed}`;
  }
  return null;
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

function buildTelegramInlineKeyboard(
  message: BotTransportMessage,
  publicBaseUrl: string | null = null,
):
  | { inline_keyboard: TelegramInlineKeyboardButton[][] }
  | undefined {
  const rows = message.action_rows
    ?? (message.actions?.length
      ? message.actions.map((action) => [action])
      : undefined);

  if (!rows || rows.length === 0) {
    return undefined;
  }

  const inlineRows = rows
    .map((row) => row
      .map((action): TelegramInlineKeyboardButton | null => {
        const button: TelegramInlineKeyboardButton = { text: action.label };
        if (action.style && action.style !== 'default') {
          button.style = action.style;
        }
        if (action.callback_data) {
          button.callback_data = action.callback_data;
          return button;
        }
        if (action.web_app?.url) {
          const url = resolveTelegramActionUrl(action.web_app.url, publicBaseUrl);
          if (url) {
            button.web_app = { url };
            return button;
          }
          const fallbackCallbackData = runtimeWebAppFallbackCallbackData(action.web_app.url);
          if (fallbackCallbackData) {
            button.callback_data = fallbackCallbackData;
            return button;
          }
        }
        if (action.url) {
          const url = resolveTelegramActionUrl(action.url, publicBaseUrl);
          if (url) {
            button.url = url;
            return button;
          }
        }
        return null;
      })
      .filter((button): button is TelegramInlineKeyboardButton => button !== null))
    .filter((row) => row.length > 0);

  return inlineRows.length > 0
    ? { inline_keyboard: inlineRows }
    : undefined;
}

class TelegramNotifier implements BotTransportNotifier {
  private readonly telegramFetch: typeof fetch;

  constructor(
    private readonly config: TelegramAdapterConfig,
    private readonly getPublicBaseUrl: () => string | null = () => null,
    telegramFetch: typeof fetch = createDefaultTelegramApiFetch(),
  ) {
    this.telegramFetch = telegramFetch;
  }

  private classifyEditFailure(description: string | null): BotMessageEditFailureKind {
    const normalized = (description ?? '').toLowerCase();
    if (normalized.includes('message is not modified')) {
      return 'not_modified';
    }
    if (
      normalized.includes('message to edit not found') ||
      normalized.includes('chat not found') ||
      normalized.includes('message_id_invalid')
    ) {
      return 'message_not_found';
    }
    return 'hard_failure';
  }

  async sendMessage(recipient: BotRecipient, message: BotTransportMessage): Promise<BotTransportMessageRef> {
    if (!this.config.botToken) {
      throw new Error('Telegram bot token is not configured');
    }
    if (message.photo) {
      return this.sendPhoto(recipient, message);
    }
    const keyboard = buildTelegramInlineKeyboard(message, this.getPublicBaseUrl());

    const response = await this.telegramFetch(
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: recipient.conversation_id,
          text: message.text,
          parse_mode: message.format === 'telegram_html' ? 'HTML' : undefined,
          reply_to_message_id: message.reply_to_message_id ?? undefined,
          reply_markup: keyboard,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed with status ${response.status}`);
    }

    const payload = await response.json() as { result?: { message_id?: number | string } };
    return {
      provider_message_id: String(payload.result?.message_id ?? ''),
    };
  }

  private appendPhoto(form: FormData, message: BotTransportMessage): void {
    const photo = message.photo;
    if (!photo) {
      throw new Error('Telegram photo message is missing photo data');
    }
    if (photo.bytes) {
      form.set(
        'photo',
        new Blob([photo.bytes], { type: photo.content_type || 'image/png' }),
        photo.filename || 'issue-card.png',
      );
      return;
    }
    const remotePhoto = photo.url || photo.file_id;
    if (!remotePhoto) {
      throw new Error('Telegram photo message requires bytes, url, or file_id');
    }
    form.set('photo', remotePhoto);
  }

  private async sendPhoto(recipient: BotRecipient, message: BotTransportMessage): Promise<BotTransportMessageRef> {
    const keyboard = buildTelegramInlineKeyboard(message, this.getPublicBaseUrl());
    const form = new FormData();
    form.set('chat_id', recipient.conversation_id);
    if (message.reply_to_message_id !== undefined && message.reply_to_message_id !== null) {
      form.set('reply_to_message_id', String(message.reply_to_message_id));
    }
    this.appendPhoto(form, message);
    form.set('caption', message.caption ?? message.text);
    if (message.format === 'telegram_html') {
      form.set('parse_mode', 'HTML');
    }
    form.set('show_caption_above_media', String(message.show_caption_above_media ?? true));
    if (keyboard) {
      form.set('reply_markup', JSON.stringify(keyboard));
    }

    const response = await this.telegramFetch(
      `https://api.telegram.org/bot${this.config.botToken}/sendPhoto`,
      {
        method: 'POST',
        body: form,
      },
    );

    if (!response.ok) {
      throw new Error(`Telegram sendPhoto failed with status ${response.status}`);
    }

    const payload = await response.json() as { result?: { message_id?: number | string } };
    return {
      provider_message_id: String(payload.result?.message_id ?? ''),
    };
  }

  async editMessage(
    recipient: BotRecipient,
    messageRef: BotTransportMessageRef,
    message: BotTransportMessage,
  ): Promise<BotTransportMessageRef> {
    if (!this.config.botToken) {
      throw new Error('Telegram bot token is not configured');
    }
    if (message.photo) {
      return this.editPhoto(recipient, messageRef, message);
    }
    if (message.caption !== undefined) {
      return this.editCaption(recipient, messageRef, message);
    }
    const keyboard = buildTelegramInlineKeyboard(message, this.getPublicBaseUrl());

    const response = await this.telegramFetch(
      `https://api.telegram.org/bot${this.config.botToken}/editMessageText`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: recipient.conversation_id,
          message_id: messageRef.provider_message_id,
          text: message.text,
          parse_mode: message.format === 'telegram_html' ? 'HTML' : undefined,
          reply_markup: keyboard,
        }),
      },
    );

    if (!response.ok) {
      let description: string | null = null;
      try {
        const raw = await response.text();
        if (raw.trim()) {
          try {
            const payload = JSON.parse(raw) as { description?: string };
            description = typeof payload.description === 'string' ? payload.description : raw;
          } catch {
            description = raw;
          }
        }
      } catch {
        description = null;
      }

      if ((description ?? '').toLowerCase().includes('there is no text in the message to edit')) {
        return this.editCaption(recipient, messageRef, {
          ...message,
          caption: message.caption ?? message.text,
        });
      }

      throw new BotMessageEditError(
        this.classifyEditFailure(description),
        `Telegram editMessageText failed with status ${response.status}${description ? `: ${description}` : ''}`,
        response.status,
        description,
      );
    }

    return {
      provider_message_id: messageRef.provider_message_id,
    };
  }

  private async editCaption(
    recipient: BotRecipient,
    messageRef: BotTransportMessageRef,
    message: BotTransportMessage,
  ): Promise<BotTransportMessageRef> {
    const keyboard = buildTelegramInlineKeyboard(message, this.getPublicBaseUrl());

    const response = await this.telegramFetch(
      `https://api.telegram.org/bot${this.config.botToken}/editMessageCaption`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: recipient.conversation_id,
          message_id: messageRef.provider_message_id,
          caption: message.caption,
          parse_mode: message.format === 'telegram_html' ? 'HTML' : undefined,
          reply_markup: keyboard,
        }),
      },
    );

    if (!response.ok) {
      let description: string | null = null;
      try {
        const raw = await response.text();
        if (raw.trim()) {
          try {
            const payload = JSON.parse(raw) as { description?: string };
            description = typeof payload.description === 'string' ? payload.description : raw;
          } catch {
            description = raw;
          }
        }
      } catch {
        description = null;
      }

      throw new BotMessageEditError(
        this.classifyEditFailure(description),
        `Telegram editMessageCaption failed with status ${response.status}${description ? `: ${description}` : ''}`,
        response.status,
        description,
      );
    }

    return {
      provider_message_id: messageRef.provider_message_id,
    };
  }

  private async editPhoto(
    recipient: BotRecipient,
    messageRef: BotTransportMessageRef,
    message: BotTransportMessage,
  ): Promise<BotTransportMessageRef> {
    const keyboard = buildTelegramInlineKeyboard(message, this.getPublicBaseUrl());
    const form = new FormData();
    form.set('chat_id', recipient.conversation_id);
    form.set('message_id', messageRef.provider_message_id);
    const photo = message.photo;
    if (!photo) {
      throw new Error('Telegram photo edit is missing photo data');
    }
    const mediaPhoto = photo.bytes ? 'attach://photo' : (photo.url || photo.file_id);
    if (!mediaPhoto) {
      throw new Error('Telegram photo edit requires bytes, url, or file_id');
    }
    form.set('media', JSON.stringify({
      type: 'photo',
      media: mediaPhoto,
      caption: message.caption ?? message.text,
      parse_mode: message.format === 'telegram_html' ? 'HTML' : undefined,
      show_caption_above_media: message.show_caption_above_media ?? true,
    }));
    if (photo.bytes) {
      this.appendPhoto(form, message);
    }
    if (keyboard) {
      form.set('reply_markup', JSON.stringify(keyboard));
    }

    const response = await this.telegramFetch(
      `https://api.telegram.org/bot${this.config.botToken}/editMessageMedia`,
      {
        method: 'POST',
        body: form,
      },
    );

    if (!response.ok) {
      let description: string | null = null;
      try {
        const raw = await response.text();
        if (raw.trim()) {
          try {
            const payload = JSON.parse(raw) as { description?: string };
            description = typeof payload.description === 'string' ? payload.description : raw;
          } catch {
            description = raw;
          }
        }
      } catch {
        description = null;
      }

      throw new BotMessageEditError(
        this.classifyEditFailure(description),
        `Telegram editMessageMedia failed with status ${response.status}${description ? `: ${description}` : ''}`,
        response.status,
        description,
      );
    }

    return {
      provider_message_id: messageRef.provider_message_id,
    };
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.config.botToken) {
      throw new Error('Telegram bot token is not configured');
    }

    const response = await this.telegramFetch(
      `https://api.telegram.org/bot${this.config.botToken}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text: text ?? '',
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Telegram answerCallbackQuery failed with status ${response.status}`);
    }
  }
}

class DiscordNotifier implements BotTransportNotifier {
  constructor(private readonly config: DiscordAdapterConfig) {}

  async sendMessage(recipient: BotRecipient, message: BotTransportMessage): Promise<BotTransportMessageRef> {
    if (!this.config.botToken) {
      throw new Error('Discord bot token is not configured');
    }

    const response = await fetch(
      `https://discord.com/api/v10/channels/${recipient.conversation_id}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${this.config.botToken}`,
        },
        body: JSON.stringify({
          content: message.text,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Discord create message failed with status ${response.status}`);
    }

    const payload = await response.json() as { id?: string };
    return {
      provider_message_id: payload.id ?? '',
    };
  }

  async editMessage(
    recipient: BotRecipient,
    _messageRef: BotTransportMessageRef,
    message: BotTransportMessage,
  ): Promise<BotTransportMessageRef> {
    return this.sendMessage(recipient, message);
  }
}

class WebCryptoDiscordVerifier implements DiscordRequestVerifier {
  async verify(params: {
    rawBody: string;
    signature: string | null;
    timestamp: string | null;
    publicKey: string | null;
  }): Promise<boolean> {
    if (!params.signature || !params.timestamp || !params.publicKey) {
      return false;
    }

    const keyBytes = Uint8Array.from(Buffer.from(params.publicKey, 'hex'));
    const signatureBytes = Uint8Array.from(Buffer.from(params.signature, 'hex'));
    const messageBytes = new TextEncoder().encode(`${params.timestamp}${params.rawBody}`);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

    return crypto.subtle.verify(
      { name: 'Ed25519' },
      cryptoKey,
      signatureBytes,
      messageBytes,
    );
  }
}

function flattenDiscordOptions(options: DiscordInteractionOption[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};

  for (const option of options || []) {
    if (Array.isArray(option.options) && option.options.length > 0) {
      Object.assign(result, flattenDiscordOptions(option.options));
      continue;
    }

    if (option.value !== undefined && option.value !== null) {
      result[option.name] = String(option.value);
    }
  }

  return result;
}

function toCreateIssueRequest(values: Record<string, string>): BotCommandRequest {
  return {
    command: 'new',
    create_issue: {
      title: values.title || '',
      description: values.description || null,
      team_id: values.team_id || null,
      project_id: values.project_id || null,
      state_id: values.state_id || null,
    },
  };
}

function buildDiscordCommandRequest(interaction: DiscordInteraction): BotCommandRequest {
  const commandName = (interaction.data?.name || 'help').toLowerCase();
  const values = flattenDiscordOptions(interaction.data?.options);

  switch (commandName) {
    case 'status':
      return { command: 'status', issue_id: values.issue || null };
    case 'stop':
      return { command: 'stop', issue_id: values.issue || null };
    case 'retry':
      return { command: 'retry', issue_id: values.issue || null };
    case 'override':
      return { command: 'override', issue_id: values.issue || null };
    case 'rewrite':
      return { command: 'rewrite', issue_id: values.issue || null };
    case 'split':
      return { command: 'split', issue_id: values.issue || null };
    case 'watch':
      return {
        command: 'watch',
        issue_id: values.issue || null,
        watch_preset: (values.preset as BotCommandRequest['watch_preset']) || null,
      };
    case 'unwatch':
      return { command: 'unwatch', issue_id: values.issue || null };
    case 'new':
      return toCreateIssueRequest(values);
    case 'help':
    default:
      return { command: 'help' };
  }
}

function isExplicitRuntimeIssueCardRequest(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return /^(?:卡片给我|卡片发我|把卡片发我|把当前卡片发我|发我卡片|发一下卡片|当前卡片|查看当前计划|看当前计划|当前计划|查看计划卡|看计划卡|计划卡给我)$/i.test(normalized)
    || /^(?:发|给|看看|看一下|查看|刷新|打开|show|send|refresh|open).{0,16}(?:运行面板|运行卡片|runtime panel|runtime card|issue card|卡片|面板)$/i.test(normalized)
    || /^(?:运行面板|运行卡片|runtime panel|runtime card|issue card|卡片|面板).{0,16}(?:发我|给我|看看|看一下|查看|刷新|打开|show|send|refresh|open)$/i.test(normalized)
    || /^(?:给我看|查看|看一下|刷新).{0,12}(?:[A-Z]+-\d+|\d+).{0,12}(?:卡片|面板|issue card|runtime card)$/i.test(normalized);
}

const ACTIVE_SUPERVISOR_SESSION_CARD_STATES = new Set<SupervisorSessionState>([
  'drafting',
  'clarifying',
  'plan_ready',
  'awaiting_user_approval',
  'approved_for_materialization',
  'materialized',
  'executing',
  'awaiting_user_decision',
]);

function createBotWriteAuthorizer(params: {
  telegramOperatorIds: Set<string>;
  discordOperatorIds: Set<string>;
}): (context: BotCommandContext) => boolean {
  return (context) => {
    const operatorIds =
      context.transport === 'telegram'
        ? params.telegramOperatorIds
        : params.discordOperatorIds;
    if (operatorIds.size === 0) {
      return true;
    }
    return Boolean(context.identity.user_id && operatorIds.has(context.identity.user_id));
  };
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInteger(value: string | null | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isPureRepositoryQuestionText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || normalized.startsWith('/')) {
    return false;
  }
  if (/(?:创建|新建|建|开|提|执行|开始|批准|取消|关闭|关掉|关了|作废|废弃|不要|不用|不做|清理|清空|删除|移除|重试|重新|停止|做成|实现|修复|修掉|改成|发布|部署|跑一下|create|open|start|approve|cancel|close|cleanup|delete|remove|retry|rerun|stop|ship|deploy)/i.test(normalized)) {
    return false;
  }
  return shouldUseReadOnlyClaudeForText(normalized) ||
    /(?:这个|当前|默认)?仓库.*(?:干啥|干什么|是干嘛|是什么|有啥|有什么|有哪些)|(?:文件|函数|模块|目录|代码).*(?:有什么用|干啥|干什么|定义|是什么)|(?:what|why|how).*(?:repo|repository|file|function|module)/i.test(normalized);
}

function shouldSendTelegramProcessingAck(text: string): boolean {
  return !isPureRepositoryQuestionText(text);
}

function waitForTelegramRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mapReadyRepoUnderstanding(
  record: SupervisorRepoUnderstanding | null,
): SupervisorRepoUnderstandingSnapshot | null {
  if (!record || record.status !== 'ready' || !record.summary) {
    return null;
  }
  return {
    repo_ref: record.repo_ref,
    commit_sha: record.commit_sha,
    summary: record.summary,
    understanding: record.understanding_json,
    evidence_paths: record.evidence_paths_json,
    source: 'cache',
  };
}

function createRepoUnderstandingServiceFromEnv(
  db: Database | null | undefined,
): SupervisorRepoUnderstandingService | null {
  if (!db) {
    return null;
  }

  const repository = new SupervisorRepoUnderstandingRepository(db);
  const timeoutMs = parsePositiveInteger(readSymHarixEnv('SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS'))
    ?? 120_000;
  const command = readSymHarixEnv('SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND')
    || 'node scripts/claude-adapter.cjs';

  return new DefaultClaudeRepoUnderstandingService({
    findCached: async ({ repoRef, commitSha }) => mapReadyRepoUnderstanding(
      repository.findByRepoAndCommit(repoRef, commitSha),
    ),
    save: async (snapshot) => {
      repository.upsert({
        id: crypto.randomUUID(),
        repo_ref: snapshot.repo_ref,
        local_path: snapshot.localPath,
        commit_sha: snapshot.commit_sha,
        status: 'ready',
        summary: snapshot.summary,
        understanding_json: snapshot.understanding,
        evidence_paths_json: snapshot.evidence_paths,
        generated_by: snapshot.source === 'fallback' ? 'fallback' : 'claude_code',
        error: null,
      });
    },
    resolveCommit: resolveGitCommit,
    runClaude: createClaudeCodeRepoUnderstandingRunner({
      command,
      timeoutMs,
      projectRoot: process.cwd(),
    }),
  });
}

export class DefaultBotGateway implements BotGateway {
  private readonly commandService: BotCommandService;
  private readonly assistantService: BotAssistantService;
  private readonly subscriptions: BotSubscriptionService;
  private readonly followups: BotFollowupService | null;
  private readonly telegramNotifier: TelegramNotifier | null;
  private readonly discordNotifier: DiscordNotifier | null;
  private readonly followupMessageStates: BotFollowupMessageStateRepository | null;
  private readonly followupDeliveryStates: BotFollowupDeliveryStateRepository | null;
  private readonly pendingActions: BotPendingActionRepository | null;
  private readonly conversationFocuses: BotConversationFocusRepository | null;
  private readonly transportEvents: BotTransportEventRepository | null;
  private readonly telegramDiagnostics: TelegramWebhookDiagnosticsService;
  private readonly telegramBootstrap: TelegramWebhookBootstrapService | null;
  private readonly supervisorSessions: SupervisorSessionRepository | null;
  private readonly supervisorSessionEvents: SupervisorSessionEventRepository | null;
  private readonly supervisorSessionService: SupervisorSessionService | null;
  private readonly supervisorWorker: SupervisorWorker | null;
  private readonly supervisorJobLoop: SupervisorJobLoop | null;
  private readonly projectResolver: TrackerProjectResolutionService | null;
  private readonly supervisorRepoSourceResolver: SupervisorRepoSourceResolver | null;
  private readonly supervisorAgentService: SupervisorAgentService | null;
  private readonly supervisorAgentRuntime: SupervisorAgentRuntimeService | null;
  private readonly supervisorClaudeRuntime: SupervisorClaudeRuntimeHandle | null;
  private readonly supervisorContextBroker: SupervisorContextBroker | null;
  private readonly supervisorOrchestratorBroker: SupervisorOrchestratorBroker | null;
  private readonly supervisorRuns: SupervisorRunRepository | null;
  private readonly supervisorRunEvents: SupervisorRunEventRepository | null;
  private readonly supervisorToolCalls: SupervisorToolCallRepository | null;
  private readonly supervisorPendingActions: SupervisorPendingActionRepository | null;
  private readonly repoClaudeConversations: RepoClaudeConversationRepository | null;
  private readonly botWriteAuthorizer: (context: BotCommandContext) => boolean;
  private readonly telegramTextProcessingAckDelayMs: number;
  private readonly telegramTextCoalesceDelayMs: number;
  private readonly pendingTelegramTextResponses = new Map<string, PendingTelegramTextResponse>();
  private readonly activeTelegramTextResponseKeys = new Set<string>();
  private readonly queuedTelegramTextResponses = new Map<string, QueuedTelegramTextResponse>();
  private readonly seenTelegramUpdateIds = new Set<string>();
  private readonly seenTelegramUpdateOrder: string[] = [];
  private readonly runtimeIssueCardLock = new RuntimeIssueCardLock();
  private readonly supervisorSessionCardLock = new SupervisorSessionCardLock();
  private telegramPublicBaseUrl: string | null = normalizePublicBaseUrl(readSymHarixEnv('SYMPHONY_PUBLIC_BASE_URL') || null);
  private telegramWebhookUsedTunnel: boolean | null = null;
  private startupRepairTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly telegramConfig: TelegramAdapterConfig,
    private readonly discordConfig: DiscordAdapterConfig,
    private readonly discordVerifier: DiscordRequestVerifier = new WebCryptoDiscordVerifier(),
    subscriptionRepository: BotWatchSubscriptionRepository | null = null,
    options: {
      preferencesRepository?: BotConversationPreferenceRepository | null;
      conversationFocusRepository?: BotConversationFocusRepository | null;
      pendingActionRepository?: BotPendingActionRepository | null;
      followupRepository?: BotIssueFollowupRepository | null;
      followupMessageStateRepository?: BotFollowupMessageStateRepository | null;
      followupDeliveryStateRepository?: BotFollowupDeliveryStateRepository | null;
      transportEventRepository?: BotTransportEventRepository | null;
      supervisorSessionRepository?: SupervisorSessionRepository | null;
      supervisorSessionEventRepository?: SupervisorSessionEventRepository | null;
      supervisorJobRepository?: SupervisorJobRepository | null;
      supervisorMemoryRepository?: SupervisorMemoryRepository | null;
      supervisorRunRepository?: SupervisorRunRepository | null;
      supervisorRunEventRepository?: SupervisorRunEventRepository | null;
      supervisorToolCallRepository?: SupervisorToolCallRepository | null;
      supervisorPendingActionRepository?: SupervisorPendingActionRepository | null;
      repoClaudeConversationRepository?: RepoClaudeConversationRepository | null;
      supervisorAgentRuntimeService?: SupervisorAgentRuntimeService | null;
      supervisorSessionService?: SupervisorSessionService | null;
      supervisorPlanBrain?: SupervisorPlanBrain | null;
      supervisorExecutionOverseer?: SupervisorExecutionOverseer | null;
      supervisorRepoIntelligenceResolver?: SupervisorRepoIntelligenceResolver | null;
      supervisorClaudeRuntimeService?: SupervisorClaudeRuntimeHandle | null;
      supervisorContextBroker?: SupervisorContextBroker | null;
      supervisorOrchestratorBroker?: SupervisorOrchestratorBroker | null;
      workItemRepository?: WorkItemRepository | null;
      projectResolver?: TrackerProjectResolutionService | null;
      supervisorRepoSourceResolver?: SupervisorRepoSourceResolver | null;
      assistantModel?: BotAssistantModel;
      supervisorCcAdvisor?: SupervisorCcAdvisor | null;
      supervisorAgentService?: SupervisorAgentService | null;
      repoUnderstandingService?: SupervisorRepoUnderstandingService | null;
      telegramDiagnostics?: TelegramWebhookDiagnosticsService;
      telegramBootstrapService?: TelegramWebhookBootstrapService | null;
      telegramTextProcessingAckDelayMs?: number | null;
      telegramTextCoalesceDelayMs?: number | null;
      startupRepairDelayMs?: number | null;
    } = {},
  ) {
    this.projectResolver = options.projectResolver ?? null;
    this.supervisorRepoSourceResolver = options.supervisorRepoSourceResolver ?? null;
    this.supervisorAgentService = options.supervisorAgentService ?? null;
    this.followupMessageStates = options.followupMessageStateRepository ?? null;
    this.followupDeliveryStates = options.followupDeliveryStateRepository ?? null;
    this.pendingActions = options.pendingActionRepository ?? null;
    this.conversationFocuses = options.conversationFocusRepository ?? null;
    this.transportEvents = options.transportEventRepository ?? null;
    this.supervisorSessions = options.supervisorSessionRepository ?? null;
    this.supervisorSessionEvents = options.supervisorSessionEventRepository ?? null;
    this.supervisorRuns = options.supervisorRunRepository ?? null;
    this.supervisorRunEvents = options.supervisorRunEventRepository ?? null;
    this.supervisorToolCalls = options.supervisorToolCallRepository ?? null;
    this.supervisorPendingActions = options.supervisorPendingActionRepository ?? null;
    this.repoClaudeConversations = options.repoClaudeConversationRepository ?? null;
    this.telegramTextProcessingAckDelayMs = Math.max(
      1,
      options.telegramTextProcessingAckDelayMs
        ?? parsePositiveInteger(readSymHarixEnv('SYMPHONY_TELEGRAM_TEXT_ACK_DELAY_MS'))
        ?? 3_000,
    );
    this.telegramTextCoalesceDelayMs = Math.max(0, options.telegramTextCoalesceDelayMs ?? 0);
    const supervisorMemories = options.supervisorMemoryRepository ?? null;
    const supervisorJobs = options.supervisorJobRepository ?? null;
    this.telegramNotifier = telegramConfig.botToken
      ? new TelegramNotifier(telegramConfig, () => this.telegramPublicBaseUrl)
      : null;
    this.discordNotifier = discordConfig.botToken ? new DiscordNotifier(discordConfig) : null;
    this.telegramDiagnostics = options.telegramDiagnostics
      ?? new DefaultTelegramWebhookDiagnosticsService(telegramConfig.botToken);
    this.telegramBootstrap = telegramConfig.botToken
      ? (options.telegramBootstrapService ?? new TelegramWebhookBootstrapService({
          botToken: telegramConfig.botToken,
          webhookSecret: telegramConfig.webhookSecret,
          publicBaseUrl: readSymHarixEnv('SYMPHONY_PUBLIC_BASE_URL') || null,
          bootstrapMode: readSymHarixEnv('SYMPHONY_TELEGRAM_BOOTSTRAP') === 'off' ? 'off' : 'auto',
        }))
      : null;
    this.subscriptions = new BotSubscriptionService(runtime, {
      telegram: this.telegramNotifier ?? undefined,
      discord: this.discordNotifier ?? undefined,
    }, subscriptionRepository);
    const canWrite = createBotWriteAuthorizer({
      telegramOperatorIds: telegramConfig.operatorIds,
      discordOperatorIds: discordConfig.operatorIds,
    });
    this.botWriteAuthorizer = canWrite;
    this.commandService = new BotCommandService(
      runtime,
      this.subscriptions,
      canWrite,
      options.preferencesRepository ?? null,
      options.projectResolver ?? null,
      options.followupRepository ?? null,
    );
    const assistantModel = options.assistantModel ?? createBotAssistantModelFromEnv();
    this.supervisorAgentRuntime = options.supervisorAgentRuntimeService === undefined
      ? (
          this.supervisorRuns &&
          this.supervisorRunEvents &&
          this.supervisorToolCalls &&
          this.supervisorPendingActions
            ? new SupervisorAgentRuntimeService({
                runtime,
                commandService: this.commandService,
                preferences: options.preferencesRepository ?? null,
                projectResolver: options.projectResolver ?? null,
                runs: this.supervisorRuns,
                events: this.supervisorRunEvents,
                toolCalls: this.supervisorToolCalls,
                pendingActions: this.supervisorPendingActions,
                repoConversations: this.repoClaudeConversations,
                model: createSupervisorToolRouterModel(assistantModel),
                supervisorAgentService: this.supervisorAgentService,
                onProgress: async ({ context, message }) => {
                  await this.sendSupervisorRuntimeProgress(context, message);
                },
              })
            : null
        )
      : options.supervisorAgentRuntimeService;
    this.supervisorSessionService = options.supervisorSessionService
      ?? ((this.supervisorSessions && this.supervisorSessionEvents)
        ? new SupervisorSessionService(
            runtime,
            options.projectResolver ?? null,
            this.supervisorSessions,
            this.supervisorSessionEvents,
            options.supervisorRepoIntelligenceResolver ?? null,
            options.supervisorPlanBrain ?? null,
            options.supervisorExecutionOverseer ?? createSupervisorExecutionOverseerFromEnv(),
          )
        : null);
    this.supervisorContextBroker = options.supervisorContextBroker === undefined
      ? new SupervisorContextBroker({
          runtime,
          preferences: options.preferencesRepository ?? null,
          conversationFocuses: this.conversationFocuses,
          projectResolver: options.projectResolver ?? null,
          repoProfileService: new DefaultRepoProfileService(),
          repoUnderstandingService: options.repoUnderstandingService ?? null,
          repoSourceResolver: this.supervisorRepoSourceResolver,
          supervisorMemories,
          supervisorSessions: this.supervisorSessions,
          repoIntelligenceResolver: options.supervisorRepoIntelligenceResolver ?? null,
      })
      : options.supervisorContextBroker;
    this.supervisorOrchestratorBroker = options.supervisorOrchestratorBroker === undefined
      ? (
          this.supervisorRuns &&
          this.supervisorRunEvents &&
          this.supervisorToolCalls &&
          this.supervisorPendingActions
            ? new SupervisorOrchestratorBroker({
                runtime,
                commandService: this.commandService,
                preferences: options.preferencesRepository ?? null,
                projectResolver: options.projectResolver ?? null,
                runs: this.supervisorRuns,
                events: this.supervisorRunEvents,
                toolCalls: this.supervisorToolCalls,
                pendingActions: this.supervisorPendingActions,
                repoConversations: this.repoClaudeConversations,
                supervisorAgentService: this.supervisorAgentService,
              })
            : null
        )
      : options.supervisorOrchestratorBroker;
    this.supervisorClaudeRuntime = options.supervisorClaudeRuntimeService ?? null;
    this.supervisorClaudeRuntime?.setOrchestratorBridge?.(this.supervisorOrchestratorBroker);
    this.assistantService = new BotAssistantService(
      runtime,
      this.commandService,
      options.preferencesRepository ?? null,
      options.pendingActionRepository ?? null,
      options.projectResolver ?? null,
      assistantModel,
      canWrite,
      this.subscriptions,
      options.followupMessageStateRepository ?? null,
      this.supervisorSessionService,
      options.supervisorCcAdvisor ?? null,
      options.supervisorAgentService ?? null,
      options.repoUnderstandingService ?? null,
      this.supervisorRepoSourceResolver,
      this.conversationFocuses,
      this.supervisorAgentRuntime,
      this.supervisorClaudeRuntime,
    );
    const runStartupRepair = () => {
      try {
        new BotFollowupRepairService(
          runtime,
          options.workItemRepository ?? null,
          options.followupRepository ?? null,
          options.followupMessageStateRepository ?? null,
          options.followupDeliveryStateRepository ?? null,
          options.pendingActionRepository ?? null,
          options.conversationFocusRepository ?? null,
        ).repair();
        if (this.supervisorSessions) {
          new SupervisorSessionRepairService(
            runtime,
            this.supervisorSessions,
            {
              staleSessionMaxAgeMs: parsePositiveInteger(readSymHarixEnv('SYMPHONY_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS'))
                ?? null,
            },
          ).repair();
        }
        this.supervisorAgentRuntime?.recoverStartupState();
      } catch (error) {
        logger.warn('Bot follow-up repair failed during gateway startup', {}, error instanceof Error ? error : undefined);
      }
    };
    const startupRepairDelayMs = options.startupRepairDelayMs
      ?? parsePositiveInteger(readSymHarixEnv('SYMPHONY_BOT_FOLLOWUP_REPAIR_DELAY_MS'))
      ?? 5_000;
    this.startupRepairTimer = setTimeout(() => {
      this.startupRepairTimer = null;
      runStartupRepair();
    }, Math.max(0, startupRepairDelayMs));
    this.startupRepairTimer.unref?.();
    this.followups = options.followupRepository
      ? new BotFollowupService(runtime, {
          telegram: this.telegramNotifier ?? undefined,
        }, options.followupRepository, options.followupMessageStateRepository ?? null, {
          telegramOperationsChatId: this.telegramConfig.operationsChatId,
          deliveryStateRepository: options.followupDeliveryStateRepository ?? null,
          transportEventRepository: options.transportEventRepository ?? null,
          supervisorSessionRepository: this.supervisorSessions,
          runtimeIssueCardLock: this.runtimeIssueCardLock,
        })
      : null;
    this.supervisorWorker = this.supervisorSessions && this.supervisorSessionService
      ? new SupervisorWorker({
          runtime,
          sessionRepository: this.supervisorSessions,
          sessionService: this.supervisorSessionService,
          transportEventRepository: this.transportEvents,
          notifiers: {
            telegram: this.telegramNotifier ?? undefined,
            discord: this.discordNotifier ?? undefined,
          },
          sessionCardLock: this.supervisorSessionCardLock,
        })
      : null;
    this.supervisorJobLoop = this.supervisorSessions && this.supervisorSessionEvents && supervisorMemories && this.supervisorSessionService
      ? new SupervisorJobLoop({
          runtime,
          sessionRepository: this.supervisorSessions,
          eventRepository: this.supervisorSessionEvents,
          memoryRepository: supervisorMemories,
          jobRepository: supervisorJobs ?? undefined,
          devConversationService: supervisorJobs ? new SupervisorDevConversationService() : undefined,
          syncIssue: (issue) => this.supervisorSessionService?.syncIssue(issue),
          intervalMs: Number.parseInt(readSymHarixEnv('SYMPHONY_SUPERVISOR_JOB_INTERVAL_MS') || '', 10) || undefined,
        })
      : null;
    if (this.supervisorWorker) {
      void this.supervisorWorker.reconcile().catch((error) => {
        logger.warn('Supervisor worker reconciliation failed during gateway startup', {}, error instanceof Error ? error : undefined);
      });
    }
    if (this.supervisorJobLoop) {
      void this.supervisorJobLoop.tick().catch((error) => {
        logger.warn('Supervisor job loop startup tick failed', {}, error instanceof Error ? error : undefined);
      });
      this.supervisorJobLoop.start();
    }
  }

  getManifest(): BotManifest {
    const telegramInboundEnabled = Boolean(this.telegramConfig.botToken);
    const telegramOutboundEnabled = Boolean(this.telegramConfig.botToken);
    const discordInboundEnabled = Boolean(this.discordConfig.publicKey);
    const discordOutboundEnabled = Boolean(this.discordConfig.botToken);
    this.telegramDiagnostics.maybeRefresh();
    const telegramDiagnostics = this.telegramDiagnostics.getSnapshot();
    const telegramPublicBaseUrl = this.telegramPublicBaseUrl;
    const activeSupervisorSessions = (this.supervisorSessions?.findAll() ?? [])
      .filter((session) => (
        session.state !== 'completed' &&
        session.state !== 'cancelled'
      ))
      .slice(0, 20)
      .map((session) => ({
        session_id: session.id,
        transport: session.transport,
        conversation_id: session.conversation_id,
        state: session.state,
        active_decision_kind: session.active_decision_kind,
        title: session.plan_card?.title ?? null,
        repo_ref: session.repo_ref,
        root_issue_id: session.root_issue_id,
        updated_at: session.updated_at,
      }));

    return {
      transports: {
        telegram: {
          enabled: telegramInboundEnabled || telegramOutboundEnabled,
          inbound_enabled: telegramInboundEnabled,
          outbound_enabled: telegramOutboundEnabled,
          watch_supported: telegramOutboundEnabled,
          write_requires_operator: this.telegramConfig.operatorIds.size > 0,
          inbound_path: '/api/v1/bots/telegram/webhook',
          proactive_followups_supported: Boolean(this.telegramNotifier),
          inline_actions_supported: Boolean(this.telegramNotifier),
          operations_chat_configured: Boolean(this.telegramConfig.operationsChatId),
          health: telegramDiagnostics.health,
          webhook_url: telegramDiagnostics.webhook_url,
          ...(telegramPublicBaseUrl
            ? {
                public_base_url: telegramPublicBaseUrl,
                mini_app_base_url: telegramPublicBaseUrl,
                webhook_used_tunnel: this.telegramWebhookUsedTunnel,
              }
            : {}),
          webhook_pending_update_count: telegramDiagnostics.webhook_pending_update_count,
          webhook_last_error_message: telegramDiagnostics.webhook_last_error_message,
          webhook_last_error_at: telegramDiagnostics.webhook_last_error_at,
          callback_ingress_recently_ok: telegramDiagnostics.callback_ingress_recently_ok,
        },
        discord: {
          enabled: discordInboundEnabled || discordOutboundEnabled,
          inbound_enabled: discordInboundEnabled,
          outbound_enabled: discordOutboundEnabled,
          watch_supported: discordOutboundEnabled,
          write_requires_operator: this.discordConfig.operatorIds.size > 0,
          inbound_path: '/api/v1/bots/discord/interactions',
        },
      },
      commands: ['help', 'clear', 'status', 'new', 'project', 'watch', 'unwatch', 'stop', 'retry', 'close', 'supersede', 'override', 'rewrite', 'split'],
      watch_presets: ['default', 'verbose', 'failures', 'status'],
      assistant: this.assistantService.getDiagnostics(),
      natural_language_enabled: true,
      supervisor: {
        active_sessions: activeSupervisorSessions,
        agent_runtime: {
          active_runs: this.supervisorRuns?.listActive().map((run) => ({
            run_id: run.id,
            transport: run.transport,
            conversation_id: run.conversation_id,
            state: run.state,
            repo_ref: run.repo_ref,
            active_issue_id: run.active_issue_id,
            step_count: run.step_count,
            updated_at: run.updated_at.toISOString(),
          })) ?? [],
          pending_actions: this.supervisorRuns?.listActive().flatMap((run) =>
            this.supervisorPendingActions?.findByRun(run.id)
              .filter((action) => action.status === 'pending_confirm')
              .map((action) => ({
                run_id: run.id,
                tool_name: action.tool_name,
                status: action.status,
                expires_at: action.expires_at.toISOString(),
              })) ?? []
          ) ?? [],
        },
        repo_sources: this.supervisorRepoSourceResolver?.getDiagnostics(
          this.projectResolver?.listConfiguredRoutes() ?? [],
        ) ?? [],
        repo_advisor_sessions: this.supervisorAgentService?.getRepoConversationDiagnostics?.() ?? [],
      },
    };
  }

  async initializeInboundIntegration(params: {
    localBaseUrl: string;
    inboundPath?: string;
  }): Promise<void> {
    const localBaseUrl = params.localBaseUrl.replace(/\/+$/, '');
    this.supervisorClaudeRuntime?.setContextEndpoint?.(`${localBaseUrl}/api/v1/bots/supervisor-context/call`);
    this.supervisorClaudeRuntime?.setOrchestratorEndpoint?.(`${localBaseUrl}/api/v1/bots/supervisor-orchestrator/call`);

    if (!this.telegramBootstrap) {
      return;
    }

    try {
      const result = await this.telegramBootstrap.bootstrap({
        localBaseUrl: params.localBaseUrl,
        inboundPath: params.inboundPath ?? '/api/v1/bots/telegram/webhook',
      });
      if (result.publicBaseUrl) {
        this.telegramPublicBaseUrl = normalizePublicBaseUrl(result.publicBaseUrl);
        this.telegramWebhookUsedTunnel = result.usedTunnel;
      }
      await this.telegramDiagnostics.refreshNow();
    } catch (error) {
      logger.warn('Telegram inbound bootstrap failed', {
        local_base_url: params.localBaseUrl,
      }, error instanceof Error ? error : undefined);
    }
  }

  dispose(): void {
    if (this.startupRepairTimer) {
      clearTimeout(this.startupRepairTimer);
      this.startupRepairTimer = null;
    }
    for (const pending of this.pendingTelegramTextResponses.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingTelegramTextResponses.clear();
    this.activeTelegramTextResponseKeys.clear();
    this.queuedTelegramTextResponses.clear();
    this.subscriptions.dispose();
    this.followups?.dispose();
    this.supervisorWorker?.dispose();
    this.supervisorJobLoop?.dispose();
    this.supervisorSessionService?.dispose();
    void this.supervisorAgentService?.disposeRepoConversations?.();
    void this.supervisorClaudeRuntime?.dispose?.();
    void this.telegramBootstrap?.dispose();
  }

  async handleSupervisorContextTool(
    body: unknown,
    headers: Headers | Record<string, string | undefined> = {},
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    if (!this.supervisorContextBroker) {
      return {
        ok: false,
        status: 503,
        body: { ok: false, error: 'Supervisor context broker is not configured' },
      };
    }

    const expectedToken = this.supervisorClaudeRuntime?.getContextToken?.() ?? null;
    if (expectedToken) {
      const receivedToken = getHeaderValue(headers, 'x-supervisor-context-token');
      if (receivedToken !== expectedToken) {
        return {
          ok: false,
          status: 403,
          body: { ok: false, error: 'Invalid supervisor context token' },
        };
      }
    }

    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const toolName = typeof payload.tool === 'string'
      ? payload.tool
      : typeof payload.name === 'string'
        ? payload.name
        : null;
    if (!toolName || !(SUPERVISOR_CONTEXT_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'Unknown supervisor context tool' },
      };
    }

    const rawArguments = payload.arguments ?? payload.args;
    const args = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
      ? rawArguments as Record<string, unknown>
      : {};
    const rawContext = payload.context && typeof payload.context === 'object'
      ? payload.context as Record<string, unknown>
      : {};
    const transport = rawContext.transport === 'discord' ? 'discord' : 'telegram';
    const conversationId = typeof rawContext.conversation_id === 'string' && rawContext.conversation_id.trim()
      ? rawContext.conversation_id.trim()
      : 'supervisor-context';
    const text = typeof payload.text === 'string'
      ? payload.text
      : typeof args.text === 'string'
        ? args.text
        : undefined;

    try {
      const result = await this.supervisorContextBroker.callTool(
        toolName as SupervisorContextToolName,
        args,
        {
          context: {
            transport,
            recipient: {
              transport,
              conversation_id: conversationId,
            },
            identity: {
              user_id: typeof rawContext.user_id === 'string' ? rawContext.user_id : null,
              display_name: typeof rawContext.display_name === 'string' ? rawContext.display_name : null,
            },
          },
          text,
        },
      );
      return {
        ok: true,
        status: 200,
        body: { ok: true, result },
      };
    } catch (error) {
      return {
        ok: false,
        status: 400,
        body: {
          ok: false,
          error: error instanceof Error ? error.message : 'Supervisor context tool failed',
        },
      };
    }
  }

  async handleSupervisorOrchestratorTool(
    body: unknown,
    headers: Headers | Record<string, string | undefined> = {},
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    if (!this.supervisorOrchestratorBroker) {
      return {
        ok: false,
        status: 503,
        body: { ok: false, error: 'Supervisor orchestrator broker is not configured' },
      };
    }

    const expectedToken = this.supervisorClaudeRuntime?.getContextToken?.() ?? null;
    if (expectedToken) {
      const receivedToken = getHeaderValue(headers, 'x-supervisor-orchestrator-token');
      if (receivedToken !== expectedToken) {
        return {
          ok: false,
          status: 403,
          body: { ok: false, error: 'Invalid supervisor orchestrator token' },
        };
      }
    }

    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const toolName = typeof payload.tool === 'string'
      ? payload.tool
      : typeof payload.name === 'string'
        ? payload.name
        : null;
    if (!toolName || !(SUPERVISOR_ORCHESTRATOR_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'Unknown supervisor orchestrator tool' },
      };
    }

    const rawArguments = payload.arguments ?? payload.args;
    const args = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
      ? rawArguments as Record<string, unknown>
      : {};
    const rawContext = payload.context && typeof payload.context === 'object'
      ? payload.context as Record<string, unknown>
      : {};
    const transport = rawContext.transport === 'discord' ? 'discord' : 'telegram';
    const conversationId = typeof rawContext.conversation_id === 'string' && rawContext.conversation_id.trim()
      ? rawContext.conversation_id.trim()
      : 'supervisor-orchestrator';
    const text = typeof payload.text === 'string'
      ? payload.text
      : typeof args.text === 'string'
        ? args.text
        : undefined;
    const repoRef = typeof rawContext.repo_ref === 'string' && rawContext.repo_ref.trim()
      ? rawContext.repo_ref.trim()
      : null;

    try {
      const result = await this.supervisorOrchestratorBroker.callTool(
        toolName as SupervisorOrchestratorToolName,
        args,
        {
          context: {
            transport,
            recipient: {
              transport,
              conversation_id: conversationId,
            },
            identity: {
              user_id: typeof rawContext.user_id === 'string' ? rawContext.user_id : null,
              display_name: typeof rawContext.display_name === 'string' ? rawContext.display_name : null,
            },
          },
          text,
          repoRef,
          canWrite: true,
        },
      );
      return {
        ok: true,
        status: 200,
        body: { ok: true, result },
      };
    } catch (error) {
      return {
        ok: false,
        status: 400,
        body: {
          ok: false,
          error: error instanceof Error ? error.message : 'Supervisor orchestrator tool failed',
        },
      };
    }
  }

  async handleTelegramWebhook(
    body: unknown,
    headers: Headers | Record<string, string | undefined> = {},
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    if (!this.telegramNotifier) {
      return {
        ok: false,
        status: 503,
        body: { ok: false, error: 'Telegram adapter is not configured' },
      };
    }

    if (this.telegramConfig.webhookSecret) {
      const receivedSecret = getHeaderValue(headers, 'x-telegram-bot-api-secret-token');
      if (receivedSecret !== this.telegramConfig.webhookSecret) {
        return {
          ok: false,
          status: 401,
          body: { ok: false, error: 'Invalid Telegram webhook secret' },
        };
      }
    }

    const update = body as TelegramUpdate;
    const updateId = update.update_id !== undefined && update.update_id !== null ? String(update.update_id) : null;
    if (updateId && this.seenTelegramUpdateIds.has(updateId)) {
      logger.info('Telegram duplicate update ignored', { update_id: updateId });
      return {
        ok: true,
        status: 200,
        body: { ok: true, duplicate: true },
      };
    }
    if (updateId) {
      this.rememberTelegramUpdateId(updateId);
    }

    const callbackQuery = update.callback_query;
    if (callbackQuery?.data) {
      const chatId = callbackQuery.message?.chat?.id;
      if (chatId === undefined || chatId === null) {
        return {
          ok: true,
          status: 200,
          body: { ok: true, ignored: true },
        };
      }

      const conversationId = String(chatId);
      const messageId = callbackQuery.message?.message_id;
      const existingCardState =
        messageId !== undefined && messageId !== null
          ? this.followupMessageStates?.findByConversationMessageId({
              transport: 'telegram',
              conversation_id: conversationId,
              message_id: String(messageId),
            }) ?? null
          : null;
      const parsedCallback = this.parseTelegramCallbackData(callbackQuery.data);
      const callbackIssue = this.resolveTelegramCallbackIssue({
        conversationId,
        existingCardState,
        issueIdentifier: parsedCallback.issueIdentifier,
      });
      const auditBase = {
        callback_id: callbackQuery.id ? String(callbackQuery.id) : null,
        chat_id: conversationId,
        message_id: messageId !== undefined && messageId !== null ? String(messageId) : null,
        callback_data: callbackQuery.data,
        issue_id: callbackIssue?.issue_id ?? existingCardState?.issue_id ?? null,
        action_kind: parsedCallback.kind,
      } satisfies Omit<TelegramCallbackAuditRecord, 'result' | 'error_message' | 'timestamp'>;

      this.recordTelegramCallbackAudit({
        ...auditBase,
        result: 'received',
        error_message: null,
        timestamp: new Date().toISOString(),
      });
      this.recordTelegramCallbackAudit({
        ...auditBase,
        result: 'parsed',
        error_message: null,
        timestamp: new Date().toISOString(),
      });

      const context = {
        transport: 'telegram' as const,
        recipient: {
          transport: 'telegram' as const,
          conversation_id: conversationId,
        },
        identity: {
          user_id: callbackQuery.from?.id ? String(callbackQuery.from.id) : null,
          display_name:
            callbackQuery.from?.username ||
            [callbackQuery.from?.first_name, callbackQuery.from?.last_name].filter(Boolean).join(' ') ||
            null,
        },
      };

      let releaseRuntimeCallbackCardLock: (() => void) | null = null;
      try {
        if (parsedCallback.kind === 'runtime_action' && parsedCallback.runtimeAction === 'open') {
          const appUrl = parsedCallback.issueIdentifier
            ? resolveTelegramActionUrl(
                `/runtime/issues/${encodeURIComponent(parsedCallback.issueIdentifier)}/app`,
                this.telegramPublicBaseUrl,
              )
            : null;
          await this.telegramNotifier.answerCallbackQuery(
            callbackQuery.id || 'unknown-callback',
            appUrl
              ? textForIssueLocale(callbackIssue, '运行视图地址已恢复，请刷新卡片后打开。', 'Runtime view URL is ready. Refresh the card, then open it again.')
              : textForIssueLocale(callbackIssue, 'Mini App 暂时不可用：未配置 SYMHARIX_PUBLIC_BASE_URL（兼容旧名 SYMPHONY_PUBLIC_BASE_URL）。启动 start:local/tunnel 后刷新卡片。', 'Mini App unavailable: SYMHARIX_PUBLIC_BASE_URL is not configured (legacy SYMPHONY_PUBLIC_BASE_URL is also accepted). Start the local tunnel, then refresh the card.'),
          );
          this.recordTelegramCallbackAudit({
            ...auditBase,
            result: 'acked',
            error_message: null,
            timestamp: new Date().toISOString(),
          });
          this.telegramDiagnostics.recordCallbackSuccess();
          return {
            ok: true,
            status: 200,
            body: { ok: true },
          };
        }

        if (parsedCallback.kind === 'supervisor_action') {
          const recipient = {
            transport: 'telegram' as const,
            conversation_id: conversationId,
          };
          const supervisorResult = await this.handleSupervisorCallback({
            context,
            parsed: parsedCallback,
          });
          await this.telegramNotifier.answerCallbackQuery(
            callbackQuery.id || 'unknown-callback',
            supervisorResult.toastText,
          );
          this.recordTelegramCallbackAudit({
            ...auditBase,
            result: 'acked',
            error_message: null,
            timestamp: new Date().toISOString(),
          });
          const delivered = await this.deliverTelegramCallbackMessage({
            recipient,
            originalMessageId: messageId !== undefined && messageId !== null ? String(messageId) : null,
            message: supervisorResult.outbound,
            issue: callbackIssue,
            materialKey: supervisorResult.materialKey,
            allowFallback: false,
          });
          this.recordTelegramCallbackAudit({
            ...auditBase,
            result: telegramCallbackDeliveryResult(delivered.mode),
            error_message: null,
            timestamp: new Date().toISOString(),
          });
          if (supervisorResult.sessionId) {
            this.supervisorSessionService?.recordOutboundMessage(
              supervisorResult.sessionId,
              delivered.ref.provider_message_id,
              supervisorResult.materialKey,
            );
          }
          this.telegramDiagnostics.recordCallbackSuccess();
          return {
            ok: true,
            status: 200,
            body: { ok: true },
          };
        }

        releaseRuntimeCallbackCardLock = parsedCallback.kind === 'confirm_pending'
          ? this.runtimeIssueCardLock.acquireConversation({
              transport: 'telegram',
              conversation_id: conversationId,
            })
          : null;
        const callbackResult = await this.handleTelegramCallback(
          context,
          parsedCallback,
          callbackIssue,
          existingCardState,
          messageId !== undefined && messageId !== null ? String(messageId) : null,
          callbackQuery.message?.text ?? callbackQuery.message?.caption ?? null,
        );
        const recipient = {
          transport: 'telegram' as const,
          conversation_id: conversationId,
        };

        try {
          await this.telegramNotifier.answerCallbackQuery(
            callbackQuery.id || 'unknown-callback',
            callbackResult.toastText,
          );
          this.recordTelegramCallbackAudit({
            ...auditBase,
            result: 'acked',
            error_message: null,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          logger.warn('Telegram callback toast failed', {
            callback_id: callbackQuery.id || 'unknown-callback',
            chat_id: conversationId,
          }, error instanceof Error ? error : undefined);
        }

        const delivered = await this.deliverTelegramCallbackMessage({
          recipient,
          originalMessageId: messageId !== undefined && messageId !== null ? String(messageId) : null,
          message: callbackResult.outbound,
          issue: callbackResult.issue,
          materialKey: callbackResult.cardKey,
        });

        this.recordTelegramCallbackAudit({
          ...auditBase,
          result: telegramCallbackDeliveryResult(delivered.mode),
          error_message: null,
          timestamp: new Date().toISOString(),
        });

        if (callbackResult.issue) {
          this.persistFollowupMessageState({
            conversationId,
            issue: callbackResult.issue,
            deliveredMessageId: delivered.ref.provider_message_id,
            cardKind: callbackResult.cardKind,
            cardState: callbackResult.cardState,
            cardKey: callbackResult.cardKey,
            existingCardState,
          });
        }

        if (callbackResult.executeAfterAck?.pendingAction && callbackResult.issue) {
          this.recordTelegramCallbackAudit({
            ...auditBase,
            result: 'executing',
            error_message: null,
            timestamp: new Date().toISOString(),
          });
          this.runTelegramPendingAction({
            context,
            recipient,
            originalMessageId: delivered.ref.provider_message_id,
            pendingAction: callbackResult.executeAfterAck.pendingAction,
            actionLabel: callbackResult.executeAfterAck.actionLabel,
            issue: callbackResult.executeAfterAck.issue,
            existingCardState,
            auditBase,
          });
        }

        this.telegramDiagnostics.recordCallbackSuccess();
        releaseRuntimeCallbackCardLock?.();
        releaseRuntimeCallbackCardLock = null;
      } catch (error) {
        releaseRuntimeCallbackCardLock?.();
        releaseRuntimeCallbackCardLock = null;
        this.telegramDiagnostics.recordCallbackFailure(error instanceof Error ? error : null);
        this.recordTelegramCallbackAudit({
          ...auditBase,
          result: 'failed',
          error_message: error instanceof Error ? error.message : 'unknown telegram callback failure',
          timestamp: new Date().toISOString(),
        });

        try {
          await this.telegramNotifier.answerCallbackQuery(
            callbackQuery.id || 'unknown-callback',
            '执行失败，请稍后重试',
          );
        } catch (toastError) {
          logger.warn('Telegram callback failure toast failed', {
            callback_id: callbackQuery.id || 'unknown-callback',
            chat_id: conversationId,
          }, toastError instanceof Error ? toastError : undefined);
        }

        try {
          await this.telegramNotifier.sendMessage(
            {
              transport: 'telegram',
              conversation_id: conversationId,
            },
            {
              text: `处理 Telegram 按钮时失败：${error instanceof Error ? error.message : 'unknown error'}`,
            },
          );
        } catch (sendError) {
          logger.error('Telegram callback fallback message failed', {
            callback_id: callbackQuery.id || 'unknown-callback',
            chat_id: conversationId,
          }, sendError instanceof Error ? sendError : undefined);
        }
      }

      return {
        ok: true,
        status: 200,
        body: { ok: true },
      };
    }

    const message = update.message ?? update.edited_message;
    const text = message?.text?.trim() || '';
    const chatId = message?.chat?.id;
    if (!text || chatId === undefined || chatId === null) {
      return {
        ok: true,
        status: 200,
        body: { ok: true, ignored: true },
      };
    }

    const context = {
      transport: 'telegram' as const,
      recipient: {
        transport: 'telegram' as const,
        conversation_id: String(chatId),
      },
      identity: {
        user_id: message?.from?.id ? String(message.from.id) : null,
        display_name:
          message?.from?.username ||
          [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(' ') ||
          null,
      },
      message_id: message?.message_id ?? null,
    };
    this.queueTelegramTextResponse(context, text);

    return {
      ok: true,
      status: 200,
      body: { ok: true },
    };
  }

  private rememberTelegramUpdateId(updateId: string): void {
    this.seenTelegramUpdateIds.add(updateId);
    this.seenTelegramUpdateOrder.push(updateId);
    while (this.seenTelegramUpdateOrder.length > 1_000) {
      const expired = this.seenTelegramUpdateOrder.shift();
      if (expired) {
        this.seenTelegramUpdateIds.delete(expired);
      }
    }
  }

  private async handleRuntimeIssueCardAction(
    context: BotCommandContext,
    issue: RuntimeIssueView | null,
    parsed: {
      issueIdentifier: string;
      runtimeAction?: TelegramRuntimeAction | null;
    },
  ): Promise<BotCommandResponse> {
    if (!this.supervisorAgentRuntime) {
      return {
        message: '这张运行卡暂时不能直接执行按钮动作。你可以直接回复“查看当前 issue”或“重试 INT-xxx”。',
      };
    }
    const english = issue?.supervisor_locale === 'en';
    const text = (() => {
      switch (parsed.runtimeAction) {
        case 'retry':
          return english ? `retry ${parsed.issueIdentifier}` : `重试 ${parsed.issueIdentifier}`;
        case 'stop':
          return english ? `stop ${parsed.issueIdentifier}` : `停止 ${parsed.issueIdentifier}`;
        case 'close':
          return english ? `clean up GitHub and Linear residue for ${parsed.issueIdentifier}` : `清理 ${parsed.issueIdentifier} 的 GitHub 和 Linear 残留垃圾`;
        case 'refresh':
        default:
          return english ? `${parsed.issueIdentifier} card` : `${parsed.issueIdentifier} 卡片`;
      }
    })();
    return this.supervisorAgentRuntime.respond({
      context,
      text,
      canWrite: this.botWriteAuthorizer(context),
    });
  }

  private async handleTelegramCallback(
    context: BotCommandContext,
    parsed: {
      kind: TelegramCallbackKind;
      issueIdentifier: string | null;
      ordinal: number | null;
      runtimeAction?: TelegramRuntimeAction | null;
    },
    issue: RuntimeIssueView | null,
    existingCardState: ReturnType<BotFollowupMessageStateRepository['findByConversationIssue']> | null,
    originalMessageId: string | null,
    originalMessageText: string | null,
  ): Promise<{
    outbound: BotTransportMessage;
    toastText: string;
    issue: RuntimeIssueView | null;
    cardKind?: BotFollowupCardKind;
    cardState: 'open' | 'confirming' | 'executing' | 'waiting_on_child' | 'resolved' | 'failed';
    cardKey: string;
    executeAfterAck?: {
      pendingAction: ReturnType<BotPendingActionRepository['findByConversationIssue']>;
      actionLabel: string;
      issue: RuntimeIssueView;
    } | null;
  }> {
    if (parsed.kind === 'runtime_action' && parsed.issueIdentifier) {
      const response = await this.handleRuntimeIssueCardAction(context, issue, parsed);
      const responseIssue = response.issue_id
        ? this.runtime.getIssue(response.issue_id)
        : issue;
      const outbound = {
        text: response.message,
        caption: response.caption,
        format: response.format,
        media_key: response.media_key ?? null,
        photo: response.photo ?? null,
        show_caption_above_media: response.show_caption_above_media,
        actions: response.actions,
        action_rows: response.action_rows,
      };
      const english = responseIssue?.supervisor_locale === 'en' || issue?.supervisor_locale === 'en';
      return {
        outbound,
        toastText: parsed.runtimeAction === 'refresh'
          ? english ? 'Refreshed' : '已刷新'
          : parsed.runtimeAction === 'close'
            ? english ? 'Confirmation ready' : '已准备确认'
            : english ? 'Got it. Processing' : '已收到，正在处理',
        issue: responseIssue,
        cardKind: 'runtime_issue',
        cardState: runtimeIssueCardStateForResponse(response, responseIssue),
        cardKey: response.media_key ?? `runtime_issue_card|${parsed.issueIdentifier}|${parsed.runtimeAction ?? 'action'}`,
        executeAfterAck: null,
      };
    }

    if (parsed.kind === 'select_governance_action' && parsed.issueIdentifier && parsed.ordinal) {
      if (!issue || !this.pendingActions) {
        const response = await this.assistantService.respondToText(
          context,
          `${parsed.issueIdentifier} ${parsed.ordinal}`,
        );
        const fallbackIssue = this.buildFallbackGovernanceIssue(issue, parsed.issueIdentifier, existingCardState);
        return {
          outbound: buildGovernanceConfirmingMessage({
            issue: fallbackIssue,
            actionLabel: textForIssueLocale(fallbackIssue, '执行治理动作', 'Run governance action'),
            confirmationSummary: response.message,
            notice: existingCardState ? null : textForIssueLocale(fallbackIssue, '原卡片状态已丢失，已重新生成确认卡。', 'The original card state was lost, so I regenerated the confirmation card.'),
          }),
          toastText: textForIssueLocale(fallbackIssue, '已收到，正在准备确认', 'Got it. Preparing confirmation'),
          issue: fallbackIssue,
          cardState: 'confirming',
          cardKey: `confirming|${buildGovernanceCardKey(fallbackIssue)}`,
          executeAfterAck: null,
        };
      }

      const selectedAction = resolveGovernanceQuickActionByOrdinal(issue, parsed.ordinal);
      if (!selectedAction) {
        return {
          outbound: {
            text: textForIssueLocale(issue, '没有找到对应的治理动作，请直接回复你的想法。', 'I could not find that governance action. Please reply with what you want to do.'),
          },
          toastText: textForIssueLocale(issue, '未找到动作', 'Action not found'),
          issue,
          cardState: issue.governance_thread_state === 'waiting_on_child' ? 'waiting_on_child' : 'open',
          cardKey: buildGovernanceCardKey(issue),
          executeAfterAck: null,
        };
      }

      const pendingRequest = this.buildGovernanceQuickActionRequest(selectedAction);
      const confirmationSummary = this.buildGovernanceQuickActionSummary(issue, selectedAction);
      this.pendingActions.upsert({
        transport: context.transport,
        conversation_id: context.recipient.conversation_id,
        issue_id: issue.issue_id,
        user_id: context.identity.user_id,
        intent_kind: pendingRequest.intentKind,
        normalized_payload: pendingRequest.request,
        summary_message: confirmationSummary,
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        status: 'pending_confirm',
        message_id: originalMessageId,
        card_key: existingCardState?.card_key ?? buildGovernanceCardKey(issue),
      });

      return {
        outbound: buildGovernanceConfirmingMessage({
          issue,
          actionLabel: selectedAction.label,
          confirmationSummary,
          notice: existingCardState ? null : textForIssueLocale(issue, '原卡片状态已丢失，已重新生成确认卡。', 'The original card state was lost, so I regenerated the confirmation card.'),
        }),
        toastText: textForIssueLocale(issue, '已收到，正在准备确认', 'Got it. Preparing confirmation'),
        issue,
        cardState: 'confirming',
        cardKey: `confirming|${buildGovernanceCardKey(issue)}`,
        executeAfterAck: null,
      };
    }

    if (parsed.kind === 'confirm_pending') {
      const pendingAction = this.resolvePendingActionForCallback(
        context,
        issue,
        existingCardState,
        originalMessageId,
        originalMessageText,
      );
      if (!pendingAction || !this.pendingActions) {
        const runtimeResult = await this.handleSupervisorRuntimePendingCallback(context, 'confirm');
        if (runtimeResult) {
          return runtimeResult;
        }
        const locale = this.resolveTelegramCallbackLocale({
          context,
          issue,
          existingCardState,
          parsed,
          originalMessageText,
        });
        return {
          outbound: {
            text: textForLocale(
              locale,
              '这张治理卡已经失效，请直接发送“现在是什么单子？”或重新查看当前待处理线程。',
              'This governance card has expired. Send "what issue is active?" or reopen the current pending thread.',
            ),
          },
          toastText: textForLocale(locale, '这张卡已失效', 'This card expired'),
          issue: null,
          cardState: 'resolved',
          cardKey: 'stale_pending_confirm',
          executeAfterAck: null,
        };
      }

      const pendingRequestIssueId = getPendingActionRequestIssueId(pendingAction);
      const executingIssue = issue
        ?? (pendingAction.issue_id ? this.runtime.getIssue(pendingAction.issue_id) : null)
        ?? this.runtime.getIssue(pendingRequestIssueId ?? '')
        ?? this.buildFallbackGovernanceIssue(null, pendingRequestIssueId ?? parsed.issueIdentifier, existingCardState);
      const actionLabel = this.describePendingAction(pendingAction, executingIssue);
      this.persistPendingAction(pendingAction, {
        status: 'executing',
        message_id: originalMessageId ?? pendingAction.message_id ?? null,
        card_key: `executing|${buildGovernanceCardKey(executingIssue)}`,
      });

      return {
        outbound: buildGovernanceExecutingMessage(executingIssue, {
          actionLabel,
          notice: existingCardState ? null : textForIssueLocale(executingIssue, '原卡片状态已丢失，已重新生成执行卡。', 'The original card state was lost, so I regenerated the execution card.'),
        }),
        toastText: textForIssueLocale(executingIssue, '已收到，正在执行', 'Got it. Running'),
        issue: executingIssue,
        cardState: 'executing',
        cardKey: `executing|${buildGovernanceCardKey(executingIssue)}`,
        executeAfterAck: {
          pendingAction: this.pendingActions.findByConversationIssue({
            transport: context.transport,
            conversation_id: context.recipient.conversation_id,
            issue_id: pendingAction.issue_id,
          }),
          actionLabel,
          issue: executingIssue,
        },
      };
    }

    if (parsed.kind === 'cancel_pending') {
      const pendingAction = this.resolvePendingActionForCallback(
        context,
        issue,
        existingCardState,
        originalMessageId,
        originalMessageText,
      );
      if (!pendingAction || !this.pendingActions) {
        const runtimeResult = await this.handleSupervisorRuntimePendingCallback(context, 'cancel');
        if (runtimeResult) {
          return runtimeResult;
        }
        const locale = this.resolveTelegramCallbackLocale({
          context,
          issue,
          existingCardState,
          parsed,
          originalMessageText,
        });
        return {
          outbound: {
            text: textForLocale(
              locale,
              '这张治理卡已经失效，不需要再取消了。请直接发送“现在是什么单子？”查看当前线程。',
              'This governance card has expired; there is nothing left to cancel. Send "what issue is active?" to view the current thread.',
            ),
          },
          toastText: textForLocale(locale, '这张卡已失效', 'This card expired'),
          issue: null,
          cardState: 'resolved',
          cardKey: 'stale_pending_cancel',
          executeAfterAck: null,
        };
      } else {
        this.persistPendingAction(pendingAction, {
          status: 'cancelled',
          message_id: originalMessageId ?? pendingAction.message_id ?? null,
        });
      }

      const pendingRequestIssueId = getPendingActionRequestIssueId(pendingAction);
      const fallbackIssue = issue
        ?? (pendingAction.issue_id ? this.runtime.getIssue(pendingAction.issue_id) : null)
        ?? this.runtime.getIssue(pendingRequestIssueId ?? '')
        ?? this.buildFallbackGovernanceIssue(issue, pendingRequestIssueId ?? parsed.issueIdentifier, existingCardState);
      if (fallbackIssue.governance_thread_state === 'waiting_on_child') {
        return {
          outbound: buildGovernanceWaitingOnChildMessage(fallbackIssue, {
            notice: textForIssueLocale(fallbackIssue, '已取消这次治理动作，源单仍在等待子任务。', 'Cancelled this governance action; the source issue is still waiting on the child task.'),
          }),
          toastText: textForIssueLocale(fallbackIssue, '已取消', 'Cancelled'),
          issue: fallbackIssue,
          cardState: 'waiting_on_child',
          cardKey: buildGovernanceCardKey(fallbackIssue),
          executeAfterAck: null,
        };
      }

      if (isGovernanceBlockedIssue(fallbackIssue)) {
        return {
          outbound: buildGovernanceBlockedMessage(fallbackIssue),
          toastText: textForIssueLocale(fallbackIssue, '已取消', 'Cancelled'),
          issue: fallbackIssue,
          cardState: 'open',
          cardKey: buildGovernanceCardKey(fallbackIssue),
          executeAfterAck: null,
        };
      }

      return {
        outbound: buildGovernanceResolvedMessage(fallbackIssue, {
          resultSummary: textForIssueLocale(fallbackIssue, '已取消当前治理操作。', 'Cancelled the current governance action.'),
        }),
        toastText: textForIssueLocale(fallbackIssue, '已取消', 'Cancelled'),
        issue: fallbackIssue,
        cardState: 'resolved',
        cardKey: `resolved|${buildGovernanceCardKey(fallbackIssue)}`,
        executeAfterAck: null,
      };
    }

    const fallbackIssue = this.buildFallbackGovernanceIssue(issue, parsed.issueIdentifier, existingCardState);
    return {
      outbound: {
        text: '暂时无法识别这个 Telegram 按钮动作，请直接回复你的想法。',
      },
      toastText: '已收到',
      issue: fallbackIssue,
      cardState: fallbackIssue.governance_thread_state === 'waiting_on_child' ? 'waiting_on_child' : 'open',
      cardKey: buildGovernanceCardKey(fallbackIssue),
      executeAfterAck: null,
    };
  }

  private async handleSupervisorRuntimePendingCallback(
    context: BotCommandContext,
    action: 'confirm' | 'cancel',
  ): Promise<{
    outbound: BotTransportMessage;
    toastText: string;
    issue: RuntimeIssueView | null;
    cardKind?: BotFollowupCardKind;
    cardState: 'open' | 'confirming' | 'executing' | 'waiting_on_child' | 'resolved' | 'failed';
    cardKey: string;
    executeAfterAck: null;
  } | null> {
    const pending = this.supervisorPendingActions?.findOpenByConversation({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    }) ?? null;
    if (!pending || !this.supervisorAgentRuntime) {
      return null;
    }

    const pendingIssueId = typeof pending.tool_args.issue_id === 'string' ? pending.tool_args.issue_id : null;
    const pendingIssue = pendingIssueId ? this.runtime.getIssue(pendingIssueId) : null;
    const text = action === 'confirm'
      ? textForIssueLocale(pendingIssue, '确认', 'Confirm')
      : textForIssueLocale(pendingIssue, '取消', 'Cancel');
    const releaseRuntimeConversationCardLock = this.runtimeIssueCardLock.acquireConversation({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    });
    let response: BotCommandResponse;
    try {
      response = await this.supervisorAgentRuntime.respond({
        context,
        text,
        canWrite: this.botWriteAuthorizer(context),
      });
    } finally {
      releaseRuntimeConversationCardLock();
    }
    const issueId = response.issue_id ?? pendingIssueId;
    const issue = issueId ? this.runtime.getIssue(issueId) : pendingIssue;
    const isRuntimeIssueCard = Boolean(response.photo && response.media_key && issue);
    return {
      outbound: {
        text: response.message,
        caption: response.caption,
        format: response.format,
        media_key: response.media_key ?? null,
        photo: response.photo ?? null,
        show_caption_above_media: response.show_caption_above_media,
        actions: response.actions,
        action_rows: response.action_rows,
      },
      toastText: action === 'confirm'
        ? textForIssueLocale(issue, '已执行', 'Executed')
        : textForIssueLocale(issue, '已取消', 'Cancelled'),
      issue,
      cardKind: isRuntimeIssueCard ? 'runtime_issue' : undefined,
      cardState: isRuntimeIssueCard
        ? runtimeIssueCardStateForResponse(response, issue)
        : action === 'confirm'
          ? 'resolved'
          : 'open',
      cardKey: response.media_key ?? `supervisor_runtime_${action === 'confirm' ? 'confirmed' : 'cancelled'}`,
      executeAfterAck: null,
    };
  }

  private parseTelegramCallbackData(data: string): {
    kind: TelegramCallbackKind;
    issueIdentifier: string | null;
    ordinal: number | null;
    sessionId?: string | null;
    supervisorAction?: 'approve' | 'edit' | 'alternate' | 'focus' | 'cancel' | null;
    runtimeAction?: TelegramRuntimeAction | null;
  } {
    if (data === 'pending|confirm') {
      return {
        kind: 'confirm_pending',
        issueIdentifier: null,
        ordinal: null,
      };
    }

    if (data === 'pending|cancel') {
      return {
        kind: 'cancel_pending',
        issueIdentifier: null,
        ordinal: null,
      };
    }

    const governanceSelection = data.match(/^govsel\|([A-Z][A-Z0-9]+-\d+)\|(\d+)$/i);
    if (governanceSelection?.[1] && governanceSelection?.[2]) {
      return {
        kind: 'select_governance_action',
        issueIdentifier: governanceSelection[1].toUpperCase(),
        ordinal: Number.parseInt(governanceSelection[2], 10),
        sessionId: null,
        supervisorAction: null,
      };
    }

    const supervisorSelection = data.match(/^sup\|([^|]+)\|(approve|edit|alternate|focus|cancel)$/i);
    if (supervisorSelection?.[1] && supervisorSelection?.[2]) {
      return {
        kind: 'supervisor_action',
        issueIdentifier: null,
        ordinal: null,
        sessionId: supervisorSelection[1],
        supervisorAction: supervisorSelection[2].toLowerCase() as 'approve' | 'edit' | 'alternate' | 'focus' | 'cancel',
        runtimeAction: null,
      };
    }

    const runtimeSelection = data.match(/^rt\|([A-Z][A-Z0-9]+-\d+)\|(refresh|retry|stop|close|open)$/i);
    if (runtimeSelection?.[1] && runtimeSelection?.[2]) {
      return {
        kind: 'runtime_action',
        issueIdentifier: runtimeSelection[1].toUpperCase(),
        ordinal: null,
        sessionId: null,
        supervisorAction: null,
        runtimeAction: runtimeSelection[2].toLowerCase() as TelegramRuntimeAction,
      };
    }

    return {
      kind: 'unknown',
      issueIdentifier: null,
      ordinal: null,
      sessionId: null,
      supervisorAction: null,
      runtimeAction: null,
    };
  }

  private async handleSupervisorCallback(params: {
    context: BotCommandContext;
    parsed: {
      sessionId?: string | null;
      supervisorAction?: 'approve' | 'edit' | 'alternate' | 'focus' | 'cancel' | null;
    };
  }): Promise<{
    outbound: BotTransportMessage;
    toastText: string;
    sessionId: string | null;
    materialKey: string | null;
  }> {
    if (!this.supervisorSessionService || !params.parsed.sessionId || !params.parsed.supervisorAction) {
      return {
        outbound: {
          text: '这条计划卡状态已经丢失。请直接回复你想继续做什么，我会重新接上当前线程。',
        },
        toastText: '计划状态已过期',
        sessionId: params.parsed.sessionId ?? null,
        materialKey: null,
      };
    }

    const response = await this.supervisorSessionService.respondToAction({
      context: params.context,
      sessionId: params.parsed.sessionId,
      action: params.parsed.supervisorAction,
      canWrite: createBotWriteAuthorizer({
        telegramOperatorIds: this.telegramConfig.operatorIds,
        discordOperatorIds: this.discordConfig.operatorIds,
      })(params.context),
    });
    return {
      outbound: {
        text: response.message,
        caption: response.caption,
        format: response.format,
        media_key: response.media_key ?? undefined,
        photo: response.photo,
        show_caption_above_media: response.show_caption_above_media,
        actions: response.actions,
        action_rows: response.action_rows,
      },
      toastText: inferRuntimeLocaleFromText(response.message) === 'en'
        ? 'Got it. Processing'
        : '已收到，正在处理',
      sessionId: response.session_id ?? params.parsed.sessionId ?? null,
      materialKey: response.material_key ?? null,
    };
  }

  private resolveTelegramCallbackIssue(params: {
    conversationId: string;
    existingCardState: ReturnType<BotFollowupMessageStateRepository['findByConversationIssue']> | null;
    issueIdentifier: string | null;
  }): ReturnType<RuntimeControlPlane['getIssue']> {
    if (params.existingCardState?.issue_id) {
      const issue = this.runtime.getIssue(params.existingCardState.issue_id);
      if (issue) {
        return issue;
      }
    }

    if (params.issueIdentifier) {
      const issue = this.runtime.getIssue(params.issueIdentifier);
      if (issue) {
        return issue;
      }
    }

    const openCards = this.followupMessageStates?.findOpenByConversation({
      transport: 'telegram',
      conversation_id: params.conversationId,
    }).filter((record) => record.card_kind === 'governance_blocked') ?? [];

    if (openCards.length === 1) {
      return this.runtime.getIssue(openCards[0]!.issue_id);
    }

    return null;
  }

  private async deliverTelegramCallbackMessage(params: {
    recipient: BotRecipient;
    originalMessageId: string | null;
    message: BotTransportMessage;
    issue?: RuntimeIssueView | null;
    materialKey?: string | null;
    source?: 'callback_update';
    allowFallback?: boolean;
  }): Promise<{ ref: BotTransportMessageRef; mode: TelegramCallbackDeliveryMode }> {
    const source = params.source ?? 'callback_update';
    const allowFallback = params.allowFallback ?? true;
    if (params.originalMessageId) {
      try {
        const ref = await this.telegramNotifier!.editMessage(
          params.recipient,
          {
            provider_message_id: params.originalMessageId,
          },
          params.message,
        );
        this.recordTransportEvent({
          recipient: params.recipient,
          issue: params.issue ?? null,
          source,
          action: 'edit',
          result: 'success',
          messageId: ref.provider_message_id,
          materialKey: params.materialKey ?? null,
        });
        return {
          ref,
          mode: 'edited',
        };
      } catch (error) {
        if (getBotMessageEditFailureKind(error) === 'not_modified') {
          this.recordTransportEvent({
            recipient: params.recipient,
            issue: params.issue ?? null,
            source,
            action: 'edit',
            result: 'success',
            messageId: params.originalMessageId,
            materialKey: params.materialKey ?? null,
          });
          return {
            ref: {
              provider_message_id: params.originalMessageId,
            },
            mode: 'edited',
          };
        }
        this.recordTransportEvent({
          recipient: params.recipient,
          issue: params.issue ?? null,
          source,
          action: 'edit',
          result: 'failed',
          messageId: params.originalMessageId,
          materialKey: params.materialKey ?? null,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        logger.warn('Telegram message edit failed', {
          conversation_id: params.recipient.conversation_id,
          message_id: params.originalMessageId,
        }, error instanceof Error ? error : undefined);
        if (!allowFallback || getBotMessageEditFailureKind(error) !== 'message_not_found') {
          logger.warn('Telegram callback kept original message to preserve one-card continuity', {
            conversation_id: params.recipient.conversation_id,
            message_id: params.originalMessageId,
            fallback_allowed: allowFallback,
            failure_kind: getBotMessageEditFailureKind(error) ?? 'unknown',
          }, error instanceof Error ? error : undefined);
          return {
            ref: {
              provider_message_id: params.originalMessageId,
            },
            mode: 'kept_original',
          };
        }
      }
    }

    const ref = await this.telegramNotifier!.sendMessage(params.recipient, params.message);
    this.recordTransportEvent({
      recipient: params.recipient,
      issue: params.issue ?? null,
      source,
      action: params.originalMessageId ? 'fallback' : 'send',
      result: 'success',
      messageId: ref.provider_message_id,
      materialKey: params.materialKey ?? null,
    });
    return {
      ref,
      mode: 'sent_fallback',
    };
  }

  private buildFallbackGovernanceIssue(
    issue: RuntimeIssueView | null,
    issueIdentifier: string | null,
    existingCardState: ReturnType<BotFollowupMessageStateRepository['findByConversationIssue']> | null,
  ): RuntimeIssueView {
    return issue ?? this.runtime.getIssue(issueIdentifier ?? '') ?? {
      issue_id: existingCardState?.issue_id ?? 'unknown',
      work_item_id: null,
      identifier: issueIdentifier ?? existingCardState?.issue_identifier ?? 'UNKNOWN',
      title: 'Governance action',
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      workspace_path: null,
      branch_name: null,
      github_repo: null,
      github_issue_number: null,
      active_pr_number: null,
      session: null,
      governance_status: 'blocked',
      governance_decision: 'split_before_implement',
      governance_summary: '当前治理动作还需要你确认。',
      governance_root_issue_id: existingCardState?.issue_id ?? 'unknown',
      governance_root_issue_identifier: issueIdentifier ?? existingCardState?.issue_identifier ?? 'UNKNOWN',
      governance_thread_state: 'blocked',
      governance_child_issues: [],
      next_recommended_action: null,
      active_governance_suggestions: [],
      actions: {
        can_stop: false,
        can_retry: false,
        can_override_governance: false,
        can_rewrite_governance: false,
        can_split_governance: false,
        can_open_pr: false,
      },
      created_at: null,
      updated_at: null,
    };
  }

  private buildGovernanceQuickActionRequest(action: GovernanceQuickActionSpec): {
    request: BotCommandRequest;
    intentKind: 'override' | 'rewrite' | 'split' | 'execute_governance_suggestion';
  } {
    switch (action.kind) {
      case 'override':
        return {
          request: { command: 'override', issue_id: action.issue_id },
          intentKind: 'override',
        };
      case 'rewrite':
        return {
          request: { command: 'rewrite', issue_id: action.issue_id },
          intentKind: 'rewrite',
        };
      case 'split':
        return {
          request: { command: 'split', issue_id: action.issue_id },
          intentKind: 'split',
        };
      case 'execute_suggestion':
        return {
          request: {
            command: 'execute_governance_suggestion',
            issue_id: action.issue_id,
            suggestion_id: action.suggestion_id,
          },
          intentKind: 'execute_governance_suggestion',
        };
    }
  }

  private buildGovernanceQuickActionSummary(issue: RuntimeIssueView, action: GovernanceQuickActionSpec): string {
    const locale = issueRuntimeLocale(issue);
    return [
      textForLocale(locale, `操作：${action.label}`, `Action: ${action.label}`),
      `Issue: ${issue.identifier}`,
      issue.github_repo ? textForLocale(locale, `仓库：${issue.github_repo}`, `Repository: ${issue.github_repo}`) : null,
      action.kind === 'execute_suggestion'
        ? textForLocale(locale, `建议：${action.suggestion_type} · ${action.suggestion_id}`, `Suggestion: ${action.suggestion_type} · ${action.suggestion_id}`)
        : null,
      textForLocale(locale, '确认后会立即执行这条治理动作。', 'This governance action will run immediately after confirmation.'),
    ].filter(Boolean).join('\n');
  }

  private resolveTelegramCallbackLocale(params: {
    context: BotCommandContext;
    issue: RuntimeIssueView | null;
    existingCardState: ReturnType<BotFollowupMessageStateRepository['findByConversationIssue']> | null;
    parsed: {
      issueIdentifier: string | null;
    };
    originalMessageText: string | null;
  }): RuntimeLocale {
    const directLocale = issueRuntimeLocale(params.issue);
    if (directLocale) {
      return directLocale;
    }

    const conversationFocus = this.conversationFocuses?.findByConversation({
      transport: params.context.transport,
      conversation_id: params.context.recipient.conversation_id,
    });
    const issueCandidates = [
      params.existingCardState?.issue_id ?? null,
      params.existingCardState?.issue_identifier ?? null,
      params.parsed.issueIdentifier,
      conversationFocus?.issue_id ?? null,
      conversationFocus?.issue_identifier ?? null,
    ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);

    for (const issueId of issueCandidates) {
      const locale = issueRuntimeLocale(this.runtime.getIssue(issueId));
      if (locale) {
        return locale;
      }
    }

    const originalText = params.originalMessageText?.trim();
    return originalText ? inferRuntimeLocaleFromText(originalText) : 'zh';
  }

  private resolvePendingActionForCallback(
    context: BotCommandContext,
    issue: RuntimeIssueView | null,
    existingCardState: ReturnType<BotFollowupMessageStateRepository['findByConversationIssue']> | null,
    originalMessageId: string | null,
    originalMessageText: string | null,
  ): ReturnType<BotPendingActionRepository['findByConversationIssue']> | null {
    if (!this.pendingActions) {
      return null;
    }
    if (existingCardState && ['resolved', 'failed'].includes(existingCardState.card_state)) {
      return null;
    }

    const key = {
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    } as const;

    const issueIds = [
      existingCardState?.issue_id ?? null,
      issue?.issue_id ?? null,
    ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);

    for (const issueId of issueIds) {
      const pending = this.pendingActions.findByConversationIssue({
        ...key,
        issue_id: issueId,
      });
      if (pending && ['pending_confirm', 'executing'].includes(pending.status)) {
        return pending;
      }
    }

    const genericPending = this.pendingActions.findByConversation(key);
    const genericPendingMatchesOriginalText = Boolean(
      genericPending &&
      !genericPending.message_id &&
      originalMessageText &&
      originalMessageText.includes(genericPending.summary_message),
    );
    if (
      genericPending &&
      ['pending_confirm', 'executing'].includes(genericPending.status) &&
      (!originalMessageId || genericPending.message_id === originalMessageId || genericPendingMatchesOriginalText)
    ) {
      return genericPending;
    }

    if (originalMessageId) {
      const sameMessagePending = this.pendingActions.findOpenByConversation(key)
        .filter((pending) => pending.message_id === originalMessageId);
      if (sameMessagePending.length === 1) {
        return sameMessagePending[0] ?? null;
      }
      return null;
    }

    return this.pendingActions.findLatestByConversation(key);
  }

  private persistPendingAction(
    pendingAction: NonNullable<ReturnType<BotPendingActionRepository['findByConversationIssue']>>,
    patch: {
      status: 'pending_confirm' | 'executing' | 'completed' | 'failed' | 'cancelled';
      message_id?: string | null;
      card_key?: string | null;
    },
  ): void {
    if (!this.pendingActions) {
      return;
    }

    this.pendingActions.upsert({
      transport: pendingAction.transport,
      conversation_id: pendingAction.conversation_id,
      issue_id: pendingAction.issue_id,
      user_id: pendingAction.user_id,
      intent_kind: pendingAction.intent_kind,
      normalized_payload: pendingAction.normalized_payload,
      summary_message: pendingAction.summary_message,
      expires_at: pendingAction.expires_at,
      status: patch.status,
      message_id: patch.message_id ?? pendingAction.message_id,
      card_key: patch.card_key ?? pendingAction.card_key,
    });
  }

  private bindPendingConfirmationToTelegramMessage(
    context: BotCommandContext,
    response: BotCommandResponse,
    messageRef: BotTransportMessageRef,
  ): void {
    if (!hasPendingConfirmationButtons(response)) {
      return;
    }

    const key = {
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    } as const;
    if (this.pendingActions) {
      const candidates = [
        response.issue_id
          ? this.pendingActions.findByConversationIssue({
              ...key,
              issue_id: response.issue_id,
            })
          : null,
        this.pendingActions.findLatestByConversation(key),
      ].filter((candidate, index, all): candidate is NonNullable<typeof candidate> => (
        Boolean(candidate) && all.findIndex((other) => (
          other?.transport === candidate?.transport &&
          other?.conversation_id === candidate?.conversation_id &&
          other?.issue_id === candidate?.issue_id
        )) === index
      ));

      const pending = candidates.find((candidate) => (
        candidate.status === 'pending_confirm' &&
        (
          candidate.summary_message === response.message ||
          response.message.includes(candidate.summary_message)
        )
      ));
      if (pending) {
        this.persistPendingAction(pending, {
          status: 'pending_confirm',
          message_id: messageRef.provider_message_id,
          card_key: pending.card_key,
        });
      }
    }

    const supervisorPending = this.supervisorPendingActions?.findOpenByConversation(key) ?? null;
    if (
      supervisorPending &&
      (
        supervisorPending.summary_message === response.message ||
        response.message.includes(supervisorPending.summary_message)
      )
    ) {
      this.supervisorPendingActions?.update({
        id: supervisorPending.id,
        telegram_message_id: messageRef.provider_message_id,
      });
    }
  }

  private async sendSupervisorRuntimeProgress(
    context: BotCommandContext,
    message: string,
  ): Promise<void> {
    if (context.transport !== 'telegram' || !this.telegramNotifier) {
      return;
    }
    const recipient = {
      transport: 'telegram' as const,
      conversation_id: context.recipient.conversation_id,
    };
    const sent = await this.telegramNotifier.sendMessage(recipient, {
      text: message,
    });
    this.recordTransportEvent({
      recipient,
      issue: null,
      source: 'sync_ack',
      action: 'send',
      result: 'success',
      messageId: sent.provider_message_id,
      materialKey: 'supervisor_runtime_progress',
    });
  }

  private persistFollowupMessageState(params: {
    conversationId: string;
    issue: RuntimeIssueView;
    deliveredMessageId: string;
    cardKind?: BotFollowupCardKind;
    cardState: 'open' | 'confirming' | 'executing' | 'waiting_on_child' | 'resolved' | 'failed';
    cardKey: string;
    existingCardState: ReturnType<BotFollowupMessageStateRepository['findByConversationIssue']> | null;
  }): void {
    if (!this.followupMessageStates) {
      return;
    }

    const record = {
      transport: 'telegram' as const,
      conversation_id: params.conversationId,
      issue_id: params.issue.issue_id,
      issue_identifier: params.issue.identifier,
      message_id: params.deliveredMessageId,
      card_kind: params.cardKind ?? 'governance_blocked',
      card_key: params.cardKey,
      card_state: params.cardState,
    };

    if (params.existingCardState) {
      this.followupMessageStates.updateState(record);
      this.rememberCallbackFocus(params.conversationId, params.issue, params.cardState);
      return;
    }

    this.followupMessageStates.upsert(record);
    this.rememberCallbackFocus(params.conversationId, params.issue, params.cardState);
  }

  private rememberCallbackFocus(
    conversationId: string,
    issue: RuntimeIssueView,
    cardState: 'open' | 'confirming' | 'executing' | 'waiting_on_child' | 'resolved' | 'failed',
  ): void {
    if (!this.conversationFocuses || cardState === 'resolved' || isTerminalIssue(issue)) {
      return;
    }
    this.conversationFocuses.upsert({
      transport: 'telegram',
      conversation_id: conversationId,
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      repo_ref: issue.github_repo,
      source: 'callback',
    });
  }

  private hasActiveRuntimeIssueCard(conversationId: string): boolean {
    return this.followupMessageStates?.findOpenByConversation({
      transport: 'telegram',
      conversation_id: conversationId,
    }).some((record) => record.card_kind === 'runtime_issue') ?? false;
  }

  private hasActiveSupervisorSessionCard(conversationId: string): boolean {
    return this.supervisorSessions?.findAll().some((session) => (
      session.transport === 'telegram'
      && session.conversation_id === conversationId
      && ACTIVE_SUPERVISOR_SESSION_CARD_STATES.has(session.state)
      && Boolean(session.last_message_id)
    )) ?? false;
  }

  private hasActiveRuntimePanel(conversationId: string): boolean {
    return this.hasActiveRuntimeIssueCard(conversationId) || this.hasActiveSupervisorSessionCard(conversationId);
  }

  private describePendingAction(
    pendingAction: NonNullable<ReturnType<BotPendingActionRepository['findByConversationIssue']>>,
    issue: RuntimeIssueView,
  ): string {
    const request = pendingAction.normalized_payload as BotCommandRequest;
    switch (request.command) {
      case 'split':
        return '按方案拆成两个任务';
      case 'rewrite':
        return '我想先改写需求';
      case 'override':
        return '强制继续开发';
      case 'execute_governance_suggestion': {
        const suggestion = issue.active_governance_suggestions?.find((item) => item.id === request.suggestion_id) ?? null;
        return suggestion ? `执行建议：${suggestion.title}` : '执行治理建议';
      }
      case 'dismiss_governance_suggestion':
        return '忽略这条治理建议';
      default:
        return pendingAction.summary_message.split('\n')[0] || '执行治理动作';
    }
  }

  private async executePendingRuntimeRequest(
    context: BotCommandContext,
    request: BotCommandRequest,
  ): Promise<RuntimeActionResult> {
    switch (request.command) {
      case 'split':
        return this.runtime.splitGovernance(request.issue_id ?? '');
      case 'rewrite':
        return this.runtime.rewriteGovernance(request.issue_id ?? '');
      case 'override':
        return this.runtime.overrideGovernance(request.issue_id ?? '');
      case 'execute_governance_suggestion':
        return this.runtime.executeGovernanceSuggestion(request.issue_id ?? '', request.suggestion_id ?? '');
      case 'dismiss_governance_suggestion':
        return this.runtime.dismissGovernanceSuggestion(request.issue_id ?? '', request.suggestion_id ?? '');
      default: {
        const response = await this.commandService.execute(context, request);
        return {
          accepted: true,
          status: 'accepted',
          message: response.message,
          issue_id: response.issue_id ?? request.issue_id ?? null,
          issue_identifier: response.issue_id ?? request.issue_id ?? null,
          governance_action: null,
        };
      }
    }
  }

  private buildGovernanceResultCard(params: {
    issue: RuntimeIssueView;
    result: RuntimeActionResult;
  }): {
    issue: RuntimeIssueView;
    message: BotTransportMessage;
    cardState: 'open' | 'waiting_on_child' | 'resolved' | 'failed';
    cardKey: string;
  } {
    const latestIssue = (params.result.issue_id ? this.runtime.getIssue(params.result.issue_id) : null) ?? params.issue;
    const governanceAction = params.result.governance_action;

    if (!params.result.accepted) {
      return {
        issue: latestIssue,
        message: buildGovernanceFailedMessage(latestIssue, {
          resultSummary: params.result.message,
        }),
        cardState: 'failed',
        cardKey: `failed|${buildGovernanceCardKey(latestIssue)}`,
      };
    }

    if (
      latestIssue.governance_thread_state === 'waiting_on_child' ||
      governanceAction?.outcome_kind === 'waiting_on_child' ||
      governanceAction?.outcome_kind === 'child_still_blocked'
    ) {
      return {
        issue: latestIssue,
        message: buildGovernanceWaitingOnChildMessage(latestIssue, {
          createdIssueIdentifiers: governanceAction?.created_issue_identifiers ?? [],
          nextRecommendedAction: governanceAction?.next_recommended_action ?? latestIssue.next_recommended_action ?? null,
          userSummary: governanceAction?.user_summary ?? params.result.message,
        }),
        cardState: 'waiting_on_child',
        cardKey: buildGovernanceCardKey(latestIssue),
      };
    }

    if (isGovernanceBlockedIssue(latestIssue)) {
      return {
        issue: latestIssue,
        message: buildGovernanceBlockedMessage(latestIssue),
        cardState: 'open',
        cardKey: buildGovernanceCardKey(latestIssue),
      };
    }

    return {
      issue: latestIssue,
      message: buildGovernanceResolvedMessage(latestIssue, {
        resultSummary: governanceAction?.user_summary ?? params.result.message,
      }),
      cardState: 'resolved',
      cardKey: `resolved|${buildGovernanceCardKey(latestIssue)}`,
    };
  }

  private runTelegramPendingAction(params: {
    context: BotCommandContext;
    recipient: BotRecipient;
    originalMessageId: string | null;
    pendingAction: NonNullable<ReturnType<BotPendingActionRepository['findByConversationIssue']>>;
    actionLabel: string;
    issue: RuntimeIssueView;
    existingCardState: ReturnType<BotFollowupMessageStateRepository['findByConversationIssue']> | null;
    auditBase: Omit<TelegramCallbackAuditRecord, 'result' | 'error_message' | 'timestamp'>;
  }): void {
    void (async () => {
      try {
        const request = params.pendingAction.normalized_payload as BotCommandRequest;
        const result = await this.executePendingRuntimeRequest(params.context, request);

        if (result.accepted && result.issue_id && params.context.transport === 'telegram') {
          this.followups?.registerOrigin({
            transport: params.context.transport,
            conversation_id: params.context.recipient.conversation_id,
            issue_id: result.issue_id,
            issue_identifier: result.issue_identifier ?? null,
            user_id: params.context.identity.user_id,
          });
        }

        const finalCard = this.buildGovernanceResultCard({
          issue: params.issue,
          result,
        });
        const delivered = await this.deliverTelegramCallbackMessage({
          recipient: params.recipient,
          originalMessageId: params.originalMessageId,
          message: finalCard.message,
          issue: finalCard.issue,
          materialKey: finalCard.cardKey,
        });

        this.recordTelegramCallbackAudit({
          ...params.auditBase,
          result: telegramCallbackDeliveryResult(delivered.mode),
          error_message: null,
          timestamp: new Date().toISOString(),
        });
        this.recordTelegramCallbackAudit({
          ...params.auditBase,
          result: 'completed',
          error_message: null,
          timestamp: new Date().toISOString(),
        });

        this.persistFollowupMessageState({
          conversationId: params.context.recipient.conversation_id,
          issue: finalCard.issue,
          deliveredMessageId: delivered.ref.provider_message_id,
          cardState: finalCard.cardState,
          cardKey: finalCard.cardKey,
          existingCardState: params.existingCardState,
        });
        this.persistPendingAction(params.pendingAction, {
          status: finalCard.cardState === 'failed' ? 'failed' : 'completed',
          message_id: delivered.ref.provider_message_id,
          card_key: finalCard.cardKey,
        });
      } catch (error) {
        const failureIssue = this.buildFallbackGovernanceIssue(params.issue, params.issue.identifier, params.existingCardState);
        try {
          const delivered = await this.deliverTelegramCallbackMessage({
            recipient: params.recipient,
            originalMessageId: params.originalMessageId,
            message: buildGovernanceFailedMessage(failureIssue, {
              resultSummary: error instanceof Error ? error.message : 'unknown governance execution error',
            }),
            issue: failureIssue,
            materialKey: `failed|${buildGovernanceCardKey(failureIssue)}`,
          });

          this.recordTelegramCallbackAudit({
            ...params.auditBase,
            result: telegramCallbackDeliveryResult(delivered.mode),
            error_message: null,
            timestamp: new Date().toISOString(),
          });

          this.persistFollowupMessageState({
            conversationId: params.context.recipient.conversation_id,
            issue: failureIssue,
            deliveredMessageId: delivered.ref.provider_message_id,
            cardState: 'failed',
            cardKey: `failed|${buildGovernanceCardKey(failureIssue)}`,
            existingCardState: params.existingCardState,
          });
          this.persistPendingAction(params.pendingAction, {
            status: 'failed',
            message_id: delivered.ref.provider_message_id,
            card_key: `failed|${buildGovernanceCardKey(failureIssue)}`,
          });
        } finally {
          this.recordTelegramCallbackAudit({
            ...params.auditBase,
            result: 'failed',
            error_message: error instanceof Error ? error.message : 'unknown governance execution error',
            timestamp: new Date().toISOString(),
          });
        }
      }
    })();
  }

  private recordTelegramCallbackAudit(record: TelegramCallbackAuditRecord): void {
    this.telegramDiagnostics.recordAudit(record);
  }

  private recordTransportEvent(params: {
    recipient: BotRecipient;
    issue: RuntimeIssueView | null;
    source: 'sync_ack' | 'callback_update';
    action: 'send' | 'edit' | 'fallback';
    result: 'success' | 'failed';
    messageId?: string | null;
    materialKey?: string | null;
    errorMessage?: string | null;
  }): void {
    this.transportEvents?.create({
      transport: params.recipient.transport,
      conversation_id: params.recipient.conversation_id,
      issue_id: params.issue?.issue_id ?? null,
      root_issue_id: params.issue?.governance_root_issue_id ?? params.issue?.issue_id ?? null,
      source: params.source,
      message_id: params.messageId ?? null,
      action: params.action,
      result: params.result,
      material_key: params.materialKey ?? null,
      error_message: params.errorMessage ?? null,
    });
  }

  private queueTelegramTextResponse(context: BotCommandContext, text: string): void {
    if (this.shouldCoalesceTelegramTextResponse(text)) {
      this.queueCoalescedTelegramTextResponse(context, text);
      return;
    }
    this.scheduleTelegramTextResponse(context, text, 1);
  }

  private shouldCoalesceTelegramTextResponse(text: string): boolean {
    return this.telegramTextCoalesceDelayMs > 0 && !text.startsWith('/');
  }

  private getTelegramTextCoalesceKey(context: BotCommandContext): string {
    return [
      context.recipient.transport,
      context.recipient.conversation_id,
      context.identity.user_id ?? 'anonymous',
    ].join(':');
  }

  private queueCoalescedTelegramTextResponse(context: BotCommandContext, text: string): void {
    const key = this.getTelegramTextCoalesceKey(context);
    const existing = this.pendingTelegramTextResponses.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.context = context;
      existing.texts.push(text);
      existing.timer = setTimeout(() => {
        this.flushCoalescedTelegramTextResponse(key);
      }, this.telegramTextCoalesceDelayMs);
      logger.info('Telegram text webhook coalesced', {
        chat_id: context.recipient.conversation_id,
        user_id: context.identity.user_id,
        message_count: existing.texts.length,
      });
      return;
    }

    this.pendingTelegramTextResponses.set(key, {
      context,
      texts: [text],
      timer: setTimeout(() => {
        this.flushCoalescedTelegramTextResponse(key);
      }, this.telegramTextCoalesceDelayMs),
    });
  }

  private flushCoalescedTelegramTextResponse(key: string): void {
    const pending = this.pendingTelegramTextResponses.get(key);
    if (!pending) {
      return;
    }
    this.pendingTelegramTextResponses.delete(key);
    this.scheduleTelegramTextResponse(pending.context, pending.texts.join('\n'), pending.texts.length);
  }

  private scheduleTelegramTextResponse(context: BotCommandContext, text: string, messageCount: number): void {
    const isCommand = text.startsWith('/');
    const queueKey = isCommand ? null : this.getTelegramTextCoalesceKey(context);
    if (queueKey && this.activeTelegramTextResponseKeys.has(queueKey)) {
      this.queueTelegramTextResponseBehindActiveTurn(queueKey, context, text);
      return;
    }
    if (queueKey) {
      this.activeTelegramTextResponseKeys.add(queueKey);
    }

    const preemptedSessions = this.supervisorSessionService?.preemptActiveSessionsForNewThread(context, text) ?? 0;
    logger.info('Telegram text webhook queued', {
      chat_id: context.recipient.conversation_id,
      user_id: context.identity.user_id,
      is_command: isCommand,
      message_count: messageCount,
      preempted_supervisor_sessions: preemptedSessions,
    });

    setTimeout(() => {
      void this.runScheduledTelegramTextResponse(queueKey, context, text);
    }, 0);
  }

  private queueTelegramTextResponseBehindActiveTurn(
    key: string,
    context: BotCommandContext,
    text: string,
  ): void {
    const existing = this.queuedTelegramTextResponses.get(key);
    if (existing) {
      existing.context = context;
      existing.texts.push(text);
      logger.info('Telegram text webhook queued behind active turn', {
        chat_id: context.recipient.conversation_id,
        user_id: context.identity.user_id,
        message_count: existing.texts.length,
      });
      return;
    }

    this.queuedTelegramTextResponses.set(key, {
      context,
      texts: [text],
    });
    logger.info('Telegram text webhook queued behind active turn', {
      chat_id: context.recipient.conversation_id,
      user_id: context.identity.user_id,
      message_count: 1,
    });
  }

  private async runScheduledTelegramTextResponse(
    queueKey: string | null,
    context: BotCommandContext,
    text: string,
  ): Promise<void> {
    try {
      await this.processTelegramTextResponse(context, text);
    } finally {
      if (!queueKey) {
        return;
      }
      this.activeTelegramTextResponseKeys.delete(queueKey);
      const queued = this.queuedTelegramTextResponses.get(queueKey);
      if (!queued) {
        return;
      }
      this.queuedTelegramTextResponses.delete(queueKey);
      this.scheduleTelegramTextResponse(queued.context, queued.texts.join('\n'), queued.texts.length);
    }
  }

  private async sendTelegramFinalMessageWithRetry(
    recipient: BotRecipient,
    outbound: BotTransportMessage,
    params: {
      context: BotCommandContext;
      isCommand: boolean;
      maxAttempts?: number;
    },
  ): Promise<BotTransportMessageRef> {
    const maxAttempts = outbound.photo
      ? 1
      : Math.max(1, params.maxAttempts ?? 3);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.telegramNotifier!.sendMessage(recipient, outbound);
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) {
          break;
        }
        logger.warn('Telegram final reply send failed; retrying', {
          chat_id: params.context.recipient.conversation_id,
          user_id: params.context.identity.user_id,
          is_command: params.isCommand,
          attempt,
          max_attempts: maxAttempts,
        }, error instanceof Error ? error : undefined);
        await waitForTelegramRetry();
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Telegram final reply send failed');
  }

  private async processTelegramTextResponse(context: BotCommandContext, text: string): Promise<void> {
    logger.info('Telegram text processing started', {
      chat_id: context.recipient.conversation_id,
      user_id: context.identity.user_id,
      is_command: text.startsWith('/'),
    });

    let processingFinished = false;
    let processingAckRef: BotTransportMessageRef | null = null;
    let processingAckPromise: Promise<BotTransportMessageRef | null> | null = null;
    const runtimeLocale = inferRuntimeLocaleFromText(text);
    const isEnglish = runtimeLocale === 'en';
    const shouldSendProcessingAck = shouldSendTelegramProcessingAck(text);
    const releaseRuntimeConversationCardLock = this.runtimeIssueCardLock.acquireConversation({
      transport: 'telegram',
      conversation_id: context.recipient.conversation_id,
    });
    const processingAckTimer = shouldSendProcessingAck ? setTimeout(() => {
      if (processingFinished || !this.telegramNotifier) {
        return;
      }
      processingAckPromise = this.telegramNotifier.sendMessage(
        {
          transport: 'telegram',
          conversation_id: context.recipient.conversation_id,
        },
        {
          text: text.startsWith('/')
            ? isEnglish ? 'Got it. I am processing the command.' : '已收到，正在处理命令。'
            : shouldUseReadOnlyClaudeForText(text)
              ? isEnglish ? 'Got it. I am reading the latest repository context and will reply shortly.' : '收到，我正在读取最新仓库信息，整理好后马上回复。'
              : isEnglish ? 'Got your message. I am thinking it through and will reply shortly.' : '收到您的消息了，我这边正在思考和处理，给我点时间',
          reply_to_message_id: context.message_id ?? undefined,
        },
      ).then((sent) => {
        processingAckRef = sent;
        this.recordTransportEvent({
          recipient: {
            transport: 'telegram',
            conversation_id: context.recipient.conversation_id,
          },
          issue: null,
          source: 'sync_ack',
          action: 'send',
          result: 'success',
          messageId: sent.provider_message_id,
          materialKey: 'text_processing_ack',
        });
        return sent;
      }).catch((error) => {
        logger.warn('Telegram text processing acknowledgement failed', {
          chat_id: context.recipient.conversation_id,
          user_id: context.identity.user_id,
        }, error instanceof Error ? error : undefined);
        return null;
      });
    }, this.telegramTextProcessingAckDelayMs) : null;

    try {
      const response = text.startsWith('/') && !isTelegramClearRepoConversationCommand(text)
        ? await this.commandService.executeText(context, text)
        : await this.assistantService.respondToText(context, text);
      processingFinished = true;
      if (processingAckTimer) {
        clearTimeout(processingAckTimer);
      }

      logger.info('Telegram text processing finished', {
        chat_id: context.recipient.conversation_id,
        user_id: context.identity.user_id,
        is_command: text.startsWith('/'),
      });

      const recipient = {
        transport: 'telegram' as const,
        conversation_id: context.recipient.conversation_id,
      };
      const explicitRuntimeIssueCardRequest = isExplicitRuntimeIssueCardRequest(text);
      const suppressRuntimeIssueCard = Boolean(response.photo && response.media_key)
        && this.hasActiveRuntimePanel(context.recipient.conversation_id)
        && !explicitRuntimeIssueCardRequest;
      const outbound = {
        text: response.message,
        caption: suppressRuntimeIssueCard ? undefined : response.caption,
        format: response.format,
        media_key: suppressRuntimeIssueCard ? undefined : response.media_key ?? undefined,
        photo: suppressRuntimeIssueCard ? undefined : response.photo,
        show_caption_above_media: suppressRuntimeIssueCard ? undefined : response.show_caption_above_media,
        reply_to_message_id: context.message_id ?? undefined,
        actions: suppressRuntimeIssueCard ? undefined : response.actions,
        action_rows: suppressRuntimeIssueCard ? undefined : response.action_rows,
      };
      const releaseRuntimeIssueCardLock = response.issue_id && outbound.photo && outbound.media_key
        ? this.runtimeIssueCardLock.acquire({
            transport: 'telegram',
            conversation_id: context.recipient.conversation_id,
            issue_id: response.issue_id,
          })
        : null;
      const releaseSupervisorSessionCardLock = response.session_id && outbound.photo && outbound.media_key
        ? this.supervisorSessionCardLock.acquire({
            transport: 'telegram',
            conversation_id: context.recipient.conversation_id,
            session_id: response.session_id,
          })
        : null;
      try {
        if (!processingAckRef && processingAckPromise) {
          processingAckRef = await processingAckPromise;
        }
        let sent: BotTransportMessageRef;
        const shouldEditProcessingAck = Boolean(processingAckRef);
        if (processingAckRef) {
          try {
            sent = await this.telegramNotifier!.editMessage(
              recipient,
              processingAckRef,
              outbound,
            );
            this.recordTransportEvent({
              recipient,
              issue: response.issue_id ? this.runtime.getIssue(response.issue_id) : null,
              source: 'sync_ack',
              action: 'edit',
              result: 'success',
              messageId: sent.provider_message_id,
              materialKey: response.material_key ?? null,
            });
          } catch (error) {
            if (getBotMessageEditFailureKind(error) === 'not_modified') {
              sent = processingAckRef;
              this.recordTransportEvent({
                recipient,
                issue: response.issue_id ? this.runtime.getIssue(response.issue_id) : null,
                source: 'sync_ack',
                action: 'edit',
                result: 'success',
                messageId: sent.provider_message_id,
                materialKey: response.material_key ?? null,
              });
            } else {
              logger.warn('Telegram text acknowledgement edit failed; sending final response separately', {
                chat_id: context.recipient.conversation_id,
                user_id: context.identity.user_id,
              }, error instanceof Error ? error : undefined);
              sent = await this.sendTelegramFinalMessageWithRetry(recipient, outbound, {
                context,
                isCommand: text.startsWith('/'),
              });
              this.recordTransportEvent({
                recipient,
                issue: response.issue_id ? this.runtime.getIssue(response.issue_id) : null,
                source: 'sync_ack',
                action: 'fallback',
                result: 'success',
                messageId: sent.provider_message_id,
                materialKey: response.material_key ?? null,
              });
            }
          }
        } else {
          sent = await this.sendTelegramFinalMessageWithRetry(recipient, outbound, {
            context,
            isCommand: text.startsWith('/'),
          });
        }
        this.bindPendingConfirmationToTelegramMessage(context, response, sent);
        if (response.session_id && outbound.photo && outbound.media_key) {
          this.supervisorSessionService?.recordOutboundMessage(
            response.session_id,
            sent.provider_message_id,
            response.material_key ?? null,
          );
        }
        const issue = response.issue_id ? this.runtime.getIssue(response.issue_id) : null;
        if (issue && outbound.photo && outbound.media_key) {
          this.persistFollowupMessageState({
            conversationId: context.recipient.conversation_id,
            issue,
            deliveredMessageId: sent.provider_message_id,
            cardKind: 'runtime_issue',
            cardState: runtimeIssueCardStateForResponse(response, issue),
            cardKey: outbound.media_key,
            existingCardState: this.followupMessageStates?.findByConversationIssue({
              transport: 'telegram',
              conversation_id: context.recipient.conversation_id,
              issue_id: issue.issue_id,
            }) ?? null,
          });
        }
        if (!shouldEditProcessingAck) {
          this.recordTransportEvent({
            recipient,
            issue,
            source: 'sync_ack',
            action: 'send',
            result: 'success',
          });
        }
      } finally {
        releaseRuntimeIssueCardLock?.();
        releaseSupervisorSessionCardLock?.();
      }

      logger.info('Telegram text outbound sent', {
        chat_id: context.recipient.conversation_id,
        user_id: context.identity.user_id,
        is_command: text.startsWith('/'),
      });
    } catch (error) {
      processingFinished = true;
      if (processingAckTimer) {
        clearTimeout(processingAckTimer);
      }
      const recipient = {
        transport: 'telegram' as const,
        conversation_id: context.recipient.conversation_id,
      };
      const message = error instanceof Error ? error.message : 'unknown error';
      logger.error('Telegram text outbound failed', {
        chat_id: context.recipient.conversation_id,
        user_id: context.identity.user_id,
        is_command: text.startsWith('/'),
      }, error instanceof Error ? error : undefined);

      this.recordTransportEvent({
        recipient,
        issue: null,
        source: 'sync_ack',
        action: 'send',
        result: 'failed',
        errorMessage: message,
      });
    } finally {
      releaseRuntimeConversationCardLock();
    }
  }

  async handleDiscordInteraction(
    rawBody: string,
    headers: Headers | Record<string, string | undefined>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!this.discordConfig.publicKey) {
      return {
        status: 503,
        body: {
          type: 4,
          data: {
            content: 'Discord adapter is not configured.',
            flags: 64,
          },
        },
      };
    }

    const verified = await this.discordVerifier.verify({
      rawBody,
      signature: getHeaderValue(headers, 'X-Signature-Ed25519'),
      timestamp: getHeaderValue(headers, 'X-Signature-Timestamp'),
      publicKey: this.discordConfig.publicKey,
    });
    if (!verified) {
      return {
        status: 401,
        body: {
          error: 'Invalid Discord signature',
        },
      };
    }

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(rawBody) as DiscordInteraction;
    } catch {
      return {
        status: 400,
        body: {
          error: 'Invalid Discord interaction payload',
        },
      };
    }

    if (interaction.type === 1) {
      return {
        status: 200,
        body: { type: 1 },
      };
    }

    if (interaction.type !== 2) {
      return {
        status: 200,
        body: {
          type: 4,
          data: {
            content: 'Unsupported Discord interaction type.',
            flags: 64,
          },
        },
      };
    }

    const request = buildDiscordCommandRequest(interaction);
    const user = interaction.member?.user || interaction.user;
    const response = await this.commandService.execute(
      {
        transport: 'discord',
        recipient: {
          transport: 'discord',
          conversation_id: interaction.channel_id || 'unknown-channel',
        },
        identity: {
          user_id: user?.id || null,
          display_name: user?.global_name || user?.username || null,
        },
      },
      request,
    );

    return {
      status: 200,
      body: {
        type: 4,
        data: {
          content: response.message,
          flags: 64,
        },
      },
    };
  }
}

export function createBotGatewayFromEnv(
  runtime: RuntimeControlPlane,
  db?: Database | null,
  options: {
    projectResolver?: TrackerProjectResolutionService | null;
    assistantModel?: BotAssistantModel;
    supervisorCcAdvisor?: SupervisorCcAdvisor | null;
    supervisorAgentService?: SupervisorAgentService | null;
    repoUnderstandingService?: SupervisorRepoUnderstandingService | null;
    supervisorRepoSourceResolver?: SupervisorRepoSourceResolver | null;
    workspaceRoot?: string | null;
    githubToken?: string | null;
  } = {},
): BotGateway {
  syncSymHarixEnvAliases();

  const parseOperatorIds = (value: string | undefined): Set<string> =>
    new Set(
      String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
  const subscriptionRepository = db ? new BotWatchSubscriptionRepository(db) : null;
  const preferencesRepository = db ? new BotConversationPreferenceRepository(db) : null;
  const conversationFocusRepository = db ? new BotConversationFocusRepository(db) : null;
  const pendingActionRepository = db ? new BotPendingActionRepository(db) : null;
  const followupRepository = db ? new BotIssueFollowupRepository(db) : null;
  const followupMessageStateRepository = db ? new BotFollowupMessageStateRepository(db) : null;
  const followupDeliveryStateRepository = db ? new BotFollowupDeliveryStateRepository(db) : null;
  const transportEventRepository = db ? new BotTransportEventRepository(db) : null;
  const supervisorSessionRepository = db ? new SupervisorSessionRepository(db) : null;
  const supervisorSessionEventRepository = db ? new SupervisorSessionEventRepository(db) : null;
  const supervisorJobRepository = db ? new SupervisorJobRepository(db) : null;
  const supervisorMemoryRepository = db ? new SupervisorMemoryRepository(db) : null;
  const supervisorRunRepository = db ? new SupervisorRunRepository(db) : null;
  const supervisorRunEventRepository = db ? new SupervisorRunEventRepository(db) : null;
  const supervisorToolCallRepository = db ? new SupervisorToolCallRepository(db) : null;
  const supervisorPendingActionRepository = db ? new SupervisorPendingActionRepository(db) : null;
  const repoClaudeConversationRepository = db ? new RepoClaudeConversationRepository(db) : null;
  const workItemRepository = db ? new WorkItemRepository(db) : null;
  const reviewEventRepository = db ? new ReviewEventRepository(db) : null;
  const governanceAssessmentRepository = db ? new GovernanceAssessmentRepository(db) : null;
  const governanceSuggestionRepository = db ? new GovernanceSuggestionRepository(db) : null;
  const decisionMemoryRepository = db ? new DecisionMemoryRepository(db) : null;
  const conflictMemoryRepository = db ? new ConflictMemoryRepository(db) : null;
  const debtSignalRepository = db ? new DebtSignalRepository(db) : null;
  const shadowHarnessRepository = db ? new ShadowHarnessRepository(db) : null;
  const repoUnderstandingService = options.repoUnderstandingService === undefined
    ? createRepoUnderstandingServiceFromEnv(db)
    : options.repoUnderstandingService;
  const supervisorRepoSourceResolver = options.supervisorRepoSourceResolver === undefined
    ? (
        options.projectResolver && options.workspaceRoot
          ? createSupervisorRepoSourceResolver({
              workspaceRoot: options.workspaceRoot,
              githubToken: options.githubToken ?? '',
            })
          : null
      )
    : options.supervisorRepoSourceResolver;
  const telegramDiagnostics = new DefaultTelegramWebhookDiagnosticsService(
    readSymHarixEnv('SYMPHONY_TELEGRAM_BOT_TOKEN') || null,
  );
  const supervisorCcAdvisor = options.supervisorCcAdvisor === undefined
    ? createSupervisorCcAdvisorFromEnv()
    : options.supervisorCcAdvisor;
  const supervisorAgentService = options.supervisorAgentService === undefined
    ? createSupervisorAgentFromEnv(
        new DefaultRepoProfileService(),
        fetch,
        repoUnderstandingService ?? null,
        supervisorRepoSourceResolver ?? null,
      )
    : options.supervisorAgentService;
  telegramDiagnostics.maybeRefresh();
  const supervisorRepoIntelligenceResolver =
    workItemRepository &&
    reviewEventRepository &&
    governanceAssessmentRepository &&
    governanceSuggestionRepository &&
    decisionMemoryRepository &&
    conflictMemoryRepository &&
    debtSignalRepository &&
    shadowHarnessRepository
      ? new DefaultSupervisorRepoIntelligenceResolver(
          shadowHarnessRepository,
          new GovernanceMemoryService({
            workItemRepository,
            reviewEventRepository,
            governanceAssessmentRepository,
            governanceSuggestionRepository,
            decisionMemoryRepository,
            conflictMemoryRepository,
            debtSignalRepository,
          }),
        )
      : null;
  const supervisorContextBroker = new SupervisorContextBroker({
    runtime,
    preferences: preferencesRepository,
    conversationFocuses: conversationFocusRepository,
    projectResolver: options.projectResolver ?? null,
    repoProfileService: new DefaultRepoProfileService(),
    repoUnderstandingService: repoUnderstandingService ?? null,
    repoSourceResolver: supervisorRepoSourceResolver ?? null,
    supervisorMemories: supervisorMemoryRepository,
    supervisorSessions: supervisorSessionRepository,
    repoIntelligenceResolver: supervisorRepoIntelligenceResolver,
  });
  const supervisorClaudeRuntimeService = readSymHarixEnv('SYMPHONY_SUPERVISOR_CLAUDE_RUNTIME') === 'off'
    ? null
    : new SupervisorClaudeRuntimeService({
        resolveWorkspace: (input) => supervisorContextBroker.resolveWorkspace(input),
        command: readSymHarixEnv('SYMPHONY_SUPERVISOR_CLAUDE_COMMAND') || 'node scripts/claude-adapter.cjs',
        contextEndpoint: readSymHarixEnv('SYMPHONY_SUPERVISOR_CONTEXT_ENDPOINT') || null,
        projectRoot: process.cwd(),
      });

  return new DefaultBotGateway(runtime, {
    botToken: readSymHarixEnv('SYMPHONY_TELEGRAM_BOT_TOKEN') || null,
    webhookSecret: readSymHarixEnv('SYMPHONY_TELEGRAM_WEBHOOK_SECRET') || null,
    operationsChatId: readSymHarixEnv('SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID') || null,
    operatorIds: parseOperatorIds(readSymHarixEnv('SYMPHONY_TELEGRAM_OPERATOR_IDS')),
  }, {
    botToken: readSymHarixEnv('SYMPHONY_DISCORD_BOT_TOKEN') || null,
    publicKey: readSymHarixEnv('SYMPHONY_DISCORD_PUBLIC_KEY') || null,
    operatorIds: parseOperatorIds(readSymHarixEnv('SYMPHONY_DISCORD_OPERATOR_IDS')),
  }, undefined, subscriptionRepository, {
    preferencesRepository,
    conversationFocusRepository,
    pendingActionRepository,
    followupRepository,
    followupMessageStateRepository,
    followupDeliveryStateRepository,
    transportEventRepository,
    supervisorSessionRepository,
    supervisorSessionEventRepository,
    supervisorJobRepository,
    supervisorMemoryRepository,
    supervisorRunRepository,
    supervisorRunEventRepository,
    supervisorToolCallRepository,
    supervisorPendingActionRepository,
    repoClaudeConversationRepository,
    supervisorRepoIntelligenceResolver,
    supervisorContextBroker,
    supervisorClaudeRuntimeService,
    supervisorPlanBrain: createSupervisorPlanBrainFromEnv(),
    supervisorExecutionOverseer: createSupervisorExecutionOverseerFromEnv(),
    workItemRepository,
    projectResolver: options.projectResolver ?? null,
    supervisorRepoSourceResolver: supervisorRepoSourceResolver ?? null,
    assistantModel: options.assistantModel,
    supervisorCcAdvisor: supervisorCcAdvisor ?? null,
    supervisorAgentService: supervisorAgentService ?? null,
    repoUnderstandingService: repoUnderstandingService ?? null,
    telegramDiagnostics,
    telegramTextCoalesceDelayMs: parseNonNegativeInteger(readSymHarixEnv('SYMPHONY_TELEGRAM_TEXT_COALESCE_DELAY_MS'))
      ?? 2_000,
  });
}
