/**
 * Claude Code Runtime Tests for Symphony Enterprise Agent Platform
 * Tests for session management, event handling, and runtime execution
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema } from '../database/schema.js';
import { TaskRepository } from '../database/repositories/taskRepository.js';
import {
  SessionManager,
  SessionBroadcaster,
  EventHandler,
  ClaudeRuntime,
  type SessionOptions,
  parseClaudeOutputLine,
} from './index.js';

/**
 * Helper to create a fresh in-memory database for each test
 */
function createTestDatabase(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

// ============================================================================
// SESSION MANAGER TESTS
// ============================================================================

describe('SessionManager', () => {
  let db: Database;
  let sessionManager: SessionManager;

  beforeEach(() => {
    db = createTestDatabase();
    sessionManager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    sessionManager.clear();
  });

  describe('createSession', () => {
    it('should create a new session with required options', () => {
      const options: SessionOptions = {
        workingDirectory: '/test/project',
      };

      const session = sessionManager.createSession('task-123', options);

      expect(session.sessionId).toBeDefined();
      expect(session.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(session.taskId).toBe('task-123');
      expect(session.state).toBe('starting');
      expect(session.options.workingDirectory).toBe('/test/project');
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.updatedAt).toBeInstanceOf(Date);
    });

    it('should create session with all options', () => {
      const options: SessionOptions = {
        workingDirectory: '/test/project',
        model: 'claude-sonnet-4-5',
        maxTurns: 100,
        timeoutMs: 60000,
        systemPrompt: 'You are a helpful assistant',
        env: { CUSTOM_VAR: 'value' },
      };

      const session = sessionManager.createSession('task-456', options);

      expect(session.options.model).toBe('claude-sonnet-4-5');
      expect(session.options.maxTurns).toBe(100);
      expect(session.options.timeoutMs).toBe(60000);
      expect(session.options.systemPrompt).toBe('You are a helpful assistant');
      expect(session.options.env?.CUSTOM_VAR).toBe('value');
    });
  });

  describe('getSession', () => {
    it('should retrieve session by ID', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });

      const retrieved = sessionManager.getSession(session.sessionId);

      expect(retrieved).toBeDefined();
      expect(retrieved?.sessionId).toBe(session.sessionId);
      expect(retrieved?.taskId).toBe('task-1');
    });

    it('should return undefined for non-existent session', () => {
      const session = sessionManager.getSession('non-existent-id');
      expect(session).toBeUndefined();
    });
  });

  describe('getAllSessions', () => {
    it('should return all sessions', () => {
      sessionManager.createSession('task-1', { workingDirectory: '/test' });
      sessionManager.createSession('task-2', { workingDirectory: '/test' });
      sessionManager.createSession('task-3', { workingDirectory: '/test' });

      const sessions = sessionManager.getAllSessions();

      expect(sessions.length).toBe(3);
    });

    it('should return empty array when no sessions', () => {
      const sessions = sessionManager.getAllSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('getSessionsByTask', () => {
    it('should return sessions for a specific task', () => {
      sessionManager.createSession('task-1', { workingDirectory: '/test' });
      sessionManager.createSession('task-1', { workingDirectory: '/test' });
      sessionManager.createSession('task-2', { workingDirectory: '/test' });

      const sessions = sessionManager.getSessionsByTask('task-1');

      expect(sessions.length).toBe(2);
      expect(sessions.every((s) => s.taskId === 'task-1')).toBe(true);
    });

    it('should return empty array for task with no sessions', () => {
      const sessions = sessionManager.getSessionsByTask('non-existent');
      expect(sessions).toEqual([]);
    });
  });

  describe('getActiveSessions', () => {
    it('should return only active sessions', () => {
      const s1 = sessionManager.createSession('task-1', { workingDirectory: '/test' });
      sessionManager.createSession('task-2', { workingDirectory: '/test' });
      const s3 = sessionManager.createSession('task-3', { workingDirectory: '/test' });

      // Set some sessions to completed
      sessionManager.updateState(s1.sessionId, 'completed');
      sessionManager.updateState(s3.sessionId, 'running');

      const active = sessionManager.getActiveSessions();

      expect(active.length).toBe(2); // starting (task-2) and running (task-3)
    });
  });

  describe('updateState', () => {
    it('should update session state', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });

      const result = sessionManager.updateState(session.sessionId, 'running');

      expect(result).toBe(true);
      const updated = sessionManager.getSession(session.sessionId);
      expect(updated?.state).toBe('running');
    });

    it('should update updatedAt timestamp', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });
      const beforeUpdate = session.updatedAt.getTime();

      // Small delay
      const start = Date.now();
      while (Date.now() === start) { /* wait */ }

      sessionManager.updateState(session.sessionId, 'running');

      const updated = sessionManager.getSession(session.sessionId);
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeUpdate);
    });

    it('should set error message when provided', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });

      sessionManager.updateState(session.sessionId, 'failed', 'Test error');

      const runtimeSession = sessionManager.getRuntimeSession(session.sessionId);
      expect(runtimeSession?.error).toBe('Test error');
    });

    it('should return false for non-existent session', () => {
      const result = sessionManager.updateState('non-existent', 'running');
      expect(result).toBe(false);
    });

    it('should set completedAt when state is completed', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });

      sessionManager.updateState(session.sessionId, 'completed');

      const runtimeSession = sessionManager.getRuntimeSession(session.sessionId);
      expect(runtimeSession?.completedAt).toBeInstanceOf(Date);
    });

    it('should set startedAt when state is running', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });

      sessionManager.updateState(session.sessionId, 'running');

      const runtimeSession = sessionManager.getRuntimeSession(session.sessionId);
      expect(runtimeSession?.startedAt).toBeInstanceOf(Date);
    });
  });

  describe('attachProcess', () => {
    it('should attach a process to a session', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });

      // Mock a child process
      const mockProcess = {
        pid: 12345,
        exited: Promise.resolve(0),
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        stdin: new WritableStream(),
        kill: () => {},
      } as unknown as Bun.ChildProcess;

      const result = sessionManager.attachProcess(session.sessionId, mockProcess);

      expect(result).toBe(true);
      expect(sessionManager.getProcess(session.sessionId)).toBe(mockProcess);
    });

    it('should return false for non-existent session', () => {
      const mockProcess = {} as Bun.ChildProcess;
      const result = sessionManager.attachProcess('non-existent', mockProcess);
      expect(result).toBe(false);
    });
  });

  describe('detachProcess', () => {
    it('should detach process from session', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });
      const mockProcess = {} as Bun.ChildProcess;

      sessionManager.attachProcess(session.sessionId, mockProcess);
      const result = sessionManager.detachProcess(session.sessionId);

      expect(result).toBe(true);
      expect(sessionManager.getProcess(session.sessionId)).toBeNull();
    });

    it('should return false for non-existent session', () => {
      const result = sessionManager.detachProcess('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('removeSession', () => {
    it('should remove session from tracking', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });

      const result = sessionManager.removeSession(session.sessionId);

      expect(result).toBe(true);
      expect(sessionManager.getSession(session.sessionId)).toBeUndefined();
    });

    it('should return false for non-existent session', () => {
      const result = sessionManager.removeSession('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('cleanupFinishedSessions', () => {
    it('should remove completed, failed, and cancelled sessions', () => {
      const s1 = sessionManager.createSession('task-1', { workingDirectory: '/test' });
      const s2 = sessionManager.createSession('task-2', { workingDirectory: '/test' });
      const s3 = sessionManager.createSession('task-3', { workingDirectory: '/test' });

      sessionManager.updateState(s1.sessionId, 'completed');
      sessionManager.updateState(s2.sessionId, 'failed');
      sessionManager.updateState(s3.sessionId, 'running'); // Should not be removed

      const removed = sessionManager.cleanupFinishedSessions();

      expect(removed).toBe(2);
      expect(sessionManager.getSession(s1.sessionId)).toBeUndefined();
      expect(sessionManager.getSession(s2.sessionId)).toBeUndefined();
      expect(sessionManager.getSession(s3.sessionId)).toBeDefined();
    });

    it('should return 0 when no finished sessions', () => {
      const session = sessionManager.createSession('task-1', { workingDirectory: '/test' });
      sessionManager.updateState(session.sessionId, 'running');

      const removed = sessionManager.cleanupFinishedSessions();

      expect(removed).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return session statistics', () => {
      const sessions = [
        sessionManager.createSession('task-1', { workingDirectory: '/test' }),
        sessionManager.createSession('task-2', { workingDirectory: '/test' }),
        sessionManager.createSession('task-3', { workingDirectory: '/test' }),
        sessionManager.createSession('task-4', { workingDirectory: '/test' }),
      ];

      sessionManager.updateState(sessions[0].sessionId, 'running');
      sessionManager.updateState(sessions[1].sessionId, 'completed');
      sessionManager.updateState(sessions[2].sessionId, 'failed');
      // sessions[3] stays 'starting'

      const stats = sessionManager.getStats();

      expect(stats.total).toBe(4);
      expect(stats.starting).toBe(1);
      expect(stats.running).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
    });
  });
});

