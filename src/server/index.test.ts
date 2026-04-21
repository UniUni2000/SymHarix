/**
 * Tests for the minimal Symphony HTTP server
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SymphonyServer } from './index';
import { initializeSchema, dropAllTables } from '../database/schema';
import {
  AgentRunRepository,
  ReviewEventRepository,
  WorkItemRepository,
} from '../database';

describe('SymphonyServer', () => {
  let db: Database;
  let server: SymphonyServer;
  let baseUrl: string;

  beforeAll(async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    server = new SymphonyServer(db, {
      port: 0,
      hostname: 'localhost',
      corsOrigins: ['*'],
    });

    const { port } = await server.start();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    db.close();
  });

  beforeEach(() => {
    dropAllTables(db);
    initializeSchema(db);
  });

  test('GET / returns minimal server info', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data.endpoints.health).toBe('/api/v1/health');
    expect(payload.data.endpoints.workItems).toBe('/api/v1/work-items');
    expect(payload.data.endpoints.tasks).toBeUndefined();
  });

  test('GET /api/v1/health returns health status', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data.status).toBeDefined();
    expect(payload.data.checks.database).toBe(true);
  });

  test('GET /api/v1/work-items returns control-plane work items', async () => {
    const workItemRepo = new WorkItemRepository(db);
    workItemRepo.create({
      id: 'wi-1',
      linear_issue_id: 'linear-1',
      linear_identifier: 'INT-1',
      linear_title: 'Control plane item',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      github_issue_number: 501,
      active_pr_number: 77,
      orchestrator_state: 'review_running',
    });

    const response = await fetch(`${baseUrl}/api/v1/work-items`);
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].linear_identifier).toBe('INT-1');
  });

  test('GET /api/v1/work-items/:id returns a specific work item', async () => {
    const workItemRepo = new WorkItemRepository(db);
    workItemRepo.create({
      id: 'wi-2',
      linear_issue_id: 'linear-2',
      linear_identifier: 'INT-2',
      linear_title: 'Specific work item',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
    });

    const response = await fetch(`${baseUrl}/api/v1/work-items/wi-2`);
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data.id).toBe('wi-2');
  });

  test('GET /api/v1/work-items/:id/runs returns agent runs', async () => {
    const workItemRepo = new WorkItemRepository(db);
    const agentRunRepo = new AgentRunRepository(db);

    workItemRepo.create({
      id: 'wi-3',
      linear_issue_id: 'linear-3',
      linear_identifier: 'INT-3',
      linear_title: 'Runs item',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
    });
    agentRunRepo.create({
      id: 'run-1',
      work_item_id: 'wi-3',
      agent_type: 'dev',
      phase: 'dev',
      input_summary: 'GitHub context',
    });

    const response = await fetch(`${baseUrl}/api/v1/work-items/wi-3/runs`);
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].id).toBe('run-1');
  });

  test('GET /api/v1/work-items/:id/reviews returns review history', async () => {
    const workItemRepo = new WorkItemRepository(db);
    const reviewEventRepo = new ReviewEventRepository(db);

    workItemRepo.create({
      id: 'wi-4',
      linear_issue_id: 'linear-4',
      linear_identifier: 'INT-4',
      linear_title: 'Reviews item',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      active_pr_number: 88,
    });
    reviewEventRepo.create({
      id: 'review-1',
      work_item_id: 'wi-4',
      pr_number: 88,
      review_round: 1,
      decision: 'REQUEST_CHANGES',
      summary_md: 'Please add tests',
    });

    const response = await fetch(`${baseUrl}/api/v1/work-items/wi-4/reviews`);
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].decision).toBe('REQUEST_CHANGES');
  });
});
