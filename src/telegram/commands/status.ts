/**
 * /status Command Handler
 * Check the status of a task
 */

import type { SymphonyContext } from '../types';
import type { TaskRepository } from '../../database/repositories/taskRepository';
import type { EventRepository } from '../../database/repositories/eventRepository';

/**
 * Handle /status command
 * Usage: /status <TASK_ID> or /status <ISSUE-123>
 */
export async function handleStatus(
  ctx: SymphonyContext,
  taskRepo: TaskRepository,
  eventRepo?: EventRepository,
): Promise<void> {
  const args = ctx.match as string;
  const userId = ctx.from?.id;

  // Check if task identifier was provided
  if (!args || args.trim() === '') {
    await ctx.reply(
      `❌ Please provide a task ID or identifier.\n\n` +
      `Usage: /status &lt;TASK_ID&gt;\n` +
      `Example: /status TASK-123\n\n` +
      `Use /help for more information.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const identifier = args.trim();

  try {
    // Try to find task by issue identifier or ID
    let task = taskRepo.findByIssueId(identifier);
    if (!task) {
      task = taskRepo.findById(identifier);
    }

    if (!task) {
      await ctx.reply(
        `❌ Task not found: ${identifier}\n\n` +
        `Please check the task ID/identifier and try again.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Build status message
    const stateEmoji = getStateEmoji(task.state);
    const priorityText = task.priority
      ? `${task.priority}/4 ${getPriorityEmoji(task.priority)}`
      : 'Normal';

    let statusMessage = `📊 <b>Task Status</b>\n\n` +
      `<b>${task.identifier}</b>: ${task.title}\n\n` +
      `State: ${stateEmoji} ${task.state}\n` +
      `Priority: ${priorityText}\n` +
      `Created: ${formatDate(task.created_at)}\n` +
      `Updated: ${formatDate(task.updated_at)}\n`;

    // Add optional fields
    if (task.description) {
      const descPreview = task.description.length > 100
        ? task.description.substring(0, 100) + '...'
        : task.description;
      statusMessage += `\nDescription: ${descPreview}\n`;
    }

    if (task.labels && task.labels.length > 0) {
      statusMessage += `\nLabels: ${task.labels.map((l) => `#${l}`).join(' ')}\n`;
    }

    if (task.url) {
      statusMessage += `\n🔗 <a href="${task.url}">View in Tracker</a>\n`;
    }

    // Add retry info if applicable
    if (task.retry_count > 0) {
      statusMessage += `\n⚠️ Retries: ${task.retry_count}/${task.max_retries}\n`;
    }

    // Add recent events if event repository is provided
    if (eventRepo) {
      const events = eventRepo.findByTaskId(task.id, { limit: 3 });
      if (events.length > 0) {
        statusMessage += `\n<b>Recent Events:</b>\n`;
        events.forEach((event) => {
          const eventEmoji = getEventEmoji(event.event_type);
          const timeAgo = getTimeAgo(event.created_at);
          statusMessage += `\n${eventEmoji} ${event.event_type} - ${timeAgo}`;
        });
      }
    }

    // Add action buttons based on state
    const replyMarkup = getActionButtons(task);

    await ctx.reply(statusMessage, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  } catch (error) {
    console.error('Error in /status command:', error);
    await ctx.reply(
      `❌ An error occurred while fetching task status.\n\n` +
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { parse_mode: 'HTML' },
    );
  }
}

/**
 * Get emoji for task state
 */
function getStateEmoji(state: string): string {
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
 * Get emoji for priority level
 */
function getPriorityEmoji(priority: number): string {
  const emojis: Record<number, string> = {
    1: '🔴',
    2: '🟠',
    3: '🟡',
    4: '🟢',
  };
  return emojis[priority] ?? '⚪';
}

/**
 * Get emoji for event type
 */
function getEventEmoji(eventType: string): string {
  const emojis: Record<string, string> = {
    session_started: '🚀',
    startup_failed: '❌',
    turn_completed: '✅',
    turn_failed: '❌',
    turn_cancelled: '⏸️',
    turn_ended_with_error: '⚠️',
    turn_input_required: '📥',
    approval_auto_approved: '✅',
    notification: '📢',
  };
  return emojis[eventType] ?? '📝';
}

/**
 * Format date for display
 */
function formatDate(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Get time ago string
 */
function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) {
    return 'Just now';
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else {
    return `${diffDays}d ago`;
  }
}

/**
 * Get action buttons based on task state
 */
function getActionButtons(task: { id: string; identifier: string; state: string }) {
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  const row: Array<{ text: string; callback_data: string }> = [];

  // Add action buttons based on state
  if (task.state === 'Unclaimed' || task.state === 'Claimed') {
    row.push({
      text: '▶️ Start',
      callback_data: `start:${task.identifier}`,
    });
  } else if (task.state === 'Running') {
    row.push({
      text: '⏸️ Pause',
      callback_data: `pause:${task.identifier}`,
    });
    row.push({
      text: '🛑 Cancel',
      callback_data: `cancel:${task.identifier}`,
    });
  } else if (task.state === 'RetryQueued') {
    row.push({
      text: '🛑 Cancel',
      callback_data: `cancel:${task.identifier}`,
    });
  }

  if (row.length > 0) {
    buttons.push(row);
  }

  // Add refresh button
  buttons.push([{
    text: '🔄 Refresh',
    callback_data: `refresh:${task.identifier}`,
  }]);

  return buttons.length > 0 ? { inline_keyboard: buttons } : undefined;
}

/**
 * Create the /status command handler with dependency injection
 */
export function createStatusHandler(
  taskRepo: TaskRepository,
  eventRepo?: EventRepository,
) {
  return (ctx: SymphonyContext) => handleStatus(ctx, taskRepo, eventRepo);
}