// ============================================================================
// SESSION BROADCASTER TESTS
// ============================================================================

describe('SessionBroadcaster', () => {
  let broadcaster: SessionBroadcaster;

  beforeEach(() => {
    broadcaster = new SessionBroadcaster();
  });

  afterEach(() => {
    broadcaster.clear();
  });

  describe('addClient', () => {
    it('should add a client', () => {
      const client = { send: () => {} };
      broadcaster.addClient(client);
      expect(broadcaster.getClientCount()).toBe(1);
    });
  });

  describe('removeClient', () => {
    it('should remove a client', () => {
      const client = { send: () => {} };
      broadcaster.addClient(client);
      broadcaster.removeClient(client);
      expect(broadcaster.getClientCount()).toBe(0);
    });
  });

  describe('broadcast', () => {
    it('should send message to all clients', () => {
      const receivedMessages: string[] = [];
      const client1 = { send: (msg: string) => receivedMessages.push(msg) };
      const client2 = { send: (msg: string) => receivedMessages.push(msg) };

      broadcaster.addClient(client1);
      broadcaster.addClient(client2);

      const event = {
        type: 'session_event' as const,
        sessionId: 'sess-1',
        taskId: 'task-1',
        eventType: 'tool_call',
        timestamp: new Date('2024-01-01T00:00:00.000Z'),
        data: { toolName: 'test' },
      };

      broadcaster.broadcast(event);

      expect(receivedMessages.length).toBe(2);
      expect(JSON.parse(receivedMessages[0])).toEqual({
        type: 'session_event',
        sessionId: 'sess-1',
        taskId: 'task-1',
        eventType: 'tool_call',
        timestamp: '2024-01-01T00:00:00.000Z',
        data: { toolName: 'test' },
      });
    });

    it('should handle client send errors', () => {
      const receivedMessages: string[] = [];
      const workingClient = { send: (msg: string) => receivedMessages.push(msg) };
      const errorClient = {
        send: () => {
          throw new Error('Send failed');
        },
      };

      broadcaster.addClient(workingClient);
      broadcaster.addClient(errorClient);

      const event = {
        type: 'session_event' as const,
        sessionId: 'sess-1',
        taskId: 'task-1',
        eventType: 'message',
        timestamp: new Date(),
        data: {},
      };

      expect(() => broadcaster.broadcast(event)).not.toThrow();
      expect(receivedMessages.length).toBe(1);
    });

    it('should remove dead clients (isAlive returns false)', () => {
      const client = {
        send: () => {},
        isAlive: () => false,
      };

      broadcaster.addClient(client);

      const event = {
        type: 'session_event' as const,
        sessionId: 'sess-1',
        taskId: 'task-1',
        eventType: 'message',
        timestamp: new Date(),
        data: {},
      };

      broadcaster.broadcast(event);

      expect(broadcaster.getClientCount()).toBe(0);
    });
  });
});

