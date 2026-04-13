/**
 * /pause Command Handler
 * Pause a running task
 */

import type { SymphonyContext } from '../types';
import type { TaskRepository } from '../../database/repositories/taskRepository';

/**
 * Handle /pause command
 * Usage: /pause <TASK_ID> or /pause <ISSUE-123>
 */
export async function handlePause(
  ctx: SymphonyContext,
  taskRepo: TaskRepository,
): Promise<void> {
  const args = ctx.match as string;
  const userId = ctx.from?.id;

  // Check if task identifier was provided
  if (!args || args.trim() === '') {
    await ctx.reply(
      `❌ Please provide a task ID or identifier.\n\n` +
      `Usage: /pause &lt;TASK_ID&gt;\n` +
      `Example: /pause TASK-123\n\n` +
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
        `Please check the task ID/identifier and try again.\n` +
        `Use /status &lt;ID&gt; to check task status.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Check if task is running
    if (task.state !== 'Running') {
      await ctx.reply(
        `⚠️ Task <b>${task.identifier}</b> is not running.\n\n` +
        `Current state: ${formatState(task.state)}\n\n` +
        `You can only pause tasks that are currently running.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // Pause the task (update state to Claimed)
    const updatedTask = taskRepo.updateStatus(task.id, 'Claimed');

    if (!updatedTask) {
      await ctx.reply(
        `❌ Failed to pause task. Please try again.`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.reply(
      `⏸️ Task paused!\n\n` +
      `<b>${updatedTask.identifier}</b>: ${updatedTask.title}\n\n` +
      `State: 🔵 Claimed (Paused)\n\n` +
      `Use <b>/start ${updatedTask.identifier}</b> to resume.`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    console.error('Error in /pause command:', error);
    await ctx.reply(
      `❌ An error occurred while pausing the task.\n\n` +
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { parse_mode: 'HTML' },
    );
  }
}

/**
 * Format state with emoji
 */
function formatState(state: string): string {
  const stateEmojis: Record<string, string> = {
    Unclaimed: '⚪ Unclaimed',
    Claimed: '🔵 Claimed',
    Running: '🟢 Running',
    RetryQueued: '🟡 Retry Queued',
    Released: '⚪ Released',
    Completed: '✅ Completed',
    Failed: '❌ Failed',
  };
  return stateEmojis[state] ?? state;
}

/**
 * Create the /pause command handler with dependency injection
 */
export function createPauseHandler(taskRepo: TaskRepository) {
  return (ctx: SymphonyContext) => handlePause(ctx, taskRepo);
}
