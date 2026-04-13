/**
 * Telegram Notification Sender
 * Sends notifications for task events to users
 */

import type { Bot } from 'grammy';
import type { SymphonyContext } from './types';
import type { TaskNotification, NotificationType } from './types';
import type { Task } from '../database/types';

/**
 * Notification sender class for Telegram
 */
export class TelegramNotificationSender {
  private bot: Bot<SymphonyContext>;
  private userSessions: Map<number, Set<number>> = new Map(); // userId -> Set of chatIds

  constructor(bot: Bot<SymphonyContext>) {
    this.bot = bot;
  }

  /**
   * Register a user's chat ID for notifications
   */
  registerUser(userId: number, chatId: number): void {
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId)?.add(chatId);
  }

  /**
   * Unregister a user's chat ID
   */
  unregisterUser(userId: number, chatId?: number): void {
    if (chatId) {
      this.userSessions.get(userId)?.delete(chatId);
    } else {
      this.userSessions.delete(userId);
    }
  }

  /**
   * Send a task notification to a user
   */
  async sendTaskNotification(
    userId: number,
    notification: TaskNotification,
  ): Promise<boolean> {
    const chatIds = this.userSessions.get(userId);
    if (!chatIds || chatIds.size === 0) {
      console.warn(`No chat IDs registered for user ${userId}`);
      return false;
    }

    const message = this.formatNotificationMessage(notification);
    const replyMarkup = this.getNotificationButtons(notification);

    let success = false;
    for (const chatId of chatIds) {
      try {
        await this.bot.api.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
          disable_web_page_preview: true,
        });
        success = true;
      } catch (error) {
        console.error(`Failed to send notification to chat ${chatId}:`, error);
      }
    }

    return success;
  }

  /**
   * Send task complete notification
   */
  async sendTaskComplete(
    userId: number,
    task: Task,
    message?: string,
  ): Promise<boolean> {
    return this.sendTaskNotification(userId, {
      type: 'task_complete',
      taskId: task.id,
      identifier: task.identifier,
      title: task.title,
      state: task.state,
      message: message ?? 'Task completed successfully!',
    });
  }

  /**
   * Send task error notification
   */
  async sendTaskError(
    userId: number,
    task: Task,
    error: string,
  ): Promise<boolean> {
    return this.sendTaskNotification(userId, {
      type: 'task_error',
      taskId: task.id,
      identifier: task.identifier,
      title: task.title,
      state: task.state,
      message: 'An error occurred during task execution.',
      error,
    });
  }

  /**
   * Send task milestone notification
   */
  async sendTaskMilestone(
    userId: number,
    task: Task,
    milestone: string,
  ): Promise<boolean> {
    return this.sendTaskNotification(userId, {
      type: 'task_milestone',
      taskId: task.id,
      identifier: task.identifier,
      title: task.title,
      state: task.state,
      message: milestone,
    });
  }

  /**
   * Send task started notification
   */
  async sendTaskStarted(
    userId: number,
    task: Task,
  ): Promise<boolean> {
    return this.sendTaskNotification(userId, {
      type: 'task_started',
      taskId: task.id,
      identifier: task.identifier,
      title: task.title,
      state: task.state,
      message: 'Task execution has started.',
    });
  }

  /**
   * Send task paused notification
   */
  async sendTaskPaused(
    userId: number,
    task: Task,
  ): Promise<boolean> {
    return this.sendTaskNotification(userId, {
      type: 'task_paused',
      taskId: task.id,
      identifier: task.identifier,
      title: task.title,
      state: task.state,
      message: 'Task has been paused.',
    });
  }

  /**
   * Send task cancelled notification
   */
  async sendTaskCancelled(
    userId: number,
    task: Task,
  ): Promise<boolean> {
    return this.sendTaskNotification(userId, {
      type: 'task_cancelled',
      taskId: task.id,
      identifier: task.identifier,
      title: task.title,
      state: task.state,
      message: 'Task has been cancelled.',
    });
  }

  /**
   * Format notification message
   */
  private formatNotificationMessage(notification: TaskNotification): string {
    const emoji = this.getNotificationEmoji(notification.type);
    const stateEmoji = this.getStateEmoji(notification.state);

    let message = `${emoji} <b>Task ${this.getNotificationTypeText(notification.type)}</b>\n\n`;
    message += `<b>${notification.identifier}</b>: ${notification.title}\n\n`;
    message += `State: ${stateEmoji} ${notification.state}\n`;

    if (notification.message) {
      message += `\n${notification.message}\n`;
    }

    if (notification.error) {
      message += `\n❌ Error: <code>${this.escapeHtml(notification.error)}</code>\n`;
    }

    message += `\nUse /status ${notification.identifier} for details.`;

    return message;
  }

  /**
   * Get notification type text
   */
  private getNotificationTypeText(type: NotificationType): string {
    const texts: Record<NotificationType, string> = {
      task_complete: 'Completed',
      task_error: 'Error',
      task_milestone: 'Milestone',
      task_started: 'Started',
      task_paused: 'Paused',
      task_cancelled: 'Cancelled',
    };
    return texts[type];
  }

  /**
   * Get emoji for notification type
   */
  private getNotificationEmoji(type: NotificationType): string {
    const emojis: Record<NotificationType, string> = {
      task_complete: '✅',
      task_error: '❌',
      task_milestone: '🎯',
      task_started: '🚀',
      task_paused: '⏸️',
      task_cancelled: '🛑',
    };
    return emojis[type];
  }

  /**
   * Get emoji for task state
   */
  private getStateEmoji(state: string): string {
    const emojis: Record<string, string> = {
      Unclaimed: '⚪',
      Claimed: '🔵',
      Running: '🟢',
      RetryQueued: '🟡',
      Released: '⚪',
      Completed: '✅',
      Failed: '❌',
    };
    return emojis[state] ?? '⚪';
  }

  /**
   * Get inline keyboard buttons for notification
   */
  private getNotificationButtons(
    notification: TaskNotification,
  ): { inline_keyboard: unknown[] } | undefined {
    const buttons = [
      [
        {
          text: '📊 View Status',
          callback_data: `status:${notification.identifier}`,
        },
      ],
    ];

    // Add action buttons based on state
    if (notification.state === 'Running') {
      buttons.push([
        {
          text: '⏸️ Pause',
          callback_data: `pause:${notification.identifier}`,
        },
        {
          text: '🛑 Cancel',
          callback_data: `cancel:${notification.identifier}`,
        },
      ]);
    } else if (notification.state === 'Claimed' || notification.state === 'Unclaimed') {
      buttons.push([
        {
          text: '▶️ Start',
          callback_data: `start:${notification.identifier}`,
        },
      ]);
    }

    return { inline_keyboard: buttons };
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Broadcast a message to all registered users
   */
  async broadcast(message: string): Promise<number> {
    let count = 0;
    for (const [userId, chatIds] of this.userSessions.entries()) {
      for (const chatId of chatIds) {
        try {
          await this.bot.api.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
          count++;
        } catch (error) {
          console.error(`Failed to broadcast to chat ${chatId}:`, error);
        }
      }
    }
    return count;
  }

  /**
   * Get the number of registered users
   */
  getRegisteredUserCount(): number {
    return this.userSessions.size;
  }
}

/**
 * Create notification sender from task event
 */
export function createNotificationFromEvent(
  task: Task,
  eventType: string,
  eventData?: Record<string, unknown>,
): TaskNotification | null {
  switch (eventType) {
    case 'session_started':
      return {
        type: 'task_started',
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        state: task.state,
        message: 'Task execution session started.',
      };
    case 'turn_completed':
      return {
        type: 'task_milestone',
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        state: task.state,
        message: `Turn completed: ${eventData?.turn_id ?? 'unknown'}`,
      };
    case 'turn_failed':
      return {
        type: 'task_error',
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        state: task.state,
        message: 'Turn execution failed.',
        error: String(eventData?.error ?? 'Unknown error'),
      };
    case 'turn_ended_with_error':
      return {
        type: 'task_error',
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        state: task.state,
        message: 'Turn ended with error.',
        error: String(eventData?.error ?? 'Unknown error'),
      };
    case 'task_completed':
      return {
        type: 'task_complete',
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        state: 'Completed',
        message: 'Task completed successfully!',
      };
    default:
      return null;
  }
}
