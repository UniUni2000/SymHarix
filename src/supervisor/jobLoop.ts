import type {
  SupervisorMemoryRepository,
  SupervisorJobRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import type { SupervisorSessionRecord } from '../database/types';
import { logger } from '../logging';
import {
  SupervisorDevConversationService,
  type SupervisorDevDirective,
} from './devConversation';
import { isInternalSupervisorTurnBudgetFailure } from './milestoneVisibility';

const LOOP_ACTIVE_STATES = new Set([
  'materialized',
  'executing',
  'awaiting_user_decision',
]);

export interface SupervisorJobLoopResult {
  sessions_checked: number;
  superseded_sessions_cancelled: number;
  issues_synced: number;
  memories_written: number;
  jobs_enqueued: number;
  jobs_processed: number;
}

export interface SupervisorJobLoopOptions {
  runtime: RuntimeControlPlane;
  sessionRepository: SupervisorSessionRepository;
  eventRepository: SupervisorSessionEventRepository;
  memoryRepository: SupervisorMemoryRepository;
  jobRepository?: SupervisorJobRepository;
  devConversationService?: SupervisorDevConversationService;
  workerId?: string;
  now?: () => Date;
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
      return { sessions_checked: 0, superseded_sessions_cancelled: 0, issues_synced: 0, memories_written: 0, jobs_enqueued: 0, jobs_processed: 0 };
    }
    this.running = true;
    try {
      const supersededSessionsCancelled = this.cancelSupersededActiveSessions();
      let sessionsChecked = 0;
      let issuesSynced = 0;
      let memoriesWritten = 0;
      let jobsEnqueued = 0;
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
          const refreshedSession = this.options.sessionRepository.findById(session.id);
          if (!refreshedSession || refreshedSession.state === 'cancelled' || refreshedSession.state === 'completed') {
            continue;
          }
          if (this.enqueueIssueJobs(refreshedSession, issue)) {
            jobsEnqueued += 1;
          }
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

      const jobsProcessed = await this.processReadyJobs();

      return {
        sessions_checked: sessionsChecked,
        superseded_sessions_cancelled: supersededSessionsCancelled,
        issues_synced: issuesSynced,
        memories_written: memoriesWritten,
        jobs_enqueued: jobsEnqueued,
        jobs_processed: jobsProcessed,
      };
    } finally {
      this.running = false;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private cancelSupersededActiveSessions(): number {
    const byConversation = new Map<string, SupervisorSessionRecord[]>();
    for (const session of this.options.sessionRepository.findAll()) {
      if (!LOOP_ACTIVE_STATES.has(session.state)) {
        continue;
      }
      const key = `${session.transport}:${session.conversation_id}`;
      byConversation.set(key, [...(byConversation.get(key) ?? []), session]);
    }

    let cancelled = 0;
    for (const sessions of byConversation.values()) {
      const sorted = [...sessions].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      for (const session of sorted.slice(1)) {
        this.options.sessionRepository.update({
          id: session.id,
          state: 'cancelled',
          active_decision_kind: null,
          delivery_summary: '同一 Telegram 会话已有更新的计划线程，旧线程已自动收口。',
        });
        this.options.eventRepository.create({
          id: crypto.randomUUID(),
          session_id: session.id,
          event_kind: 'supervisor_session_superseded',
          payload_json: {
            reason: 'newer_active_session_in_same_conversation',
          },
        });
        cancelled += 1;
      }
    }
    return cancelled;
  }

  private enqueueIssueJobs(session: SupervisorSessionRecord, issue: RuntimeIssueView): boolean {
    if (!this.options.jobRepository) {
      return false;
    }
    const rootIssueId = issue.governance_root_issue_id ?? issue.issue_id;
    const internalDeliveryFailure = isInternalSupervisorTurnBudgetFailure({
      kind: issue.delivery_state,
      key: issue.delivery_code ?? issue.delivery_summary ?? '',
      summary: issue.delivery_summary,
      delivery_code: issue.delivery_code,
    });
    const cancelled = issue.orchestrator_state === 'cancelled' || /^(cancelled|canceled)$/i.test(issue.tracker_state || '');
    if (cancelled) {
      return false;
    }
    const completed = issue.orchestrator_state === 'completed' || issue.delivery_state === 'completed';
    const milestoneKind = completed
      ? 'completed'
      : (issue.delivery_state === 'delivery_failed' || issue.delivery_code) && !internalDeliveryFailure
        ? 'delivery_failed'
        : internalDeliveryFailure
          ? 'sync'
          : issue.orchestrator_state === 'failed'
            ? 'child_failed'
            : issue.orchestrator_state === 'retry_scheduled'
              ? 'retrying'
              : issue.governance_thread_state ?? issue.orchestrator_state ?? 'sync';
    const milestoneKey = [
      session.id,
      session.plan_version,
      rootIssueId,
      issue.issue_id,
      milestoneKind,
      issue.updated_at ?? '',
      issue.delivery_code ?? '',
    ].join('|');
    const shouldIssueDevInstruction = session.state !== 'awaiting_user_decision' && !internalDeliveryFailure;
    const userVisibleDeliveryFailure =
      !internalDeliveryFailure && (issue.delivery_state === 'delivery_failed' || Boolean(issue.delivery_code));
    const kinds = [
      ...(shouldIssueDevInstruction ? ['issue_dev_instruction' as const] : []),
      'sync_runtime_state',
      'assess_milestone',
      'verify_handoff',
      'summarize_memory',
      ...(session.active_decision_kind || userVisibleDeliveryFailure || issue.orchestrator_state === 'failed'
        ? ['notify_user' as const]
        : []),
    ] as const;
    let enqueued = false;
    for (const kind of kinds) {
      const idempotencyKey = `${milestoneKey}|${kind}`;
      const existing = this.options.jobRepository.findByIdempotencyKey(idempotencyKey);
      this.options.jobRepository.enqueue({
        session_id: session.id,
        root_issue_id: rootIssueId,
        job_kind: kind,
        idempotency_key: idempotencyKey,
        payload: {
          issue_id: issue.issue_id,
          issue_identifier: issue.identifier,
          milestone_kind: milestoneKind,
          milestone_key: milestoneKey,
        },
        run_after: this.now(),
      });
      if (!existing) {
        enqueued = true;
      }
    }
    return enqueued;
  }

  private async processReadyJobs(): Promise<number> {
    const jobs = this.options.jobRepository;
    const directives = this.options.devConversationService;
    if (!jobs || !directives) {
      return 0;
    }
    const job = jobs.leaseNextReady({
      now: this.now(),
      leaseOwner: this.options.workerId ?? 'supervisor-job-loop',
      leaseMs: 60_000,
    });
    if (!job) {
      return 0;
    }

    try {
      const session = this.options.sessionRepository.findById(job.session_id);
      if (!session) {
        jobs.fail(job.id, { error: 'session_not_found', now: this.now() });
        return 1;
      }
      const issueId = typeof job.payload?.issue_id === 'string'
        ? job.payload.issue_id
        : session.root_issue_id;
      const issue = issueId ? this.options.runtime.getIssue(issueId) : null;
      if (!issue) {
        jobs.fail(job.id, { error: 'issue_not_found', retryAt: new Date(this.now().getTime() + 30_000), now: this.now() });
        return 1;
      }

      if (job.job_kind === 'issue_dev_instruction' && session.state === 'awaiting_user_decision') {
        jobs.complete(job.id, {
          result: {
            skipped: true,
            reason: 'awaiting_user_decision',
          },
          now: this.now(),
        });
        return 1;
      }

      if (job.job_kind === 'issue_dev_instruction' && isInternalSupervisorTurnBudgetFailure({
        kind: issue.delivery_state,
        key: issue.delivery_code ?? issue.delivery_summary ?? '',
        summary: issue.delivery_summary,
        delivery_code: issue.delivery_code,
      })) {
        jobs.complete(job.id, {
          result: {
            skipped: true,
            reason: 'internal_delivery_milestone',
          },
          now: this.now(),
        });
        return 1;
      }

      if (job.job_kind === 'sync_runtime_state') {
        this.options.syncIssue(issue);
        this.options.eventRepository.create({
          id: crypto.randomUUID(),
          session_id: session.id,
          event_kind: 'supervisor_runtime_state_synced',
          payload_json: {
            job_id: job.id,
            issue_id: issue.issue_id,
            issue_identifier: issue.identifier,
            orchestrator_state: issue.orchestrator_state,
            delivery_state: issue.delivery_state,
          },
        });
        jobs.complete(job.id, {
          result: {
            issue_identifier: issue.identifier,
            orchestrator_state: issue.orchestrator_state,
            delivery_state: issue.delivery_state,
          },
          now: this.now(),
        });
        return 1;
      }

      if (job.job_kind === 'assess_milestone') {
        const milestoneKind = typeof job.payload?.milestone_kind === 'string'
          ? job.payload.milestone_kind
          : issue.orchestrator_state ?? 'sync';
        const internalDeliveryFailure = isInternalSupervisorTurnBudgetFailure({
          kind: issue.delivery_state,
          key: issue.delivery_code ?? issue.delivery_summary ?? '',
          summary: issue.delivery_summary,
          delivery_code: issue.delivery_code,
        });
        this.options.eventRepository.create({
          id: crypto.randomUUID(),
          session_id: session.id,
          event_kind: 'supervisor_milestone_assessed',
          payload_json: {
            job_id: job.id,
            issue_id: issue.issue_id,
            issue_identifier: issue.identifier,
            milestone_kind: milestoneKind,
            delivery_code: issue.delivery_code,
            next_recommended_action: issue.next_recommended_action,
          },
        });
        jobs.complete(job.id, {
          result: {
            milestone_kind: milestoneKind,
            needs_user: Boolean(
              session.active_decision_kind ||
              (!internalDeliveryFailure && (issue.delivery_state === 'delivery_failed' || Boolean(issue.delivery_code)))
            ),
          },
          now: this.now(),
        });
        return 1;
      }

      if (job.job_kind === 'notify_user') {
        const summary = [
          issue.delivery_summary,
          issue.next_recommended_action,
          session.active_decision_kind ? `等待用户决定：${session.active_decision_kind}` : null,
        ].filter(Boolean).join('\n') || `计划 ${session.plan_card?.title ?? issue.title} 有新的高信号状态。`;
        this.options.eventRepository.create({
          id: crypto.randomUUID(),
          session_id: session.id,
          event_kind: 'supervisor_user_notification_requested',
          payload_json: {
            job_id: job.id,
            issue_id: issue.issue_id,
            issue_identifier: issue.identifier,
            summary,
            active_decision_kind: session.active_decision_kind,
          },
        });
        this.options.sessionRepository.update({
          id: session.id,
          last_material_outcome: {
            ...(session.last_material_outcome ?? {}),
            pending_user_notification_job_id: job.id,
            pending_user_notification_summary: summary,
          },
        });
        jobs.complete(job.id, { result: { summary }, now: this.now() });
        return 1;
      }

      if (job.job_kind === 'verify_handoff') {
        const handoffReady = Boolean(
          issue.delivery_state === 'completed' ||
          issue.orchestrator_state === 'completed' ||
          issue.active_pr_number ||
          issue.branch_name,
        );
        this.options.eventRepository.create({
          id: crypto.randomUUID(),
          session_id: session.id,
          event_kind: 'supervisor_handoff_verified',
          payload_json: {
            job_id: job.id,
            issue_id: issue.issue_id,
            issue_identifier: issue.identifier,
            handoff_ready: handoffReady,
            branch_name: issue.branch_name,
            active_pr_number: issue.active_pr_number,
          },
        });
        jobs.complete(job.id, {
          result: {
            handoff_ready: handoffReady,
            branch_name: issue.branch_name,
            active_pr_number: issue.active_pr_number,
          },
          now: this.now(),
        });
        return 1;
      }

      if (job.job_kind === 'summarize_memory') {
        const repoRef = session.repo_ref ?? session.plan_card?.repo_ref ?? issue.github_repo;
        const summary = [
          issue.delivery_code ? `delivery_code=${issue.delivery_code}` : null,
          issue.delivery_summary,
          issue.last_review_decision ? `review=${issue.last_review_decision}` : null,
          session.plan_card?.title ? `plan=${session.plan_card.title}` : null,
        ].filter(Boolean).join(' · ') || `Supervisor observed ${issue.identifier}.`;
        this.options.memoryRepository.upsert({
          repo_ref: repoRef,
          memory_kind: issue.delivery_state === 'delivery_failed' || issue.delivery_code
            ? 'delivery_failure'
            : issue.delivery_state === 'completed' || issue.orchestrator_state === 'completed'
              ? 'execution_pattern'
              : 'execution_pattern',
          subject_key: `job:${job.id}:${issue.identifier}`,
          summary,
          evidence: {
            session_id: session.id,
            issue_id: issue.issue_id,
            issue_identifier: issue.identifier,
            job_id: job.id,
          },
          confidence: 0.7,
        });
        this.options.eventRepository.create({
          id: crypto.randomUUID(),
          session_id: session.id,
          event_kind: 'supervisor_memory_summarized',
          payload_json: {
            job_id: job.id,
            issue_id: issue.issue_id,
            issue_identifier: issue.identifier,
            summary,
          },
        });
        jobs.complete(job.id, { result: { summary }, now: this.now() });
        return 1;
      }

      const repoRef = session.repo_ref ?? session.plan_card?.repo_ref ?? issue.github_repo;
      const memories = repoRef ? this.options.memoryRepository.searchRelevant({
        repo_ref: repoRef,
        query: [
          session.plan_card?.title,
          issue.title,
          issue.delivery_code,
          issue.delivery_summary,
          issue.next_recommended_action,
        ].filter(Boolean).join(' '),
        limit: 6,
      }) : [];
      const directive = directives.buildDirective({
        session,
        issue,
        timeline: this.options.runtime.getTimeline(issue.issue_id),
        memories,
      });
      this.applyDirective(session, issue, directive, job.id);
      jobs.complete(job.id, {
        result: {
          directive_kind: directive.directive_kind,
          instruction: directive.instruction,
        },
        now: this.now(),
      });
      return 1;
    } catch (error) {
      jobs.fail(job.id, {
        error: error instanceof Error ? error.message : String(error),
        retryAt: new Date(this.now().getTime() + 60_000),
        now: this.now(),
      });
      return 1;
    }
  }

  private applyDirective(
    session: SupervisorSessionRecord,
    issue: RuntimeIssueView,
    directive: SupervisorDevDirective,
    jobId: string,
  ): void {
    this.options.eventRepository.create({
      id: crypto.randomUUID(),
      session_id: session.id,
      event_kind: 'supervisor_dev_directive',
      payload_json: {
        job_id: jobId,
        issue_id: issue.issue_id,
        issue_identifier: issue.identifier,
        directive_kind: directive.directive_kind,
        instruction: directive.instruction,
        required_evidence: directive.required_evidence,
        stop_conditions: directive.stop_conditions,
        memory_summaries: directive.memory_summaries,
      },
    });
    this.options.sessionRepository.update({
      id: session.id,
      active_decision_kind: directive.directive_kind === 'pause_for_user'
        ? 'execution_decision'
        : session.active_decision_kind,
      last_material_outcome: {
        ...(session.last_material_outcome ?? {}),
        latest_supervisor_job_id: jobId,
        latest_dev_directive_kind: directive.directive_kind,
        latest_dev_instruction: directive.instruction,
        latest_dev_required_evidence: directive.required_evidence,
        latest_dev_stop_conditions: directive.stop_conditions,
        latest_dev_directive_source: directive.source,
      },
    });
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
