import type { Database } from 'bun:sqlite';
import type {
  RepoClaudeConversationKey,
  RepoClaudeConversationRecord,
  UpsertRepoClaudeConversationRecord,
} from '../types';

export class RepoClaudeConversationRepository {
  constructor(private readonly db: Database) {}

  upsert(record: UpsertRepoClaudeConversationRecord): RepoClaudeConversationRecord {
    const now = new Date().toISOString();
    const existing = this.findByConversationRepo(record);
    const clearGeneration = record.clear_generation ?? existing?.clear_generation ?? 0;
    this.db.prepare(`
      INSERT INTO repo_claude_conversations (
        transport, conversation_id, repo_ref, backend_session_id, status,
        clear_generation, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport, conversation_id, repo_ref) DO UPDATE SET
        backend_session_id = excluded.backend_session_id,
        status = excluded.status,
        clear_generation = excluded.clear_generation,
        last_used_at = excluded.last_used_at
    `).run(
      record.transport,
      record.conversation_id,
      record.repo_ref,
      record.backend_session_id ?? existing?.backend_session_id ?? null,
      record.status ?? 'active',
      clearGeneration,
      existing?.created_at.toISOString() ?? now,
      now,
    );
    return this.findByConversationRepo(record)!;
  }

  findByConversationRepo(key: RepoClaudeConversationKey): RepoClaudeConversationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM repo_claude_conversations
      WHERE transport = ? AND conversation_id = ? AND repo_ref = ?
    `).get(key.transport, key.conversation_id, key.repo_ref) as Record<string, unknown> | undefined;
    return this.map(row);
  }

  listByConversation(key: Omit<RepoClaudeConversationKey, 'repo_ref'>): RepoClaudeConversationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM repo_claude_conversations
      WHERE transport = ? AND conversation_id = ?
      ORDER BY last_used_at DESC, repo_ref ASC
    `).all(key.transport, key.conversation_id) as Record<string, unknown>[];
    return rows.map((row) => this.map(row)).filter((row): row is RepoClaudeConversationRecord => row !== null);
  }

  clearByConversationRepo(key: RepoClaudeConversationKey): number {
    const existing = this.findByConversationRepo(key);
    if (!existing) {
      return 0;
    }
    this.upsert({
      ...key,
      backend_session_id: null,
      status: 'cleared',
      clear_generation: existing.clear_generation + 1,
    });
    return 1;
  }

  clearByConversation(key: Omit<RepoClaudeConversationKey, 'repo_ref'>): number {
    const rows = this.listByConversation(key);
    for (const row of rows) {
      this.clearByConversationRepo({
        transport: row.transport,
        conversation_id: row.conversation_id,
        repo_ref: row.repo_ref,
      });
    }
    return rows.length;
  }

  private map(row: Record<string, unknown> | undefined): RepoClaudeConversationRecord | null {
    if (!row) {
      return null;
    }
    return {
      transport: row.transport as RepoClaudeConversationRecord['transport'],
      conversation_id: String(row.conversation_id),
      repo_ref: String(row.repo_ref),
      backend_session_id: row.backend_session_id as string | null,
      status: row.status as RepoClaudeConversationRecord['status'],
      clear_generation: Number(row.clear_generation ?? 0),
      created_at: new Date(String(row.created_at)),
      last_used_at: new Date(String(row.last_used_at)),
    };
  }
}
