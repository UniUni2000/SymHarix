/**
 * Review Repository - handles review_history and audit_log tables
 */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';

export interface ReviewRecord {
  id: string;
  issue_id: string;
  round: number;
  decision: 'approve' | 'minor' | 'major' | 'tests' | 'reject';
  report_md: string;
  reviewer_comment?: string;
  created_at: string;
}

export interface AuditRecord {
  id: string;
  issue_id: string;
  action: string;
  agent_type?: string;
  details?: string;
  created_at: string;
}

export class ReviewRepository {
  constructor(private db: Database) {}

  saveReview(record: Omit<ReviewRecord, 'id' | 'created_at'>): ReviewRecord {
    const id = randomUUID();
    const created_at = new Date().toISOString();
    this.db.exec(
      `INSERT INTO review_history (id, issue_id, round, decision, report_md, reviewer_comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, record.issue_id, record.round, record.decision, record.report_md, record.reviewer_comment || null, created_at]
    );
    return { ...record, id, created_at };
  }

  getReviewsByIssueId(issueId: string): ReviewRecord[] {
    return this.db.query(
      `SELECT * FROM review_history WHERE issue_id = ? ORDER BY round ASC`
    ).all(issueId) as ReviewRecord[];
  }

  getLatestReview(issueId: string): ReviewRecord | null {
    return this.db.query(
      `SELECT * FROM review_history WHERE issue_id = ? ORDER BY round DESC LIMIT 1`
    ).get(issueId) as ReviewRecord | null;
  }

  saveAudit(record: Omit<AuditRecord, 'id' | 'created_at'>): AuditRecord {
    const id = randomUUID();
    const created_at = new Date().toISOString();
    this.db.exec(
      `INSERT INTO audit_log (id, issue_id, action, agent_type, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, record.issue_id, record.action, record.agent_type || null, record.details || null, created_at]
    );
    return { ...record, id, created_at };
  }

  getAuditLogs(issueId: string): AuditRecord[] {
    return this.db.query(
      `SELECT * FROM audit_log WHERE issue_id = ? ORDER BY created_at ASC`
    ).all(issueId) as AuditRecord[];
  }

  upsertIssueTracking(record: {
    id: string;
    identifier: string;
    state: string;
    complexity?: string;
    dev_attempts?: number;
    review_round?: number;
    last_review_decision?: string;
  }): void {
    const updated_at = new Date().toISOString();
    this.db.exec(
      `INSERT INTO issue_tracking (id, identifier, state, complexity, dev_attempts, review_round, last_review_decision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         complexity = excluded.complexity,
         dev_attempts = excluded.dev_attempts,
         review_round = excluded.review_round,
         last_review_decision = excluded.last_review_decision,
         updated_at = excluded.updated_at`,
      [
        record.id, record.identifier, record.state,
        record.complexity || null, record.dev_attempts || 0,
        record.review_round || 0, record.last_review_decision || null,
        updated_at, updated_at
      ]
    );
  }

  getIssueTracking(identifier: string): Record<string, unknown> | null {
    return this.db.query(
      `SELECT * FROM issue_tracking WHERE identifier = ?`
    ).get(identifier) as Record<string, unknown> | null;
  }
}