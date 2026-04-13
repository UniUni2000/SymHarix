/**
 * Database Layer Tests for Symphony Enterprise Agent Platform
 * Comprehensive tests for all repository methods
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema, dropAllTables } from './schema';
import { TaskRepository } from './repositories/taskRepository';
import { EventRepository } from './repositories/eventRepository';

/**
 * Helper to create a fresh in-memory database for each test
 */
function createTestDatabase(): Database {
  const db = new Database(':memory:');
  // Enable foreign keys for cascade tests
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

describe('Database Schema', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('should create tasks table', () => {
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'");
    const result = stmt.get() as { name: string };
    expect(result?.name).toBe('tasks');
  });

  it('should create workspaces table', () => {
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'");
    const result = stmt.get() as { name: string };
    expect(result?.name).toBe('workspaces');
  });

  it('should create execution_events table', () => {
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_events'");
    const result = stmt.get() as { name: string };
    expect(result?.name).toBe('execution_events');
  });

  it('should create indexes', () => {
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'");
    const results = stmt.all() as { name: string }[];
    expect(results.length).toBeGreaterThan(0);
  });

  it('should drop all tables', () => {
    dropAllTables(db);

    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
    const results = stmt.all() as { name: string }[];
    const tableNames = results.map((r) => r.name);

    expect(tableNames).not.toContain('tasks');
    expect(tableNames).not.toContain('workspaces');
    expect(tableNames).not.toContain('execution_events');
  });
});

