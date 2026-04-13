/**
 * Telegram Bot Types for Symphony Enterprise Agent Platform
 */

import type { Context } from 'grammy';
import type { Task, TaskStatus } from '../database/types';

/**
 * Telegram Bot configuration
 */
export interface TelegramBotConfig {
  /** Bot token from @BotFather */
  token: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Allowed user IDs (if empty, all users are allowed) */
  allowedUserIds?: number[];
}

/**
 * Bot session state for interactive flows
 */
export interface BotSession {
  /** Current state in the conversation flow */
  state: 'idle' | 'awaiting_title' | 'awaiting_description' | 'awaiting_priority';
  /** Temporary data for issue creation */
  draft?: {
    title?: string;
    description?: string;
    priority?: number;
  };
}

/**
 * Extended context with session support
 */
export interface SymphonyContext extends Context {
  session?: BotSession;
}

/**
 * Command handler function
 */
export type CommandHandler = (ctx: SymphonyContext) => Promise<void>;

/**
 * Task notification types
 */
export type NotificationType =
  | 'task_complete'
  | 'task_error'
  | 'task_milestone'
  | 'task_started'
  | 'task_paused'
  | 'task_cancelled';

/**
 * Task notification payload
 */
export interface TaskNotification {
  /** Type of notification */
  type: NotificationType;
  /** Task ID */
  taskId: string;
  /** Task identifier (e.g., "ABC-123") */
  identifier: string;
  /** Task title */
  title: string;
  /** Current state */
  state: string;
  /** Additional message */
  message?: string;
  /** Optional error details */
  error?: string;
}

/**
 * User mapping for Telegram to internal users
 */
export interface TelegramUser {
  /** Telegram user ID */
  telegramId: number;
  /** Internal user ID (if linked) */
  userId?: string;
  /** Username */
  username?: string;
  /** First name */
  firstName: string;
  /** Last name (optional) */
  lastName?: string;
  /** When user started the bot */
  startedAt: Date;
  /** User preferences */
  preferences: UserPreferences;
}

/**
 * User notification preferences
 */
export interface UserPreferences {
  /** Receive task complete notifications */
  notifyOnComplete: boolean;
  /** Receive task error notifications */
  notifyOnError: boolean;
  /** Receive milestone notifications */
  notifyOnMilestone: boolean;
  /** Notification quiet hours */
  quietHours?: {
    start: number; // Hour (0-23)
    end: number; // Hour (0-23)
  };
}

/**
 * Callback data for inline buttons
 */
export interface CallbackData {
  /** Action type */
  action: string;
  /** Associated task ID */
  taskId?: string;
  /** Additional data */
  data?: Record<string, string>;
}

/**
 * Inline keyboard button definition
 */
export interface InlineButton {
  /** Button label */
  text: string;
  /** Callback data */
  callback_data: string;
}

/**
 * Response for command handlers
 */
export interface CommandResponse {
  /** Whether the command was handled */
  handled: boolean;
  /** Response message */
  message?: string;
  /** Optional error */
  error?: string;
}

/**
 * Parsed task reference from command arguments
 */
export interface TaskReference {
  /** Full task ID (UUID format) */
  fullId?: string;
  /** Short ID (first 8 chars) */
  shortId?: string;
  /** Issue identifier (e.g., "ABC-123") */
  identifier?: string;
}

/**
 * Task summary for Telegram messages
 */
export interface TaskSummary {
  id: string;
  identifier: string;
  title: string;
  state: string;
  priority: number | null;
  url: string | null;
  labels: string[];
}

/**
 * Formatting helper for task state
 */
export function formatState(state: string): string {
  const stateEmojis: Record<string, string> = {
    Unclaimed: '⚪',
    Claimed: '🔵',
    Running: '🟢',
    RetryQueued: '🟡',
    Released: '⚪',
    Completed: '✅',
    Failed: '❌',
  };
  return `${stateEmojis[state] ?? '⚪'} ${state}`;
}

/**
 * Serialize callback data to string
 */
export function serializeCallbackData(data: CallbackData): string {
  return JSON.stringify(data);
}

/**
 * Parse callback data from string
 */
export function parseCallbackData(data: string): CallbackData | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
