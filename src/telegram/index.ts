/**
 * Telegram Bot Entry Point
 * Symphony Bot using grammy framework
 */

import { Bot, Context } from 'grammy';
import type { Database } from 'bun:sqlite';
import { TaskRepository, EventRepository } from '../database/repositories';
import type { TelegramBotConfig, SymphonyContext } from './types';
import { TelegramNotificationSender } from './notifications';
import { createStartHandler } from './commands/start';
import { createHelpHandler } from './commands/help';
import { createNewIssueHandler, createNewIssueInputHandler } from './commands/newIssue';
import { createPauseHandler } from './commands/pause';
import { createCancelHandler } from './commands/cancel';
import { createStatusHandler } from './commands/status';

/**
 * SymphonyBot class
 * Main Telegram bot implementation
 */
export class SymphonyBot {
  private bot: Bot<SymphonyContext>;
  private taskRepo: TaskRepository;
  private eventRepo: EventRepository;
  private notificationSender: TelegramNotificationSender;
  private config: TelegramBotConfig;
  private isRunning = false;

  /**
   * Create a new SymphonyBot instance
   */
  constructor(db: Database, config: TelegramBotConfig) {
    this.config = config;
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new EventRepository(db);

    // Create bot instance with context type
    this.bot = new Bot<SymphonyContext>(config.token);

    // Set up custom context constructor
    this.bot.use(async (ctx, next) => {
      (ctx as SymphonyContext).session = (ctx as SymphonyContext).session ?? { state: 'idle', draft: {} };
      await next();
    });

    // Create notification sender
    this.notificationSender = new TelegramNotificationSender(this.bot);

    this.setupHandlers();
  }

  /**
   * Setup all bot handlers
   */
  private setupHandlers(): void {
    // Error handler
    this.bot.catch((err) => {
      console.error('Bot error:', err);
    });

    // User authorization middleware
    this.bot.use((ctx, next) => {
      const userId = ctx.from?.id;
      if (userId && this.config.allowedUserIds && this.config.allowedUserIds.length > 0) {
        if (!this.config.allowedUserIds.includes(userId)) {
          console.warn(`Unauthorized user attempt: ${userId}`);
          return ctx.reply('❌ 未授权的用户。此 Bot 仅供授权用户使用。');
        }
      }
      return next();
    });

    // Command handlers
    this.bot.command('start', createStartHandler(this.taskRepo));
    this.bot.command('help', createHelpHandler());
    this.bot.command('new_issue', createNewIssueHandler(this.taskRepo));
    this.bot.command('pause', createPauseHandler(this.taskRepo));
    this.bot.command('cancel', createCancelHandler(this.taskRepo));
    this.bot.command('status', createStatusHandler(this.taskRepo, this.eventRepo));

    // Handle text messages (for interactive flows like new_issue)
    this.bot.on('message:text', createNewIssueInputHandler(this.taskRepo));

    // Handle callback queries (for inline buttons)
    this.bot.on('callback_query:data', async (ctx) => {
      await this.handleCallbackQuery(ctx);
    });

    // Welcome new users
    this.bot.on('my_chat_member', async (ctx) => {
      if (ctx.myChatMember.new_chat_member.status === 'member') {
        await ctx.reply(
          '👋 Welcome to Symphony Bot! Use /help to see available commands.',
        );
      }
    });
  }

  /**
   * Handle callback query from inline buttons
   */
  private async handleCallbackQuery(ctx: SymphonyContext): Promise<void> {
    const data = ctx.callbackQuery?.data;
    if (!data || typeof data !== 'string') {
      await ctx.answerCallbackQuery();
      return;
    }

    // Parse callback data (format: "action:identifier")
    const [action, identifier] = data.split(':');

    if (!action || !identifier) {
      await ctx.answerCallbackQuery({ text: 'Invalid action' });
      return;
    }

    try {
      switch (action) {
        case 'start':
          await this.handleCallbackStart(ctx, identifier);
          break;
        case 'pause':
          await this.handleCallbackPause(ctx, identifier);
          break;
        case 'cancel':
          await this.handleCallbackCancel(ctx, identifier);
          break;
        case 'status':
          await this.handleCallbackStatus(ctx, identifier);
          break;
        case 'refresh':
          await this.handleCallbackRefresh(ctx, identifier);
          break;
        default:
          await ctx.answerCallbackQuery({ text: 'Unknown action' });
          return;
      }
    } catch (error) {
      console.error('Error handling callback:', error);
      await ctx.answerCallbackQuery({ text: 'An error occurred' });
    }
  }

  /**
   * Handle callback: start
   */
  private async handleCallbackStart(
    ctx: SymphonyContext,
    identifier: string,
  ): Promise<void> {
    // Create a mock context with match
    const mockCtx = {
      ...ctx,
      match: identifier,
    };
    await createStartHandler(this.taskRepo)(mockCtx as SymphonyContext);
    await ctx.answerCallbackQuery();
  }

  /**
   * Handle callback: pause
   */
  private async handleCallbackPause(
    ctx: SymphonyContext,
    identifier: string,
  ): Promise<void> {
    const mockCtx = {
      ...ctx,
      match: identifier,
    };
    await createPauseHandler(this.taskRepo)(mockCtx as SymphonyContext);
    await ctx.answerCallbackQuery();
  }

  /**
   * Handle callback: cancel
   */
  private async handleCallbackCancel(
    ctx: SymphonyContext,
    identifier: string,
  ): Promise<void> {
    const mockCtx = {
      ...ctx,
      match: identifier,
    };
    await createCancelHandler(this.taskRepo)(mockCtx as SymphonyContext);
    await ctx.answerCallbackQuery();
  }

  /**
   * Handle callback: status
   */
  private async handleCallbackStatus(
    ctx: SymphonyContext,
    identifier: string,
  ): Promise<void> {
    await this.handleCallbackRefresh(ctx, identifier);
    await ctx.answerCallbackQuery();
  }

  /**
   * Handle callback: refresh
   */
  private async handleCallbackRefresh(
    ctx: SymphonyContext,
    identifier: string,
  ): Promise<void> {
    const mockCtx = {
      ...ctx,
      match: identifier,
    };
    await createStatusHandler(this.taskRepo, this.eventRepo)(mockCtx as SymphonyContext);
    await ctx.answerCallbackQuery();
  }

  /**
   * Get the notification sender
   */
  getNotificationSender(): TelegramNotificationSender {
    return this.notificationSender;
  }

  /**
   * Get the underlying bot instance
   */
  getBot(): Bot<SymphonyContext> {
    return this.bot;
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('Bot is already running');
      return;
    }

    console.log('Starting Symphony Bot...');

    // Start polling
    this.bot.start({
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    });

    this.isRunning = true;
    console.log('Symphony Bot started');

    // Register shutdown handlers
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('Stopping Symphony Bot...');

    await this.bot.stop();
    this.isRunning = false;

    console.log('Symphony Bot stopped');
  }

  /**
   * Check if bot is running
   */
  isBotRunning(): boolean {
    return this.isRunning;
  }
}

/**
 * Create and start a SymphonyBot instance
 */
export async function createBot(
  db: Database,
  config: TelegramBotConfig,
): Promise<SymphonyBot> {
  const bot = new SymphonyBot(db, config);
  await bot.start();
  return bot;
}

export default SymphonyBot;