// ============================================================================
// EVENT HANDLER TESTS
// ============================================================================

describe('EventHandler', () => {
  let db: Database;
  let taskRepo: TaskRepository;
  let eventHandler: EventHandler;
  let broadcaster: SessionBroadcaster;
  const taskId = 'task-1';

  beforeEach(() => {
    db = createTestDatabase();
    taskRepo = new TaskRepository(db);
    broadcaster = new SessionBroadcaster();

    // Create a task first (required for foreign key constraint)
    taskRepo.create({
      id: taskId,
      identifier: 'TEST-001',
      title: 'Test Task',
      state: 'Running',
    });

    eventHandler = new EventHandler(db, broadcaster, {
      enableBroadcast: true,
      enableDatabase: true,
      enableLogging: false,
    });
  });

  afterEach(() => {
    db.close();
    broadcaster.clear();
  });

  describe('handleEvent', () => {
    it('should store event in database', async () => {
      const event = eventHandler.createThoughtEvent('sess-1', taskId, 'Thinking about the problem...');

      const result = await eventHandler.handleEvent(event);

      expect(result.success).toBe(true);
      expect(result.eventId).toBeDefined();
    });

    it('should broadcast event to clients', async () => {
      const receivedMessages: string[] = [];
      const client = { send: (msg: string) => receivedMessages.push(msg) };
      broadcaster.addClient(client);

      const event = eventHandler.createToolCallEvent('sess-1', taskId, 'read_file', { path: 'test.txt' });

      await eventHandler.handleEvent(event);

      expect(receivedMessages.length).toBe(1);
      const parsed = JSON.parse(receivedMessages[0]);
      expect(parsed.eventType).toBe('tool_call');
    });

    it('should handle error event', async () => {
      const event = eventHandler.createErrorEvent('sess-1', taskId, 'Something went wrong', undefined, false);

      const result = await eventHandler.handleEvent(event);

      expect(result.success).toBe(true);
    });

    it('should handle complete event', async () => {
      const event = eventHandler.createCompleteEvent('sess-1', taskId, 'Task completed successfully');

      const result = await eventHandler.handleEvent(event);

      expect(result.success).toBe(true);
    });

    it('should handle usage event', async () => {
      const event = eventHandler.createUsageEvent('sess-1', taskId, 100, 200, 300);

      const result = await eventHandler.handleEvent(event);

      expect(result.success).toBe(true);
    });
  });

  describe('handleEvent with options', () => {
    it('should skip database storage when disabled', async () => {
      const handler = new EventHandler(db, null, { enableDatabase: false });
      const event = handler.createThoughtEvent('sess-1', taskId, 'Test');

      const result = await handler.handleEvent(event);

      expect(result.success).toBe(true);
      // Verify no events in database
      const stmt = db.prepare('SELECT COUNT(*) as count FROM execution_events');
      const row = stmt.get() as { count: number };
      expect(row.count).toBe(0);
    });

    it('should skip broadcasting when disabled', async () => {
      const handler = new EventHandler(null, broadcaster, { enableBroadcast: false });
      const client = { send: () => {} };
      broadcaster.addClient(client);

      const event = handler.createThoughtEvent('sess-1', taskId, 'Test');
      await handler.handleEvent(event);

      // Should not throw, just skip broadcasting
    });
  });
});

