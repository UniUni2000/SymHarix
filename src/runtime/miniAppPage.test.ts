import { describe, expect, test } from 'bun:test';
import type { RuntimeIssueView } from './types';
import {
  buildRuntimeMiniAppActivityFeed,
  buildRuntimeMiniAppDiffFiles,
  buildRuntimeMiniAppIssuePresentation,
  renderRuntimeMiniAppPage,
  visibleRuntimeMiniAppMilestones,
} from './miniAppPage';

function createIssue(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-143',
    work_item_id: 'work-143',
    identifier: 'INT-143',
    title: 'E2E 删除 docs 文件夹',
    phase: 'REVIEW',
    tracker_state: 'In Review',
    orchestrator_state: 'review_running',
    workspace_path: null,
    branch_name: 'feature/int-143',
    github_repo: 'UniUni2000/test2',
    github_issue_number: 84,
    active_pr_number: 85,
    session: null,
    governance_status: null,
    governance_decision: null,
    governance_summary: null,
    governance_root_issue_id: 'issue-143',
    governance_root_issue_identifier: 'INT-143',
    governance_child_issues: [],
    governance_current_child: null,
    governance_child_queue: [],
    next_recommended_action: '继续完善 harness，确保测试通过，准备 HANDOVER 与 PR。',
    delivery_state: null,
    delivery_code: null,
    delivery_summary: null,
    active_governance_suggestions: [],
    actions: {
      can_stop: true,
      can_retry: false,
      can_open_pr: true,
    },
    created_at: '2026-05-04T04:14:21.969Z',
    updated_at: '2026-05-04T04:26:30.587Z',
    ...overrides,
  };
}

