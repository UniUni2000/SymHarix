import { readSymHarixEnv } from '../config/env';

export const DEFAULT_MAX_TASK_TOKENS = 500_000;
export const DEFAULT_MAX_TURN_OUTPUT_TOKENS = 16_000;
export const DEFAULT_MAX_TURN_STEPS = 12;
// OpenCode reports aggregate usage across tool steps. Coding turns routinely
// cross 100k mostly through cheap cache reads, so keep the standard ceiling
// above that while task/daily/USD limits remain the outer guardrails.
export const DEFAULT_TURN_RESERVE_TOKENS = 200_000;
export const DEFAULT_MAX_REPO_DAILY_TOKENS = 2_000_000;
export const DEFAULT_MAX_DAILY_TOKENS = 5_000_000;
export const DEFAULT_MAX_TASK_USD = 25;
export const DEFAULT_MAX_REPO_DAILY_USD = 100;
export const DEFAULT_MAX_DAILY_USD = 250;
export const DEFAULT_COST_OVERRIDE_MINUTES = 60;

export interface TaskTokenUsage {
  input: number;
  output: number;
  total: number;
  cache_read_input?: number;
}

export interface CostPolicy {
  maxTurnOutputTokens: number;
  maxTurnSteps: number;
  turnReserveTokens: number;
  maxTaskTokens: number;
  maxRepoDailyTokens: number;
  maxDailyTokens: number;
  maxTaskUsd: number;
  maxRepoDailyUsd: number;
  maxDailyUsd: number;
  overrideMinutes: number;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cacheReadUsdPerMillion: number | null;
}

function parsePositiveNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  return Math.trunc(parsePositiveNumber(value) ?? fallback);
}

export function resolveCostPolicy(
  env: NodeJS.ProcessEnv = process.env,
): CostPolicy {
  return {
    maxTurnOutputTokens: positiveInteger(
      readSymHarixEnv('SYMPHONY_MAX_TURN_OUTPUT_TOKENS', env),
      DEFAULT_MAX_TURN_OUTPUT_TOKENS,
    ),
    maxTurnSteps: positiveInteger(
      readSymHarixEnv('SYMPHONY_MAX_TURN_STEPS', env),
      DEFAULT_MAX_TURN_STEPS,
    ),
    turnReserveTokens: positiveInteger(
      readSymHarixEnv('SYMPHONY_TURN_RESERVE_TOKENS', env),
      DEFAULT_TURN_RESERVE_TOKENS,
    ),
    maxTaskTokens: positiveInteger(
      readSymHarixEnv('SYMPHONY_MAX_TASK_TOKENS', env),
      DEFAULT_MAX_TASK_TOKENS,
    ),
    maxRepoDailyTokens: positiveInteger(
      readSymHarixEnv('SYMPHONY_MAX_REPO_DAILY_TOKENS', env),
      DEFAULT_MAX_REPO_DAILY_TOKENS,
    ),
    maxDailyTokens: positiveInteger(
      readSymHarixEnv('SYMPHONY_MAX_DAILY_TOKENS', env),
      DEFAULT_MAX_DAILY_TOKENS,
    ),
    maxTaskUsd: parsePositiveNumber(
      readSymHarixEnv('SYMPHONY_MAX_TASK_USD', env),
    ) ?? DEFAULT_MAX_TASK_USD,
    maxRepoDailyUsd: parsePositiveNumber(
      readSymHarixEnv('SYMPHONY_MAX_REPO_DAILY_USD', env),
    ) ?? DEFAULT_MAX_REPO_DAILY_USD,
    maxDailyUsd: parsePositiveNumber(
      readSymHarixEnv('SYMPHONY_MAX_DAILY_USD', env),
    ) ?? DEFAULT_MAX_DAILY_USD,
    overrideMinutes: positiveInteger(
      readSymHarixEnv('SYMPHONY_COST_OVERRIDE_MINUTES', env),
      DEFAULT_COST_OVERRIDE_MINUTES,
    ),
    inputUsdPerMillion: parsePositiveNumber(
      readSymHarixEnv('SYMPHONY_COST_INPUT_USD_PER_MILLION', env),
    ),
    outputUsdPerMillion: parsePositiveNumber(
      readSymHarixEnv('SYMPHONY_COST_OUTPUT_USD_PER_MILLION', env),
    ),
    cacheReadUsdPerMillion: parsePositiveNumber(
      readSymHarixEnv('SYMPHONY_COST_CACHE_READ_USD_PER_MILLION', env),
    ),
  };
}

export function isCostPricingConfigured(policy: CostPolicy): boolean {
  return policy.inputUsdPerMillion !== null && policy.outputUsdPerMillion !== null;
}

export function estimateReservationCostUsd(policy: CostPolicy): number | null {
  const output = Math.min(policy.turnReserveTokens, policy.maxTurnOutputTokens);
  return estimateTaskCostUsd({
    input: Math.max(0, policy.turnReserveTokens - output),
    output,
    total: policy.turnReserveTokens,
  }, policy);
}

export function isTaskTokenBudgetExceeded(
  usage: TaskTokenUsage,
  policy: CostPolicy,
): boolean {
  return usage.total > policy.maxTaskTokens;
}

export function estimateTaskCostUsd(
  usage: TaskTokenUsage,
  policy: CostPolicy,
): number | null {
  if (
    policy.inputUsdPerMillion === null
    || policy.outputUsdPerMillion === null
  ) {
    return null;
  }

  const cacheReadInput = Math.max(0, usage.cache_read_input ?? 0);
  const uncachedInput = Math.max(0, usage.input - cacheReadInput);
  const cacheReadRate = policy.cacheReadUsdPerMillion
    ?? policy.inputUsdPerMillion;
  return (
    uncachedInput * policy.inputUsdPerMillion
    + cacheReadInput * cacheReadRate
    + Math.max(0, usage.output) * policy.outputUsdPerMillion
  ) / 1_000_000;
}
