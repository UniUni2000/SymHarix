import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeSchema } from '../database/schema';
import { AgentRunRepository, WorkItemRepository } from '../database';
import type { WorkItem } from '../database/types';
import { CostGovernor } from './governor';
import { resolveCostPolicy } from './policy';

function createFixture(env: NodeJS.ProcessEnv = {}) {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  const workItems = new WorkItemRepository(db);
  const runs = new AgentRunRepository(db);
  const now = new Date('2026-07-31T08:00:00.000Z');
  const governor = new CostGovernor(db, resolveCostPolicy(env), () => now);

  const createWorkItem = (
    id: string,
    identifier: string,
    githubRepo = 'example/repo',
  ): WorkItem => workItems.create({
    id,
    linear_issue_id: `linear-${id}`,
    linear_identifier: identifier,
    linear_title: `Title ${identifier}`,
    linear_state: 'In Progress',
    github_repo: githubRepo,
  });
  const createRun = (id: string, workItemId: string) => runs.create({
    id,
    work_item_id: workItemId,
    agent_type: 'dev',
    phase: 'dev',
    started_at: now,
  });

  return { db, governor, runs, createWorkItem, createRun };
}

describe('CostGovernor', () => {
  test('atomically reserves a turn so concurrent runs cannot oversubscribe a task', () => {
    const fixture = createFixture({
      SYMHARIX_TURN_RESERVE_TOKENS: '100',
      SYMHARIX_MAX_TASK_TOKENS: '150',
      SYMHARIX_MAX_REPO_DAILY_TOKENS: '1000',
      SYMHARIX_MAX_DAILY_TOKENS: '1000',
    });
    const workItem = fixture.createWorkItem('wi-1', 'INT-1');
    fixture.createRun('run-1', workItem.id);
    fixture.createRun('run-2', workItem.id);

    expect(fixture.governor.reserveNextCall(workItem, 'run-1').allowed).toBe(true);
    const second = fixture.governor.reserveNextCall(workItem, 'run-2');
    expect(second.allowed).toBe(false);
    expect(second.blocked_scope).toBe('task');
    expect(fixture.runs.findById('run-1')?.budget_reserved_tokens).toBe(100);
    expect(fixture.runs.findById('run-2')?.budget_reserved_tokens).toBe(0);
    fixture.db.close();
  });

  test('enforces repository and global daily token budgets across work items', () => {
    const fixture = createFixture({
      SYMHARIX_TURN_RESERVE_TOKENS: '100',
      SYMHARIX_MAX_TASK_TOKENS: '1000',
      SYMHARIX_MAX_REPO_DAILY_TOKENS: '150',
      SYMHARIX_MAX_DAILY_TOKENS: '220',
    });
    const first = fixture.createWorkItem('wi-1', 'INT-1');
    const second = fixture.createWorkItem('wi-2', 'INT-2');
    const third = fixture.createWorkItem('wi-3', 'INT-3', 'other/repo');
    const fourth = fixture.createWorkItem('wi-4', 'INT-4', 'third/repo');
    fixture.createRun('run-1', first.id);
    fixture.createRun('run-2', second.id);
    fixture.createRun('run-3', third.id);

    expect(fixture.governor.reserveNextCall(first, 'run-1').allowed).toBe(true);
    expect(fixture.governor.reserveNextCall(second, 'run-2').blocked_scope).toBe('repo_daily');
    expect(fixture.governor.reserveNextCall(third, 'run-3').allowed).toBe(true);
    fixture.governor.recordUsage('run-3', { input: 70, output: 30, total: 100 });
    fixture.governor.releaseReservation('run-1');
    fixture.governor.recordUsage('run-1', { input: 70, output: 30, total: 100 });

    fixture.createRun('run-4', fourth.id);
    expect(fixture.governor.reserveNextCall(fourth, 'run-4').blocked_scope).toBe('daily');
    fixture.db.close();
  });

  test('enforces USD limits only when model pricing is configured', () => {
    const fixture = createFixture({
      SYMHARIX_TURN_RESERVE_TOKENS: '100',
      SYMHARIX_MAX_TURN_OUTPUT_TOKENS: '20',
      SYMHARIX_MAX_TASK_TOKENS: '1000',
      SYMHARIX_MAX_REPO_DAILY_TOKENS: '1000',
      SYMHARIX_MAX_DAILY_TOKENS: '1000',
      SYMHARIX_COST_INPUT_USD_PER_MILLION: '1',
      SYMHARIX_COST_OUTPUT_USD_PER_MILLION: '10',
      SYMHARIX_MAX_TASK_USD: '0.0002',
      SYMHARIX_MAX_REPO_DAILY_USD: '10',
      SYMHARIX_MAX_DAILY_USD: '10',
    });
    const workItem = fixture.createWorkItem('wi-1', 'INT-1');
    fixture.createRun('run-1', workItem.id);

    const decision = fixture.governor.reserveNextCall(workItem, 'run-1');
    expect(decision.allowed).toBe(false);
    expect(decision.blocked_scope).toBe('task');
    expect(decision.snapshot.pricing_configured).toBe(true);
    expect(decision.snapshot.scopes[0]?.usd_enforced).toBe(true);
    fixture.db.close();
  });

  test('records live usage and a time-limited operator override permits continuation', () => {
    const fixture = createFixture({
      SYMHARIX_TURN_RESERVE_TOKENS: '100',
      SYMHARIX_MAX_TASK_TOKENS: '120',
      SYMHARIX_MAX_REPO_DAILY_TOKENS: '1000',
      SYMHARIX_MAX_DAILY_TOKENS: '1000',
      SYMHARIX_COST_OVERRIDE_MINUTES: '30',
    });
    const workItem = fixture.createWorkItem('wi-1', 'INT-1');
    fixture.createRun('run-1', workItem.id);
    fixture.governor.recordUsage('run-1', {
      input: 90,
      output: 20,
      total: 110,
      cache_read_input: 10,
    });
    expect(fixture.governor.reserveNextCall(workItem, 'run-1').allowed).toBe(false);

    const override = fixture.governor.approveOverride(workItem.id, 'User approved');
    expect(override.active).toBe(true);
    expect(override.expires_at).toBe('2026-07-31T08:30:00.000Z');
    expect(fixture.governor.reserveNextCall(workItem, 'run-1').allowed).toBe(true);

    const snapshot = fixture.governor.getWorkItemSnapshot(workItem);
    expect(snapshot.override.reason).toBe('User approved');
    expect(snapshot.blocked_scopes).toEqual([]);
    expect(snapshot.scopes[0]).toMatchObject({
      tokens_used: 110,
      tokens_reserved: 100,
      token_limit: 120,
    });
    fixture.db.close();
  });

  test('releases crash-residue reservations when a new primary leader starts', () => {
    const fixture = createFixture({
      SYMHARIX_TURN_RESERVE_TOKENS: '100',
      SYMHARIX_MAX_TASK_TOKENS: '500',
    });
    const workItem = fixture.createWorkItem('wi-1', 'INT-1');
    fixture.createRun('run-1', workItem.id);
    fixture.governor.reserveNextCall(workItem, 'run-1');

    expect(fixture.runs.findById('run-1')?.budget_reserved_tokens).toBe(100);
    expect(fixture.governor.releaseStaleReservations()).toBe(1);
    expect(fixture.runs.findById('run-1')?.budget_reserved_tokens).toBe(0);
    expect(fixture.governor.releaseStaleReservations()).toBe(0);
    fixture.db.close();
  });
});
