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
import {
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
  BotTransportEventRepository,
  BotWatchSubscriptionRepository,
  WorkItemRepository,
} from '../database';
import type { RuntimeActionResult, RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import type { Database } from 'bun:sqlite';
import type {
  BotManifest,
  BotCommandContext,
  BotCommandRequest,
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
import { logger } from '../logging';
import { SupervisorSessionService, type SupervisorPlanBrain } from '../supervisor/sessionService';
import type { SupervisorRepoIntelligenceResolver } from '../supervisor/repoIntelligence';
import { DefaultSupervisorRepoIntelligenceResolver } from '../supervisor/repoIntelligence';
import { SupervisorWorker } from '../supervisor/worker';
import { createSupervisorPlanBrainFromEnv } from '../supervisor/planBrain';
import {
  createSupervisorExecutionOverseerFromEnv,
  type SupervisorExecutionOverseer,
} from '../supervisor/executionOverseer';
import { GovernanceMemoryService } from '../governance/repoIntelligence';

interface TelegramUpdate {
  message?: {
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
    };
    from?: { id: number | string; username?: string; first_name?: string; last_name?: string };
  };
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

type TelegramCallbackKind = 'select_governance_action' | 'confirm_pending' | 'cancel_pending' | 'supervisor_action' | 'unknown';

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

function buildTelegramInlineKeyboard(message: BotTransportMessage):
  | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
  | undefined {
  const rows = message.action_rows
    ?? (message.actions?.length
      ? message.actions.map((action) => [action])
      : undefined);

  if (!rows || rows.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: rows.map((row) => row.map((action) => ({
      text: action.label,
      callback_data: action.callback_data,
    }))),
  };
}

class TelegramNotifier implements BotTransportNotifier {
  constructor(private readonly config: TelegramAdapterConfig) {}

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
    const keyboard = buildTelegramInlineKeyboard(message);

    const response = await fetch(
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

  async editMessage(
    recipient: BotRecipient,
    messageRef: BotTransportMessageRef,
    message: BotTransportMessage,
  ): Promise<BotTransportMessageRef> {
    if (!this.config.botToken) {
      throw new Error('Telegram bot token is not configured');
    }
    const keyboard = buildTelegramInlineKeyboard(message);

    const response = await fetch(
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

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.config.botToken) {
      throw new Error('Telegram bot token is not configured');
    }

    const response = await fetch(
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
  private readonly transportEvents: BotTransportEventRepository | null;
  private readonly telegramDiagnostics: TelegramWebhookDiagnosticsService;
  private readonly telegramBootstrap: TelegramWebhookBootstrapService | null;
  private readonly supervisorSessions: SupervisorSessionRepository | null;
  private readonly supervisorSessionEvents: SupervisorSessionEventRepository | null;
  private readonly supervisorSessionService: SupervisorSessionService | null;
  private readonly supervisorWorker: SupervisorWorker | null;

  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly telegramConfig: TelegramAdapterConfig,
    private readonly discordConfig: DiscordAdapterConfig,
    private readonly discordVerifier: DiscordRequestVerifier = new WebCryptoDiscordVerifier(),
    subscriptionRepository: BotWatchSubscriptionRepository | null = null,
    options: {
      preferencesRepository?: BotConversationPreferenceRepository | null;
      pendingActionRepository?: BotPendingActionRepository | null;
      followupRepository?: BotIssueFollowupRepository | null;
      followupMessageStateRepository?: BotFollowupMessageStateRepository | null;
      followupDeliveryStateRepository?: BotFollowupDeliveryStateRepository | null;
      transportEventRepository?: BotTransportEventRepository | null;
      supervisorSessionRepository?: SupervisorSessionRepository | null;
      supervisorSessionEventRepository?: SupervisorSessionEventRepository | null;
      supervisorSessionService?: SupervisorSessionService | null;
      supervisorPlanBrain?: SupervisorPlanBrain | null;
      supervisorExecutionOverseer?: SupervisorExecutionOverseer | null;
      supervisorRepoIntelligenceResolver?: SupervisorRepoIntelligenceResolver | null;
      workItemRepository?: WorkItemRepository | null;
      projectResolver?: TrackerProjectResolutionService | null;
      assistantModel?: BotAssistantModel;
      telegramDiagnostics?: TelegramWebhookDiagnosticsService;
      telegramBootstrapService?: TelegramWebhookBootstrapService | null;
    } = {},
  ) {
    this.followupMessageStates = options.followupMessageStateRepository ?? null;
    this.followupDeliveryStates = options.followupDeliveryStateRepository ?? null;
    this.pendingActions = options.pendingActionRepository ?? null;
    this.transportEvents = options.transportEventRepository ?? null;
    this.supervisorSessions = options.supervisorSessionRepository ?? null;
    this.supervisorSessionEvents = options.supervisorSessionEventRepository ?? null;
    this.telegramNotifier = telegramConfig.botToken ? new TelegramNotifier(telegramConfig) : null;
    this.discordNotifier = discordConfig.botToken ? new DiscordNotifier(discordConfig) : null;
    this.telegramDiagnostics = options.telegramDiagnostics
      ?? new DefaultTelegramWebhookDiagnosticsService(telegramConfig.botToken);
    this.telegramBootstrap = telegramConfig.botToken
      ? (options.telegramBootstrapService ?? new TelegramWebhookBootstrapService({
          botToken: telegramConfig.botToken,
          webhookSecret: telegramConfig.webhookSecret,
          publicBaseUrl: process.env.SYMPHONY_PUBLIC_BASE_URL || null,
          bootstrapMode: process.env.SYMPHONY_TELEGRAM_BOOTSTRAP === 'off' ? 'off' : 'auto',
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
    this.commandService = new BotCommandService(
      runtime,
      this.subscriptions,
      canWrite,
      options.preferencesRepository ?? null,
      options.projectResolver ?? null,
      options.followupRepository ?? null,
    );
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
    this.assistantService = new BotAssistantService(
      runtime,
      this.commandService,
      options.preferencesRepository ?? null,
      options.pendingActionRepository ?? null,
      options.projectResolver ?? null,
      options.assistantModel ?? createBotAssistantModelFromEnv(),
      canWrite,
      this.subscriptions,
      options.followupMessageStateRepository ?? null,
      this.supervisorSessionService,
    );
    new BotFollowupRepairService(
      runtime,
      options.workItemRepository ?? null,
      options.followupRepository ?? null,
      options.followupMessageStateRepository ?? null,
      options.followupDeliveryStateRepository ?? null,
      options.pendingActionRepository ?? null,
    ).repair();
    this.followups = options.followupRepository
      ? new BotFollowupService(runtime, {
          telegram: this.telegramNotifier ?? undefined,
        }, options.followupRepository, options.followupMessageStateRepository ?? null, {
          telegramOperationsChatId: this.telegramConfig.operationsChatId,
          deliveryStateRepository: options.followupDeliveryStateRepository ?? null,
          transportEventRepository: options.transportEventRepository ?? null,
          supervisorSessionRepository: this.supervisorSessions,
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
        })
      : null;
    if (this.supervisorWorker) {
      void this.supervisorWorker.reconcile().catch((error) => {
        logger.warn('Supervisor worker reconciliation failed during gateway startup', {}, error instanceof Error ? error : undefined);
      });
    }
  }

  getManifest(): BotManifest {
    const telegramInboundEnabled = Boolean(this.telegramConfig.botToken);
    const telegramOutboundEnabled = Boolean(this.telegramConfig.botToken);
    const discordInboundEnabled = Boolean(this.discordConfig.publicKey);
    const discordOutboundEnabled = Boolean(this.discordConfig.botToken);
    this.telegramDiagnostics.maybeRefresh();
    const telegramDiagnostics = this.telegramDiagnostics.getSnapshot();

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
      commands: ['help', 'status', 'new', 'project', 'watch', 'unwatch', 'stop', 'retry', 'override', 'rewrite', 'split'],
      watch_presets: ['default', 'verbose', 'failures', 'status'],
      assistant: this.assistantService.getDiagnostics(),
      natural_language_enabled: true,
    };
  }

  async initializeInboundIntegration(params: {
    localBaseUrl: string;
    inboundPath?: string;
  }): Promise<void> {
    if (!this.telegramBootstrap) {
      return;
    }

    try {
      await this.telegramBootstrap.bootstrap({
        localBaseUrl: params.localBaseUrl,
        inboundPath: params.inboundPath ?? '/api/v1/bots/telegram/webhook',
      });
      await this.telegramDiagnostics.refreshNow();
    } catch (error) {
      logger.warn('Telegram inbound bootstrap failed', {
        local_base_url: params.localBaseUrl,
      }, error instanceof Error ? error : undefined);
    }
  }

  dispose(): void {
    this.subscriptions.dispose();
    this.followups?.dispose();
    this.supervisorWorker?.dispose();
    this.supervisorSessionService?.dispose();
    void this.telegramBootstrap?.dispose();
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

      try {
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
          });
          this.recordTelegramCallbackAudit({
            ...auditBase,
            result: delivered.mode === 'edited' ? 'edited' : 'sent_fallback',
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

        const callbackResult = await this.handleTelegramCallback(
          context,
          parsedCallback,
          callbackIssue,
          existingCardState,
          messageId !== undefined && messageId !== null ? String(messageId) : null,
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
          result: delivered.mode === 'edited' ? 'edited' : 'sent_fallback',
          error_message: null,
          timestamp: new Date().toISOString(),
        });

        if (callbackResult.issue) {
          this.persistFollowupMessageState({
            conversationId,
            issue: callbackResult.issue,
            deliveredMessageId: delivered.ref.provider_message_id,
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
      } catch (error) {
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
    };
    this.queueTelegramTextResponse(context, text);

    return {
      ok: true,
      status: 200,
      body: { ok: true },
    };
  }

  private async handleTelegramCallback(
    context: BotCommandContext,
    parsed: { kind: TelegramCallbackKind; issueIdentifier: string | null; ordinal: number | null },
    issue: RuntimeIssueView | null,
    existingCardState: ReturnType<BotFollowupMessageStateRepository['findByConversationIssue']> | null,
    originalMessageId: string | null,
  ): Promise<{
    outbound: BotTransportMessage;
    toastText: string;
    issue: RuntimeIssueView | null;
    cardState: 'open' | 'confirming' | 'executing' | 'waiting_on_child' | 'resolved' | 'failed';
    cardKey: string;
    executeAfterAck?: {
      pendingAction: ReturnType<BotPendingActionRepository['findByConversationIssue']>;
      actionLabel: string;
      issue: RuntimeIssueView;
    } | null;
  }> {
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
            actionLabel: '执行治理动作',
            confirmationSummary: response.message,
            notice: existingCardState ? null : '原卡片状态已丢失，已重新生成确认卡。',
          }),
          toastText: '已收到，正在准备确认',
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
            text: '没有找到对应的治理动作，请直接回复你的想法。',
          },
          toastText: '未找到动作',
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
          notice: existingCardState ? null : '原卡片状态已丢失，已重新生成确认卡。',
        }),
        toastText: '已收到，正在准备确认',
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
      );
      if (!pendingAction || !pendingAction.issue_id || !this.pendingActions) {
        return {
          outbound: {
            text: '这张治理卡已经失效，请直接发送“现在是什么单子？”或重新查看当前待处理线程。',
          },
          toastText: '这张卡已失效',
          issue: null,
          cardState: 'resolved',
          cardKey: 'stale_pending_confirm',
          executeAfterAck: null,
        };
      }

      const executingIssue = issue
        ?? this.runtime.getIssue(pendingAction.issue_id)
        ?? this.buildFallbackGovernanceIssue(null, parsed.issueIdentifier, existingCardState);
      const actionLabel = this.describePendingAction(pendingAction, executingIssue);
      this.persistPendingAction(pendingAction, {
        status: 'executing',
        message_id: originalMessageId ?? pendingAction.message_id ?? null,
        card_key: `executing|${buildGovernanceCardKey(executingIssue)}`,
      });

      return {
        outbound: buildGovernanceExecutingMessage(executingIssue, {
          actionLabel,
          notice: existingCardState ? null : '原卡片状态已丢失，已重新生成执行卡。',
        }),
        toastText: '已收到，正在执行',
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
      );
      if (!pendingAction || !this.pendingActions) {
        return {
          outbound: {
            text: '这张治理卡已经失效，不需要再取消了。请直接发送“现在是什么单子？”查看当前线程。',
          },
          toastText: '这张卡已失效',
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

      const fallbackIssue = this.buildFallbackGovernanceIssue(issue, parsed.issueIdentifier, existingCardState);
      if (fallbackIssue.governance_thread_state === 'waiting_on_child') {
        return {
          outbound: buildGovernanceWaitingOnChildMessage(fallbackIssue, {
            notice: '已取消这次治理动作，源单仍在等待子任务。',
          }),
          toastText: '已取消',
          issue: fallbackIssue,
          cardState: 'waiting_on_child',
          cardKey: buildGovernanceCardKey(fallbackIssue),
          executeAfterAck: null,
        };
      }

      if (isGovernanceBlockedIssue(fallbackIssue)) {
        return {
          outbound: buildGovernanceBlockedMessage(fallbackIssue),
          toastText: '已取消',
          issue: fallbackIssue,
          cardState: 'open',
          cardKey: buildGovernanceCardKey(fallbackIssue),
          executeAfterAck: null,
        };
      }

      return {
        outbound: buildGovernanceResolvedMessage(fallbackIssue, {
          resultSummary: '已取消当前治理操作。',
        }),
        toastText: '已取消',
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

  private parseTelegramCallbackData(data: string): {
    kind: TelegramCallbackKind;
    issueIdentifier: string | null;
    ordinal: number | null;
    sessionId?: string | null;
    supervisorAction?: 'approve' | 'edit' | 'alternate' | null;
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

    const supervisorSelection = data.match(/^sup\|([^|]+)\|(approve|edit|alternate)$/i);
    if (supervisorSelection?.[1] && supervisorSelection?.[2]) {
      return {
        kind: 'supervisor_action',
        issueIdentifier: null,
        ordinal: null,
        sessionId: supervisorSelection[1],
        supervisorAction: supervisorSelection[2].toLowerCase() as 'approve' | 'edit' | 'alternate',
      };
    }

    return {
      kind: 'unknown',
      issueIdentifier: null,
      ordinal: null,
      sessionId: null,
      supervisorAction: null,
    };
  }

  private async handleSupervisorCallback(params: {
    context: BotCommandContext;
    parsed: {
      sessionId?: string | null;
      supervisorAction?: 'approve' | 'edit' | 'alternate' | null;
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
        format: response.format,
        actions: response.actions,
        action_rows: response.action_rows,
      },
      toastText: '已收到，正在处理',
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
  }): Promise<{ ref: BotTransportMessageRef; mode: 'edited' | 'sent_fallback' }> {
    const source = params.source ?? 'callback_update';
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
        logger.warn('Telegram editMessageText failed; falling back to sendMessage', {
          conversation_id: params.recipient.conversation_id,
          message_id: params.originalMessageId,
        }, error instanceof Error ? error : undefined);
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
    return [
      `操作：${action.label}`,
      `Issue：${issue.identifier}`,
      issue.github_repo ? `仓库：${issue.github_repo}` : null,
      action.kind === 'execute_suggestion' ? `建议：${action.suggestion_type} · ${action.suggestion_id}` : null,
      '确认后会立即执行这条治理动作。',
    ].filter(Boolean).join('\n');
  }

  private resolvePendingActionForCallback(
    context: BotCommandContext,
    issue: RuntimeIssueView | null,
    existingCardState: ReturnType<BotFollowupMessageStateRepository['findByConversationIssue']> | null,
    originalMessageId: string | null,
  ): ReturnType<BotPendingActionRepository['findByConversationIssue']> | null {
    if (!this.pendingActions) {
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

    if (originalMessageId) {
      const sameMessagePending = this.pendingActions.findOpenByConversation(key)
        .filter((pending) => pending.message_id === originalMessageId);
      if (sameMessagePending.length === 1) {
        return sameMessagePending[0] ?? null;
      }
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

  private persistFollowupMessageState(params: {
    conversationId: string;
    issue: RuntimeIssueView;
    deliveredMessageId: string;
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
      card_kind: 'governance_blocked' as const,
      card_key: params.cardKey,
      card_state: params.cardState,
    };

    if (params.existingCardState) {
      this.followupMessageStates.updateState(record);
      return;
    }

    this.followupMessageStates.upsert(record);
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
          result: delivered.mode === 'edited' ? 'edited' : 'sent_fallback',
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
            result: delivered.mode === 'edited' ? 'edited' : 'sent_fallback',
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
    logger.info('Telegram text webhook queued', {
      chat_id: context.recipient.conversation_id,
      user_id: context.identity.user_id,
      is_command: text.startsWith('/'),
    });

    setTimeout(() => {
      void this.processTelegramTextResponse(context, text);
    }, 0);
  }

  private async processTelegramTextResponse(context: BotCommandContext, text: string): Promise<void> {
    logger.info('Telegram text processing started', {
      chat_id: context.recipient.conversation_id,
      user_id: context.identity.user_id,
      is_command: text.startsWith('/'),
    });

    try {
      const response = text.startsWith('/')
        ? await this.commandService.executeText(context, text)
        : await this.assistantService.respondToText(context, text);

      logger.info('Telegram text processing finished', {
        chat_id: context.recipient.conversation_id,
        user_id: context.identity.user_id,
        is_command: text.startsWith('/'),
      });

      const sent = await this.telegramNotifier!.sendMessage(
        {
          transport: 'telegram',
          conversation_id: context.recipient.conversation_id,
        },
        {
          text: response.message,
          format: response.format,
          actions: response.actions,
          action_rows: response.action_rows,
        },
      );
      if (response.session_id) {
        this.supervisorSessionService?.recordOutboundMessage(
          response.session_id,
          sent.provider_message_id,
          response.material_key ?? null,
        );
      }
      const issue = response.issue_id ? this.runtime.getIssue(response.issue_id) : null;
      this.recordTransportEvent({
        recipient: {
          transport: 'telegram',
          conversation_id: context.recipient.conversation_id,
        },
        issue,
        source: 'sync_ack',
        action: 'send',
        result: 'success',
      });

      logger.info('Telegram text outbound sent', {
        chat_id: context.recipient.conversation_id,
        user_id: context.identity.user_id,
        is_command: text.startsWith('/'),
      });
    } catch (error) {
      logger.error('Telegram text outbound failed', {
        chat_id: context.recipient.conversation_id,
        user_id: context.identity.user_id,
        is_command: text.startsWith('/'),
      }, error instanceof Error ? error : undefined);

      try {
        await this.telegramNotifier!.sendMessage(
          {
            transport: 'telegram',
            conversation_id: context.recipient.conversation_id,
          },
          {
            text: `处理 Telegram 消息时失败：${error instanceof Error ? error.message : 'unknown error'}`,
          },
        );
        this.recordTransportEvent({
          recipient: {
            transport: 'telegram',
            conversation_id: context.recipient.conversation_id,
          },
          issue: null,
          source: 'sync_ack',
          action: 'send',
          result: 'failed',
          errorMessage: error instanceof Error ? error.message : 'unknown error',
        });
      } catch (sendError) {
        logger.error('Telegram text fallback send failed', {
          chat_id: context.recipient.conversation_id,
          user_id: context.identity.user_id,
        }, sendError instanceof Error ? sendError : undefined);
      }
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
  } = {},
): BotGateway {
  const parseOperatorIds = (value: string | undefined): Set<string> =>
    new Set(
      String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
  const subscriptionRepository = db ? new BotWatchSubscriptionRepository(db) : null;
  const preferencesRepository = db ? new BotConversationPreferenceRepository(db) : null;
  const pendingActionRepository = db ? new BotPendingActionRepository(db) : null;
  const followupRepository = db ? new BotIssueFollowupRepository(db) : null;
  const followupMessageStateRepository = db ? new BotFollowupMessageStateRepository(db) : null;
  const followupDeliveryStateRepository = db ? new BotFollowupDeliveryStateRepository(db) : null;
  const transportEventRepository = db ? new BotTransportEventRepository(db) : null;
  const supervisorSessionRepository = db ? new SupervisorSessionRepository(db) : null;
  const supervisorSessionEventRepository = db ? new SupervisorSessionEventRepository(db) : null;
  const workItemRepository = db ? new WorkItemRepository(db) : null;
  const reviewEventRepository = db ? new ReviewEventRepository(db) : null;
  const governanceAssessmentRepository = db ? new GovernanceAssessmentRepository(db) : null;
  const governanceSuggestionRepository = db ? new GovernanceSuggestionRepository(db) : null;
  const decisionMemoryRepository = db ? new DecisionMemoryRepository(db) : null;
  const conflictMemoryRepository = db ? new ConflictMemoryRepository(db) : null;
  const debtSignalRepository = db ? new DebtSignalRepository(db) : null;
  const shadowHarnessRepository = db ? new ShadowHarnessRepository(db) : null;
  const telegramDiagnostics = new DefaultTelegramWebhookDiagnosticsService(
    process.env.SYMPHONY_TELEGRAM_BOT_TOKEN || null,
  );
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

  return new DefaultBotGateway(runtime, {
    botToken: process.env.SYMPHONY_TELEGRAM_BOT_TOKEN || null,
    webhookSecret: process.env.SYMPHONY_TELEGRAM_WEBHOOK_SECRET || null,
    operationsChatId: process.env.SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID || null,
    operatorIds: parseOperatorIds(process.env.SYMPHONY_TELEGRAM_OPERATOR_IDS),
  }, {
    botToken: process.env.SYMPHONY_DISCORD_BOT_TOKEN || null,
    publicKey: process.env.SYMPHONY_DISCORD_PUBLIC_KEY || null,
    operatorIds: parseOperatorIds(process.env.SYMPHONY_DISCORD_OPERATOR_IDS),
  }, undefined, subscriptionRepository, {
    preferencesRepository,
    pendingActionRepository,
    followupRepository,
    followupMessageStateRepository,
    followupDeliveryStateRepository,
    transportEventRepository,
    supervisorSessionRepository,
    supervisorSessionEventRepository,
    supervisorRepoIntelligenceResolver,
    supervisorPlanBrain: createSupervisorPlanBrainFromEnv(),
    supervisorExecutionOverseer: createSupervisorExecutionOverseerFromEnv(),
    workItemRepository,
    projectResolver: options.projectResolver ?? null,
    assistantModel: options.assistantModel,
    telegramDiagnostics,
  });
}
