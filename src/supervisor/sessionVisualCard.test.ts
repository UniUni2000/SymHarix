import { describe, expect, test } from 'bun:test';
import type { SupervisorSessionRecord } from '../database/types';
import type { RuntimeIssueView } from '../runtime/types';
import type { SupervisorMilestone } from './types';
import {
  buildSupervisorMilestoneSummaryCard,
  buildSupervisorSessionVisualCard,
  buildSupervisorSessionVisualCardSvg,
} from './sessionVisualCard';

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  return {
    width: new DataView(bytes.buffer, bytes.byteOffset + 16, 4).getUint32(0),
    height: new DataView(bytes.buffer, bytes.byteOffset + 20, 4).getUint32(0),
  };
}

function createSession(overrides: Partial<SupervisorSessionRecord> = {}): SupervisorSessionRecord {
  return {
    id: 'session-visual',
    transport: 'telegram',
    conversation_id: 'chat-1',
    user_id: 'user-1',
    state: 'executing',
    repo_ref: 'acme/repo',
    intake_mode: 'plan_then_approve',
    approval_mode: 'explicit_user_approval',
    plan_version: 2,
    root_issue_id: 'issue-root',
    root_work_item_id: 'work-root',
    current_child_issue_id: null,
    active_decision_kind: null,
    delivery_state: null,
    delivery_summary: null,
    last_message_id: 'msg-root',
    last_card_key: 'session|old',
    last_material_outcome: {
      round_index: 2,
      round_total: 4,
      round_goal: 'Close the review feedback and prepare delivery evidence.',
      risk_delta: 'Risk down after review blockers were reduced.',
    },
    plan_card: {
      title: 'Operator cockpit rollout',
      user_goal: 'Ship the Telegram operator cockpit.',
      in_scope: ['Visual cards', 'Mini App cockpit'],
      out_of_scope: ['Core orchestrator semantics'],
      acceptance: ['Root card updates', 'Milestone cards are sent separately'],
      known_risks: ['Telegram media editing can fail and must fall back cleanly.'],
      execution_strategy: 'Run the plan in rounds and summarize key milestones.',
      needs_user_approval: true,
      repo_ref: 'acme/repo',
      project_slug: 'demo',
      clarification_question: null,
      materialization_mode: 'root_with_split_queue',
      recommended_option: {
        label: 'Approve',
        summary: 'Proceed with the cockpit rollout.',
      },
      alternate_option: null,
      governance_preview: null,
    },
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:05:00.000Z'),
    ...overrides,
  };
}

function createIssue(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-root',
    work_item_id: 'work-root',
    identifier: 'INT-248',
    title: 'Operator cockpit rollout',
    phase: 'DEV',
    tracker_state: 'In Progress',
    orchestrator_state: 'dev_running',
    workspace_path: null,
    branch_name: 'feature/cockpit',
    github_repo: 'acme/repo',
    github_issue_number: null,
    active_pr_number: null,
    session: null,
    governance_status: null,
    governance_decision: null,
    governance_summary: null,
    governance_root_issue_id: 'issue-root',
    governance_root_issue_identifier: 'INT-248',
    governance_child_issues: [],
    governance_current_child: null,
    governance_child_queue: [],
    next_recommended_action: 'Run the review pass and attach evidence.',
    delivery_state: null,
    delivery_code: null,
    delivery_summary: null,
    active_governance_suggestions: [],
    actions: {
      can_stop: true,
      can_retry: false,
      can_open_pr: false,
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:05:00.000Z',
    ...overrides,
  };
}

