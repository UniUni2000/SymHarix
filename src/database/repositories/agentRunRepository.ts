/**
 * Agent Run Repository - CRUD for agent_runs table
 */

import type { Database } from 'bun:sqlite';
import type { AgentRun, CreateAgentRun, UpdateAgentRun } from '../types';

export class AgentRunRepository {
  constructor(private db: Database) {}

  private tokenNumber(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.trunc(value))
      : 0;
  }

  create(run: CreateAgentRun): AgentRun {
    const startedAt = run.started_at?.toISOString() ?? new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO agent_runs (
        id, work_item_id, agent_type, phase, run_status,
        input_summary, output_summary, decision, error,
        input_tokens, output_tokens, total_tokens,
        uncached_input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const inputTokens = this.tokenNumber(run.input_tokens);
    const outputTokens = this.tokenNumber(run.output_tokens);
    const totalTokens = Math.max(this.tokenNumber(run.total_tokens), inputTokens + outputTokens);
    stmt.run(
      run.id,
      run.work_item_id,
      run.agent_type,
      run.phase,
      run.run_status ?? 'running',
      run.input_summary ?? null,
      run.output_summary ?? null,
      run.decision ?? null,
      run.error ?? null,
      inputTokens,
      outputTokens,
      totalTokens,
      this.tokenNumber(run.uncached_input_tokens),
      this.tokenNumber(run.cache_creation_input_tokens),
      this.tokenNumber(run.cache_read_input_tokens),
      startedAt,
      run.finished_at?.toISOString() ?? null
    );

    return this.findById(run.id)!;
  }

  findById(id: string): AgentRun | null {
    const stmt = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`);
    return this.mapToAgentRun(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findByWorkItemId(workItemId: string): AgentRun[] {
    const stmt = this.db.prepare(`
      SELECT * FROM agent_runs WHERE work_item_id = ? ORDER BY started_at ASC, id ASC
    `);
    const rows = stmt.all(workItemId) as Record<string, unknown>[];
    return rows.map(row => this.mapToAgentRun(row)).filter((item): item is AgentRun => item !== null);
  }

  update(run: UpdateAgentRun): AgentRun | null {
    const fields: string[] = [];
    const params: Array<string | number | null> = [];

    const assign = (field: string, value: string | number | null): void => {
      fields.push(`${field} = ?`);
      params.push(value);
    };

    if (run.agent_type !== undefined) assign('agent_type', run.agent_type);
    if (run.phase !== undefined) assign('phase', run.phase);
    if (run.run_status !== undefined) assign('run_status', run.run_status);
    if (run.input_summary !== undefined) assign('input_summary', run.input_summary);
    if (run.output_summary !== undefined) assign('output_summary', run.output_summary);
    if (run.decision !== undefined) assign('decision', run.decision);
    if (run.error !== undefined) assign('error', run.error);
    if (run.input_tokens !== undefined) assign('input_tokens', this.tokenNumber(run.input_tokens));
    if (run.output_tokens !== undefined) assign('output_tokens', this.tokenNumber(run.output_tokens));
    if (run.total_tokens !== undefined) assign('total_tokens', this.tokenNumber(run.total_tokens));
    if (run.uncached_input_tokens !== undefined) assign('uncached_input_tokens', this.tokenNumber(run.uncached_input_tokens));
    if (run.cache_creation_input_tokens !== undefined) assign('cache_creation_input_tokens', this.tokenNumber(run.cache_creation_input_tokens));
    if (run.cache_read_input_tokens !== undefined) assign('cache_read_input_tokens', this.tokenNumber(run.cache_read_input_tokens));
    if (run.started_at !== undefined) assign('started_at', run.started_at.toISOString());
    if (run.finished_at !== undefined) assign('finished_at', run.finished_at?.toISOString() ?? null);

    if (fields.length === 0) {
      return this.findById(run.id);
    }

    params.push(run.id);
    const stmt = this.db.prepare(`UPDATE agent_runs SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...params);
    return this.findById(run.id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM agent_runs WHERE id = ?`);
    const result = stmt.run(id);
    return (result as { changes: number }).changes > 0;
  }

  private mapToAgentRun(row: Record<string, unknown> | undefined): AgentRun | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      work_item_id: row.work_item_id as string,
      agent_type: row.agent_type as AgentRun['agent_type'],
      phase: row.phase as string,
      run_status: row.run_status as AgentRun['run_status'],
      input_summary: row.input_summary as string | null,
      output_summary: row.output_summary as string | null,
      decision: row.decision as string | null,
      error: row.error as string | null,
      input_tokens: this.tokenNumber(row.input_tokens as number | null | undefined),
      output_tokens: this.tokenNumber(row.output_tokens as number | null | undefined),
      total_tokens: this.tokenNumber(row.total_tokens as number | null | undefined),
      uncached_input_tokens: this.tokenNumber(row.uncached_input_tokens as number | null | undefined),
      cache_creation_input_tokens: this.tokenNumber(row.cache_creation_input_tokens as number | null | undefined),
      cache_read_input_tokens: this.tokenNumber(row.cache_read_input_tokens as number | null | undefined),
      started_at: new Date(row.started_at as string),
      finished_at: row.finished_at ? new Date(row.finished_at as string) : null,
    };
  }
}
