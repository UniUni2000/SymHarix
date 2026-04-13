/**
 * Tests for Symphony HTTP Server
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SymphonyServer } from './index';
import { initializeSchema, dropAllTables } from '../database/schema';
import type { Task } from '../database/types';

describe('SymphonyServer', () => {
  let db: Database;
  let server: SymphonyServer;
  let baseUrl: string;

  beforeAll(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    initializeSchema(db);

    // Create and start server
    server = new SymphonyServer(db, {
      port: 0, // Use random available port
      hostname: 'localhost',
      corsOrigins: ['*'],
      enableWebSocket: true,
    });

    const { port } = await server.start();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    db.close();
  });

  beforeEach(() => {
    // Clear data between tests
    dropAllTables(db);
    initializeSchema(db);
  });

  describe('Root Endpoint', () => {
    test('GET / returns server info', async () => {
      const response = await fetch(baseUrl);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('Symphony HTTP Server');
      expect(data.data.version).toBe('1.0.0');
    });
  });

  describe('Health Endpoints', () => {
    describe('GET /api/v1/health', () => {
      test('returns health status', async () => {
        const response = await fetch(`${baseUrl}/api/v1/health`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.data.status).toBeDefined();
        expect(data.data.version).toBe('1.0.0');
        expect(data.data.checks.database).toBe(true);
      });
    });

    describe('GET /api/v1/health/ready', () => {
      test('returns readiness status', async () => {
        const response = await fetch(`${baseUrl}/api/v1/health/ready`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.data.ready).toBe(true);
      });
    });

    describe('GET /api/v1/health/live', () => {
      test('returns liveness status', async () => {
        const response = await fetch(`${baseUrl}/api/v1/health/live`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.data.alive).toBe(true);
      });
    });
  });

  describe('Task Endpoints', () => {
    describe('POST /api/v1/tasks', () => {
      test('creates a new task', async () => {
        const response = await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-001',
            title: 'Test Task',
            description: 'A test task',
            priority: 1,
          }),
        });

        expect(response.status).toBe(201);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.data.identifier).toBe('TEST-001');
        expect(data.data.title).toBe('Test Task');
        expect(data.data.state).toBe('Unclaimed');
      });

      test('returns 400 for missing required fields', async () => {
        const response = await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Missing identifier' }),
        });

        expect(response.status).toBe(400);
      });

      test('returns 409 for duplicate identifier', async () => {
        // Create first task
        await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-002',
            title: 'First Task',
          }),
        });

        // Try to create duplicate
        const response = await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-002',
            title: 'Duplicate Task',
          }),
        });

        expect(response.status).toBe(409);
      });
    });

    describe('GET /api/v1/tasks', () => {
      test('returns empty list when no tasks', async () => {
        const response = await fetch(`${baseUrl}/api/v1/tasks`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.data).toEqual([]);
        expect(data.pagination.total).toBe(0);
      });

      test('returns paginated list of tasks', async () => {
        // Create test tasks
        for (let i = 1; i <= 5; i++) {
          await fetch(`${baseUrl}/api/v1/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              identifier: `TEST-00${i}`,
              title: `Task ${i}`,
            }),
          });
        }

        const response = await fetch(`${baseUrl}/api/v1/tasks?page=1&limit=3`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.data.length).toBe(3);
        expect(data.pagination.total).toBe(5);
        expect(data.pagination.hasMore).toBe(true);
      });

      test('filters tasks by state', async () => {
        // Create tasks with different states
        await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-STATE-1',
            title: 'Task 1',
            state: 'Running',
          }),
        });

        await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-STATE-2',
            title: 'Task 2',
            state: 'Unclaimed',
          }),
        });

        const response = await fetch(`${baseUrl}/api/v1/tasks?state=Running`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.data.length).toBe(1);
        expect(data.data[0].state).toBe('Running');
      });
    });

    describe('GET /api/v1/tasks/:id', () => {
      test('returns task by ID', async () => {
        // Create a task first
        const createResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-GET',
            title: 'Get Test Task',
          }),
        });
        const created = await createResponse.json();

        const response = await fetch(`${baseUrl}/api/v1/tasks/${created.data.id}`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.data.id).toBe(created.data.id);
        expect(data.data.identifier).toBe('TEST-GET');
      });

      test('returns 404 for non-existent task', async () => {
        const response = await fetch(`${baseUrl}/api/v1/tasks/non-existent-id`);
        expect(response.status).toBe(404);
      });
    });

    describe('POST /api/v1/tasks/:id/pause', () => {
      test('pauses a running task', async () => {
        // Create a running task
        const createResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-PAUSE',
            title: 'Pause Test Task',
            state: 'Running',
          }),
        });
        const created = await createResponse.json();

        const response = await fetch(`${baseUrl}/api/v1/tasks/${created.data.id}/pause`, {
          method: 'POST',
        });

        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.action).toBe('pause');

        // Verify state changed
        const getResponse = await fetch(`${baseUrl}/api/v1/tasks/${created.data.id}`);
        const task = await getResponse.json();
        expect(task.data.state).toBe('Claimed');
      });

      test('returns 404 for non-existent task', async () => {
        const response = await fetch(`${baseUrl}/api/v1/tasks/non-existent-id/pause`, {
          method: 'POST',
        });
        expect(response.status).toBe(404);
      });
    });

    describe('POST /api/v1/tasks/:id/cancel', () => {
      test('cancels a task', async () => {
        // Create a task
        const createResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-CANCEL',
            title: 'Cancel Test Task',
            state: 'Running',
          }),
        });
        const created = await createResponse.json();

        const response = await fetch(`${baseUrl}/api/v1/tasks/${created.data.id}/cancel`, {
          method: 'POST',
        });

        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.action).toBe('cancel');

        // Verify state changed
        const getResponse = await fetch(`${baseUrl}/api/v1/tasks/${created.data.id}`);
        const task = await getResponse.json();
        expect(task.data.state).toBe('Released');
      });

      test('returns 404 for non-existent task', async () => {
        const response = await fetch(`${baseUrl}/api/v1/tasks/non-existent-id/cancel`, {
          method: 'POST',
        });
        expect(response.status).toBe(404);
      });
    });

    describe('DELETE /api/v1/tasks/:id', () => {
      test('soft deletes a task', async () => {
        // Create a task
        const createResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-DELETE',
            title: 'Delete Test Task',
          }),
        });
        const created = await createResponse.json();

        const response = await fetch(`${baseUrl}/api/v1/tasks/${created.data.id}`, {
          method: 'DELETE',
        });

        expect(response.status).toBe(200);

        // Verify task is no longer returned
        const getResponse = await fetch(`${baseUrl}/api/v1/tasks/${created.data.id}`);
        expect(getResponse.status).toBe(404);
      });
    });

    describe('GET /api/v1/tasks/:id/events', () => {
      test('returns events for a task', async () => {
        // Create a task
        const createResponse = await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'TEST-EVENTS',
            title: 'Events Test Task',
          }),
        });
        const created = await createResponse.json();

        const response = await fetch(`${baseUrl}/api/v1/tasks/${created.data.id}/events`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(Array.isArray(data.data)).toBe(true);
      });
    });
  });

  describe('Stats Endpoints', () => {
    describe('GET /api/v1/stats', () => {
      test('returns system statistics', async () => {
        // Create some test data
        await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'STATS-001',
            title: 'Stats Task 1',
            state: 'Running',
          }),
        });

        await fetch(`${baseUrl}/api/v1/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: 'STATS-002',
            title: 'Stats Task 2',
            state: 'Unclaimed',
          }),
        });

        const response = await fetch(`${baseUrl}/api/v1/stats`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.data.tasks.total).toBe(2);
        expect(data.data.tasks.byState.Running).toBe(1);
        expect(data.data.tasks.byState.Unclaimed).toBe(1);
      });
    });

    describe('GET /api/v1/stats/summary', () => {
      test('returns quick summary', async () => {
        const response = await fetch(`${baseUrl}/api/v1/stats/summary`);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.data).toHaveProperty('tasks');
        expect(data.data).toHaveProperty('events');
        expect(data.data).toHaveProperty('running');
      });
    });
  });

  describe('CORS', () => {
    test('includes CORS headers in response', async () => {
      const response = await fetch(`${baseUrl}/api/v1/health`, {
        headers: {
          Origin: 'http://example.com',
        },
      });

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('Error Handling', () => {
    test('returns 404 for unknown routes', async () => {
      const response = await fetch(`${baseUrl}/api/v1/unknown`);
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Not found');
    });
  });
});