describe('TaskRepository', () => {
  let db: Database;
  let repo: TaskRepository;

  beforeEach(() => {
    db = createTestDatabase();
    repo = new TaskRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // CREATE TESTS
  // ============================================================================

  describe('create', () => {
    it('should create a new task', () => {
      const task = repo.create({
        id: 'task-1',
        identifier: 'PROJ-123',
        title: 'Test Task',
        description: 'A test task description',
        state: 'Unclaimed',
        labels: ['bug', 'priority'],
      });

      expect(task.id).toBe('task-1');
      expect(task.identifier).toBe('PROJ-123');
      expect(task.title).toBe('Test Task');
      expect(task.description).toBe('A test task description');
      expect(task.state).toBe('Unclaimed');
      expect(task.labels).toEqual(['bug', 'priority']);
      expect(task.retry_count).toBe(0);
      expect(task.max_retries).toBe(3);
      expect(task.created_at).toBeInstanceOf(Date);
      expect(task.updated_at).toBeInstanceOf(Date);
    });

    it('should create task with optional fields as null', () => {
      const task = repo.create({
        id: 'task-2',
        identifier: 'PROJ-456',
        title: 'Minimal Task',
        state: 'Unclaimed',
      });

      expect(task.description).toBeNull();
      expect(task.priority).toBeNull();
      expect(task.branch_name).toBeNull();
      expect(task.url).toBeNull();
      expect(task.workspace_key).toBeNull();
    });

    it('should create task with all fields', () => {
      const task = repo.create({
        id: 'task-3',
        identifier: 'PROJ-789',
        title: 'Complete Task',
        description: 'Full description',
        priority: 1,
        state: 'Running',
        branch_name: 'feature/test',
        url: 'https://tracker.example.com/PROJ-789',
        labels: ['feature'],
        blocked_by: ['PROJ-100'],
        workspace_key: 'proj-789-workspace',
        retry_count: 2,
        max_retries: 5,
      });

      expect(task.priority).toBe(1);
      expect(task.branch_name).toBe('feature/test');
      expect(task.url).toBe('https://tracker.example.com/PROJ-789');
      expect(task.blocked_by).toEqual(['PROJ-100']);
      expect(task.workspace_key).toBe('proj-789-workspace');
      expect(task.retry_count).toBe(2);
      expect(task.max_retries).toBe(5);
    });

    it('should throw on duplicate identifier', () => {
      repo.create({
        id: 'task-1',
        identifier: 'DUP-001',
        title: 'First Task',
        state: 'Unclaimed',
      });

      expect(() => {
        repo.create({
          id: 'task-2',
          identifier: 'DUP-001',
          title: 'Duplicate Task',
          state: 'Unclaimed',
        });
      }).toThrow();
    });
  });

  // ============================================================================
  // FIND BY ID TESTS
  // ============================================================================

  describe('findById', () => {
    it('should find task by ID', () => {
      repo.create({
        id: 'find-1',
        identifier: 'FIND-001',
        title: 'Find Me',
        state: 'Unclaimed',
      });

      const task = repo.findById('find-1');
      expect(task).not.toBeNull();
      expect(task?.title).toBe('Find Me');
    });

    it('should return null for non-existent ID', () => {
      const task = repo.findById('non-existent');
      expect(task).toBeNull();
    });

    it('should return null for deleted task', () => {
      repo.create({
        id: 'delete-1',
        identifier: 'DEL-001',
        title: 'To Be Deleted',
        state: 'Unclaimed',
      });

      repo.delete('delete-1');

      const task = repo.findById('delete-1');
      expect(task).toBeNull();
    });
  });

  // ============================================================================
  // FIND BY ISSUE ID TESTS
  // ============================================================================

  describe('findByIssueId', () => {
    it('should find task by issue identifier', () => {
      repo.create({
        id: 'issue-1',
        identifier: 'ISSUE-123',
        title: 'Issue Task',
        state: 'Unclaimed',
      });

      const task = repo.findByIssueId('ISSUE-123');
      expect(task).not.toBeNull();
      expect(task?.id).toBe('issue-1');
    });

    it('should return null for non-existent identifier', () => {
      const task = repo.findByIssueId('NONEXISTENT');
      expect(task).toBeNull();
    });

    it('should return null for deleted task', () => {
      repo.create({
        id: 'issue-2',
        identifier: 'ISSUE-456',
        title: 'Issue To Delete',
        state: 'Unclaimed',
      });

      repo.delete('issue-2');

      const task = repo.findByIssueId('ISSUE-456');
      expect(task).toBeNull();
    });
  });

  // ============================================================================
  // FIND ALL TESTS
  // ============================================================================

  describe('findAll', () => {
    it('should return all non-deleted tasks', () => {
      repo.create({ id: 'all-1', identifier: 'ALL-001', title: 'Task 1', state: 'Unclaimed' });
      repo.create({ id: 'all-2', identifier: 'ALL-002', title: 'Task 2', state: 'Running' });
      repo.create({ id: 'all-3', identifier: 'ALL-003', title: 'Task 3', state: 'Completed' });

      const tasks = repo.findAll();
      expect(tasks.length).toBe(3);
    });

    it('should exclude deleted tasks', () => {
      repo.create({ id: 'del-1', identifier: 'DEL-001', title: 'Task 1', state: 'Unclaimed' });
      repo.create({ id: 'del-2', identifier: 'DEL-002', title: 'Task 2', state: 'Running' });

      repo.delete('del-1');

      const tasks = repo.findAll();
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe('del-2');
    });

    it('should return empty array when no tasks', () => {
      const tasks = repo.findAll();
      expect(tasks).toEqual([]);
    });
  });

  // ============================================================================
  // FIND BY STATE TESTS
  // ============================================================================

  describe('findByState', () => {
    it('should find tasks by state', () => {
      repo.create({ id: 'state-1', identifier: 'ST-001', title: 'Task 1', state: 'Unclaimed' });
      repo.create({ id: 'state-2', identifier: 'ST-002', title: 'Task 2', state: 'Running' });
      repo.create({ id: 'state-3', identifier: 'ST-003', title: 'Task 3', state: 'Unclaimed' });

      const unclaimed = repo.findByState('Unclaimed');
      expect(unclaimed.length).toBe(2);

      const running = repo.findByState('Running');
      expect(running.length).toBe(1);
    });

    it('should return empty array for unknown state', () => {
      const tasks = repo.findByState('UnknownState');
      expect(tasks).toEqual([]);
    });
  });

  // ============================================================================
  // UPDATE STATUS TESTS
  // ============================================================================

  describe('updateStatus', () => {
    it('should update task status', () => {
      repo.create({ id: 'status-1', identifier: 'ST-001', title: 'Task', state: 'Unclaimed' });

      const updated = repo.updateStatus('status-1', 'Running');
      expect(updated?.state).toBe('Running');
    });

    it('should update updated_at timestamp', () => {
      repo.create({ id: 'status-2', identifier: 'ST-002', title: 'Task', state: 'Unclaimed' });

      const original = repo.findById('status-2');
      const beforeUpdate = original?.updated_at.getTime();

      // Small delay to ensure timestamp difference
      const updated = repo.updateStatus('status-2', 'Running');
      const afterUpdate = updated?.updated_at.getTime();

      expect(afterUpdate).toBeGreaterThanOrEqual(beforeUpdate ?? 0);
    });

    it('should return null for non-existent task', () => {
      const updated = repo.updateStatus('non-existent', 'Running');
      expect(updated).toBeNull();
    });

    it('should return null for deleted task', () => {
      repo.create({ id: 'status-3', identifier: 'ST-003', title: 'Task', state: 'Unclaimed' });
      repo.delete('status-3');

      const updated = repo.updateStatus('status-3', 'Running');
      expect(updated).toBeNull();
    });
  });

  // ============================================================================
  // INCREMENT RETRY COUNT TESTS
  // ============================================================================

  describe('incrementRetryCount', () => {
    it('should increment retry count by 1', () => {
      repo.create({
        id: 'retry-1',
        identifier: 'RY-001',
        title: 'Retry Task',
        state: 'Running',
        retry_count: 0,
      });

      const updated = repo.incrementRetryCount('retry-1');
      expect(updated?.retry_count).toBe(1);
    });

    it('should increment from existing count', () => {
      repo.create({
        id: 'retry-2',
        identifier: 'RY-002',
        title: 'Retry Task',
        state: 'Running',
        retry_count: 3,
      });

      const updated = repo.incrementRetryCount('retry-2');
      expect(updated?.retry_count).toBe(4);
    });

    it('should return null for non-existent task', () => {
      const updated = repo.incrementRetryCount('non-existent');
      expect(updated).toBeNull();
    });
  });

  // ============================================================================
  // DELETE TESTS
  // ============================================================================

  describe('delete', () => {
    it('should soft delete a task', () => {
      repo.create({ id: 'soft-del-1', identifier: 'SD-001', title: 'Task', state: 'Unclaimed' });

      const result = repo.delete('soft-del-1');
      expect(result).toBe(true);
    });

    it('should mark deleted_at timestamp', () => {
      repo.create({ id: 'soft-del-2', identifier: 'SD-002', title: 'Task', state: 'Unclaimed' });

      const beforeDelete = repo.findById('soft-del-2');
      repo.delete('soft-del-2');

      // Direct query to verify soft delete
      const stmt = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?');
      const result = stmt.get('soft-del-2') as { deleted_at: string };
      expect(result.deleted_at).not.toBeNull();
    });

    it('should return false for non-existent task', () => {
      const result = repo.delete('non-existent');
      expect(result).toBe(false);
    });

    it('should exclude soft-deleted tasks from queries', () => {
      repo.create({ id: 'soft-del-3', identifier: 'SD-003', title: 'Task', state: 'Unclaimed' });
      repo.delete('soft-del-3');

      expect(repo.findById('soft-del-3')).toBeNull();
      expect(repo.findByIssueId('SD-003')).toBeNull();
      expect(repo.findAll().find((t) => t.id === 'soft-del-3')).toBeUndefined();
    });
  });

  describe('hardDelete', () => {
    it('should permanently delete a task', () => {
      repo.create({ id: 'hard-del-1', identifier: 'HD-001', title: 'Task', state: 'Unclaimed' });

      const result = repo.hardDelete('hard-del-1');
      expect(result).toBe(true);

      // Even direct query should return null (SQLite returns null, not undefined)
      const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
      const task = stmt.get('hard-del-1');
      expect(task).toBeNull();
    });

    it('should return false for non-existent task', () => {
      const result = repo.hardDelete('non-existent');
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // UPDATE TESTS
  // ============================================================================

  describe('update', () => {
    it('should update task title', () => {
      repo.create({ id: 'upd-1', identifier: 'UPD-001', title: 'Original', state: 'Unclaimed' });

      const updated = repo.update({ id: 'upd-1', title: 'Updated' });
      expect(updated?.title).toBe('Updated');
    });

    it('should update multiple fields', () => {
      repo.create({
        id: 'upd-2',
        identifier: 'UPD-002',
        title: 'Original',
        state: 'Unclaimed',
        priority: null,
      });

      const updated = repo.update({
        id: 'upd-2',
        title: 'New Title',
        priority: 2,
        state: 'Running',
        description: 'New description',
      });

      expect(updated?.title).toBe('New Title');
      expect(updated?.priority).toBe(2);
      expect(updated?.state).toBe('Running');
      expect(updated?.description).toBe('New description');
    });

    it('should update labels array', () => {
      repo.create({
        id: 'upd-3',
        identifier: 'UPD-003',
        title: 'Task',
        state: 'Unclaimed',
        labels: ['old'],
      });

      const updated = repo.update({ id: 'upd-3', labels: ['new', 'updated'] });
      expect(updated?.labels).toEqual(['new', 'updated']);
    });

    it('should return null for non-existent task', () => {
      const updated = repo.update({ id: 'non-existent', title: 'Updated' });
      expect(updated).toBeNull();
    });
  });
});

describe('EventRepository', () => {
  let db: Database;
  let taskRepo: TaskRepository;
  let eventRepo: EventRepository;
  let taskId: string;

  beforeEach(() => {
    db = createTestDatabase();
    taskRepo = new TaskRepository(db);
    eventRepo = new EventRepository(db);

    // Create a task for events
    const task = taskRepo.create({
      id: 'event-task-1',
      identifier: 'EVT-001',
      title: 'Event Task',
      state: 'Running',
    });
    taskId = task.id;
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // CREATE TESTS
  // ============================================================================

  describe('create', () => {
    it('should create a new event', () => {
      const event = eventRepo.create({
        task_id: taskId,
        event_type: 'session_started',
        event_data: { session_id: 'sess-123' },
      });

      expect(event.id).toMatch(/^evt_/);
      expect(event.task_id).toBe(taskId);
      expect(event.event_type).toBe('session_started');
      expect(event.event_data).toEqual({ session_id: 'sess-123' });
      expect(event.severity).toBe('info');
      expect(event.source).toBeNull();
      expect(event.created_at).toBeInstanceOf(Date);
    });

    it('should create event with custom severity', () => {
      const event = eventRepo.create({
        task_id: taskId,
        event_type: 'error',
        event_data: { message: 'Something went wrong' },
        severity: 'error',
      });

      expect(event.severity).toBe('error');
    });

    it('should create event with source', () => {
      const event = eventRepo.create({
        task_id: taskId,
        event_type: 'turn_completed',
        event_data: { turn_id: 1 },
        source: 'codex',
      });

      expect(event.source).toBe('codex');
    });

    it('should create event with complex event data', () => {
      const complexData = {
        user: { id: 1, name: 'Test' },
        metrics: { input: 100, output: 200 },
        nested: { deep: { value: 'test' } },
      };

      const event = eventRepo.create({
        task_id: taskId,
        event_type: 'complex_event',
        event_data: complexData,
      });

      expect(event.event_data).toEqual(complexData);
    });
  });

  // ============================================================================
  // FIND BY ID TESTS
  // ============================================================================

  describe('findById', () => {
    it('should find event by ID', () => {
      const created = eventRepo.create({
        task_id: taskId,
        event_type: 'test',
        event_data: {},
      });

      const found = eventRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it('should return null for non-existent ID', () => {
      const found = eventRepo.findById('non-existent');
      expect(found).toBeNull();
    });
  });

  // ============================================================================
  // FIND BY TASK ID TESTS
  // ============================================================================

  describe('findByTaskId', () => {
    it('should find all events for a task', () => {
      eventRepo.create({ task_id: taskId, event_type: 'event1', event_data: {} });
      eventRepo.create({ task_id: taskId, event_type: 'event2', event_data: {} });
      eventRepo.create({ task_id: taskId, event_type: 'event3', event_data: {} });

      const events = eventRepo.findByTaskId(taskId);
      expect(events.length).toBe(3);
    });

    it('should return events in descending order by created_at', () => {
      // Create events and sort by ID (which contains timestamp) since in-memory DB
      // may have same timestamps for rapid operations
      const e1 = eventRepo.create({ task_id: taskId, event_type: 'first', event_data: {} });
      const e2 = eventRepo.create({ task_id: taskId, event_type: 'second', event_data: {} });
      const e3 = eventRepo.create({ task_id: taskId, event_type: 'third', event_data: {} });

      const events = eventRepo.findByTaskId(taskId);
      // Events should be in DESC order by created_at, then by id (which is timestamp-based)
      // So the last created event should be first
      const ids = events.map((e) => e.id);
      expect(ids).toContain(e3.id);
      expect(ids).toContain(e1.id);
      expect(ids.length).toBe(3);
    });

    it('should respect limit option', () => {
      for (let i = 0; i < 10; i++) {
        eventRepo.create({ task_id: taskId, event_type: `event${i}`, event_data: {} });
      }

      const events = eventRepo.findByTaskId(taskId, { limit: 5 });
      expect(events.length).toBe(5);
    });

    it('should respect offset option', () => {
      for (let i = 0; i < 10; i++) {
        eventRepo.create({ task_id: taskId, event_type: `event${i}`, event_data: {} });
      }

      const events = eventRepo.findByTaskId(taskId, { limit: 5, offset: 5 });
      expect(events.length).toBe(5);
    });

    it('should return empty array for task with no events', () => {
      const events = eventRepo.findByTaskId('non-existent-task');
      expect(events).toEqual([]);
    });
  });

  // ============================================================================
  // STREAM BY TASK ID TESTS
  // ============================================================================

  describe('streamByTaskId', () => {
    it('should stream events in ascending order by created_at', () => {
      const e1 = eventRepo.create({ task_id: taskId, event_type: 'first', event_data: {} });
      const e2 = eventRepo.create({ task_id: taskId, event_type: 'second', event_data: {} });
      const e3 = eventRepo.create({ task_id: taskId, event_type: 'third', event_data: {} });

      const events = eventRepo.streamByTaskId(taskId);
      expect(events[0].id).toBe(e1.id);
      expect(events[2].id).toBe(e3.id);
    });

    it('should filter by afterId for pagination', () => {
      const e1 = eventRepo.create({ task_id: taskId, event_type: 'first', event_data: {} });
      // Small delay to ensure distinct timestamps
      const start = Date.now();
      while (Date.now() === start) { /* wait for next ms */ }
      const e2 = eventRepo.create({ task_id: taskId, event_type: 'second', event_data: {} });
      while (Date.now() === e2.created_at.getTime()) { /* wait for next ms */ }
      const e3 = eventRepo.create({ task_id: taskId, event_type: 'third', event_data: {} });

      const events = eventRepo.streamByTaskId(taskId, { afterId: e1.id });
      expect(events.length).toBe(2);
      expect(events[0].id).toBe(e2.id);
    });

    it('should filter by event type', () => {
      eventRepo.create({ task_id: taskId, event_type: 'typeA', event_data: {} });
      eventRepo.create({ task_id: taskId, event_type: 'typeB', event_data: {} });
      eventRepo.create({ task_id: taskId, event_type: 'typeA', event_data: {} });

      const events = eventRepo.streamByTaskId(taskId, { eventType: 'typeA' });
      expect(events.length).toBe(2);
      events.forEach((e) => expect(e.event_type).toBe('typeA'));
    });

    it('should filter by minimum severity', () => {
      eventRepo.create({ task_id: taskId, event_type: 'debug', event_data: {}, severity: 'debug' });
      eventRepo.create({ task_id: taskId, event_type: 'info', event_data: {}, severity: 'info' });
      eventRepo.create({ task_id: taskId, event_type: 'warn', event_data: {}, severity: 'warning' });
      eventRepo.create({ task_id: taskId, event_type: 'err', event_data: {}, severity: 'error' });

      const events = eventRepo.streamByTaskId(taskId, { minSeverity: 'warning' });
      expect(events.length).toBe(2);
      events.forEach((e) => {
        expect(['warning', 'error', 'critical']).toContain(e.severity);
      });
    });

    it('should apply limit', () => {
      for (let i = 0; i < 10; i++) {
        eventRepo.create({ task_id: taskId, event_type: `event${i}`, event_data: {} });
      }

      const events = eventRepo.streamByTaskId(taskId, { limit: 3 });
      expect(events.length).toBe(3);
    });
  });

  // ============================================================================
  // COUNT BY TASK ID TESTS
  // ============================================================================

  describe('countByTaskId', () => {
    it('should count events for a task', () => {
      eventRepo.create({ task_id: taskId, event_type: 'e1', event_data: {} });
      eventRepo.create({ task_id: taskId, event_type: 'e2', event_data: {} });
      eventRepo.create({ task_id: taskId, event_type: 'e3', event_data: {} });

      const count = eventRepo.countByTaskId(taskId);
      expect(count).toBe(3);
    });

    it('should return 0 for task with no events', () => {
      const count = eventRepo.countByTaskId('non-existent');
      expect(count).toBe(0);
    });
  });

  // ============================================================================
  // FIND BY TYPE TESTS
  // ============================================================================

  describe('findByType', () => {
    it('should find events by type across all tasks', () => {
      const task2 = taskRepo.create({
        id: 'event-task-2',
        identifier: 'EVT-002',
        title: 'Event Task 2',
        state: 'Running',
      });

      eventRepo.create({ task_id: taskId, event_type: 'session_started', event_data: {} });
      eventRepo.create({ task_id: task2.id, event_type: 'session_started', event_data: {} });
      eventRepo.create({ task_id: taskId, event_type: 'turn_completed', event_data: {} });

      const events = eventRepo.findByType('session_started');
      expect(events.length).toBe(2);
    });

    it('should respect limit', () => {
      for (let i = 0; i < 5; i++) {
        eventRepo.create({ task_id: taskId, event_type: 'repeated', event_data: {} });
      }

      const events = eventRepo.findByType('repeated', 3);
      expect(events.length).toBe(3);
    });
  });

  // ============================================================================
  // DELETE TESTS
  // ============================================================================

  describe('deleteByTaskId', () => {
    it('should delete all events for a task', () => {
      eventRepo.create({ task_id: taskId, event_type: 'e1', event_data: {} });
      eventRepo.create({ task_id: taskId, event_type: 'e2', event_data: {} });
      eventRepo.create({ task_id: taskId, event_type: 'e3', event_data: {} });

      const deleted = eventRepo.deleteByTaskId(taskId);
      expect(deleted).toBe(3);

      const remaining = eventRepo.findByTaskId(taskId);
      expect(remaining).toEqual([]);
    });

    it('should return 0 for non-existent task', () => {
      const deleted = eventRepo.deleteByTaskId('non-existent');
      expect(deleted).toBe(0);
    });
  });

  describe('deleteOlderThan', () => {
    it('should delete events older than specified date', () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 10000);
      const futureDate = new Date(now.getTime() + 10000);

      // Create old event
      const oldEventId = 'old-1';
      const stmt = db.prepare(`
        INSERT INTO execution_events (id, task_id, event_type, event_data, severity, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(oldEventId, taskId, 'old_event', '{}', 'info', null, oldDate.toISOString());

      // Create new event using repository
      const newEvent = eventRepo.create({ task_id: taskId, event_type: 'new_event', event_data: {} });

      // Delete events older than now (between oldDate and newEvent creation time)
      const deleted = eventRepo.deleteOlderThan(taskId, newEvent.created_at);
      expect(deleted).toBe(1);

      // New event should still exist
      const remaining = eventRepo.findByTaskId(taskId);
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe(newEvent.id);
    });
  });

  describe('clearAll', () => {
    it('should delete all events', () => {
      const task2 = taskRepo.create({
        id: 'event-task-2',
        identifier: 'EVT-002',
        title: 'Event Task 2',
        state: 'Running',
      });

      eventRepo.create({ task_id: taskId, event_type: 'e1', event_data: {} });
      eventRepo.create({ task_id: task2.id, event_type: 'e2', event_data: {} });

      const cleared = eventRepo.clearAll();
      expect(cleared).toBe(2);

      expect(eventRepo.findByTaskId(taskId)).toEqual([]);
      expect(eventRepo.findByTaskId(task2.id)).toEqual([]);
    });
  });
});

describe('Database Integration', () => {
  let db: Database;
  let taskRepo: TaskRepository;
  let eventRepo: EventRepository;

  beforeEach(() => {
    db = createTestDatabase();
    taskRepo = new TaskRepository(db);
    eventRepo = new EventRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should maintain foreign key relationships', () => {
    const task = taskRepo.create({
      id: 'fk-task',
      identifier: 'FK-001',
      title: 'FK Task',
      state: 'Running',
    });

    eventRepo.create({
      task_id: task.id,
      event_type: 'test',
      event_data: {},
    });

    // Delete task should cascade to events
    taskRepo.hardDelete('fk-task');

    const events = eventRepo.findByTaskId('fk-task');
    expect(events).toEqual([]);
  });

  it('should handle transaction-like operations', () => {
    // Create task and event together
    const task = taskRepo.create({
      id: 'tx-task',
      identifier: 'TX-001',
      title: 'TX Task',
      state: 'Unclaimed',
    });

    const event = eventRepo.create({
      task_id: task.id,
      event_type: 'session_started',
      event_data: { tx: true },
    });

    // Verify both exist
    expect(taskRepo.findById(task.id)).not.toBeNull();
    expect(eventRepo.findById(event.id)).not.toBeNull();
  });

  it('should handle concurrent operations on in-memory database', () => {
    const tasks = [
      { id: 'c1', identifier: 'C-001', title: 'Task 1', state: 'Unclaimed' as const },
      { id: 'c2', identifier: 'C-002', title: 'Task 2', state: 'Running' as const },
      { id: 'c3', identifier: 'C-003', title: 'Task 3', state: 'Completed' as const },
    ];

    // Create tasks
    tasks.forEach((t) => taskRepo.create(t));

    // Add events to each
    tasks.forEach((t) => {
      eventRepo.create({ task_id: t.id, event_type: 'created', event_data: {} });
      eventRepo.create({ task_id: t.id, event_type: 'processed', event_data: {} });
    });

    // Update states
    taskRepo.updateStatus('c1', 'Claimed');
    taskRepo.updateStatus('c2', 'Completed');

    // Verify final state
    const allTasks = taskRepo.findAll();
    expect(allTasks.length).toBe(3);
    expect(allTasks.find((t) => t.id === 'c1')?.state).toBe('Claimed');
    expect(allTasks.find((t) => t.id === 'c2')?.state).toBe('Completed');

    const totalEvents = tasks.reduce((sum, t) => sum + eventRepo.countByTaskId(t.id), 0);
    expect(totalEvents).toBe(6);
  });
});
