import type { Database } from 'bun:sqlite';
import type { WorkItem } from '../database/types';
import {
  estimateReservationCostUsd,
  estimateTaskCostUsd,
  isCostPricingConfigured,
  resolveCostPolicy,
  type CostPolicy,
  type TaskTokenUsage,
} from './policy';

export type CostBudgetScopeName = 'task' | 'repo_daily' | 'daily';

export interface CostBudgetScope {
  scope: CostBudgetScopeName;
  label: string;
  tokens_used: number;
  tokens_reserved: number;
  token_limit: number;
  token_remaining: number;
  token_utilization: number;
  cost_usd: number | null;
  cost_usd_reserved: number | null;
  usd_limit: number;
  usd_remaining: number | null;
  usd_utilization: number | null;
  usd_enforced: boolean;
  blocked: boolean;
}

export interface CostBudgetOverride {
  active: boolean;
  approved_at: string | null;
  expires_at: string | null;
  reason: string | null;
}

export interface WorkItemCostSnapshot {
  generated_at: string;
  day_key: string;
  github_repo: string;
  pricing_configured: boolean;
  max_turn_output_tokens: number;
  max_turn_steps: number;
  turn_reserve_tokens: number;
  override: CostBudgetOverride;
  scopes: CostBudgetScope[];
  blocked_scopes: CostBudgetScopeName[];
}

export interface CostOverviewSnapshot {
  generated_at: string;
  day_key: string;
  pricing_configured: boolean;
  daily: CostBudgetScope;
  repositories: Array<{
    github_repo: string;
    budget: CostBudgetScope;
  }>;
}

export interface CostPreflightDecision {
  allowed: boolean;
  blocked_scope: CostBudgetScopeName | null;
  message: string | null;
  snapshot: WorkItemCostSnapshot;
}

interface UsageRow {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  reserved_tokens?: number | null;
  reserved_usd_micros?: number | null;
}

interface OverrideRow {
  approved_at?: string | null;
  expires_at?: string | null;
  reason?: string | null;
}

