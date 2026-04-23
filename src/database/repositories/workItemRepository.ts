/**
 * Work Item Repository - control-plane CRUD for work_items table
 */

import type { Database } from 'bun:sqlite';
import type { CreateWorkItem, UpdateWorkItem, WorkItem, WorkItemOrchestratorState } from '../types';

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class WorkItemRepository {
  constructor(private db: Database) {}

  create(item: CreateWorkItem): WorkItem {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO work_items (
        id, linear_issue_id, linear_identifier, linear_title, linear_state,
        github_repo, github_issue_number, active_pr_number, branch_name,
        workspace_path, workspace_key, orchestrator_state, dev_attempt_count,
        review_round, last_review_decision, last_review_summary,
        repo_harness_status, constitution_status, governance_status, governance_decision,
        governance_summary, governance_override_at, governance_override_reason, change_pack_summary_json,
        task_status_json, evidence_summary_json, missing_requirements_json, constitution_hits_json,
        touched_paths_json, touched_areas_json, path_families_json, boundary_edges_json, import_edges_json,
        architectural_target,
        fitness_signals_json, cancelled_at, merged_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      item.id,
      item.linear_issue_id,
      item.linear_identifier,
      item.linear_title,
      item.linear_state,
      item.github_repo,
      item.github_issue_number ?? null,
      item.active_pr_number ?? null,
      item.branch_name ?? null,
      item.workspace_path ?? null,
      item.workspace_key ?? null,
      item.orchestrator_state ?? 'discovering',
      item.dev_attempt_count ?? 0,
      item.review_round ?? 0,
      item.last_review_decision ?? null,
      item.last_review_summary ?? null,
      item.repo_harness_status ?? null,
      item.constitution_status ?? null,
      item.governance_status ?? null,
      item.governance_decision ?? null,
      item.governance_summary ?? null,
      item.governance_override_at?.toISOString() ?? null,
      item.governance_override_reason ?? null,
      JSON.stringify(item.change_pack_summary ?? null),
      JSON.stringify(item.task_status ?? null),
      JSON.stringify(item.evidence_summary ?? null),
      JSON.stringify(item.missing_requirements ?? []),
      JSON.stringify(item.constitution_hits ?? []),
      JSON.stringify(item.touched_paths ?? []),
      JSON.stringify(item.touched_areas ?? []),
      JSON.stringify(item.path_families ?? []),
      JSON.stringify(item.boundary_edges ?? []),
      JSON.stringify(item.import_edges ?? []),
      item.architectural_target ?? null,
      JSON.stringify(item.fitness_signals ?? []),
      item.cancelled_at?.toISOString() ?? null,
      item.merged_at?.toISOString() ?? null,
      now,
      now
    );

    return this.findById(item.id)!;
  }

  upsert(item: CreateWorkItem): WorkItem {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO work_items (
        id, linear_issue_id, linear_identifier, linear_title, linear_state,
        github_repo, github_issue_number, active_pr_number, branch_name,
        workspace_path, workspace_key, orchestrator_state, dev_attempt_count,
        review_round, last_review_decision, last_review_summary,
        repo_harness_status, constitution_status, governance_status, governance_decision,
        governance_summary, governance_override_at, governance_override_reason, change_pack_summary_json,
        task_status_json, evidence_summary_json, missing_requirements_json, constitution_hits_json,
        touched_paths_json, touched_areas_json, path_families_json, boundary_edges_json, import_edges_json,
        architectural_target,
        fitness_signals_json, cancelled_at, merged_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        linear_issue_id = excluded.linear_issue_id,
        linear_identifier = excluded.linear_identifier,
        linear_title = excluded.linear_title,
        linear_state = excluded.linear_state,
        github_repo = excluded.github_repo,
        github_issue_number = excluded.github_issue_number,
        active_pr_number = excluded.active_pr_number,
        branch_name = excluded.branch_name,
        workspace_path = excluded.workspace_path,
        workspace_key = excluded.workspace_key,
        orchestrator_state = excluded.orchestrator_state,
        dev_attempt_count = excluded.dev_attempt_count,
        review_round = excluded.review_round,
        last_review_decision = excluded.last_review_decision,
        last_review_summary = excluded.last_review_summary,
        repo_harness_status = excluded.repo_harness_status,
        constitution_status = excluded.constitution_status,
        governance_status = excluded.governance_status,
        governance_decision = excluded.governance_decision,
        governance_summary = excluded.governance_summary,
        governance_override_at = excluded.governance_override_at,
        governance_override_reason = excluded.governance_override_reason,
        change_pack_summary_json = excluded.change_pack_summary_json,
        task_status_json = excluded.task_status_json,
        evidence_summary_json = excluded.evidence_summary_json,
        missing_requirements_json = excluded.missing_requirements_json,
        constitution_hits_json = excluded.constitution_hits_json,
        touched_paths_json = excluded.touched_paths_json,
        touched_areas_json = excluded.touched_areas_json,
        path_families_json = excluded.path_families_json,
        boundary_edges_json = excluded.boundary_edges_json,
        import_edges_json = excluded.import_edges_json,
        architectural_target = excluded.architectural_target,
        fitness_signals_json = excluded.fitness_signals_json,
        cancelled_at = excluded.cancelled_at,
        merged_at = excluded.merged_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      item.id,
      item.linear_issue_id,
      item.linear_identifier,
      item.linear_title,
      item.linear_state,
      item.github_repo,
      item.github_issue_number ?? null,
      item.active_pr_number ?? null,
      item.branch_name ?? null,
      item.workspace_path ?? null,
      item.workspace_key ?? null,
      item.orchestrator_state ?? 'discovering',
      item.dev_attempt_count ?? 0,
      item.review_round ?? 0,
      item.last_review_decision ?? null,
      item.last_review_summary ?? null,
      item.repo_harness_status ?? null,
      item.constitution_status ?? null,
      item.governance_status ?? null,
      item.governance_decision ?? null,
      item.governance_summary ?? null,
      item.governance_override_at?.toISOString() ?? null,
      item.governance_override_reason ?? null,
      JSON.stringify(item.change_pack_summary ?? null),
      JSON.stringify(item.task_status ?? null),
      JSON.stringify(item.evidence_summary ?? null),
      JSON.stringify(item.missing_requirements ?? []),
      JSON.stringify(item.constitution_hits ?? []),
      JSON.stringify(item.touched_paths ?? []),
      JSON.stringify(item.touched_areas ?? []),
      JSON.stringify(item.path_families ?? []),
      JSON.stringify(item.boundary_edges ?? []),
      JSON.stringify(item.import_edges ?? []),
      item.architectural_target ?? null,
      JSON.stringify(item.fitness_signals ?? []),
      item.cancelled_at?.toISOString() ?? null,
      item.merged_at?.toISOString() ?? null,
      now,
      now
    );

    return this.findById(item.id)!;
  }

  findById(id: string): WorkItem | null {
    const stmt = this.db.prepare(`SELECT * FROM work_items WHERE id = ?`);
    return this.mapToWorkItem(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findByLinearIssueId(linearIssueId: string): WorkItem | null {
    const stmt = this.db.prepare(`SELECT * FROM work_items WHERE linear_issue_id = ?`);
    return this.mapToWorkItem(stmt.get(linearIssueId) as Record<string, unknown> | undefined);
  }

  findByIdentifier(identifier: string): WorkItem | null {
    const stmt = this.db.prepare(`SELECT * FROM work_items WHERE linear_identifier = ?`);
    return this.mapToWorkItem(stmt.get(identifier) as Record<string, unknown> | undefined);
  }

  findByGitHubIssue(repo: string, issueNumber: number): WorkItem | null {
    const stmt = this.db.prepare(`
      SELECT * FROM work_items WHERE github_repo = ? AND github_issue_number = ?
    `);
    return this.mapToWorkItem(stmt.get(repo, issueNumber) as Record<string, unknown> | undefined);
  }

  findByActivePullRequest(repo: string, prNumber: number): WorkItem | null {
    const stmt = this.db.prepare(`
      SELECT * FROM work_items WHERE github_repo = ? AND active_pr_number = ?
    `);
    return this.mapToWorkItem(stmt.get(repo, prNumber) as Record<string, unknown> | undefined);
  }

  findByBranchName(repo: string, branchName: string): WorkItem | null {
    const stmt = this.db.prepare(`
      SELECT * FROM work_items WHERE github_repo = ? AND branch_name = ?
    `);
    return this.mapToWorkItem(stmt.get(repo, branchName) as Record<string, unknown> | undefined);
  }

  findAll(): WorkItem[] {
    const stmt = this.db.prepare(`SELECT * FROM work_items ORDER BY updated_at DESC`);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => this.mapToWorkItem(row)).filter((item): item is WorkItem => item !== null);
  }

  findByOrchestratorState(state: WorkItemOrchestratorState): WorkItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM work_items WHERE orchestrator_state = ? ORDER BY updated_at DESC
    `);
    const rows = stmt.all(state) as Record<string, unknown>[];
    return rows.map(row => this.mapToWorkItem(row)).filter((item): item is WorkItem => item !== null);
  }

  update(item: UpdateWorkItem): WorkItem | null {
    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const params: Array<string | number | null> = [now];

    const assign = (field: string, value: string | number | null): void => {
      fields.push(`${field} = ?`);
      params.push(value);
    };

    if (item.linear_issue_id !== undefined) assign('linear_issue_id', item.linear_issue_id);
    if (item.linear_identifier !== undefined) assign('linear_identifier', item.linear_identifier);
    if (item.linear_title !== undefined) assign('linear_title', item.linear_title);
    if (item.linear_state !== undefined) assign('linear_state', item.linear_state);
    if (item.github_repo !== undefined) assign('github_repo', item.github_repo);
    if (item.github_issue_number !== undefined) assign('github_issue_number', item.github_issue_number);
    if (item.active_pr_number !== undefined) assign('active_pr_number', item.active_pr_number);
    if (item.branch_name !== undefined) assign('branch_name', item.branch_name);
    if (item.workspace_path !== undefined) assign('workspace_path', item.workspace_path);
    if (item.workspace_key !== undefined) assign('workspace_key', item.workspace_key);
    if (item.orchestrator_state !== undefined) assign('orchestrator_state', item.orchestrator_state);
    if (item.dev_attempt_count !== undefined) assign('dev_attempt_count', item.dev_attempt_count);
    if (item.review_round !== undefined) assign('review_round', item.review_round);
    if (item.last_review_decision !== undefined) assign('last_review_decision', item.last_review_decision);
    if (item.last_review_summary !== undefined) assign('last_review_summary', item.last_review_summary);
    if (item.repo_harness_status !== undefined) assign('repo_harness_status', item.repo_harness_status);
    if (item.constitution_status !== undefined) assign('constitution_status', item.constitution_status);
    if (item.governance_status !== undefined) assign('governance_status', item.governance_status);
    if (item.governance_decision !== undefined) assign('governance_decision', item.governance_decision);
    if (item.governance_summary !== undefined) assign('governance_summary', item.governance_summary);
    if (item.governance_override_at !== undefined) assign('governance_override_at', item.governance_override_at?.toISOString() ?? null);
    if (item.governance_override_reason !== undefined) assign('governance_override_reason', item.governance_override_reason);
    if (item.change_pack_summary !== undefined) assign('change_pack_summary_json', JSON.stringify(item.change_pack_summary));
    if (item.task_status !== undefined) assign('task_status_json', JSON.stringify(item.task_status));
    if (item.evidence_summary !== undefined) assign('evidence_summary_json', JSON.stringify(item.evidence_summary));
    if (item.missing_requirements !== undefined) assign('missing_requirements_json', JSON.stringify(item.missing_requirements));
    if (item.constitution_hits !== undefined) assign('constitution_hits_json', JSON.stringify(item.constitution_hits));
    if (item.touched_paths !== undefined) assign('touched_paths_json', JSON.stringify(item.touched_paths));
    if (item.touched_areas !== undefined) assign('touched_areas_json', JSON.stringify(item.touched_areas));
    if (item.path_families !== undefined) assign('path_families_json', JSON.stringify(item.path_families));
    if (item.boundary_edges !== undefined) assign('boundary_edges_json', JSON.stringify(item.boundary_edges));
    if (item.import_edges !== undefined) assign('import_edges_json', JSON.stringify(item.import_edges));
    if (item.architectural_target !== undefined) assign('architectural_target', item.architectural_target);
    if (item.fitness_signals !== undefined) assign('fitness_signals_json', JSON.stringify(item.fitness_signals));
    if (item.cancelled_at !== undefined) assign('cancelled_at', item.cancelled_at?.toISOString() ?? null);
    if (item.merged_at !== undefined) assign('merged_at', item.merged_at?.toISOString() ?? null);

    params.push(item.id);

    const stmt = this.db.prepare(`
      UPDATE work_items SET ${fields.join(', ')} WHERE id = ?
    `);
    stmt.run(...params);

    return this.findById(item.id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM work_items WHERE id = ?`);
    const result = stmt.run(id);
    return (result as { changes: number }).changes > 0;
  }

  private mapToWorkItem(row: Record<string, unknown> | undefined): WorkItem | null {
    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      linear_issue_id: row.linear_issue_id as string,
      linear_identifier: row.linear_identifier as string,
      linear_title: row.linear_title as string,
      linear_state: row.linear_state as string,
      github_repo: row.github_repo as string,
      github_issue_number: (row.github_issue_number as number | null) ?? null,
      active_pr_number: (row.active_pr_number as number | null) ?? null,
      branch_name: row.branch_name as string | null,
      workspace_path: row.workspace_path as string | null,
      workspace_key: row.workspace_key as string | null,
      orchestrator_state: row.orchestrator_state as WorkItemOrchestratorState,
      dev_attempt_count: (row.dev_attempt_count as number) ?? 0,
      review_round: (row.review_round as number) ?? 0,
      last_review_decision: row.last_review_decision as WorkItem['last_review_decision'],
      last_review_summary: row.last_review_summary as string | null,
      repo_harness_status: (row.repo_harness_status as WorkItem['repo_harness_status']) ?? null,
      constitution_status: (row.constitution_status as WorkItem['constitution_status']) ?? null,
      governance_status: (row.governance_status as WorkItem['governance_status']) ?? null,
      governance_decision: (row.governance_decision as WorkItem['governance_decision']) ?? null,
      governance_summary: row.governance_summary as string | null,
      governance_override_at: row.governance_override_at ? new Date(row.governance_override_at as string) : null,
      governance_override_reason: row.governance_override_reason as string | null,
      change_pack_summary: parseJsonValue(row.change_pack_summary_json, null),
      task_status: parseJsonValue(row.task_status_json, null),
      evidence_summary: parseJsonValue(row.evidence_summary_json, null),
      missing_requirements: parseJsonValue(row.missing_requirements_json, []),
      constitution_hits: parseJsonValue(row.constitution_hits_json, []),
      touched_paths: parseJsonValue(row.touched_paths_json, []),
      touched_areas: parseJsonValue(row.touched_areas_json, []),
      path_families: parseJsonValue(row.path_families_json, []),
      boundary_edges: parseJsonValue(row.boundary_edges_json, []),
      import_edges: parseJsonValue(row.import_edges_json, []),
      architectural_target: (row.architectural_target as string | null) ?? null,
      fitness_signals: parseJsonValue(row.fitness_signals_json, []),
      cancelled_at: row.cancelled_at ? new Date(row.cancelled_at as string) : null,
      merged_at: row.merged_at ? new Date(row.merged_at as string) : null,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }
}
