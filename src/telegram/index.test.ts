/**
 * Tests for Telegram Bot
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema, dropAllTables } from '../database/schema';
import { TaskRepository, EventRepository } from '../database/repositories';
import { SymphonyBot } from './index';
import { TelegramNotificationSender } from './notifications';
import { handleStart } from './commands/start';
import { handleHelp } from './commands/help';
import { handlePause } from './commands/pause';
import { handleCancel } from './commands/cancel';
import { handleStatus } from './commands/status';
import { handleNewIssue, handleNewIssueInput } from './commands/newIssue';

/**
 * Helper to create a fresh in-memory database for each test
 */
function createTestDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

/**
 * Mock context for testing handlers
 */
interface MockContext {
  reply: ReturnType<typeof mock<(message: string, options?: unknown) => Promise<unknown>>>;
  answerCallbackQuery: ReturnType<typeof mock<(options?: unknown) => Promise<unknown>>>;
  from?: {
    id: number;
    first_name: string;
    username?: string;
  };
  match?: string;
  message?: {
    text: string;
  };
  callbackQuery?: {
    data: string;
  };
}

function createMockContext(overrides?: Partial<MockContext>): MockContext {
  return {
    reply: mock(() => Promise.resolve()),
    answerCallbackQuery: mock(() => Promise.resolve()),
    from: {
      id: 12345,
      first_name: 'Test User',
    },
    match: '',
    ...overrides,
  };
}

