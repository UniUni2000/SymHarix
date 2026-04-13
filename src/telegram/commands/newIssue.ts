/**
 * /new_issue Command Handler
 * Interactive issue creation flow
 */

import type { SymphonyContext, BotSession } from '../types';
import type { TaskRepository } from '../../database/repositories/taskRepository';

// Session key for storing user state
const SESSION_KEY = 'telegram_session';

/**
 * Get session for a user
 */
function getSession(ctx: SymphonyContext): BotSession {
  const userId = ctx.from?.id?.toString() ?? 'unknown';
  const sessionData = (ctx as unknown as Record<string, unknown>)[SESSION_KEY] as BotSession | undefined;
  return sessionData ?? { state: 'idle', draft: {} };
}

/**
 * Set session for a user
 */
function setSession(ctx: SymphonyContext, session: BotSession): void {
  const userId = ctx.from?.id?.toString() ?? 'unknown';
  (ctx as unknown as Record<string, unknown>)[SESSION_KEY] = session;
}

/**
 * Handle /new_issue command - Start interactive creation flow
 */
export async function handleNewIssue(
  ctx: SymphonyContext,
  taskRepo: TaskRepository,
): Promise<void> {
  const userId = ctx.from?.id;
  const firstName = ctx.from?.first_name ?? 'there';

  // Initialize session
  const session: BotSession = { state: 'awaiting_title', draft: {} };
  setSession(ctx, session);

  const introMessage = `📝 <b>Create New Issue</b>

Hi ${firstName}! Let's create a new issue together.

Please enter the <b>title</b> for your issue:

<i>Example: "Fix login button not responding"</i>

Or send /cancel to abort.`;

  await ctx.reply(introMessage, {
    parse_mode: 'HTML',
    reply_markup: {
      force_reply: true,
      input_field_placeholder: 'Enter issue title...',
    },
  });
}

/**
 * Handle user input during new_issue flow
 */
export async function handleNewIssueInput(
  ctx: SymphonyContext,
  taskRepo: TaskRepository,
): Promise<void> {
  const userId = ctx.from?.id;
  const message = ctx.message;

  // Only handle text messages
  if (!message || !('text' in message)) {
    return;
  }

  const text = message.text;
  if (!text) {
    return;
  }

  const session = getSession(ctx);

  // Handle based on current state
  switch (session.state) {
    case 'awaiting_title':
      await handleTitleInput(ctx, taskRepo, text);
      break;
    case 'awaiting_description':
      await handleDescriptionInput(ctx, taskRepo, text);
      break;
    case 'awaiting_priority':
      await handlePriorityInput(ctx, taskRepo, text);
      break;
    default:
      // Not in a flow, ignore
      break;
  }
}

/**
 * Handle title input
 */
async function handleTitleInput(
  ctx: SymphonyContext,
  taskRepo: TaskRepository,
  title: string,
): Promise<void> {
  const session = getSession(ctx);
  session.draft = { ...session.draft, title };
  session.state = 'awaiting_description';
  setSession(ctx, session);

  await ctx.reply(
    `✅ Title received: "${title}"\n\n` +
    `Now enter a <b>description</b> (optional):\n\n` +
    `<i>Example: "The login button doesn't respond when clicked. This happens on Chrome and Firefox."\n\n` +
    `Or send /skip to skip the description.</i>\n\n` +
    `Or send /cancel to abort.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Enter description (optional)...',
      },
    },
  );
}

/**
 * Handle description input
 */
async function handleDescriptionInput(
  ctx: SymphonyContext,
  taskRepo: TaskRepository,
  description: string,
): Promise<void> {
  const session = getSession(ctx);
  session.draft = { ...session.draft, description };
  session.state = 'awaiting_priority';
  setSession(ctx, session);

  await ctx.reply(
    `✅ Description received\n\n` +
    `Now select a <b>priority</b> level:\n\n` +
    `1 - 🔴 Urgent (highest priority)\n` +
    `2 - 🟠 High\n` +
    `3 - 🟡 Normal (default)\n` +
    `4 - 🟢 Low\n\n` +
    `Send a number (1-4) or /skip for default.`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Enter priority (1-4)...',
      },
    },
  );
}

/**
 * Handle priority input and create the task
 */
async function handlePriorityInput(
  ctx: SymphonyContext,
  taskRepo: TaskRepository,
  priorityInput: string,
): Promise<void> {
  const session = getSession(ctx);
  const draft = session.draft;

  if (!draft.title) {
    await ctx.reply('❌ Error: Missing title. Please start over with /new_issue');
    return;
  }

  // Parse priority
  let priority: number | null = null;
  const priorityMap: Record<string, number> = {
    '1': 1,
    '2': 2,
    '3': 3,
    '4': 4,
  };

  if (priorityInput.trim() !== '/skip') {
    const num = priorityMap[priorityInput.trim()];
    if (num) {
      priority = num;
    }
  }

  // Generate a unique identifier
  const identifier = `ISSUE-${Date.now().toString().slice(-6)}`;

  try {
    // Create the task
    const task = taskRepo.create({
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      identifier,
      title: draft.title,
      description: draft.description ?? null,
      priority,
      state: 'Unclaimed',
      labels: ['telegram'],
    });

    // Reset session
    setSession(ctx, { state: 'idle', draft: {} });

    await ctx.reply(
      `✅ <b>Issue Created!</b>\n\n` +
      `<b>${task.identifier}</b>: ${task.title}\n\n` +
      `Description: ${draft.description ?? 'None'}\n` +
      `Priority: ${priority ? `${priority}/4` : 'Normal'}\n` +
      `State: ⚪ Unclaimed\n\n` +
      `Use <b>/start ${task.identifier}</b> to begin working on it!`,
      {
        parse_mode: 'HTML',
      },
    );
  } catch (error) {
    console.error('Error creating issue:', error);
    await ctx.reply(
      `❌ Failed to create issue.\n\n` +
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}\n\n` +
      `Please try again or use /help for assistance.`,
      { parse_mode: 'HTML' },
    );
  }
}

/**
 * Create the /new_issue command handler with dependency injection
 */
export function createNewIssueHandler(taskRepo: TaskRepository) {
  return (ctx: SymphonyContext) => handleNewIssue(ctx, taskRepo);
}

/**
 * Create the input handler for new_issue flow
 */
export function createNewIssueInputHandler(taskRepo: TaskRepository) {
  return (ctx: SymphonyContext) => handleNewIssueInput(ctx, taskRepo);
}
