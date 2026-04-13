/**
 * Integration Tests for Symphony Enterprise Agent Platform
 * End-to-end tests covering full system integration
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from 'bun:test';
import { Database } from 'bun:sqlite';
import { SymphonyServer } from '../server/index';
import { initializeSchema, dropAllTables } from '../database/schema';
import { TaskRepository, EventRepository } from '../database/repositories';
import { TaskEventsManager } from '../server/websocket/taskEvents';
import {
  TelegramNotificationSender,
  createNotificationFromEvent,
} from '../telegram/notifications';
import type { Task } from '../database/types';

/**
 * Mock Telegram Bot for testing
 */
class MockTelegramBot {
  public api = {
    sendMessage: mock(async (chatId: number, text: string) => {
      return { success: true, chatId, text };
    }),
  };

  start = mock(() => {
    // Mock start method
  });

  stop = mock(() => {
    // Mock stop method
  });
}

/**
 * Integration test helper to create a fresh test environment
 */
interface TestEnvironment {
  db: Database;
  server: SymphonyServer;
  baseUrl: string;
  taskRepo: TaskRepository;
  eventRepo: EventRepository;
  notificationSender: TelegramNotificationSender;
  mockBot: MockTelegramBot;
  eventsManager: TaskEventsManager;
}

async function createTestEnvironment(): Promise<TestEnvironment> {
  // Create in-memory database
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);

  // Create repositories
  const taskRepo = new TaskRepository(db);
  const eventRepo = new EventRepository(db);

  // Create mock bot and notification sender
  const mockBot = new MockTelegramBot();
  const notificationSender = new TelegramNotificationSender(
    mockBot as unknown as ReturnType<typeof mockBot>,
  );

  // Create and start server on random port
  const server = new SymphonyServer(db, {
    port: 0,
    hostname: 'localhost',
    corsOrigins: ['*'],
    enableWebSocket: true,
  });

  const { port } = await server.start();
  const baseUrl = `http://localhost:${port}`;

  // Create events manager for WebSocket testing
  const eventsManager = new TaskEventsManager(db);

  return {
    db,
    server,
    baseUrl,
    taskRepo,
    eventRepo,
    notificationSender,
    mockBot,
    eventsManager,
  };
}

function cleanupTestEnvironment(env: TestEnvironment): void {
  env.server.stop();
  dropAllTables(env.db);
  env.db.close();
}

