import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_DAILY_TOKENS,
  DEFAULT_MAX_REPO_DAILY_TOKENS,
  DEFAULT_MAX_TASK_TOKENS,
  DEFAULT_MAX_TURN_OUTPUT_TOKENS,
  DEFAULT_MAX_TURN_STEPS,
  DEFAULT_TURN_RESERVE_TOKENS,
  estimateTaskCostUsd,
  isTaskTokenBudgetExceeded,
  resolveCostPolicy,
} from './policy';

describe('cost policy', () => {
  test('uses a model-agnostic hard token budget by default', () => {
    const policy = resolveCostPolicy({});
    expect(policy.maxTaskTokens).toBe(DEFAULT_MAX_TASK_TOKENS);
    expect(policy.maxTurnOutputTokens).toBe(DEFAULT_MAX_TURN_OUTPUT_TOKENS);
    expect(policy.maxTurnSteps).toBe(DEFAULT_MAX_TURN_STEPS);
    expect(policy.turnReserveTokens).toBe(DEFAULT_TURN_RESERVE_TOKENS);
    expect(policy.maxRepoDailyTokens).toBe(DEFAULT_MAX_REPO_DAILY_TOKENS);
    expect(policy.maxDailyTokens).toBe(DEFAULT_MAX_DAILY_TOKENS);
    expect(isTaskTokenBudgetExceeded({
      input: DEFAULT_MAX_TASK_TOKENS,
      output: 0,
      total: DEFAULT_MAX_TASK_TOKENS,
    }, policy)).toBe(false);
    expect(isTaskTokenBudgetExceeded({
      input: DEFAULT_MAX_TASK_TOKENS + 1,
      output: 0,
      total: DEFAULT_MAX_TASK_TOKENS + 1,
    }, policy)).toBe(true);
  });

  test('estimates configured input, output, and cache-read rates', () => {
    const policy = resolveCostPolicy({
      SYMHARIX_MAX_TASK_TOKENS: '100000',
      SYMHARIX_COST_INPUT_USD_PER_MILLION: '2',
      SYMHARIX_COST_OUTPUT_USD_PER_MILLION: '8',
      SYMHARIX_COST_CACHE_READ_USD_PER_MILLION: '0.2',
    });

    expect(policy.maxTaskTokens).toBe(100_000);
    expect(estimateTaskCostUsd({
      input: 10_000,
      output: 2_000,
      total: 12_000,
      cache_read_input: 4_000,
    }, policy)).toBeCloseTo(0.0288);
  });

  test('does not invent a cost estimate without configured rates', () => {
    expect(estimateTaskCostUsd({
      input: 100,
      output: 50,
      total: 150,
    }, resolveCostPolicy({}))).toBeNull();
  });
});
