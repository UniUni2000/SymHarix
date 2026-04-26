import type { Database } from 'bun:sqlite';
import type {
  CreateSupervisorSessionRecord,
  FindSupervisorSessionConversationKey,
  SupervisorPlanCard,
  SupervisorSessionRecord,
  UpdateSupervisorSessionRecord,
} from '../types';

const ACTIVE_SESSION_STATES = [
  'drafting',
  'clarifying',
  'plan_ready',
  'awaiting_user_approval',
  'approved_for_materialization',
  'materialized',
  'executing',
  'awaiting_user_decision',
] as const;

function parseJsonObject<T>(value: unknown): T | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export class SupervisorSessionRepository {
  constructor(private readonly db: Database) {}

  create(record: CreateSupervisorSessionRecord): SupervisorSessionRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO supervisor_sessions (
        id, transport, conversation_id, user_id, state, repo_ref, intake_mode, approval_mode,
        plan_card_json, plan_version, root_issue_id, root_work_item_id, current_child_issue_id,
        active_decision_kind, delivery_state, delivery_summary, last_material_outcome_json,
        last_message_id, last_card_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.id,
      record.transport,
      record.conversation_id,
      record.user_id ?? null,
      record.state,
      record.repo_ref ?? null,
      record.intake_mode ?? null,
      record.approval_mode ?? null,
      record.plan_card ? JSON.stringify(record.plan_card) : null,
      record.plan_version ?? 1,
      record.root_issue_id ?? null,
      record.root_work_item_id ?? null,
      record.current_child_issue_id ?? null,
      record.active_decision_kind ?? null,
      record.delivery_state ?? null,
      record.delivery_summary ?? null,
      record.last_material_outcome ? JSON.stringify(record.last_material_outcome) : null,
      record.last_message_id ?? null,
      record.last_card_key ?? null,
      now,
      now,
    );

    return this.findById(record.id)!;
  }

  findById(id: string): SupervisorSessionRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM supervisor_sessions WHERE id = ?`);
    return this.mapRow(stmt.get(id) as Record<string, unknown> | undefined);
  }

  findActiveByConversation(key: FindSupervisorSessionConversationKey): SupervisorSessionRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM supervisor_sessions
      WHERE transport = ? AND conversation_id = ? AND state IN (${ACTIVE_SESSION_STATES.map(() => '?').join(', ')})
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    return this.mapRow(
      stmt.get(key.transport, key.conversation_id, ...ACTIVE_SESSION_STATES) as Record<string, unknown> | undefined,
    );
  }

  findByConversationRootIssue(key: FindSupervisorSessionConversationKey & {
    root_issue_id: string;
  }): SupervisorSessionRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM supervisor_sessions
      WHERE transport = ? AND conversation_id = ? AND root_issue_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    return this.mapRow(
      stmt.get(key.transport, key.conversation_id, key.root_issue_id) as Record<string, unknown> | undefined,
    );
  }

  findByRootIssueId(rootIssueId: string): SupervisorSessionRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM supervisor_sessions
      WHERE root_issue_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    return this.mapRow(stmt.get(rootIssueId) as Record<string, unknown> | undefined);
  }

  findAll(): SupervisorSessionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM supervisor_sessions
      ORDER BY updated_at DESC, created_at DESC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((row): row is SupervisorSessionRecord => row !== null);
  }

  update(record: UpdateSupervisorSessionRecord): SupervisorSessionRecord | null {
    const fields: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];
    const assign = (field: string, value: unknown): void => {
      fields.push(`${field} = ?`);
      params.push(value);
    };

    if (record.user_id !== undefined) assign('user_id', record.user_id ?? null);
    if (record.state !== undefined) assign('state', record.state);
    if (record.repo_ref !== undefined) assign('repo_ref', record.repo_ref ?? null);
    if (record.intake_mode !== undefined) assign('intake_mode', record.intake_mode ?? null);
    if (record.approval_mode !== undefined) assign('approval_mode', record.approval_mode ?? null);
    if (record.plan_card !== undefined) assign('plan_card_json', record.plan_card ? JSON.stringify(record.plan_card) : null);
    if (record.plan_version !== undefined) assign('plan_version', record.plan_version);
    if (record.root_issue_id !== undefined) assign('root_issue_id', record.root_issue_id ?? null);
    if (record.root_work_item_id !== undefined) assign('root_work_item_id', record.root_work_item_id ?? null);
    if (record.current_child_issue_id !== undefined) assign('current_child_issue_id', record.current_child_issue_id ?? null);
    if (record.active_decision_kind !== undefined) assign('active_decision_kind', record.active_decision_kind ?? null);
    if (record.delivery_state !== undefined) assign('delivery_state', record.delivery_state ?? null);
    if (record.delivery_summary !== undefined) assign('delivery_summary', record.delivery_summary ?? null);
    if (record.last_material_outcome !== undefined) {
      assign(
        'last_material_outcome_json',
        record.last_material_outcome ? JSON.stringify(record.last_material_outcome) : null,
      );
    }
    if (record.last_message_id !== undefined) assign('last_message_id', record.last_message_id ?? null);
    if (record.last_card_key !== undefined) assign('last_card_key', record.last_card_key ?? null);

    params.push(record.id);
    const stmt = this.db.prepare(`
      UPDATE supervisor_sessions
      SET ${fields.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...params);
    return this.findById(record.id);
  }

  private mapRow(row: Record<string, unknown> | undefined): SupervisorSessionRecord | null {
    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      transport: row.transport as SupervisorSessionRecord['transport'],
      conversation_id: String(row.conversation_id),
      user_id: row.user_id as string | null,
      state: row.state as SupervisorSessionRecord['state'],
      repo_ref: row.repo_ref as string | null,
      intake_mode: (row.intake_mode as SupervisorSessionRecord['intake_mode']) ?? null,
      approval_mode: (row.approval_mode as SupervisorSessionRecord['approval_mode']) ?? null,
      plan_card: parseJsonObject<SupervisorPlanCard>(row.plan_card_json),
      plan_version: Number(row.plan_version ?? 1),
      root_issue_id: row.root_issue_id as string | null,
      root_work_item_id: row.root_work_item_id as string | null,
      current_child_issue_id: row.current_child_issue_id as string | null,
      active_decision_kind: (row.active_decision_kind as SupervisorSessionRecord['active_decision_kind']) ?? null,
      delivery_state: row.delivery_state as string | null,
      delivery_summary: row.delivery_summary as string | null,
      last_material_outcome: parseJsonObject<Record<string, unknown>>(row.last_material_outcome_json),
      last_message_id: row.last_message_id as string | null,
      last_card_key: row.last_card_key as string | null,
      created_at: new Date(String(row.created_at)),
      updated_at: new Date(String(row.updated_at)),
    };
  }
}