describe('Integration Tests - Full System Flow', () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await createTestEnvironment();
  });

  afterEach(() => {
    cleanupTestEnvironment(env);
  });

  describe('End-to-End Task Lifecycle', () => {
    it('should complete full task lifecycle: create -> verify DB -> update state -> verify events', async () => {
      // 1. Create task via HTTP API
      const createResponse = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'INT-001',
          title: 'Integration Test Task',
          description: 'Full lifecycle test',
          priority: 1,
          state: 'Unclaimed',
          labels: ['integration', 'test'],
        }),
      });

      expect(createResponse.status).toBe(201);
      const createData = await createResponse.json();
      expect(createData.success).toBe(true);
      const taskId = createData.data.id;

      // 2. Verify task stored in database
      const storedTask = env.taskRepo.findById(taskId);
      expect(storedTask).not.toBeNull();
      expect(storedTask?.identifier).toBe('INT-001');
      expect(storedTask?.title).toBe('Integration Test Task');
      expect(storedTask?.state).toBe('Unclaimed');
      expect(storedTask?.priority).toBe(1);

      // 3. Verify task via GET endpoint
      const getResponse = await fetch(`${env.baseUrl}/api/v1/tasks/${taskId}`);
      expect(getResponse.status).toBe(200);
      const getData = await getResponse.json();
      expect(getData.data.id).toBe(taskId);

      // 4. Start task (update state to Running)
      const startResponse = await fetch(
        `${env.baseUrl}/api/v1/tasks/${taskId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'Running' }),
        },
      );
      expect(startResponse.status).toBe(200);
      const startData = await startResponse.json();
      expect(startData.data.state).toBe('Running');

      // 5. Log execution events
      env.eventRepo.create({
        task_id: taskId,
        event_type: 'session_started',
        event_data: { session_id: `sess-${Date.now()}` },
        source: 'orchestrator',
      });

      env.eventRepo.create({
        task_id: taskId,
        event_type: 'turn_completed',
        event_data: { turn_id: 1, tokens_used: 150 },
        source: 'runtime',
      });

      // 6. Verify events stored
      const events = env.eventRepo.findByTaskId(taskId);
      expect(events.length).toBeGreaterThan(0);

      // 7. Complete task
      const completeResponse = await fetch(
        `${env.baseUrl}/api/v1/tasks/${taskId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'Completed' }),
        },
      );
      expect(completeResponse.status).toBe(200);
      const completeData = await completeResponse.json();
      expect(completeData.data.state).toBe('Completed');

      // 8. Verify final state in database
      const finalTask = env.taskRepo.findById(taskId);
      expect(finalTask?.state).toBe('Completed');

      // 9. Log completion event
      env.eventRepo.create({
        task_id: taskId,
        event_type: 'task_completed',
        event_data: { success: true },
        source: 'orchestrator',
      });

      // 10. Verify task appears in completed stats
      const statsResponse = await fetch(`${env.baseUrl}/api/v1/stats`);
      expect(statsResponse.status).toBe(200);
      const statsData = await statsResponse.json();
      expect(statsData.data.tasks.byState.Completed).toBeGreaterThanOrEqual(1);
    });

    it('should handle task creation with default values', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'DEFAULT-001',
          title: 'Task With Defaults',
        }),
      });

      expect(response.status).toBe(201);
      const data = await response.json();

      // Verify defaults
      expect(data.data.state).toBe('Unclaimed');
      expect(data.data.labels).toEqual([]);
      expect(data.data.blocked_by).toEqual([]);
      expect(data.data.retry_count).toBe(0);
      expect(data.data.max_retries).toBe(3);
    });
  });

  describe('WebSocket Event Broadcasting', () => {
    it('should broadcast task state changes to subscribers', () => {
      const taskId = 'ws-test-task';

      // Create task directly
      env.taskRepo.create({
        id: taskId,
        identifier: 'WS-001',
        title: 'WebSocket Test Task',
        state: 'Unclaimed',
      });

      // Track broadcast calls
      const broadcastSpy = mock((...args: unknown[]) => {
        // Spy on broadcast
      });
      const originalBroadcast = env.eventsManager.broadcast;
      env.eventsManager.broadcast = broadcastSpy;

      // Broadcast state change
      env.eventsManager.broadcastStateChange(taskId, 'Running', 'Unclaimed');

      expect(broadcastSpy).toHaveBeenCalled();
      const call = broadcastSpy.mock.calls[0];
      expect(call[0]).toBe(taskId);
      expect(call[1].type).toBe('task_state_changed');
      expect(call[1].data.newState).toBe('Running');
      expect(call[1].data.previousState).toBe('Unclaimed');
    });

    it('should broadcast task events', () => {
      const taskId = 'ws-event-task';

      env.taskRepo.create({
        id: taskId,
        identifier: 'WS-EVT-001',
        title: 'WebSocket Event Test',
        state: 'Running',
      });

      const broadcastSpy = mock(() => {});
      env.eventsManager.broadcast = broadcastSpy;

      env.eventsManager.broadcastEvent(taskId, 'turn_completed', {
        turn_id: 1,
        tokens: 100,
      });

      expect(broadcastSpy).toHaveBeenCalled();
      const call = broadcastSpy.mock.calls[0];
      expect(call[1].type).toBe('task_event');
      expect(call[1].data.eventType).toBe('turn_completed');
    });

    it('should manage client subscriptions', () => {
      const mockWs = {
        send: mock(() => {}),
        data: { url: 'ws://localhost/ws/tasks/client-test' },
      } as unknown as ReturnType<typeof mockWs>;

      // Add client
      env.eventsManager.addClient(mockWs, 'client-test');
      expect(env.eventsManager.getClientCount('client-test')).toBe(1);

      // Remove client
      env.eventsManager.removeClient(mockWs);
      expect(env.eventsManager.getClientCount('client-test')).toBe(0);
    });
  });

  describe('Telegram Notification Integration', () => {
    it('should register users for notifications', () => {
      env.notificationSender.registerUser(12345, 67890);
      expect(env.notificationSender.getRegisteredUserCount()).toBe(1);
    });

    it('should format and send task notifications', async () => {
      const task = env.taskRepo.create({
        id: 'notify-task',
        identifier: 'NOTIFY-001',
        title: 'Notification Test Task',
        state: 'Running',
      });

      env.notificationSender.registerUser(12345, 67890);

      // Send notification
      const result = await env.notificationSender.sendTaskNotification(12345, {
        type: 'task_started',
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        state: task.state,
        message: 'Task execution started',
      });

      expect(result).toBe(true);
    });

    it('should create notification from task events', () => {
      const task = env.taskRepo.create({
        id: 'event-notify-task',
        identifier: 'EVT-NOTIFY-001',
        title: 'Event Notification Task',
        state: 'Running',
      });

      // Test session_started event
      const sessionNotification = createNotificationFromEvent(
        task,
        'session_started',
      );
      expect(sessionNotification).not.toBeNull();
      expect(sessionNotification?.type).toBe('task_started');

      // Test turn_completed event
      const turnNotification = createNotificationFromEvent(task, 'turn_completed', {
        turn_id: 'turn-1',
      });
      expect(turnNotification).not.toBeNull();
      expect(turnNotification?.type).toBe('task_milestone');

      // Test task_completed event
      const completeNotification = createNotificationFromEvent(
        task,
        'task_completed',
      );
      expect(completeNotification).not.toBeNull();
      expect(completeNotification?.type).toBe('task_complete');

      // Test error event
      const errorNotification = createNotificationFromEvent(task, 'turn_failed', {
        error: 'Test error',
      });
      expect(errorNotification).not.toBeNull();
      expect(errorNotification?.type).toBe('task_error');
    });

    it('should send task complete notification', async () => {
      const task = env.taskRepo.create({
        id: 'complete-notify',
        identifier: 'COMPLETE-001',
        title: 'Complete Notification Test',
        state: 'Completed',
      });

      env.notificationSender.registerUser(12345, 67890);

      const result = await env.notificationSender.sendTaskComplete(
        12345,
        task,
        'Custom completion message',
      );

      expect(result).toBe(true);
    });

    it('should send task error notification', async () => {
      const task = env.taskRepo.create({
        id: 'error-notify',
        identifier: 'ERROR-001',
        title: 'Error Notification Test',
        state: 'Failed',
      });

      env.notificationSender.registerUser(12345, 67890);

      const result = await env.notificationSender.sendTaskError(
        12345,
        task,
        'Task execution failed: timeout',
      );

      expect(result).toBe(true);
    });

    it('should handle multiple registered chat IDs for a user', async () => {
      env.notificationSender.registerUser(12345, 67890);
      env.notificationSender.registerUser(12345, 11111);
      env.notificationSender.registerUser(12345, 22222);

      expect(env.notificationSender.getRegisteredUserCount()).toBe(1);

      // Unregister specific chat
      env.notificationSender.unregisterUser(12345, 67890);
      expect(env.notificationSender.getRegisteredUserCount()).toBe(1);

      // Unregister all
      env.notificationSender.unregisterUser(12345);
      expect(env.notificationSender.getRegisteredUserCount()).toBe(0);
    });
  });

  describe('Server + Database Integration', () => {
    it('should persist tasks across server operations', async () => {
      // Create task
      await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'PERSIST-001',
          title: 'Persistence Test',
        }),
      });

      // Query database directly
      const tasks = env.taskRepo.findAll();
      expect(tasks.length).toBe(1);
      expect(tasks[0].identifier).toBe('PERSIST-001');
    });

    it('should maintain referential integrity with events', async () => {
      const task = env.taskRepo.create({
        id: 'fk-test',
        identifier: 'FK-001',
        title: 'Foreign Key Test',
        state: 'Running',
      });

      env.eventRepo.create({
        task_id: task.id,
        event_type: 'test_event',
        event_data: { test: true },
      });

      // Verify event linked to task
      const events = env.eventRepo.findByTaskId(task.id);
      expect(events.length).toBe(1);
      expect(events[0].task_id).toBe(task.id);
    });

    it('should handle concurrent task operations', async () => {
      // Create multiple tasks concurrently
      const createPromises = Array.from({ length: 5 }, (_, i) =>
        fetch(`${env.baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: `CONCURRENT-${i}`,
            title: `Concurrent Task ${i}`,
            state: i % 2 === 0 ? 'Unclaimed' : 'Running',
          }),
        }),
      );

      await Promise.all(createPromises);

      const tasks = env.taskRepo.findAll();
      expect(tasks.length).toBe(5);

      const unclaimed = env.taskRepo.findByState('Unclaimed');
      const running = env.taskRepo.findByState('Running');
      expect(unclaimed.length).toBe(3);
      expect(running.length).toBe(2);
    });
  });

  describe('Error Handling Scenarios', () => {
    it('should return 400 for invalid task creation request', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Missing identifier' }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('required');
    });

    it('should return 404 for non-existent task', async () => {
      const response = await fetch(
        `${env.baseUrl}/api/v1/tasks/non-existent-id`,
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Task not found');
    });

    it('should return 409 for duplicate identifier', async () => {
      await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'DUP-TEST',
          title: 'First Task',
        }),
      });

      const response = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'DUP-TEST',
          title: 'Duplicate Task',
        }),
      });

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('already exists');
    });

    it('should return 404 for operations on deleted task', async () => {
      const createResponse = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'DEL-TEST',
          title: 'To Delete',
        }),
      });
      const created = await createResponse.json();

      // Delete task
      await fetch(`${env.baseUrl}/api/v1/tasks/${created.data.id}`, {
        method: 'DELETE',
      });

      // Try to get deleted task
      const response = await fetch(
        `${env.baseUrl}/api/v1/tasks/${created.data.id}`,
      );
      expect(response.status).toBe(404);
    });

    it('should handle invalid JSON in request body', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-valid-json',
      });

      expect(response.status).toBe(400);
    });

    it('should handle pause on non-existent task', async () => {
      const response = await fetch(
        `${env.baseUrl}/api/v1/tasks/non-existent/pause`,
        { method: 'POST' },
      );

      expect(response.status).toBe(404);
    });

    it('should handle cancel on non-existent task', async () => {
      const response = await fetch(
        `${env.baseUrl}/api/v1/tasks/non-existent/cancel`,
        { method: 'POST' },
      );

      expect(response.status).toBe(404);
    });
  });

  describe('Task State Transitions', () => {
    it('should transition from Unclaimed to Running', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'TRANS-001',
          title: 'Transition Test',
          state: 'Unclaimed',
        }),
      });
      const data = await response.json();

      const updateResponse = await fetch(
        `${env.baseUrl}/api/v1/tasks/${data.data.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'Running' }),
        },
      );
      const updateData = await updateResponse.json();

      expect(updateData.data.state).toBe('Running');
    });

    it('should pause task from Running to Claimed', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'PAUSE-001',
          title: 'Pause Test',
          state: 'Running',
        }),
      });
      const data = await response.json();

      const pauseResponse = await fetch(
        `${env.baseUrl}/api/v1/tasks/${data.data.id}/pause`,
        { method: 'POST' },
      );
      const pauseData = await pauseResponse.json();

      expect(pauseData.action).toBe('pause');

      const task = env.taskRepo.findById(data.data.id);
      expect(task?.state).toBe('Claimed');
    });

    it('should cancel task from Running to Released', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'CANCEL-001',
          title: 'Cancel Test',
          state: 'Running',
        }),
      });
      const data = await response.json();

      const cancelResponse = await fetch(
        `${env.baseUrl}/api/v1/tasks/${data.data.id}/cancel`,
        { method: 'POST' },
      );
      const cancelData = await cancelResponse.json();

      expect(cancelData.action).toBe('cancel');

      const task = env.taskRepo.findById(data.data.id);
      expect(task?.state).toBe('Released');
    });

    it('should mark task as completed', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'COMPLETE-002',
          title: 'Complete Test',
          state: 'Running',
        }),
      });
      const data = await response.json();

      const updateResponse = await fetch(
        `${env.baseUrl}/api/v1/tasks/${data.data.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'Completed' }),
        },
      );
      const updateData = await updateResponse.json();

      expect(updateData.data.state).toBe('Completed');
    });
  });

  describe('Task Events Endpoint', () => {
    it('should return events for a task', async () => {
      const createResponse = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'EVENTS-001',
          title: 'Events Test',
        }),
      });
      const created = await createResponse.json();

      // Add some events
      env.eventRepo.create({
        task_id: created.data.id,
        event_type: 'session_started',
        event_data: { started_at: new Date().toISOString() },
      });
      env.eventRepo.create({
        task_id: created.data.id,
        event_type: 'turn_completed',
        event_data: { turn_id: 1 },
      });

      const response = await fetch(
        `${env.baseUrl}/api/v1/tasks/${created.data.id}/events`,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      // Note: task_created event is automatically added by the API
      expect(data.data.length).toBe(3);
    });

    it('should return empty events for task without events', async () => {
      const createResponse = await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'NO-EVENTS',
          title: 'No Events Task',
        }),
      });
      const created = await createResponse.json();

      const response = await fetch(
        `${env.baseUrl}/api/v1/tasks/${created.data.id}/events`,
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      // Note: task_created event is automatically added by the API
      expect(data.data.length).toBe(1);
      expect(data.data[0].event_type).toBe('task_created');
    });

    it('should return 404 for events of non-existent task', async () => {
      const response = await fetch(
        `${env.baseUrl}/api/v1/tasks/non-existent/events`,
      );
      expect(response.status).toBe(404);
    });
  });

  describe('Stats and Aggregation', () => {
    it('should return accurate task counts by state', async () => {
      // Create tasks in different states
      await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'STATS-U',
          title: 'Unclaimed Task',
          state: 'Unclaimed',
        }),
      });
      await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'STATS-R',
          title: 'Running Task',
          state: 'Running',
        }),
      });
      await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'STATS-C',
          title: 'Completed Task',
          state: 'Completed',
        }),
      });

      const statsResponse = await fetch(`${env.baseUrl}/api/v1/stats`);
      const statsData = await statsResponse.json();

      expect(statsData.data.tasks.total).toBe(3);
      expect(statsData.data.tasks.byState.Unclaimed).toBe(1);
      expect(statsData.data.tasks.byState.Running).toBe(1);
      expect(statsData.data.tasks.byState.Completed).toBe(1);
    });

    it('should return event counts by type', async () => {
      const task = env.taskRepo.create({
        id: 'stats-task',
        identifier: 'STATS-EVT',
        title: 'Stats Event Task',
        state: 'Running',
      });

      // Create events
      env.eventRepo.create({
        task_id: task.id,
        event_type: 'session_started',
        event_data: {},
      });
      env.eventRepo.create({
        task_id: task.id,
        event_type: 'session_started',
        event_data: {},
      });
      env.eventRepo.create({
        task_id: task.id,
        event_type: 'turn_completed',
        event_data: {},
      });

      const response = await fetch(`${env.baseUrl}/api/v1/stats/events`);
      const data = await response.json();

      expect(data.data.total).toBe(3);
      expect(data.data.byType.session_started).toBe(2);
      expect(data.data.byType.turn_completed).toBe(1);
    });

    it('should return summary statistics', async () => {
      await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'SUMMARY-001',
          title: 'Summary Task',
          state: 'Running',
        }),
      });

      const response = await fetch(`${env.baseUrl}/api/v1/stats/summary`);
      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.data.tasks).toBeGreaterThanOrEqual(1);
      expect(data.data).toHaveProperty('events');
      expect(data.data).toHaveProperty('running');
    });
  });

  describe('Pagination and Filtering', () => {
    it('should paginate tasks correctly', async () => {
      // Create 10 tasks
      for (let i = 1; i <= 10; i++) {
        await fetch(`${env.baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: `PAGE-${i}`,
            title: `Task ${i}`,
          }),
        });
      }

      // Get first page
      const response1 = await fetch(
        `${env.baseUrl}/api/v1/tasks?page=1&limit=3`,
      );
      const data1 = await response1.json();
      expect(data1.data.length).toBe(3);
      expect(data1.pagination.total).toBe(10);
      expect(data1.pagination.hasMore).toBe(true);

      // Get second page
      const response2 = await fetch(
        `${env.baseUrl}/api/v1/tasks?page=2&limit=3`,
      );
      const data2 = await response2.json();
      expect(data2.data.length).toBe(3);

      // Get last page
      const response3 = await fetch(
        `${env.baseUrl}/api/v1/tasks?page=4&limit=3`,
      );
      const data3 = await response3.json();
      expect(data3.data.length).toBe(1);
      expect(data3.pagination.hasMore).toBe(false);
    });

    it('should filter tasks by state', async () => {
      await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'FILTER-R',
          title: 'Running Filter',
          state: 'Running',
        }),
      });
      await fetch(`${env.baseUrl}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: 'FILTER-U',
          title: 'Unclaimed Filter',
          state: 'Unclaimed',
        }),
      });

      const response = await fetch(
        `${env.baseUrl}/api/v1/tasks?state=Running`,
      );
      const data = await response.json();

      expect(data.data.length).toBe(1);
      expect(data.data[0].state).toBe('Running');
      expect(data.data[0].identifier).toBe('FILTER-R');
    });
  });

  describe('Health Check Endpoints', () => {
    it('should return health status', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/health`);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.status).toBeDefined();
      expect(data.data.checks.database).toBe(true);
    });

    it('should return ready status', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/health/ready`);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.ready).toBe(true);
    });

    it('should return live status', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/health/live`);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data.alive).toBe(true);
    });
  });

  describe('CORS Headers', () => {
    it('should include CORS headers in response', async () => {
      const response = await fetch(`${env.baseUrl}/api/v1/health`, {
        headers: { Origin: 'http://example.com' },
      });

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });
});