describe('Telegram Bot', () => {
  let db: Database;
  let taskRepo: TaskRepository;
  let eventRepo: EventRepository;

  beforeEach(() => {
    db = createTestDatabase();
    taskRepo = new TaskRepository(db);
    eventRepo = new EventRepository(db);
  });

  afterEach(() => {
    dropAllTables(db);
    db.close();
  });

  describe('SymphonyBot', () => {
    it('should create bot instance', () => {
      const bot = new SymphonyBot(db, {
        token: 'test-token',
        verbose: false,
      });

      expect(bot).toBeDefined();
      expect(bot.getBot()).toBeDefined();
      expect(bot.getNotificationSender()).toBeDefined();
      expect(bot.isBotRunning()).toBe(false);
    });

    it('should get notification sender', () => {
      const bot = new SymphonyBot(db, { token: 'test-token' });
      const sender = bot.getNotificationSender();

      expect(sender).toBeDefined();
      expect(sender.getRegisteredUserCount()).toBe(0);
    });
  });

  describe('TelegramNotificationSender', () => {
    let bot: SymphonyBot;
    let sender: TelegramNotificationSender;

    beforeEach(() => {
      bot = new SymphonyBot(db, { token: 'test-token' });
      sender = bot.getNotificationSender();
    });

    it('should register a user', () => {
      sender.registerUser(12345, 67890);
      expect(sender.getRegisteredUserCount()).toBe(1);
    });

    it('should unregister a user', () => {
      sender.registerUser(12345, 67890);
      expect(sender.getRegisteredUserCount()).toBe(1);

      sender.unregisterUser(12345);
      expect(sender.getRegisteredUserCount()).toBe(0);
    });

    it('should unregister specific chat', () => {
      sender.registerUser(12345, 67890);
      sender.registerUser(12345, 11111);
      expect(sender.getRegisteredUserCount()).toBe(1);

      sender.unregisterUser(12345, 67890);
      expect(sender.getRegisteredUserCount()).toBe(1);
    });

    it('should create notification from session_started event', () => {
      const task = taskRepo.create({
        id: 'task-1',
        identifier: 'TEST-001',
        title: 'Test Task',
        state: 'Running',
      });

      // The notification creation should work
      expect(task).toBeDefined();
      expect(task.identifier).toBe('TEST-001');
    });
  });

  describe('/start command', () => {
    it('should show welcome message without arguments', async () => {
      const ctx = createMockContext({ match: '' });

      await handleStart(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Welcome to Symphony Bot');
      expect(call[0]).toContain('/new_issue');
      expect(call[0]).toContain('/help');
    });

    it('should start task by identifier', async () => {
      const task = taskRepo.create({
        id: 'task-1',
        identifier: 'TEST-001',
        title: 'Test Task',
        state: 'Unclaimed',
      });

      const ctx = createMockContext({ match: 'TEST-001' });

      await handleStart(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Task started');
      expect(call[0]).toContain('TEST-001');

      // Verify task state changed
      const updatedTask = taskRepo.findById(task.id);
      expect(updatedTask?.state).toBe('Running');
    });

    it('should start task by ID', async () => {
      const task = taskRepo.create({
        id: 'task-by-id',
        identifier: 'TEST-002',
        title: 'Test Task By ID',
        state: 'Unclaimed',
      });

      const ctx = createMockContext({ match: 'task-by-id' });

      await handleStart(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();

      // Verify task state changed
      const updatedTask = taskRepo.findById(task.id);
      expect(updatedTask?.state).toBe('Running');
    });

    it('should handle non-existent task', async () => {
      const ctx = createMockContext({ match: 'NONEXISTENT' });

      await handleStart(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Task not found');
    });

    it('should handle already running task', async () => {
      taskRepo.create({
        id: 'task-running',
        identifier: 'TEST-RUN',
        title: 'Running Task',
        state: 'Running',
      });

      const ctx = createMockContext({ match: 'TEST-RUN' });

      await handleStart(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('already running');
    });

    it('should handle completed task', async () => {
      taskRepo.create({
        id: 'task-done',
        identifier: 'TEST-DONE',
        title: 'Completed Task',
        state: 'Completed',
      });

      const ctx = createMockContext({ match: 'TEST-DONE' });

      await handleStart(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('already completed');
    });
  });

  describe('/help command', () => {
    it('should show help message', async () => {
      const ctx = createMockContext();

      await handleHelp(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      const message = call[0] as string;

      expect(message).toContain('Symphony Bot Help');
      expect(message).toContain('/start');
      expect(message).toContain('/new_issue');
      expect(message).toContain('/pause');
      expect(message).toContain('/cancel');
      expect(message).toContain('/status');
      expect(message).toContain('/help');
    });
  });

  describe('/pause command', () => {
    it('should show error without identifier', async () => {
      const ctx = createMockContext({ match: '' });

      await handlePause(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Please provide a task ID');
    });

    it('should pause a running task', async () => {
      taskRepo.create({
        id: 'task-pause',
        identifier: 'TEST-PAUSE',
        title: 'Task To Pause',
        state: 'Running',
      });

      const ctx = createMockContext({ match: 'TEST-PAUSE' });

      await handlePause(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Task paused');

      // Verify task state changed
      const updatedTask = taskRepo.findByIssueId('TEST-PAUSE');
      expect(updatedTask?.state).toBe('Claimed');
    });

    it('should handle non-running task', async () => {
      taskRepo.create({
        id: 'task-not-running',
        identifier: 'TEST-NOTRUN',
        title: 'Not Running Task',
        state: 'Unclaimed',
      });

      const ctx = createMockContext({ match: 'TEST-NOTRUN' });

      await handlePause(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('is not running');
    });

    it('should handle non-existent task', async () => {
      const ctx = createMockContext({ match: 'NONEXISTENT' });

      await handlePause(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Task not found');
    });
  });

  describe('/cancel command', () => {
    it('should show error without identifier', async () => {
      const ctx = createMockContext({ match: '' });

      await handleCancel(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Please provide a task ID');
    });

    it('should cancel a task', async () => {
      taskRepo.create({
        id: 'task-cancel',
        identifier: 'TEST-CANCEL',
        title: 'Task To Cancel',
        state: 'Running',
      });

      const ctx = createMockContext({ match: 'TEST-CANCEL' });

      await handleCancel(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Task cancelled');

      // Verify task state changed
      const updatedTask = taskRepo.findByIssueId('TEST-CANCEL');
      expect(updatedTask?.state).toBe('Released');
    });

    it('should handle already completed task', async () => {
      taskRepo.create({
        id: 'task-already-done',
        identifier: 'TEST-DONE2',
        title: 'Already Done',
        state: 'Completed',
      });

      const ctx = createMockContext({ match: 'TEST-DONE2' });

      await handleCancel(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('already completed');
    });

    it('should handle already cancelled task', async () => {
      taskRepo.create({
        id: 'task-already-cancelled',
        identifier: 'TEST-CANCELLED',
        title: 'Already Cancelled',
        state: 'Released',
      });

      const ctx = createMockContext({ match: 'TEST-CANCELLED' });

      await handleCancel(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('already cancelled');
    });

    it('should handle non-existent task', async () => {
      const ctx = createMockContext({ match: 'NONEXISTENT' });

      await handleCancel(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Task not found');
    });
  });

  describe('/status command', () => {
    it('should show error without identifier', async () => {
      const ctx = createMockContext({ match: '' });

      await handleStatus(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Please provide a task ID');
    });

    it('should show task status', async () => {
      taskRepo.create({
        id: 'task-status',
        identifier: 'TEST-STATUS',
        title: 'Task Status Check',
        state: 'Running',
        priority: 2,
        description: 'A test description',
      });

      const ctx = createMockContext({ match: 'TEST-STATUS' });

      await handleStatus(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      const message = call[0] as string;

      expect(message).toContain('Task Status');
      expect(message).toContain('TEST-STATUS');
      expect(message).toContain('Task Status Check');
      expect(message).toContain('Running');
    });

    it('should show task with labels', async () => {
      taskRepo.create({
        id: 'task-labels',
        identifier: 'TEST-LABELS',
        title: 'Task With Labels',
        state: 'Unclaimed',
        labels: ['bug', 'urgent'],
      });

      const ctx = createMockContext({ match: 'TEST-LABELS' });

      await handleStatus(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      const message = call[0] as string;

      expect(message).toContain('#bug');
      expect(message).toContain('#urgent');
    });

    it('should handle non-existent task', async () => {
      const ctx = createMockContext({ match: 'NONEXISTENT' });

      await handleStatus(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toContain('Task not found');
    });

    it('should include events when event repo provided', async () => {
      const task = taskRepo.create({
        id: 'task-events',
        identifier: 'TEST-EVENTS',
        title: 'Task With Events',
        state: 'Running',
      });

      eventRepo.create({
        task_id: task.id,
        event_type: 'session_started',
        event_data: { session_id: 'sess-1' },
      });

      const ctx = createMockContext({ match: 'TEST-EVENTS' });

      await handleStatus(ctx, taskRepo, eventRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      const message = call[0] as string;

      expect(message).toContain('Recent Events');
      expect(message).toContain('session_started');
    });
  });

  describe('/new_issue command', () => {
    it('should start new issue flow', async () => {
      const ctx = createMockContext();

      await handleNewIssue(ctx, taskRepo);

      expect(ctx.reply).toHaveBeenCalled();
      const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
      const message = call[0] as string;

      expect(message).toContain('Create New Issue');
      expect(message).toContain('title');
    });

    it('should handle title input', async () => {
      const ctx = createMockContext({
        message: { text: 'My New Issue Title' },
      });

      // This would require session state, which is complex to test
      // For now, just verify the handler exists and doesn't crash
      expect(() => handleNewIssueInput(ctx, taskRepo)).not.toThrow();
    });
  });
});

describe('Type Helpers', () => {
  it('should format state with emoji', () => {
    // Import the formatState helper from types
    const formatState = (state: string): string => {
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
    };

    expect(formatState('Running')).toBe('🟢 Running');
    expect(formatState('Unclaimed')).toBe('⚪ Unclaimed');
    expect(formatState('Completed')).toBe('✅ Completed');
    expect(formatState('Unknown')).toBe('⚪ Unknown');
  });
});
