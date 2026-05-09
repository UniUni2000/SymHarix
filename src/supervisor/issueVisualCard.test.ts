import { describe, expect, test } from 'bun:test';
import type { RuntimeIssueView } from '../runtime/types';
import { buildSupervisorIssueVisualCardSvg } from './issueVisualCard';

function issue(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-157',
    work_item_id: 'work-157',
    identifier: 'INT-157',
    title: '补充 README.md 项目文档',
    phase: 'DEV',
    tracker_state: 'Canceled',
    orchestrator_state: 'cancelled',
    workspace_path: '/tmp/workspaces/INT-157',
    branch_name: 'feature/int-157',
    github_repo: 'UniUni2000/test2',
    github_issue_number: 157,
    active_pr_number: null,
    session: null,
    governance_status: 'advisory',
    governance_decision: null,
    governance_summary: null,
    active_governance_suggestions: [],
    delivery_state: null,
    delivery_code: null,
    delivery_summary: '证据已满足，交付动作需要处理。',
    next_recommended_action: '等待终态交付动作完成。',
    actions: {
      can_stop: false,
      can_retry: false,
      can_override_governance: false,
      can_rewrite_governance: false,
      can_split_governance: false,
      can_open_pr: false,
    },
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:01:00.000Z',
    ...overrides,
  };
}

describe('issue visual cards', () => {
  test('renders direct issue cards with the same dark symphonyness card language as Telegram session cards', () => {
    const svg = buildSupervisorIssueVisualCardSvg(issue());

    expect(svg).toContain('symphonyness');
    expect(svg).toContain('Supervisor');
    expect(svg).toContain('Supervisor 判断');
    expect(svg).toContain('本次范围');
    expect(svg).toContain('验收标准');
    expect(svg).toContain('阶段进度');
    expect(svg).toContain('High Confidence');
    expect(svg).toContain('#071622');
    expect(svg).not.toContain('#F8FBFD');
    expect(svg).not.toContain('LATEST SIGNAL');
  });
});
