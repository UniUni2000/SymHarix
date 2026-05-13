import { describe, expect, test } from 'bun:test';
import { buildRuntimeMiniAppIssuePresentation } from '../runtime/miniAppPage';
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
  test('renders direct issue cards as Mini App-aligned Telegram status previews', () => {
    const svg = buildSupervisorIssueVisualCardSvg(issue({
      phase: 'REVIEW',
      tracker_state: 'In Progress',
      orchestrator_state: 'review_running',
      delivery_state: null,
      active_pr_number: 112,
      session: {
        session_id: 'session-157',
        turn_count: 3,
        stage: null,
        last_event: 'timeline',
        last_message: 'Review is checking delivery evidence.',
        started_at: '2026-05-08T00:00:00.000Z',
        last_event_at: '2026-05-08T00:03:00.000Z',
        tokens: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
        recent_tools: [],
        recent_files: [{
          path: '/tmp/workspaces/INT-157/README.md',
          operation: 'edit',
          status: 'completed',
          timestamp: '2026-05-08T00:03:00.000Z',
        }],
      },
    }));

    expect(svg).toContain('symphonyness');
    expect(svg).toContain('打开 Mini App');
    expect(svg).toContain('状态概览');
    expect(svg).toContain('Telegram 预览');
    expect(svg).toContain('实时进度');
    expect(svg).toContain('Review 进行中');
    expect(svg).toContain('Review 中');
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('PR #112');
    expect(svg).toContain('改了 README.md');
    expect(svg).toContain('#0B1016');
    expect(svg).not.toContain('阶段 · REVIEW 中');
    expect(svg).not.toContain('#F8FBFD');
    expect(svg).not.toContain('High Confidence');
  });

  test('renders English issue cards without Chinese labels when the issue locale is English', () => {
    const svg = buildSupervisorIssueVisualCardSvg(issue({
      supervisor_locale: 'en',
      title: 'smoke test',
      delivery_summary: null,
      next_recommended_action: null,
    }));

    expect(svg).toContain('Open Mini App');
    expect(svg).toContain('Status Overview');
    expect(svg).toContain('Telegram Preview');
    expect(svg).toContain('Live progress');
    expect(svg).toContain('Cancelled');
    expect(svg).not.toContain('STAGE · CANCELLED');
    expect(svg).not.toContain('状态概览');
    expect(svg).not.toContain('打开 Mini App');
    expect(svg).not.toContain('实时进度');
  });

  test('keeps completed progress labels from colliding with the live progress caption', () => {
    const svg = buildSupervisorIssueVisualCardSvg(issue({
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      active_pr_number: 112,
    }));

    expect(svg).toContain('100%');
    expect(svg).toContain('font-size="58"');
    expect(svg).toContain('x="252"');
  });

  test('keeps preview card progress aligned with the Mini App presentation', () => {
    const cases: Array<Partial<RuntimeIssueView>> = [
      {
        phase: 'DEV',
        tracker_state: 'Todo',
        orchestrator_state: 'mapping',
        delivery_state: null,
        session: null,
      },
      {
        phase: 'DEV',
        tracker_state: 'In Progress',
        orchestrator_state: 'dev_running',
        delivery_state: null,
        session: null,
      },
      {
        phase: 'REVIEW',
        tracker_state: 'In Progress',
        orchestrator_state: 'review_running',
        delivery_state: null,
        session: null,
      },
      {
        phase: 'DEV',
        tracker_state: 'In Progress',
        orchestrator_state: 'failed',
        delivery_state: 'delivery_failed',
        session: null,
        actions: {
          can_stop: false,
          can_retry: true,
          can_override_governance: false,
          can_rewrite_governance: false,
          can_split_governance: false,
          can_open_pr: false,
        },
      },
    ];

    for (const overrides of cases) {
      const view = issue(overrides);
      const expectedProgress = buildRuntimeMiniAppIssuePresentation(view).progress;
      const svg = buildSupervisorIssueVisualCardSvg(view);
      expect(svg).toContain(`>${expectedProgress}%</text>`);
    }
  });

  test('omits row detail when the latest signal wraps to two lines', () => {
    const svg = buildSupervisorIssueVisualCardSvg(issue({
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      active_pr_number: 117,
      branch_name: 'feature/int-166',
      github_repo: 'repo-overlap-check',
      delivery_summary: '## Review Decision: APPROVE ## Review Summary 已完整审查 PR #117 的所有变更，并确认交付证据已经闭环。',
    }));

    expect(svg).toContain('## Review Decision: APPROVE');
    expect(svg).not.toContain('repo-overlap-check');
  });
});