describe('Telegram Mini App issue presentation', () => {
  test('treats completed delivery as the highest-priority issue fact', () => {
    const presentation = buildRuntimeMiniAppIssuePresentation(createIssue({
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      delivery_summary: 'Review 批准：docs 文件夹已安全删除，路径验证通过，Git 提交成功。',
      milestones: [
        {
          kind: 'delivery_failed',
          key: 'delivery_failed|issue-143|supervisor_turn_budget_exhausted||halted',
          summary: 'supervisor_turn_budget_exhausted',
          timestamp: '2026-05-04T04:24:01.817Z',
        },
      ],
    }));

    expect(presentation.progress).toBe(100);
    expect(presentation.stateLabel).toBe('Completed');
    expect(presentation.nextRecommendation).toContain('已完成');
    expect(presentation.reviewStatus).toBe('完成');
    expect(presentation.visibleMilestones.map((item) => item.kind)).not.toContain('delivery_failed');
  });

  test('hides supervisor turn-budget delivery failures from user-facing milestones', () => {
    const milestones = visibleRuntimeMiniAppMilestones(createIssue({
      milestones: [
        {
          kind: 'delivery_failed',
          key: 'delivery_failed|issue-143|supervisor_turn_budget_exhausted||halted',
          summary: 'supervisor_turn_budget_exhausted',
          timestamp: '2026-05-04T04:21:38.058Z',
        },
        {
          kind: 'proof_satisfied',
          key: 'delivery:issue-143:proof_satisfied:',
          summary: '证据已满足，正在等待最终交付动作完成。',
          timestamp: '2026-05-04T04:19:21.988Z',
        },
      ],
    }));

    expect(milestones.map((milestone) => milestone.kind)).toEqual(['proof_satisfied']);
  });

  test('builds a compact Codex-like activity feed from recent tools and files', () => {
    const issue = createIssue({
      orchestrator_state: 'dev_running',
      phase: 'DEV',
      session: {
        session_id: 'session-143',
        turn_count: 3,
        stage: 'coding',
        last_event: 'tool.completed',
        last_message: '正在删除 docs 目录并运行验证。',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:18:00.000Z',
        tokens: {
          input_tokens: 1200,
          output_tokens: 480,
          total_tokens: 1680,
        },
        recent_tools: [
          {
            tool_name: 'Read',
            status: 'completed',
            message: 'Read docs/CONFIGURATION.md',
            summary: '读取配置文档确认 docs 目录用途',
            path: 'docs/CONFIGURATION.md',
            timestamp: '2026-05-04T04:16:00.000Z',
          },
          {
            tool_name: 'Bash',
            status: 'started',
            message: 'cat > "/Users/example/projects/symharix/workspaces/uniuni2000__test2/worktrees/INT-149/.symphony/state.json" << EOF',
            summary: '删除 docs 后运行测试',
            path: null,
            timestamp: '2026-05-04T04:17:00.000Z',
          },
        ],
        recent_files: [
          {
            path: 'src/runtime/miniAppPage.ts',
            operation: 'edit',
            status: 'completed',
            timestamp: '2026-05-04T04:17:20.000Z',
          },
        ],
      },
    });

    const feed = buildRuntimeMiniAppActivityFeed(issue);

    expect(feed.map((item) => item.label)).toEqual(['Bash', 'Edit', 'Read']);
    expect(feed[0]?.summary).toBe('写入 state.json');
    expect(feed[0]?.summary).not.toContain('/Users/example');
    expect(feed[1]?.summary).toContain('miniAppPage.ts');
    expect(feed[1]?.detail).toBe('编辑 · src/runtime');
    expect(feed.every((item) => item.timestamp)).toBe(true);
  });

  test('switches completed issues to a closed delivery summary mode', () => {
    const presentation = buildRuntimeMiniAppIssuePresentation(createIssue({
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      delivery_summary: '已删除 docs 目录，测试通过，PR #85 已合并。',
    }));

    expect(presentation.mode).toBe('completed');
    expect(presentation.liveBadgeLabel).toBe('Final');
    expect(presentation.timelineTitle).toBe('交付总结');
    expect(presentation.activityFeed[0]?.label).toBe('Closed');
    expect(presentation.emptyChildQueueLabel).toContain('单 issue');
  });

  test('reserves an auto-sized column for activity feed badges', () => {
    const html = renderRuntimeMiniAppPage('INT-143');

    expect(html).toContain('grid-template-columns: 62px 22px minmax(0, 1fr) minmax(42px, max-content)');
  });

  test('derives user-facing milestones when backend milestones are not populated yet', () => {
    const presentation = buildRuntimeMiniAppIssuePresentation(createIssue({
      milestones: [],
      phase: 'DEV',
      orchestrator_state: 'dev_running',
      session: {
        session_id: 'session-143',
        turn_count: 2,
        stage: 'coding',
        last_event: 'tool.started',
        last_message: '正在编辑 runtime Mini App。',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:18:00.000Z',
        tokens: { input_tokens: 1200, output_tokens: 480, total_tokens: 1680 },
        recent_tools: [],
        recent_files: [],
      },
    }));

    expect(presentation.visibleMilestones.map((item) => item.kind)).toEqual([
      'plan_ready',
      'dispatch_ready',
      'dev_running',
    ]);
    expect(presentation.visibleMilestones[2]?.summary).toContain('正在编辑 runtime Mini App');
  });

  test('builds a code-diff preview from change pack files and write/edit activity', () => {
    const issue = createIssue({
      change_pack_summary: {
        profile: 'coding',
        complexity: 'small',
        files: ['src/runtime/miniAppPage.ts', 'src/runtime/miniAppPage.test.ts'],
        overview: 'Mini App visual polish',
      },
      session: {
        session_id: 'session-143',
        turn_count: 3,
        stage: 'coding',
        last_event: 'tool.completed',
        last_message: '正在修复 Mini App 排版。',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:18:00.000Z',
        tokens: { input_tokens: 1200, output_tokens: 480, total_tokens: 1680 },
        recent_tools: [],
        recent_files: [
          {
            path: 'docs/CONFIGURATION.md',
            operation: 'read',
            status: 'completed',
            timestamp: '2026-05-04T04:17:00.000Z',
          },
          {
            path: 'src/runtime/miniAppPage.ts',
            operation: 'edit',
            status: 'completed',
            timestamp: '2026-05-04T04:18:00.000Z',
          },
        ],
      },
    });

    const diffFiles = buildRuntimeMiniAppDiffFiles(issue);

    expect(diffFiles.map((file) => file.path)).toEqual([
      'src/runtime/miniAppPage.ts',
      'src/runtime/miniAppPage.test.ts',
    ]);
    expect(diffFiles[0]?.badge).toBe('M');
    expect(new Set(diffFiles.map((file) => file.summary)).size).toBeGreaterThan(1);
    expect(diffFiles.some((file) => file.path === 'docs/CONFIGURATION.md')).toBe(false);
  });

  test('shortens absolute runtime paths before rendering file and diff rows', () => {
    const issue = createIssue({
      change_pack_summary: {
        profile: 'coding',
        complexity: 'small',
        files: [
          '/Users/example/projects/symharix/workspaces/uniuni2000__test2/worktrees/INT-149/src/runtime/miniAppPage.ts',
        ],
        overview: 'go complexity profile repeated metadata',
      },
      session: {
        session_id: 'session-143',
        turn_count: 3,
        stage: 'coding',
        last_event: 'tool.completed',
        last_message: '正在修复 Mini App 排版。',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:18:00.000Z',
        tokens: { input_tokens: 1200, output_tokens: 480, total_tokens: 1680 },
        recent_tools: [],
        recent_files: [
          {
            path: '/Users/example/projects/symharix/workspaces/uniuni2000__test2/worktrees/INT-149/.symphony/state.json',
            operation: 'read',
            status: 'completed',
            timestamp: '2026-05-04T04:17:00.000Z',
          },
        ],
      },
    });

    const feed = buildRuntimeMiniAppActivityFeed(issue);
    const diffFiles = buildRuntimeMiniAppDiffFiles(issue);

    expect(feed[0]?.summary).toBe('读取 state.json');
    expect(feed[0]?.detail).toBe('读取 · .symphony');
    expect(diffFiles[0]?.path).toBe('src/runtime/miniAppPage.ts');
    expect(diffFiles[0]?.summary).toBe('调整界面展示逻辑与排版。');
  });

  test('renders GitHub repository branding and a code diff panel shell', () => {
    const html = renderRuntimeMiniAppPage('INT-143');

    expect(html).toContain('class="github-mark"');
    expect(html).toContain('id="diff-list"');
    expect(html).toContain('代码改动');
  });

  test('renders Mini App event times down to seconds', () => {
    const html = renderRuntimeMiniAppPage('INT-143');

    expect(html).toContain("second: '2-digit'");
    expect(html).toContain("return '--:--:--'");
  });

  test('renders a one-click recovery action for retryable delivery failures', () => {
    const presentation = buildRuntimeMiniAppIssuePresentation(createIssue({
      orchestrator_state: 'failed',
      delivery_state: 'delivery_failed',
      delivery_code: 'dirty_workspace_no_commit',
      delivery_summary: 'Failed to remove workflow artifacts from branch feature/int-155: Symphony workflow artifacts must not be committed',
      actions: {
        can_stop: false,
        can_retry: true,
        can_open_pr: false,
      },
    }));
    const html = renderRuntimeMiniAppPage('INT-155');

    expect(presentation.stateLabel).toBe('Needs recovery');
    expect(presentation.nextRecommendation).toContain('一键重试');
    expect(html).toContain('修复交付并重试');
    expect(html).toContain("setRuntimeAction(el.pauseButton, 'retry', '修复交付并重试'");
    expect(html).toContain('/api/v1/runtime/issues/');
  });

  test('opens a complete log panel from the completed issue action bar', () => {
    const html = renderRuntimeMiniAppPage('INT-155');

    expect(html).toContain('id="history-panel"');
    expect(html).toContain('id="history-entry-list"');
    expect(html).toContain("setRuntimeAction(el.pauseButton, 'history', '完整日志'");
    expect(html).toContain("if (action === 'history')");
    expect(html).toContain('renderHistoryPanel()');
    expect(html).toContain('完整日志');
  });

  test('renders expandable controls for long Mini App summaries', () => {
    const html = renderRuntimeMiniAppPage('INT-155');

    expect(html).toContain('class="expand-button"');
    expect(html).toContain('data-full-text');
    expect(html).toContain('function expandableCopy(');
    expect(html).toContain('function toggleExpandedText(');
    expect(html).toContain("if (button.classList.contains('expand-button'))");
    expect(html).toContain('renderExpandableText(el.judgmentCopy');
    expect(html).toContain('renderExpandableText(el.nextCopy');
    expect(html).toContain('function findExpandedHistoryText(summary)');
    expect(html).toContain('expandableCopy(findExpandedHistoryText(item.summary)');
  });

  test('extracts deleted and modified files from history for the code diff panel', () => {
    const html = renderRuntimeMiniAppPage('INT-155');

    expect(html).toContain('function extractDiffFilesFromHistory(');
    expect(html).toContain('entry.detail && entry.detail.payload && entry.detail.payload.body');
    expect(html).toContain("parseChangeLine(line)");
    expect(html).toContain("badge: 'D'");
    expect(html).toContain("badge: 'M'");
    expect(html).toContain('class="diff-detail"');
    expect(html).toContain('getPresentation(issue).diffFiles');
    expect(html).toContain('extractDiffFilesFromHistory(state.history)');
  });

  test('humanizes raw runtime JSON before it reaches agent progress or milestones', () => {
    const rawEvent = '{"level":"info","category":"tool","code":"tool_started","message":"Using Bash","turn":1,"tool_name":"Bash","detail":{"tool_call_id":"call_function_1k0l7s1exxb3_1","output_length":4000}}';
    const issue = createIssue({
      phase: 'DEV',
      orchestrator_state: 'dev_running',
      agent_recent_progress: {
        dev: [
          {
            summary: rawEvent,
            status: 'coding',
            timestamp: '2026-05-04T04:18:21.000Z',
          },
        ],
        review: [],
      },
      session: {
        session_id: 'session-143',
        turn_count: 1,
        stage: 'coding',
        last_event: 'tool_started',
        last_message: rawEvent,
        started_at: '2026-05-04T04:18:00.000Z',
        last_event_at: '2026-05-04T04:18:21.000Z',
        tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        recent_tools: [],
        recent_files: [],
      },
      milestones: [],
    });

    const presentation = buildRuntimeMiniAppIssuePresentation(issue);

    expect(presentation.visibleMilestones[2]?.summary).toBe('Bash 正在运行');
    expect(presentation.visibleMilestones[2]?.summary).not.toContain('tool_call_id');
  });

  test('allows agent and milestone summaries to wrap inside their panels', () => {
    const html = renderRuntimeMiniAppPage('INT-143');

    expect(html).toContain('.agent-row span,');
    expect(html).toContain('white-space: normal;');
    expect(html).toContain('overflow-wrap: anywhere;');
  });
});
