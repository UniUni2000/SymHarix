/**
 * /help Command Handler
 * Shows available commands and usage information
 */

import type { SymphonyContext } from '../types';

/**
 * Handle /help command
 */
export async function handleHelp(ctx: SymphonyContext): Promise<void> {
  const helpMessage = `🤖 <b>Symphony Bot Help</b>

I'm your assistant for managing software development tasks.

<b>📋 Commands:</b>

<b>/start</b> or <b>/start &lt;ID&gt;</b>
  Start the bot or begin working on a task
  Example: /start TASK-123

<b>/new_issue</b>
  Create a new issue interactively
  I'll guide you through title, description, and priority

<b>/pause &lt;ID&gt;</b>
  Pause a running task
  Example: /pause TASK-123

<b>/cancel &lt;ID&gt;</b>
  Cancel a task
  Example: /cancel TASK-123

<b>/status &lt;ID&gt;</b>
  Check the status of a task
  Example: /status TASK-123

<b>/help</b>
  Show this help message

<b>💡 Tips:</b>
• You can use either task IDs or issue identifiers (e.g., "ABC-123")
• The bot will notify you when tasks complete
• Use descriptive titles when creating issues
• Set priority levels to help with task ordering

<b>🔗 Quick Links:</b>
• Dashboard: http://localhost:3000
• Documentation: [Coming Soon]

Need more help? Contact the development team.`;

  await ctx.reply(helpMessage, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/**
 * Create the /help command handler
 */
export function createHelpHandler() {
  return handleHelp;
}
