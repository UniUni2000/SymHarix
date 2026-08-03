import { describe, expect, test } from 'bun:test';
import type { RuntimeIssueView } from '../runtime/types';
import { buildIssueCardActionRows } from './issueCardActions';

function retryableIssue(deliveryCode: RuntimeIssueView['delivery_code']): RuntimeIssueView {
  return {
    issue_id: 'issue-1',
    work_item_id: 'work-item-1',
    identifier: 'SYM-52',
    title: '实现 weather_agent.py',
    phase: 'DEV',
    tracker_state: 'In Progress',
    orchestrator_state: 'halted',
    workspace_path: null,
    branch_name: 'feature/sym-52',
    github_repo: 'acme/repo',
    github_issue_number: null,
    active_pr_number: null,
    session: null,
    governance_status: null,
    governance_decision: null,
    governance_summary: null,
    active_governance_suggestions: [],
    delivery_state: 'delivery_failed',
    delivery_code: deliveryCode,
    delivery_summary: null,
    actions: {
      can_stop: false,
      can_retry: true,
      can_open_pr: false,
    },
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  };
}

describe('Runtime issue card actions', () => {
  test('marks a token-ceiling retry as a new budget-spending action', () => {
    const rows = buildIssueCardActionRows(retryableIssue('turn_token_ceiling_reached'));

    expect(rows[0]?.[0]).toMatchObject({
      label: '重新消耗预算并重试',
      style: 'danger',
      callback_data: 'rt|SYM-52|retry',
    });
  });

  test('keeps ordinary retries concise', () => {
    const rows = buildIssueCardActionRows(retryableIssue('merge_blocked'));

    expect(rows[0]?.[0]).toMatchObject({
      label: '重试',
      style: 'success',
    });
  });
});
