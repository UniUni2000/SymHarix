/**
 * /cancel Command Handler
 * Cancel a task
 */

import type { SymphonyContext } from '../types';
import type { TaskRepository } from '../../database/repositories/taskRepository';

/**
 * Handle /cancel command
 * Usage: /cancel <TASK_ID> or /cancel <ISSUE-123>
 */
export async function handleCancel(
  ctx: SymphonyContext,
  taskRepo: TaskRepository,
): Promise<void> {
  const args = ctx.match as string;
  const userId = ctx.from?.id;

  // Check if task identifier was provided
  if (!args || args.trim() === '') {
    await ctx.reply(
      `❌ Please provide a task ID or identifier.\n\n` +
      `Usage: /cancel &lt;TASK_ID&gt;\n` +
      `Example: /cancel TASK-123\n\n` +
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

    // Check if task is in a terminal state
    if (task.state === 'Completed') {
      await ctx.reply(
        `⚠️ Task <b>${task.identifier}</b> is already completed.\n\n` +
        `Cannot cancel a completed task.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (task.state === 'Released') {
      await ctx.reply(
        `⚠️ Task <b>${task.identifier}</b> is already cancelled.\n\n` +
        `Current state: Released`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Cancel the task (update state to Released)
    const updatedTask = taskRepo.updateStatus(task.id, 'Released');

    if (!updatedTask) {
      await ctx.reply(
        `❌ Failed to cancel task. Please try again.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.reply(
      `🛑 Task cancelled!\n\n` +
      `<b>${updatedTask.identifier}</b>: ${updatedTask.title}\n\n` +
      `State: ⚪ Released (Cancelled)\n\n` +
      `The task has been released and will not be processed further.`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    console.error('Error in /cancel command:', error);
    await ctx.reply(
      `❌ An error occurred while cancelling the task.\n\n` +
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { parse_mode: 'HTML' },
    );
  }
}

/**
 * Create the /cancel command handler with dependency injection
 */
export function createCancelHandler(taskRepo: TaskRepository) {
  return (ctx: SymphonyContext) => handleCancel(ctx, taskRepo);
}
