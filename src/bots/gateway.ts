import { BotAssistantService } from './assistant';
import { BotCommandService } from './commandService';
import { BotSubscriptionService } from './subscriptions';
import {
  BotConversationPreferenceRepository,
  BotPendingActionRepository,
  BotWatchSubscriptionRepository,
} from '../database';
import type { RuntimeControlPlane } from '../runtime/types';
import type { Database } from 'bun:sqlite';
import type {
  BotManifest,
  BotCommandContext,
  BotCommandRequest,
  BotGateway,
  BotRecipient,
  BotTransportNotifier,
} from './types';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { createBotAssistantModelFromEnv, type BotAssistantModel } from './model';

interface TelegramUpdate {
  message?: {
    text?: string;
    chat?: { id: number | string };
    from?: { id: number | string; username?: string; first_name?: string; last_name?: string };
  };
  edited_message?: TelegramUpdate['message'];
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
  operatorIds: Set<string>;
}

interface DiscordAdapterConfig {
  botToken: string | null;
  publicKey: string | null;
  operatorIds: Set<string>;
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

class TelegramNotifier implements BotTransportNotifier {
  constructor(private readonly config: TelegramAdapterConfig) {}

  async sendMessage(recipient: BotRecipient, message: string): Promise<void> {
    if (!this.config.botToken) {
      throw new Error('Telegram bot token is not configured');
    }

    const response = await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: recipient.conversation_id,
          text: message,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed with status ${response.status}`);
    }
  }
}

class DiscordNotifier implements BotTransportNotifier {
  constructor(private readonly config: DiscordAdapterConfig) {}

  async sendMessage(recipient: BotRecipient, message: string): Promise<void> {
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
          content: message,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Discord create message failed with status ${response.status}`);
    }
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
  private readonly telegramNotifier: TelegramNotifier | null;
  private readonly discordNotifier: DiscordNotifier | null;

  constructor(
    runtime: RuntimeControlPlane,
    private readonly telegramConfig: TelegramAdapterConfig,
    private readonly discordConfig: DiscordAdapterConfig,
    private readonly discordVerifier: DiscordRequestVerifier = new WebCryptoDiscordVerifier(),
    subscriptionRepository: BotWatchSubscriptionRepository | null = null,
    options: {
      preferencesRepository?: BotConversationPreferenceRepository | null;
      pendingActionRepository?: BotPendingActionRepository | null;
      projectResolver?: TrackerProjectResolutionService | null;
      assistantModel?: BotAssistantModel;
    } = {},
  ) {
    this.telegramNotifier = telegramConfig.botToken ? new TelegramNotifier(telegramConfig) : null;
    this.discordNotifier = discordConfig.botToken ? new DiscordNotifier(discordConfig) : null;
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
    );
    this.assistantService = new BotAssistantService(
      runtime,
      this.commandService,
      options.preferencesRepository ?? null,
      options.pendingActionRepository ?? null,
      options.projectResolver ?? null,
      options.assistantModel ?? createBotAssistantModelFromEnv(),
      canWrite,
      this.subscriptions,
    );
  }

  getManifest(): BotManifest {
    const telegramInboundEnabled = Boolean(this.telegramConfig.botToken);
    const telegramOutboundEnabled = Boolean(this.telegramConfig.botToken);
    const discordInboundEnabled = Boolean(this.discordConfig.publicKey);
    const discordOutboundEnabled = Boolean(this.discordConfig.botToken);

    return {
      transports: {
        telegram: {
          enabled: telegramInboundEnabled || telegramOutboundEnabled,
          inbound_enabled: telegramInboundEnabled,
          outbound_enabled: telegramOutboundEnabled,
          watch_supported: telegramOutboundEnabled,
          write_requires_operator: this.telegramConfig.operatorIds.size > 0,
          inbound_path: '/api/v1/bots/telegram/webhook',
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

  dispose(): void {
    this.subscriptions.dispose();
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
    const response = text.startsWith('/')
      ? await this.commandService.executeText(context, text)
      : await this.assistantService.respondToText(context, text);

    await this.telegramNotifier.sendMessage(
      {
        transport: 'telegram',
        conversation_id: String(chatId),
      },
      response.message,
    );

    return {
      ok: true,
      status: 200,
      body: { ok: true },
    };
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

  return new DefaultBotGateway(runtime, {
    botToken: process.env.SYMPHONY_TELEGRAM_BOT_TOKEN || null,
    webhookSecret: process.env.SYMPHONY_TELEGRAM_WEBHOOK_SECRET || null,
    operatorIds: parseOperatorIds(process.env.SYMPHONY_TELEGRAM_OPERATOR_IDS),
  }, {
    botToken: process.env.SYMPHONY_DISCORD_BOT_TOKEN || null,
    publicKey: process.env.SYMPHONY_DISCORD_PUBLIC_KEY || null,
    operatorIds: parseOperatorIds(process.env.SYMPHONY_DISCORD_OPERATOR_IDS),
  }, undefined, subscriptionRepository, {
    preferencesRepository,
    pendingActionRepository,
    projectResolver: options.projectResolver ?? null,
    assistantModel: options.assistantModel,
  });
}