describe('Integration Tests - Notification Types', () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await createTestEnvironment();
  });

  afterEach(() => {
    cleanupTestEnvironment(env);
  });

  it('should handle all notification types', async () => {
    const task = env.taskRepo.create({
      id: 'all-notif',
      identifier: 'ALL-NOTIF-001',
      title: 'All Notifications Test',
      state: 'Running',
    });

    env.notificationSender.registerUser(12345, 67890);

    // Test all notification types
    const notifications = [
      {
        fn: () =>
          env.notificationSender.sendTaskStarted(12345, task),
        type: 'started',
      },
      {
        fn: () =>
          env.notificationSender.sendTaskComplete(12345, task),
        type: 'complete',
      },
      {
        fn: () =>
          env.notificationSender.sendTaskError(
            12345,
            task,
            'Test error',
          ),
        type: 'error',
      },
      {
        fn: () =>
          env.notificationSender.sendTaskMilestone(
            12345,
            task,
            'Milestone reached',
          ),
        type: 'milestone',
      },
      {
        fn: () =>
          env.notificationSender.sendTaskPaused(12345, task),
        type: 'paused',
      },
      {
        fn: () =>
          env.notificationSender.sendTaskCancelled(12345, task),
        type: 'cancelled',
      },
    ];

    for (const notif of notifications) {
      const result = await notif.fn();
      expect(result).toBe(true);
    }
  });
});