function nonNegative(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function utcDay(now: Date): { key: string; start: string; end: string } {
  const key = now.toISOString().slice(0, 10);
  return {
    key,
    start: `${key}T00:00:00.000Z`,
    end: new Date(Date.parse(`${key}T00:00:00.000Z`) + 86_400_000).toISOString(),
  };
}

export class CostGovernor {
  readonly policy: CostPolicy;

  constructor(
    private readonly db: Database,
    policy: CostPolicy = resolveCostPolicy(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.policy = policy;
  }

  reserveNextCall(workItem: WorkItem, agentRunId: string): CostPreflightDecision {
    const transaction = this.db.transaction(() => {
      this.db.query(`
        UPDATE agent_runs
        SET budget_reserved_tokens = 0, budget_reserved_usd_micros = 0
        WHERE id = ?
      `).run(agentRunId);

      const snapshot = this.getWorkItemSnapshot(workItem);
      if (!snapshot.override.active) {
        const blocked = snapshot.scopes.find((scope) =>
          scope.tokens_used + scope.tokens_reserved + this.policy.turnReserveTokens > scope.token_limit
          || (
            scope.usd_enforced
            && (scope.cost_usd ?? 0)
              + (scope.cost_usd_reserved ?? 0)
              + (estimateReservationCostUsd(this.policy) ?? 0) > scope.usd_limit
          )
        );
        if (blocked) {
          return {
            allowed: false,
            blocked_scope: blocked.scope,
            message: this.blockMessage(blocked),
            snapshot: this.getWorkItemSnapshot(workItem),
          } satisfies CostPreflightDecision;
        }
      }

      const reservationUsd = estimateReservationCostUsd(this.policy);
      this.db.query(`
        UPDATE agent_runs
        SET budget_reserved_tokens = ?, budget_reserved_usd_micros = ?
        WHERE id = ?
      `).run(
        this.policy.turnReserveTokens,
        Math.round((reservationUsd ?? 0) * 1_000_000),
        agentRunId,
      );
      return {
        allowed: true,
        blocked_scope: null,
        message: null,
        snapshot: this.getWorkItemSnapshot(workItem),
      } satisfies CostPreflightDecision;
    });

    return transaction.immediate();
  }

  recordUsage(agentRunId: string, usage: TaskTokenUsage): void {
    this.db.query(`
      UPDATE agent_runs
      SET input_tokens = ?,
          output_tokens = ?,
          total_tokens = ?,
          uncached_input_tokens = ?,
          cache_creation_input_tokens = ?,
          cache_read_input_tokens = ?,
          budget_reserved_tokens = 0,
          budget_reserved_usd_micros = 0
      WHERE id = ?
    `).run(
      nonNegative(usage.input),
      nonNegative(usage.output),
      Math.max(nonNegative(usage.total), nonNegative(usage.input) + nonNegative(usage.output)),
      nonNegative((usage as TaskTokenUsage & { uncached_input?: number }).uncached_input),
      nonNegative((usage as TaskTokenUsage & { cache_creation_input?: number }).cache_creation_input),
      nonNegative(usage.cache_read_input),
      agentRunId,
    );
  }

  releaseReservation(agentRunId: string): void {
    this.db.query(`
      UPDATE agent_runs
      SET budget_reserved_tokens = 0, budget_reserved_usd_micros = 0
      WHERE id = ?
    `).run(agentRunId);
  }

  /**
   * Reservations represent model calls that are live in the current primary
   * orchestrator process. Once a new process owns the leadership lease, any
   * reservation still stored in SQLite is crash residue.
   */
  releaseStaleReservations(): number {
    const result = this.db.query(`
      UPDATE agent_runs
      SET budget_reserved_tokens = 0, budget_reserved_usd_micros = 0
      WHERE budget_reserved_tokens <> 0 OR budget_reserved_usd_micros <> 0
    `).run();
    return result.changes;
  }

  approveOverride(workItemId: string, reason = 'Approved by Runtime operator'): CostBudgetOverride {
    const approvedAt = this.now();
    const expiresAt = new Date(approvedAt.getTime() + this.policy.overrideMinutes * 60_000);
    this.db.query(`
      INSERT INTO cost_budget_overrides (
        work_item_id, approved_at, expires_at, reason
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET
        approved_at = excluded.approved_at,
        expires_at = excluded.expires_at,
        reason = excluded.reason
    `).run(workItemId, approvedAt.toISOString(), expiresAt.toISOString(), reason);
    return this.getOverride(workItemId);
  }

  getWorkItemSnapshot(workItem: WorkItem): WorkItemCostSnapshot {
    const day = utcDay(this.now());
    const task = this.queryUsage('ar.work_item_id = ?', [workItem.id]);
    const repo = this.queryUsage(
      'wi.github_repo = ? AND ar.started_at >= ? AND ar.started_at < ?',
      [workItem.github_repo, day.start, day.end],
    );
    const daily = this.queryUsage(
      'ar.started_at >= ? AND ar.started_at < ?',
      [day.start, day.end],
    );
    const override = this.getOverride(workItem.id);
    const scopes = [
      this.buildScope('task', `Task ${workItem.linear_identifier}`, task, this.policy.maxTaskTokens, this.policy.maxTaskUsd),
      this.buildScope('repo_daily', `${workItem.github_repo} today`, repo, this.policy.maxRepoDailyTokens, this.policy.maxRepoDailyUsd),
      this.buildScope('daily', 'All repositories today', daily, this.policy.maxDailyTokens, this.policy.maxDailyUsd),
    ];
    return {
      generated_at: this.now().toISOString(),
      day_key: day.key,
      github_repo: workItem.github_repo,
      pricing_configured: isCostPricingConfigured(this.policy),
      max_turn_output_tokens: this.policy.maxTurnOutputTokens,
      max_turn_steps: this.policy.maxTurnSteps,
      turn_reserve_tokens: this.policy.turnReserveTokens,
      override,
      scopes,
      blocked_scopes: override.active
        ? []
        : scopes.filter((scope) => scope.blocked).map((scope) => scope.scope),
    };
  }

  getOverviewSnapshot(): CostOverviewSnapshot {
    const day = utcDay(this.now());
    const dailyUsage = this.queryUsage(
      'ar.started_at >= ? AND ar.started_at < ?',
      [day.start, day.end],
    );
    const repositories = this.db.query(`
      SELECT DISTINCT wi.github_repo AS github_repo
      FROM agent_runs ar
      JOIN work_items wi ON wi.id = ar.work_item_id
      WHERE ar.started_at >= ? AND ar.started_at < ?
      ORDER BY wi.github_repo ASC
    `).all(day.start, day.end) as Array<{ github_repo: string }>;
    return {
      generated_at: this.now().toISOString(),
      day_key: day.key,
      pricing_configured: isCostPricingConfigured(this.policy),
      daily: this.buildScope(
        'daily',
        'All repositories today',
        dailyUsage,
        this.policy.maxDailyTokens,
        this.policy.maxDailyUsd,
      ),
      repositories: repositories.map(({ github_repo }) => ({
        github_repo,
        budget: this.buildScope(
          'repo_daily',
          `${github_repo} today`,
          this.queryUsage(
            'wi.github_repo = ? AND ar.started_at >= ? AND ar.started_at < ?',
            [github_repo, day.start, day.end],
          ),
          this.policy.maxRepoDailyTokens,
          this.policy.maxRepoDailyUsd,
        ),
      })),
    };
  }

  private getOverride(workItemId: string): CostBudgetOverride {
    const row = this.db.query(`
      SELECT approved_at, expires_at, reason
      FROM cost_budget_overrides
      WHERE work_item_id = ?
    `).get(workItemId) as OverrideRow | null;
    const active = Boolean(row?.expires_at && Date.parse(row.expires_at) > this.now().getTime());
    return {
      active,
      approved_at: row?.approved_at ?? null,
      expires_at: row?.expires_at ?? null,
      reason: row?.reason ?? null,
    };
  }

  private queryUsage(where: string, params: Array<string | number>): UsageRow {
    return this.db.query(`
      SELECT
        COALESCE(SUM(ar.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(ar.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(ar.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(ar.cache_read_input_tokens), 0) AS cache_read_input_tokens,
        COALESCE(SUM(ar.budget_reserved_tokens), 0) AS reserved_tokens,
        COALESCE(SUM(ar.budget_reserved_usd_micros), 0) AS reserved_usd_micros
      FROM agent_runs ar
      JOIN work_items wi ON wi.id = ar.work_item_id
      WHERE ${where}
    `).get(...params) as UsageRow;
  }

  private buildScope(
    scope: CostBudgetScopeName,
    label: string,
    row: UsageRow,
    tokenLimit: number,
    usdLimit: number,
  ): CostBudgetScope {
    const tokensUsed = nonNegative(row.total_tokens);
    const tokensReserved = nonNegative(row.reserved_tokens);
    const cost = estimateTaskCostUsd({
      input: nonNegative(row.input_tokens),
      output: nonNegative(row.output_tokens),
      total: tokensUsed,
      cache_read_input: nonNegative(row.cache_read_input_tokens),
    }, this.policy);
    const usdReserved = isCostPricingConfigured(this.policy)
      ? nonNegative(row.reserved_usd_micros) / 1_000_000
      : null;
    const usdEnforced = cost !== null;
    const combinedCost = (cost ?? 0) + (usdReserved ?? 0);
    return {
      scope,
      label,
      tokens_used: tokensUsed,
      tokens_reserved: tokensReserved,
      token_limit: tokenLimit,
      token_remaining: Math.max(0, tokenLimit - tokensUsed - tokensReserved),
      token_utilization: tokenLimit > 0 ? (tokensUsed + tokensReserved) / tokenLimit : 1,
      cost_usd: cost === null ? null : roundUsd(cost),
      cost_usd_reserved: usdReserved === null ? null : roundUsd(usdReserved),
      usd_limit: usdLimit,
      usd_remaining: usdEnforced ? roundUsd(Math.max(0, usdLimit - combinedCost)) : null,
      usd_utilization: usdEnforced && usdLimit > 0 ? combinedCost / usdLimit : null,
      usd_enforced: usdEnforced,
      blocked: tokensUsed + tokensReserved >= tokenLimit
        || (usdEnforced && combinedCost >= usdLimit),
    };
  }

  private blockMessage(scope: CostBudgetScope): string {
    const reason = scope.tokens_used + scope.tokens_reserved + this.policy.turnReserveTokens > scope.token_limit
      ? `${scope.label} token budget would be exceeded`
      : `${scope.label} USD budget would be exceeded`;
    return `${reason}; operator approval is required before another model call.`;
  }
}