// ============================================================================
// PARSE CLAUSE OUTPUT LINE TESTS
// ============================================================================

describe('parseClaudeOutputLine', () => {
  const sessionId = 'test-session';
  const taskId = 'test-task';

  it('should parse tool_call JSON event', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool_name: 'read_file',
      input: { path: 'test.txt' },
      turn_id: 'turn-1',
    });

    const event = parseClaudeOutputLine(line, sessionId, taskId);

    expect(event?.type).toBe('tool_call');
    expect((event as any).toolName).toBe('read_file');
    expect((event as any).input).toEqual({ path: 'test.txt' });
  });

  it('should parse file_change JSON event', () => {
    const line = JSON.stringify({
      type: 'file_change',
      file_path: 'src/index.ts',
      change_type: 'modify',
      diff: '+ new line',
    });

    const event = parseClaudeOutputLine(line, sessionId, taskId);

    expect(event?.type).toBe('file_change');
    expect((event as any).filePath).toBe('src/index.ts');
    expect((event as any).changeType).toBe('modify');
  });

  it('should parse error JSON event', () => {
    const line = JSON.stringify({
      type: 'error',
      message: 'File not found',
      recoverable: true,
    });

    const event = parseClaudeOutputLine(line, sessionId, taskId);

    expect(event?.type).toBe('error');
    expect((event as any).message).toBe('File not found');
    expect((event as any).recoverable).toBe(true);
  });

  it('should parse complete JSON event', () => {
    const line = JSON.stringify({
      type: 'complete',
      summary: 'All tasks completed',
      output: 'Final output',
    });

    const event = parseClaudeOutputLine(line, sessionId, taskId);

    expect(event?.type).toBe('complete');
    expect((event as any).summary).toBe('All tasks completed');
  });

  it('should parse usage JSON event', () => {
    const line = JSON.stringify({
      type: 'usage',
      input_tokens: 100,
      output_tokens: 200,
      total_tokens: 300,
    });

    const event = parseClaudeOutputLine(line, sessionId, taskId);

    expect(event?.type).toBe('usage');
    expect((event as any).inputTokens).toBe(100);
    expect((event as any).outputTokens).toBe(200);
    expect((event as any).totalTokens).toBe(300);
  });

  it('should parse thought event from text marker', () => {
    const line = 'Thinking: Let me analyze this problem step by step...';

    const event = parseClaudeOutputLine(line, sessionId, taskId);

    expect(event?.type).toBe('thought');
    expect((event as any).content).toBe('Let me analyze this problem step by step...');
  });

  it('should parse thought event with <thought> tag', () => {
    const line = '<thought>Internal reasoning here</thought>';

    const event = parseClaudeOutputLine(line, sessionId, taskId);

    expect(event?.type).toBe('thought');
  });

  it('should parse message event for plain text', () => {
    const line = 'Hello, this is a response from Claude.';

    const event = parseClaudeOutputLine(line, sessionId, taskId);

    expect(event?.type).toBe('message');
    expect((event as any).content).toBe('Hello, this is a response from Claude.');
  });

  it('should return null for empty line', () => {
    const event = parseClaudeOutputLine('', sessionId, taskId);
    expect(event).toBeNull();
  });

  it('should return null for whitespace-only line', () => {
    const event = parseClaudeOutputLine('   \n  \t  ', sessionId, taskId);
    expect(event).toBeNull();
  });

  it('should return message event for invalid JSON', () => {
    const line = '{ invalid json }';

    const event = parseClaudeOutputLine(line, sessionId, taskId);

    expect(event?.type).toBe('message');
  });
});

