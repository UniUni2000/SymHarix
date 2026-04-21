/**
 * Agent Run Repository - CRUD for agent_runs table
 */

import type { Database } from 'bun:sqlite';
import type { AgentRun, CreateAgentRun, UpdateAgentRun } from '../types';

export class AgentRunRepository {
  constructor(private db: Database) {}

  create(run: CreateAgentRun): AgentRun {
    const startedAt = run.started_at?.toISOString() ?? new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO agent_runs (
        id, work_item_id, agent_type, phase, run_status,
        input_summary, output_summary, decision, error, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

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
    const params: Array<string | null> = [];

    const assign = (field: string, value: string | null): void => {
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
      started_at: new Date(row.started_at as string),
      finished_at: row.finished_at ? new Date(row.finished_at as string) : null,
    };
  }
}
