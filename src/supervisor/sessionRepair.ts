import type { SupervisorSessionRepository } from '../database/repositories/supervisorSessionRepository';
import type { RuntimeControlPlane } from '../runtime/types';

const ACTIVE_STATES = new Set([
  'drafting',
  'clarifying',
  'plan_ready',
  'awaiting_user_approval',
  'approved_for_materialization',
  'materialized',
  'executing',
  'awaiting_user_decision',
]);

export interface SupervisorSessionRepairSummary {
  stale_sessions_cancelled: number;
  superseded_sessions_cancelled: number;
  completed_sessions_closed: number;
}

export class SupervisorSessionRepairService {
  private readonly staleSessionMaxAgeMs: number;

  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly sessions: SupervisorSessionRepository,
    options: { staleSessionMaxAgeMs?: number | null } = {},
  ) {
    this.staleSessionMaxAgeMs = Math.max(60_000, options.staleSessionMaxAgeMs ?? 24 * 60 * 60_000);
  }

  repair(now: Date = new Date()): SupervisorSessionRepairSummary {
    let staleSessionsCancelled = 0;
    let supersededSessionsCancelled = 0;
    let completedSessionsClosed = 0;
    const nowMs = now.getTime();
    const activeByConversation = new Map<string, Array<ReturnType<SupervisorSessionRepository['findAll']>[number]>>();

    for (const session of this.sessions.findAll()) {
      if (!ACTIVE_STATES.has(session.state)) {
        continue;
      }
      const key = `${session.transport}:${session.conversation_id}`;
      activeByConversation.set(key, [...(activeByConversation.get(key) ?? []), session]);
    }

    const supersededSessionIds = new Set<string>();
    for (const sessions of activeByConversation.values()) {
      const sorted = [...sessions].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      for (const session of sorted.slice(1)) {
        supersededSessionIds.add(session.id);
      }
    }

    for (const session of this.sessions.findAll()) {
      if (!ACTIVE_STATES.has(session.state)) {
        continue;
      }

      if (supersededSessionIds.has(session.id)) {
        this.sessions.update({
          id: session.id,
          state: 'cancelled',
          active_decision_kind: null,
          delivery_summary: '同一 Telegram 会话已有更新的计划线程，旧线程已自动收口。',
        });
        supersededSessionsCancelled += 1;
        continue;
      }

      const rootIssue = session.root_issue_id ? this.runtime.getIssue(session.root_issue_id) : null;
      if (
        rootIssue &&
        (rootIssue.orchestrator_state === 'completed' || rootIssue.delivery_state === 'completed')
      ) {
        this.sessions.update({
          id: session.id,
          state: 'completed',
          active_decision_kind: null,
          delivery_state: rootIssue.delivery_state ?? session.delivery_state,
          delivery_summary: rootIssue.delivery_summary ?? session.delivery_summary,
        });
        completedSessionsClosed += 1;
        continue;
      }

      const ageMs = nowMs - session.updated_at.getTime();
      const isUnmaterialized = !session.root_issue_id;
      const isOrphanedRoot = Boolean(session.root_issue_id && !rootIssue);
      if (ageMs >= this.staleSessionMaxAgeMs && (isUnmaterialized || isOrphanedRoot)) {
        this.sessions.update({
          id: session.id,
          state: 'cancelled',
          active_decision_kind: null,
          delivery_summary: isUnmaterialized
            ? '历史计划线程已过期并自动收口。'
            : '历史计划线程对应的 root issue 已不存在，已自动收口。',
        });
        staleSessionsCancelled += 1;
      }
    }

    return {
      stale_sessions_cancelled: staleSessionsCancelled,
      superseded_sessions_cancelled: supersededSessionsCancelled,
      completed_sessions_closed: completedSessionsClosed,
    };
  }
}