// ============================================================================
// CLAUDERUNTIME TESTS
// ============================================================================

describe('ClaudeRuntime', () => {
  let db: Database;
  let runtime: ClaudeRuntime;

  beforeEach(() => {
    db = createTestDatabase();
    runtime = new ClaudeRuntime(db, { verbose: false });
  });

  afterEach(async () => {
    await runtime.shutdown();
    db.close();
  });

  describe('constructor', () => {
    it('should create runtime with default config', () => {
      const rt = new ClaudeRuntime(db);
      expect(rt.sessions).toBeDefined();
      expect(rt.broadcasterInstance).toBeDefined();
    });

    it('should create runtime with custom config', () => {
      const rt = new ClaudeRuntime(db, {
        claudePath: '/custom/path/claude',
        defaultWorkingDirectory: '/custom/workdir',
        defaultModel: 'claude-opus-4-5',
        verbose: true,
      });
      expect(rt).toBeDefined();
    });

    it('should work without database', () => {
      const rt = new ClaudeRuntime(undefined);
      expect(rt.sessions).toBeDefined();
    });
  });

  describe('startSession', () => {
    it('should start a new session', async () => {
      const session = await runtime.startSession('task-1', {
        workingDirectory: '/test/project',
      });

      expect(session.sessionId).toBeDefined();
      expect(session.taskId).toBe('task-1');
      expect(session.state).toBe('starting');
    });

    it('should store session with all options', async () => {
      const session = await runtime.startSession('task-2', {
        workingDirectory: '/test',
        model: 'claude-sonnet-4-5',
        maxTurns: 50,
        timeoutMs: 30000,
      });

      expect(session.options.model).toBe('claude-sonnet-4-5');
      expect(session.options.maxTurns).toBe(50);
    });
  });

  describe('getSessionStatus', () => {
    it('should get session status', async () => {
      const session = await runtime.startSession('task-1', { workingDirectory: '/test' });

      const status = runtime.getSessionStatus(session.sessionId);

      expect(status).toBeDefined();
      expect(status?.sessionId).toBe(session.sessionId);
    });

    it('should return undefined for non-existent session', () => {
      const status = runtime.getSessionStatus('non-existent');
      expect(status).toBeUndefined();
    });
  });

  describe('getActiveSessions', () => {
    it('should return active sessions', async () => {
      await runtime.startSession('task-1', { workingDirectory: '/test' });
      await runtime.startSession('task-2', { workingDirectory: '/test' });

      const active = runtime.getActiveSessions();

      expect(active.length).toBe(2);
    });
  });

  describe('getStats', () => {
    it('should return session statistics', async () => {
      await runtime.startSession('task-1', { workingDirectory: '/test' });
      await runtime.startSession('task-2', { workingDirectory: '/test' });

      const stats = runtime.getStats();

      expect(stats.total).toBe(2);
      expect(stats.starting).toBe(2);
    });
  });

  describe('addWebSocketClient', () => {
    it('should add WebSocket client', async () => {
      const client = { send: () => {}, isAlive: () => true };

      runtime.addWebSocketClient(client);

      expect(runtime.getClientCount()).toBe(1);
    });
  });

  describe('removeWebSocketClient', () => {
    it('should remove WebSocket client', async () => {
      const client = { send: () => {} };
      runtime.addWebSocketClient(client);
      runtime.removeWebSocketClient(client);

      expect(runtime.getClientCount()).toBe(0);
    });
  });

  describe('cleanupFinishedSessions', () => {
    it('should cleanup finished sessions', async () => {
      const session = await runtime.startSession('task-1', { workingDirectory: '/test' });
      runtime.sessions.updateState(session.sessionId, 'completed');

      const cleaned = runtime.cleanupFinishedSessions();

      expect(cleaned).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('should shutdown runtime', async () => {
      await runtime.startSession('task-1', { workingDirectory: '/test' });

      await runtime.shutdown();

      const stats = runtime.getStats();
      expect(stats.total).toBe(0);
      expect(runtime.getClientCount()).toBe(0);
    });
  });

  describe('execute (integration)', () => {
    it('should return error when claude executable not found', async () => {
      // Use a non-existent path to simulate missing executable
      const rt = new ClaudeRuntime(db, {
        claudePath: '/nonexistent/claude-fake',
        verbose: false,
      });

      const result = await rt.execute('task-1', {
        prompt: 'Test prompt',
        workingDirectory: '/test',
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(null);
      expect(result.error).toBeDefined();
    });
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('Claude Runtime Integration', () => {
  let db: Database;
  let taskRepo: TaskRepository;

  beforeEach(() => {
    db = createTestDatabase();
    taskRepo = new TaskRepository(db);

    // Create a task first (required for foreign key constraint)
    taskRepo.create({
      id: 'task-1',
      identifier: 'TEST-001',
      title: 'Test Task',
      state: 'Running',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('should integrate session management with event handling', async () => {
    const runtime = new ClaudeRuntime(db, { verbose: false });

    // Start session
    const session = await runtime.startSession('task-1', { workingDirectory: '/test' });

    // Update to running
    runtime.sessions.updateState(session.sessionId, 'running');

    // Create event handler and emit events
    const eventHandler = new EventHandler(db, runtime.broadcasterInstance);

    await eventHandler.handleEvent(eventHandler.createThoughtEvent(session.sessionId, 'task-1', 'Test thought'));
    await eventHandler.handleEvent(eventHandler.createToolCallEvent(session.sessionId, 'task-1', 'test_tool', { arg: 'value' }));

    // Verify events stored in database
    const stmt = db.prepare('SELECT COUNT(*) as count FROM execution_events WHERE task_id = ?');
    const row = stmt.get('task-1') as { count: number };
    expect(row.count).toBeGreaterThanOrEqual(2);

    await runtime.shutdown();
  });

  it('should broadcast events to WebSocket clients', async () => {
    const runtime = new ClaudeRuntime(db, { verbose: false });

    const receivedEvents: string[] = [];
    const client = { send: (msg: string) => receivedEvents.push(msg) };
    runtime.addWebSocketClient(client);

    const session = await runtime.startSession('task-1', { workingDirectory: '/test' });

    const eventHandler = new EventHandler(db, runtime.broadcasterInstance);
    await eventHandler.handleEvent(eventHandler.createMessageEvent(session.sessionId, 'task-1', 'Test message', 'assistant'));

    expect(receivedEvents.length).toBe(1);
    const parsed = JSON.parse(receivedEvents[0]);
    expect(parsed.eventType).toBe('message');

    await runtime.shutdown();
  });
});
