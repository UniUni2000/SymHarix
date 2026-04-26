import type {
  SupervisorMemoryRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import type { SupervisorSessionRecord } from '../database/types';
import { logger } from '../logging';

const LOOP_ACTIVE_STATES = new Set([
  'materialized',
  'executing',
  'awaiting_user_decision',
]);

export interface SupervisorJobLoopResult {
  sessions_checked: number;
  issues_synced: number;
  memories_written: number;
}

export interface SupervisorJobLoopOptions {
  runtime: RuntimeControlPlane;
  sessionRepository: SupervisorSessionRepository;
  eventRepository: SupervisorSessionEventRepository;
  memoryRepository: SupervisorMemoryRepository;
  syncIssue: (issue: RuntimeIssueView) => void;
  intervalMs?: number;
}

function outcomeString(session: SupervisorSessionRecord, key: string): string | null {
  const value = session.last_material_outcome?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export class SupervisorJobLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly options: SupervisorJobLoopOptions) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const intervalMs = Math.max(5_000, this.options.intervalMs ?? 30_000);
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        logger.warn('Supervisor job loop tick failed', {}, error instanceof Error ? error : undefined);
      });
    }, intervalMs);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<SupervisorJobLoopResult> {
    if (this.running) {
      return { sessions_checked: 0, issues_synced: 0, memories_written: 0 };
    }
    this.running = true;
    try {
      let sessionsChecked = 0;
      let issuesSynced = 0;
      let memoriesWritten = 0;
      const sessions = this.options.sessionRepository.findAll()
        .filter((session) => LOOP_ACTIVE_STATES.has(session.state));

      for (const session of sessions) {
        sessionsChecked += 1;
        const issue = session.root_issue_id
          ? this.options.runtime.getIssue(session.root_issue_id)
          : null;
        if (issue) {
          this.options.syncIssue(issue);
          issuesSynced += 1;
        }
        this.options.eventRepository.create({
          id: crypto.randomUUID(),
          session_id: session.id,
          event_kind: 'supervisor_job_tick',
          payload_json: {
            root_issue_id: session.root_issue_id,
            issue_identifier: issue?.identifier ?? null,
            state: session.state,
          },
        });
        if (this.writeMemory(session, issue)) {
          memoriesWritten += 1;
        }
      }

      return {
        sessions_checked: sessionsChecked,
        issues_synced: issuesSynced,
        memories_written: memoriesWritten,
      };
    } finally {
      this.running = false;
    }
  }

  private writeMemory(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): boolean {
    const repoRef = session.repo_ref ?? session.plan_card?.repo_ref ?? issue?.github_repo;
    const oversightKey = outcomeString(session, 'oversight_key');
    const instruction = outcomeString(session, 'dev_instruction');
    const userSummary = outcomeString(session, 'user_summary');
    if (!repoRef || !oversightKey || (!instruction && !userSummary)) {
      return false;
    }
    this.options.memoryRepository.upsert({
      repo_ref: repoRef,
      memory_kind: issue?.delivery_state === 'delivery_failed' || session.delivery_state === 'delivery_failed'
        ? 'delivery_failure'
        : 'execution_pattern',
      subject_key: oversightKey,
      summary: instruction ?? userSummary ?? 'Supervisor oversight recorded.',
      evidence: {
        session_id: session.id,
        root_issue_id: session.root_issue_id,
        issue_identifier: issue?.identifier ?? null,
        supervisor_reason: outcomeString(session, 'supervisor_reason'),
        supervisor_decision: outcomeString(session, 'supervisor_decision'),
      },
      confidence: 0.75,
    });
    return true;
  }
}
