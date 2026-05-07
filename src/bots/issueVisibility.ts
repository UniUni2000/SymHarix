import type { RuntimeIssueView } from '../runtime/types';

export function isTerminalTrackerState(state: string | null | undefined): boolean {
  return /^(done|completed|cancelled|canceled|duplicate|closed)$/i.test(state || '');
}

export function isTerminalIssue(issue: RuntimeIssueView | null | undefined): boolean {
  if (!issue) {
    return false;
  }
  return isTerminalTrackerState(issue.tracker_state) ||
    /^(completed|cancelled|canceled)$/i.test(issue.orchestrator_state || '');
}

function isActiveSupervisorState(state: string | null | undefined): boolean {
  return Boolean(state && !/^(completed|cancelled|canceled)$/i.test(state));
}

export function isUserVisibleActiveIssue(issue: RuntimeIssueView): boolean {
  if (isTerminalIssue(issue)) {
    return false;
  }
  if (issue.actions.can_retry) {
    return true;
  }
  if (issue.actions.can_stop) {
    return true;
  }
  if (isActiveSupervisorState(issue.supervisor_session_state)) {
    return true;
  }
  if (issue.delivery_state === 'delivery_failed' && issue.delivery_code !== 'manual_stop') {
    return true;
  }
  return false;
}
