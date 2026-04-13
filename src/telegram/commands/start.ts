/**
 * /start Command Handler
 * Initializes the bot and optionally starts a task for a given issue ID
 */

import type { SymphonyContext } from '../types';
import type { TaskRepository } from '../../database/repositories/taskRepository';

/**
 * Handle /start command
 * Usage:
 * - /start - Show welcome message
 * - /start <TASK_ID> - Start a task by ID
 * - /start <ISSUE-123> - Start a task by issue identifier
 */
export async function handleStart(
  ctx: SymphonyContext,
  taskRepo: TaskRepository,
): Promise<void> {
  const args = ctx.match as string;
  const userId = ctx.from?.id;
  const firstName = ctx.from?.first_name ?? 'there';

  // No arguments - show welcome message
  if (!args || args.trim() === '') {
    const welcomeMessage = `👋 Welcome to Symphony Bot, ${firstName}!

I'm your assistant for managing development tasks.

<b>Available Commands:</b>
/new_issue - Create a new issue interactively
/start &lt;ID&gt; - Start a task for an issue
/pause &lt;ID&gt; - Pause a running task
/cancel &lt;ID&gt; - Cancel a task
/status &lt;ID&gt; - Check task status
/help - Show this help message

<b>Quick Start:</b>
1. Use /new_issue to create your first issue
2. Use /start &lt;ISSUE-123&gt; to begin working on it
3. Get notified when tasks complete!

Need help? Use /help for more information.`;

    await ctx.reply(welcomeMessage, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return;
  }

  // Parse task identifier from arguments
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
        `Please check the task ID/identifier and try again.\n` +
        `Use /help to see available commands.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Check if task is already running
    if (task.state === 'Running') {
      await ctx.reply(
        `✅ Task <b>${task.identifier}</b> is already running.\n\n` +
        `Title: ${task.title}\n` +
        `State: 🟢 Running\n\n` +
        `Use /pause ${task.identifier} to pause it.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Check if task is in a terminal state
    if (task.state === 'Completed') {
      await ctx.reply(
        `✅ Task <b>${task.identifier}</b> is already completed.\n\n` +
        `Title: ${task.title}\n` +
        `Use /new_issue to create a new task.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (task.state === 'Failed') {
      await ctx.reply(
        `❌ Task <b>${task.identifier}</b> has failed.\n\n` +
        `Title: ${task.title}\n\n` +
        `Would you like to retry? (This feature is coming soon)`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Start the task (update state to Running)
    const updatedTask = taskRepo.updateStatus(task.id, 'Running');

    if (!updatedTask) {
      await ctx.reply(
        `❌ Failed to start task. Please try again.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.reply(
      `🚀 Task started!\n\n` +
      `<b>${updatedTask.identifier}</b>: ${updatedTask.title}\n\n` +
      `State: 🟢 Running\n` +
      `Priority: ${updatedTask.priority ?? 'Normal'}\n\n` +
      `I'll notify you when the task completes or if there are any issues.\n\n` +
      `Use /status ${updatedTask.identifier} to check progress.`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    console.error('Error in /start command:', error);
    await ctx.reply(
      `❌ An error occurred while starting the task.\n\n` +
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { parse_mode: 'HTML' },
    );
  }
}

/**
 * Create the /start command handler with dependency injection
 */
export function createStartHandler(taskRepo: TaskRepository) {
  return (ctx: SymphonyContext) => handleStart(ctx, taskRepo);
}