describe('session visual cards', () => {
  test('renders large Telegram root cards that carry the plan summary in the image', () => {
    const session = createSession({
      state: 'awaiting_user_approval',
    });
    const issue = createIssue({
      identifier: 'INT-142',
      title: 'Production Ready 计划',
      github_repo: 'acme/demo-app',
    });

    const card = buildSupervisorSessionVisualCard(session, issue, 'session|visual-v6');

    expect(card).not.toBeNull();
    expect(card?.media_key).toBe('visual|session|visual-v6');
    expect(card?.caption).toContain('INT-142');
    expect(card?.photo.content_type).toBe('image/png');
    expect(card?.photo.filename).toBe('INT-142-supervisor-card.png');
    expect(card?.photo.bytes.length).toBeGreaterThan(1000);
    expect(card?.caption.length).toBeLessThan(140);
    expect(pngSize(card!.photo.bytes)).toEqual({ width: 1080, height: 1080 });
  });

  test('uses a clean Plan Card identity before the root issue exists', () => {
    const session = createSession({
      root_issue_id: null,
      root_work_item_id: null,
      state: 'awaiting_user_approval',
      plan_card: {
        ...createSession().plan_card!,
        title: '删除 docs 文件夹',
        user_goal: '删除 docs 文件夹',
        materialization_mode: 'root_only',
      },
    });

    const card = buildSupervisorSessionVisualCard(session, null, 'session|preissue');

    expect(card).not.toBeNull();
    expect(card?.caption).toContain('Plan Card · 删除 docs 文件夹');
    expect(card?.caption).not.toContain('session-visual');
    expect(card?.photo.filename).toBe('Plan-Card-supervisor-card.png');
  });

  test('promotes live delivery blockers into the Telegram card summary', () => {
    const session = createSession({
      state: 'awaiting_user_decision',
      active_decision_kind: 'delivery_failure',
      delivery_state: 'delivery_failed',
      delivery_summary: '证据已满足，但交付卡在 Command failed with code 1。',
      last_material_outcome: {
        pending_user_notification_summary: '证据已满足，但交付卡在 Command failed with code 1。',
        milestone_kind: 'delivery_failed',
      },
    });
    const issue = createIssue({
      delivery_state: 'delivery_failed',
      orchestrator_state: 'failed',
      delivery_summary: '证据已满足，但交付卡在 Command failed with code 1。',
    });

    const card = buildSupervisorSessionVisualCard(session, issue, 'session|blocked');

    expect(card).not.toBeNull();
    expect(card?.caption).toContain('需要决策');
    expect(card?.photo.bytes.length).toBeGreaterThan(1000);
    expect(pngSize(card!.photo.bytes)).toEqual({ width: 1080, height: 1080 });
  });

  test('renders completed Telegram card progress checkpoints in green', () => {
    const session = createSession({
      state: 'completed',
      delivery_state: 'completed',
      delivery_summary: 'Issue completed.',
    });
    const issue = createIssue({
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      delivery_summary: 'Issue completed.',
    });

    const svg = buildSupervisorSessionVisualCardSvg(session, issue);

    expect(svg.match(/fill="#55E49D" stroke="#55E49D"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(svg).not.toContain('stroke="#57B8FF"');
    expect(svg).not.toContain('fill="#183851"');
  });

  test('renders stable Telegram milestone summary cards with round, risk, result, and next goal', () => {
    const session = createSession();
    const issue = createIssue();
    const milestone: SupervisorMilestone = {
      kind: 'completed',
      key: 'completed|issue-root|2026-01-01T00:05:00.000Z',
      issue_id: 'issue-root',
      issue_identifier: 'INT-248',
      summary: 'Review completed and delivery evidence is ready.',
      delivery_state: 'completed',
      delivery_code: null,
      governance_thread_state: null,
      current_child_issue_id: null,
    };

    const first = buildSupervisorMilestoneSummaryCard(session, issue, milestone, 'milestone|session|1');
    const second = buildSupervisorMilestoneSummaryCard(session, issue, milestone, 'milestone|session|1');

    expect(first.media_key).toBe(second.media_key);
    expect(first.media_key).toBe('milestone_summary|milestone|session|1');
    expect(first.caption).toContain('INT-248');
    expect(first.caption).toContain('Round 2/4');
    expect(first.caption).toContain('Risk down');
    expect(first.photo.content_type).toBe('image/png');
    expect(first.photo.filename).toBe('INT-248-milestone-summary.png');
    expect(first.photo.bytes?.length).toBeGreaterThan(1000);
  });
});
