import { describe, expect, test } from 'bun:test';
import type { RuntimeIssueView } from '../runtime/types';
import {
  buildGovernanceCardKey,
  buildGovernanceBlockedMessage,
  buildGovernanceConfirmingMessage,
  buildGovernanceExecutingMessage,
  buildGovernanceFailedMessage,
  buildGovernanceResolvedMessage,
  buildGovernanceWaitingOnChildMessage,
} from './governanceCards';

function createGovernanceBlockedIssue(): RuntimeIssueView {
  return {
    issue_id: 'issue-1',
    work_item_id: 'wi-1',
    identifier: 'INT-37',
    title: '[GOVERNANCE] Clean up runtime',
    phase: 'DEV',
    tracker_state: 'In Progress',
    orchestrator_state: 'halted',
    workspace_path: null,
    branch_name: 'feature/int-37',
    github_repo: 'UniUni2000/test2',
    github_issue_number: 37,
    active_pr_number: null,
    session: null,
    governance_status: 'blocked',
    governance_decision: 'split_before_implement',
    governance_summary:
      'This issue spans multiple objectives across different parts of the system. Please split it before dispatch. Repo context (UniUni2000/test2): Recent repo history shows bots+runtime+server keeps recreating the same cross-surface path, so prefer consolidation or rewrite instead of another parallel path.',
    active_governance_suggestions: [
      {
        id: 'suggestion-1',
        suggestion_type: 'cleanup',
        status: 'pending',
        title: 'Clean up runtime surface',
        summary: 'Split runtime cleanup into a dedicated governance follow-up.',
        can_execute: true,
        can_dismiss: true,
      },
    ],
    actions: {
      can_stop: false,
      can_retry: false,
      can_override_governance: true,
      can_rewrite_governance: false,
      can_split_governance: true,
      can_open_pr: false,
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('governanceCards', () => {
  test('renders blocked cards as structured Telegram HTML with prioritized action rows', () => {
    const message = buildGovernanceBlockedMessage(createGovernanceBlockedIssue());

    expect(message.format).toBe('telegram_html');
    expect(message.text).toContain('<b>待你处理 · INT-37</b>');
    expect(message.text).toContain('这张单已被治理拦住，正在等你决定下一步');
    expect(message.text).toContain('<b>仓库</b>');
    expect(message.text).toContain('<b>当前建议</b>');
    expect(message.text).toContain('<b>为什么被拦</b>');
    expect(message.text).toContain('结论：');
    expect(message.text).toContain('Repo 原因：');
    expect(message.text).toContain('系统建议：');
    expect(message.text).toContain('也可以直接回复你的想法');
    expect(message.action_rows).toEqual([
      [{ label: '按方案拆成两个任务', callback_data: 'govsel|INT-37|1' }],
      [{ label: '强制继续开发', callback_data: 'govsel|INT-37|2', style: 'danger' }],
    ]);
  });

  test('renders confirming cards on the same Telegram card with clear confirmation buttons', () => {
    const message = buildGovernanceConfirmingMessage({
      issue: createGovernanceBlockedIssue(),
      actionLabel: '按方案拆成两个任务',
      confirmationSummary: '将根据当前建议把任务拆成两个更聚焦的 issue，再等待你确认后继续。',
    });

    expect(message.format).toBe('telegram_html');
    expect(message.text).toContain('<b>请确认 · INT-37</b>');
    expect(message.text).toContain('你即将执行下面的操作');
    expect(message.text).toContain('按方案拆成两个任务');
    expect(message.action_rows).toEqual([
      [{ label: '确认执行', callback_data: 'pending|confirm' }],
      [{ label: '返回上一步', callback_data: 'pending|cancel' }],
    ]);
  });

  test('renders resolved cards as HTML summaries without interactive buttons', () => {
    const message = buildGovernanceResolvedMessage(createGovernanceBlockedIssue(), {
      resultSummary: '已按你的选择提交治理动作，后续状态会继续同步到这里。',
    });

    expect(message.format).toBe('telegram_html');
    expect(message.text).toContain('<b>已处理 · INT-37</b>');
    expect(message.text).toContain('这张治理卡片已经处理完成');
    expect(message.text).toContain('已按你的选择提交治理动作');
    expect(message.action_rows ?? []).toHaveLength(0);
  });

  test('renders resolved cards in English for English supervisor issues', () => {
    const issue = createGovernanceBlockedIssue();
    issue.supervisor_locale = 'en';
    const message = buildGovernanceResolvedMessage(issue, {
      resultSummary: '已恢复自动执行，这张治理卡片已结束。',
    });

    expect(message.format).toBe('telegram_html');
    expect(message.text).toContain('<b>Processed · INT-37</b>');
    expect(message.text).toContain('This governance card has been processed');
    expect(message.text).toContain('<b>Repository</b>');
    expect(message.text).toContain('<b>Result</b>');
    expect(message.text).toContain('Automatic execution has resumed');
    expect(message.text).toContain('Current status: DEV · In Progress · halted');
    expect(message.text).not.toContain('已处理');
    expect(message.text).not.toContain('处理结果');
    expect(message.text).not.toContain('当前状态');
  });

  test('renders executing cards while Telegram governance actions are still running', () => {
    const message = buildGovernanceExecutingMessage(createGovernanceBlockedIssue(), {
      actionLabel: '按方案拆成两个任务',
    });

    expect(message.format).toBe('telegram_html');
    expect(message.text).toContain('<b>正在执行 · INT-37</b>');
    expect(message.text).toContain('Symphony 正在处理你的治理操作');
    expect(message.text).toContain('按方案拆成两个任务');
    expect(message.action_rows ?? []).toHaveLength(0);
  });

  test('renders waiting-on-child cards when the root issue is still blocked behind a governance child issue', () => {
    const issue = createGovernanceBlockedIssue();
    issue.governance_pause_reason = '源单当前暂停在 INT-38；完成这张子任务前不会放行后续 sibling。';
    issue.governance_expected_handoff = '处理完 INT-38 后，会自动接力 INT-39。';
    issue.governance_queued_child_identifiers = ['INT-39'];

    const message = buildGovernanceWaitingOnChildMessage(issue, {
      createdIssueIdentifiers: ['INT-38'],
      childSummaries: ['INT-38：先把 runtime cleanup 收成一个单独任务'],
      nextRecommendedAction: '先处理治理子任务 INT-38',
      userSummary: '已为 INT-37 创建治理子任务 INT-38，源单仍在等待这个子任务。',
    });

    expect(message.format).toBe('telegram_html');
    expect(message.text).toContain('<b>治理线程 · INT-37</b>');
    expect(message.text).toContain('当前先处理下面这张子任务');
    expect(message.text).toContain('INT-38');
    expect(message.text).toContain('源单仍暂停');
    expect(message.text).toContain('源单当前暂停在 INT-38');
    expect(message.text).toContain('处理完 INT-38 后，会自动接力 INT-39');
    expect(message.text).toContain('先处理治理子任务 INT-38');
    expect(message.action_rows ?? []).toHaveLength(0);
  });

  test('keeps the waiting-on-child card key stable across child retry churn', () => {
    const issue = createGovernanceBlockedIssue();
    issue.governance_thread_state = 'waiting_on_child';
    issue.next_recommended_action = '先处理治理子任务 INT-38';
    issue.governance_child_issues = [{
      issue_id: 'issue-2',
      issue_identifier: 'INT-38',
      title: '[GOVERNANCE FOLLOW-UP for INT-37] Runtime cleanup',
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      governance_decision: 'accept_with_rewrite',
      governance_summary: 'INT-38 still needs a rewrite before dispatch.',
    }];

    const initialKey = buildGovernanceCardKey(issue);

    issue.governance_child_issues = [{
      issue_id: 'issue-2',
      issue_identifier: 'INT-38',
      title: '[GOVERNANCE FOLLOW-UP for INT-37] Runtime cleanup',
      tracker_state: 'In Progress',
      orchestrator_state: 'retry_scheduled',
      governance_decision: 'accept',
      governance_summary: 'INT-38 is retrying after a failed attempt.',
    }];

    expect(buildGovernanceCardKey(issue)).toBe(initialKey);
  });

  test('updates the waiting-on-child card key when the structured pause reason changes materially', () => {
    const issue = createGovernanceBlockedIssue();
    issue.governance_thread_state = 'waiting_on_child';
    issue.next_recommended_action = '先处理治理子任务 INT-38';
    issue.governance_pause_reason = '源单当前暂停在 INT-38；完成这张子任务前不会放行后续 sibling。';
    issue.governance_expected_handoff = '处理完 INT-38 后，会自动接力 INT-39。';
    issue.governance_child_issues = [{
      issue_id: 'issue-2',
      issue_identifier: 'INT-38',
      title: '[GOVERNANCE FOLLOW-UP for INT-37] Runtime cleanup',
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      governance_decision: null,
      governance_summary: '等待处理。',
    }];

    const initialKey = buildGovernanceCardKey(issue);
    issue.governance_pause_reason = '源单当前暂停在 INT-38；这张子任务先要补完 review 交付。';

    expect(buildGovernanceCardKey(issue)).not.toBe(initialKey);
  });

  test('keeps the blocked card key stable when secondary suggestion text churns but the primary action stays the same', () => {
    const issue = createGovernanceBlockedIssue();
    const initialKey = buildGovernanceCardKey(issue);

    issue.active_governance_suggestions = [
      {
        id: 'suggestion-2',
        suggestion_type: 'consolidation',
        status: 'pending',
        title: 'Consolidate runtime and bot cleanup',
        summary: 'The same cross-surface change keeps reappearing and should be consolidated.',
        can_execute: true,
        can_dismiss: true,
      },
      {
        id: 'suggestion-3',
        suggestion_type: 'cleanup',
        status: 'pending',
        title: 'Clean up runtime surface',
        summary: 'Split runtime cleanup into a dedicated governance follow-up.',
        can_execute: true,
        can_dismiss: true,
      },
    ];

    expect(buildGovernanceCardKey(issue)).toBe(initialKey);
  });

  test('renders failed cards with a retry-friendly summary', () => {
    const message = buildGovernanceFailedMessage(createGovernanceBlockedIssue(), {
      resultSummary: '治理动作执行失败：Linear API 超时。',
    });

    expect(message.format).toBe('telegram_html');
    expect(message.text).toContain('<b>执行失败 · INT-37</b>');
    expect(message.text).toContain('Linear API 超时');
    expect(message.text).toContain('你可以稍后重试');
  });
});
