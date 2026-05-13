import type { RuntimeIssueView } from './types';

export function isRuntimeIssueCompleted(issue: RuntimeIssueView): boolean {
  return issue.delivery_state === 'completed' ||
    issue.orchestrator_state === 'completed' ||
    /^(done|completed)$/i.test(issue.tracker_state || '') ||
    issue.supervisor_session_state === 'completed';
}

export function isRuntimeIssueRetryableFailure(issue: RuntimeIssueView): boolean {
  return Boolean(
    issue.actions?.can_retry &&
    (issue.delivery_state === 'delivery_failed' || issue.delivery_code || issue.orchestrator_state === 'failed'),
  );
}

export function runtimeIssueBaseProgress(issue: RuntimeIssueView): number {
  if (isRuntimeIssueCompleted(issue)) {
    return 100;
  }
  if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
    return 72;
  }
  if (issue.session || issue.orchestrator_state === 'dev_running') {
    return 42;
  }
  if (issue.governance_thread_state === 'waiting_on_child') {
    return 34;
  }
  return 18;
}

export function runtimeIssueProgressValue(issue: RuntimeIssueView): number {
  const progress = runtimeIssueBaseProgress(issue);
  return isRuntimeIssueRetryableFailure(issue) ? Math.max(progress, 82) : progress;
}
