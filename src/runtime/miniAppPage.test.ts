import { describe, expect, test } from 'bun:test';
import type { RuntimeIssueView } from './types';
import {
  buildRuntimeMiniAppActivityFeed,
  buildRuntimeMiniAppDiffFiles,
  buildRuntimeMiniAppIssuePresentation,
  buildRuntimeMiniAppMilestones,
  buildRuntimeMiniAppUsagePresentation,
  normalizeRuntimeMiniAppSummary,
  renderRuntimeMiniAppPage,
  runtimeMiniAppProgressLabel,
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
  test('shows review as active once dev has handed off to review', () => {
    const presentation = buildRuntimeMiniAppIssuePresentation(createIssue());

    expect(presentation.progress).toBe(72);
    expect(presentation.devStatus).toBe('完成');
    expect(presentation.reviewStatus).toBe('运行中');
    expect(presentation.reviewDeliveryStatus).toBe('running');
  });

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
            message: 'cat > "/Users/liupenghui/Documents/code/agent/test-cc/workspaces/uniuni2000__test2/worktrees/INT-149/.symphony/state.json" << EOF',
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
    expect(feed[0]?.summary).not.toContain('/Users/liupenghui');
    expect(feed[1]?.summary).toContain('miniAppPage.ts');
    expect(feed[1]?.detail).toBe('编辑 · src/runtime');
    expect(feed.every((item) => item.timestamp)).toBe(true);
  });

  test('normalizes structured runtime summaries across tool, message, and fallback payloads', () => {
    expect(normalizeRuntimeMiniAppSummary(JSON.stringify({
      tool_name: 'bash',
      code: 'tool_started',
      message: 'Using Bash',
    }))).toBe('Bash 正在运行');

    expect(normalizeRuntimeMiniAppSummary(JSON.stringify({
      tool_name: 'read',
      code: 'tool_completed',
      message: 'Read complete',
    }))).toBe('Read 完成');

    expect(normalizeRuntimeMiniAppSummary(JSON.stringify({
      tool_name: 'custom_tool',
      code: 'tool_failed',
    }))).toBe('Custom tool failed');

    expect(normalizeRuntimeMiniAppSummary(JSON.stringify({
      message: '正在读取当前 issue 状态。',
    }), '', 120, 'en')).toBe('正在读取当前 issue 状态。');

    expect(normalizeRuntimeMiniAppSummary('{oops')).toBe('{oops');
    expect(normalizeRuntimeMiniAppSummary('', 'Fallback summary')).toBe('Fallback summary');
    expect(normalizeRuntimeMiniAppSummary('["array"]')).toBe('["array"]');
    expect(normalizeRuntimeMiniAppSummary('word '.repeat(40), '', 24)).toBe('word word word word wor…');
  });

  test('derives fallback milestones for decision, proof, review, dev, and completed states', () => {
    const blocked = buildRuntimeMiniAppMilestones(createIssue({
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      governance_thread_state: 'blocked',
      next_recommended_action: '等待用户确认下一步。',
      milestones: [],
      session: null,
    }));
    const proof = buildRuntimeMiniAppMilestones(createIssue({
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      delivery_state: 'proof_satisfied',
      delivery_summary: '证据已满足，等待最终交付。',
      milestones: [],
      session: null,
    }));
    const review = buildRuntimeMiniAppMilestones(createIssue({
      phase: 'REVIEW',
      orchestrator_state: 'review_running',
      milestones: [],
      session: {
        session_id: 'session-review',
        turn_count: 4,
        stage: 'review',
        last_event: 'tool.completed',
        last_message: 'Waiting for reviewer confirmation.',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:19:00.000Z',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        recent_tools: [],
        recent_files: [],
      },
    }));
    const dev = buildRuntimeMiniAppMilestones(createIssue({
      phase: 'DEV',
      orchestrator_state: 'dev_running',
      milestones: [],
      session: {
        session_id: 'session-dev',
        turn_count: 2,
        stage: 'coding',
        last_event: 'tool.started',
        last_message: 'Implementing the current round.',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:18:00.000Z',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        recent_tools: [],
        recent_files: [],
      },
    }));
    const completed = buildRuntimeMiniAppMilestones(createIssue({
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      delivery_summary: 'Issue 已完成，交付闭环。',
      milestones: [],
      session: null,
    }));

    expect(blocked.map((item) => item.kind)).toEqual(['plan_ready', 'needs_decision']);
    expect(blocked[1]?.summary).toContain('等待用户确认下一步');
    expect(proof.at(-1)?.kind).toBe('proof_satisfied');
    expect(review.at(-1)).toMatchObject({
      kind: 'review_running',
      timestamp: '2026-05-04T04:19:00.000Z',
    });
    expect(dev.at(-1)?.kind).toBe('dev_running');
    expect(completed.at(-1)?.kind).toBe('delivery_completed');
  });

  test('uses milestone fallback copy when plan, decision, delivery, review, and dev text are missing', () => {
    const planAndDecision = buildRuntimeMiniAppMilestones(createIssue({
      supervisor_locale: 'en',
      title: '',
      supervisor_plan_summary: '',
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: null as any,
      governance_thread_state: 'blocked',
      next_recommended_action: '',
      governance_summary: '',
      milestones: [],
      session: null,
    }));
    const dispatchReady = buildRuntimeMiniAppMilestones(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: null as any,
      governance_thread_state: null,
      milestones: [],
      session: null,
    }));
    const completed = buildRuntimeMiniAppMilestones(createIssue({
      supervisor_locale: 'en',
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      delivery_summary: '',
      milestones: [],
      session: null,
    }));
    const proof = buildRuntimeMiniAppMilestones(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      delivery_state: 'proof_satisfied',
      delivery_summary: '',
      milestones: [],
      session: null,
    }));
    const review = buildRuntimeMiniAppMilestones(createIssue({
      supervisor_locale: 'en',
      phase: 'REVIEW',
      tracker_state: 'In Review',
      orchestrator_state: 'review_running',
      next_recommended_action: '',
      milestones: [],
      session: {
        session_id: 'session-review-fallback',
        turn_count: 1,
        stage: 'review',
        last_event: 'tool.started',
        last_message: '',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: null,
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        recent_tools: [],
        recent_files: [],
      },
    }));
    const dev = buildRuntimeMiniAppMilestones(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'dev_running',
      next_recommended_action: '',
      milestones: [],
      session: {
        session_id: 'session-dev-fallback',
        turn_count: 1,
        stage: 'coding',
        last_event: 'tool.started',
        last_message: '',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: null,
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        recent_tools: [],
        recent_files: [],
      },
    }));

    expect(planAndDecision[0]?.summary).toBe('Plan is ready and waiting for the execution signal.');
    expect(planAndDecision[1]?.summary).toBe('User confirmation is needed for the next step.');
    expect(dispatchReady[1]?.summary).toBe('Ready to enter the runtime lane.');
    expect(completed.at(-1)?.summary).toBe('Issue is complete and final delivery is closed.');
    expect(proof.at(-1)?.summary).toBe('Proof is satisfied and final delivery is pending.');
    expect(review.at(-1)?.summary).toBe('Review is checking delivery quality.');
    expect(dev.at(-1)?.summary).toBe('The dev agent is advancing the current round.');
  });

  test('formats runtime progress labels across done, proof, review, build, dispatch, and plan states', () => {
    expect(runtimeMiniAppProgressLabel(createIssue({
      supervisor_locale: 'en',
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
    }), 100)).toBe('Done 100%');

    expect(runtimeMiniAppProgressLabel(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      orchestrator_state: 'halted',
      delivery_state: 'proof_satisfied',
      session: null,
    }), 82)).toBe('Proof 82%');

    expect(runtimeMiniAppProgressLabel(createIssue({
      supervisor_locale: 'en',
      phase: 'REVIEW',
      orchestrator_state: 'review_running',
      session: null,
    }), 72)).toBe('Review 72%');

    expect(runtimeMiniAppProgressLabel(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      orchestrator_state: 'dev_running',
      session: {
        session_id: 'session-progress',
        turn_count: 1,
        stage: 'coding',
        last_event: 'tool.started',
        last_message: 'Running',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:16:00.000Z',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        recent_tools: [],
        recent_files: [],
      },
    }), 42)).toBe('Build 42%');

    expect(runtimeMiniAppProgressLabel(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      governance_thread_state: 'waiting_on_child',
      session: null,
    }), 34)).toBe('Dispatch 34%');

    expect(runtimeMiniAppProgressLabel(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: null as any,
      session: null,
    }), 18)).toBe('Plan 18%');
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

  test('humanizes live state labels instead of exposing raw orchestrator enums', () => {
    const running = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      orchestrator_state: 'dev_running',
    }));
    const review = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'REVIEW',
      orchestrator_state: 'review_running',
    }));

    expect(running.stateLabel).toBe('Dev running');
    expect(review.stateLabel).toBe('Review running');
    expect(running.stateLabel).not.toContain('dev_running');
    expect(review.stateLabel).not.toContain('review_running');
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

  test('classifies diff files for docs, evidence, packages, tests, and new writes', () => {
    const issue = createIssue({
      change_pack_summary: {
        profile: 'coding',
        complexity: 'small',
        files: [
          'docs/README.md',
          '.symphony/evidence.json',
          'package.json',
          'tests/smoke.test.ts',
          '/Users/liupenghui/Documents/code/agent/test-cc/.symphony/state.json',
          '/opt/project/plain.txt',
          'src/feature.ts',
          '',
        ],
        overview: 'Mini App runtime cleanup',
      },
      session: {
        session_id: 'session-143',
        turn_count: 5,
        stage: 'coding',
        last_event: 'tool.completed',
        last_message: '正在更新多个交付文件。',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:20:00.000Z',
        tokens: { input_tokens: 1200, output_tokens: 480, total_tokens: 1680 },
        recent_tools: [],
        recent_files: [
          {
            path: 'src/new-file.ts',
            operation: 'write',
            status: 'started',
            timestamp: '2026-05-04T04:20:00.000Z',
          },
          {
            path: 'src/feature.ts',
            operation: 'edit',
            status: 'failed',
            timestamp: '2026-05-04T04:19:00.000Z',
          },
          {
            path: 'docs/README.md',
            operation: 'read',
            status: 'completed',
            timestamp: '2026-05-04T04:18:00.000Z',
          },
        ],
      },
    });

    const files = buildRuntimeMiniAppDiffFiles(issue);
    const byPath = new Map(files.map((file) => [file.path, file]));

    expect(byPath.get('docs/README.md')?.summary).toBe('更新文档说明。');
    expect(byPath.get('.symphony/evidence.json')?.summary).toBe('更新运行证据与交付状态。');
    expect(byPath.get('package.json')?.summary).toBe('更新依赖或脚本配置。');
    expect(byPath.get('tests/smoke.test.ts')?.summary).toBe('补充或更新回归测试。');
    expect(byPath.get('.symphony/state.json')?.summary).toBe('更新运行证据与交付状态。');
    expect(byPath.get('plain.txt')?.summary).toBe('Mini App runtime cleanup');
    expect(byPath.get('src/new-file.ts')).toMatchObject({
      badge: 'A',
      tone: 'blue',
    });
    expect(byPath.get('src/new-file.ts')?.summary).toContain('写入中');
    expect(byPath.get('src/feature.ts')?.tone).toBe('red');
    expect(files.some((file) => file.path === '')).toBe(false);
  });

  test('covers generic file activity labels and single-segment folders in the live feed', () => {
    const issue = createIssue({
      phase: 'DEV',
      orchestrator_state: 'dev_running',
      session: {
        session_id: 'session-generic-file',
        turn_count: 2,
        stage: 'coding',
        last_event: 'tool.completed',
        last_message: '正在处理通用文件动作。',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:16:00.000Z',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        recent_tools: [],
        recent_files: [
          {
            path: 'README.md',
            operation: 'rename' as any,
            status: null as any,
            timestamp: '2026-05-04T04:16:00.000Z',
          },
        ],
      },
    });

    expect(buildRuntimeMiniAppActivityFeed(issue)).toEqual([
      expect.objectContaining({
        label: 'File',
        summary: '文件活动 README.md',
        detail: '文件活动',
        tone: 'neutral',
      }),
    ]);
  });

  test('shortens absolute runtime paths before rendering file and diff rows', () => {
    const issue = createIssue({
      change_pack_summary: {
        profile: 'coding',
        complexity: 'small',
        files: [
          '/Users/liupenghui/Documents/code/agent/test-cc/workspaces/uniuni2000__test2/worktrees/INT-149/src/runtime/miniAppPage.ts',
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
            path: '/Users/liupenghui/Documents/code/agent/test-cc/workspaces/uniuni2000__test2/worktrees/INT-149/.symphony/state.json',
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
    expect(html).toContain('id="diff-drawer"');
    expect(html).toContain('代码改动');
  });

  test('renders the Mini App as a four-item bottom phone tab bar', () => {
    const html = renderRuntimeMiniAppPage('INT-143');

    expect(html).toContain('class="fixed-header"');
    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('data-tab="changes"');
    expect(html).toContain('data-tab="delivery"');
    expect(html).toContain('data-tab="usage"');
    expect(html).toContain('id="tab-overview"');
    expect(html).toContain('id="tab-changes"');
    expect(html).toContain('id="tab-delivery"');
    expect(html).toContain('id="tab-usage"');
    expect(html).toContain('class="tab-icon"');
    expect(html).toContain('<span class="tab-label">Issue</span>');
    expect(html).toContain('<span class="tab-label">Changes</span>');
    expect(html).toContain('<span class="tab-label">Delivery</span>');
    expect(html).toContain('<span class="tab-label">Usage</span>');
    expect(html).toContain('symharix issue cockpit');
    expect(html).toContain('<span>symharix</span>');
    expect(html).not.toContain('symphonyness');
    expect(html).toContain('id="usage-donut"');
    expect(html).toContain('id="usage-bars"');
    expect(html).not.toContain('id="usage-metrics"');
    expect(html).not.toContain('id="usage-heading"');
    expect(html).not.toContain('id="usage-equation"');
    expect(html).toContain('function usageTotalFontSize(value)');
    expect(html).toContain('function renderUsage(issue)');
    expect(html).toContain("chip(issue.active_pr_number ? 'PR #' + issue.active_pr_number : t('prPending'), 'blue')");
    expect(html).toContain("chip(issue.branch_name || (child && child.issue_identifier) || t('rootIssue'), 'blue')");
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('id="language-toggle"');
    expect(html).toContain('class="segmented-control"');
    expect(html).toContain('data-theme-choice="light"');
    expect(html).toContain('data-theme-choice="dark"');
    expect(html).toContain('data-lang-choice="zh"');
    expect(html).toContain('data-lang-choice="en"');
    expect(html).toContain('html[data-theme="light"]');
    expect(html).toContain("const storedLang = window.localStorage.getItem('symphony.miniapp.lang.' + issueId)");
    expect(html).toContain('langInitialized: storedLang === \'en\' || storedLang === \'zh\'');
    expect(html).toContain("state.lang = issue && issue.supervisor_locale === 'en' ? 'en' : 'zh'");
  });

  test('keeps delivery and changes details in their dedicated tab surfaces', () => {
    const html = renderRuntimeMiniAppPage('INT-143');

    expect(html).toContain('验收标准');
    expect(html).toContain('id="acceptance-list"');
    expect(html).toContain('id="delivery-summary"');
    expect(html).toContain('完整 diff');
    expect(html).toContain('改动摘要');
    expect(html).toContain("escapeHtml(t('reason'))");
    expect(html).toContain('class="diff-open-button"');
    expect(html).toContain('id="diff-drawer-note"');
    expect(html).toContain("[t('restore'), isRetryableDeliveryFailure(issue) ? t('restorable') : t('noRestore')]");
    expect(html).toContain('class="diff-stat-summary"');
    expect(html).toContain('class="diff-stat-token add"');
    expect(html).toContain('class="diff-stat-token del"');
    expect(html).toContain('background: rgba(255, 255, 255, 0.98);');
    expect(html).toContain('background: rgba(248, 251, 255, 0.96);');
    expect(html).toContain('html[data-theme="dark"] .diff-drawer');
    expect(html).toContain('html[data-theme="dark"] .diff-drawer-code');
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
      delivery_summary: 'Failed to remove workflow artifacts from branch feature/int-155: SymHarix workflow artifacts must not be committed',
      actions: {
        can_stop: false,
        can_retry: true,
        can_open_pr: false,
      },
    }));
    const html = renderRuntimeMiniAppPage('INT-155');

    expect(presentation.stateLabel).toBe('需要恢复');
    expect(presentation.nextRecommendation).toContain('一键重试');
    expect(html).toContain('修复交付并重试');
    expect(html).toContain("setRuntimeAction(el.pauseButton, 'retry', t('retryDelivery')");
    expect(html).toContain('/api/v1/runtime/issues/');
  });

  test('opens a complete log panel from the completed issue action bar', () => {
    const html = renderRuntimeMiniAppPage('INT-155');

    expect(html).toContain('id="history-panel"');
    expect(html).toContain('id="history-entry-list"');
    expect(html).toContain("setRuntimeAction(el.pauseButton, 'history', t('completed'), 'success')");
    expect(html).toContain("if (action === 'history')");
    expect(html).toContain('renderHistoryPanel()');
    expect(html).toContain('完整日志');
  });

  test('renders the compact hero rail and overview signal shell', () => {
    const html = renderRuntimeMiniAppPage('INT-155');

    expect(html).toContain('id="progress-fill"');
    expect(html).toContain('class="progress-value"');
    expect(html).toContain('id="stage-badge"');
    expect(html).toContain('class="stage-badge blue"');
    expect(html).toContain("function stageBadgeInfo(issue, presentation)");
    expect(html).toContain("t('stageDev')");
    expect(html).toContain("t('stageReview')");
    expect(html).toContain('id="overview-signal"');
    expect(html).toContain('id="signal-pills"');
    expect(html).toContain("function renderOverviewSignal(issue)");
    expect(html).toContain("el.hero.addEventListener('click'");
  });

  test('uses real phone Mini App proportions with a bottom tab bar', () => {
    const html = renderRuntimeMiniAppPage('INT-155');

    expect(html).toContain('--miniapp-width: 390px;');
    expect(html).toContain('max-width: var(--miniapp-width);');
    expect(html).toContain('min-height: 100svh;');
    expect(html).toContain('padding-bottom: calc(86px + env(safe-area-inset-bottom));');
    expect(html).toContain('position: fixed;');
    expect(html).toContain('bottom: calc(8px + env(safe-area-inset-bottom));');
    expect(html).toContain('width: min(calc(100vw - 34px), calc(var(--miniapp-width) - 34px));');
    expect(html).toContain('html[data-theme="light"] .tabbar');
    expect(html).toContain('html[data-theme="light"] .tab-button.active');
    expect(html).toContain("state.theme = state.theme === 'light' ? 'dark' : 'light'");
    expect(html).toContain("state.lang = state.lang === 'en' ? 'zh' : 'en'");
    expect(html).toContain("background: url(\"data:image/svg+xml");
    expect(html).toContain('.hero {');
    expect(html).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(html).toContain('.progress-value {');
    expect(html).toContain('font-size: 34px;');
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

  test('emits syntactically valid inline client script for the Mini App page', () => {
    const html = renderRuntimeMiniAppPage('INT-155');
    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);

    expect(scriptMatch).not.toBeNull();
    expect(() => new Function(scriptMatch?.[1] || '')).not.toThrow();
  });

  test('extracts deleted and modified files from history for the code diff panel', () => {
    const html = renderRuntimeMiniAppPage('INT-155');

    expect(html).toContain('function extractDiffFilesFromHistory(');
    expect(html).toContain('entry.detail && entry.detail.payload && entry.detail.payload.body');
    expect(html).toContain("parseChangeLine(line)");
    expect(html).toContain("const match = String(value || '').match(/\\+(\\d+)\\s*-\\s*(\\d+)/);");
    expect(html).toContain('additions: stats.additions');
    expect(html).toContain('deletions: stats.deletions');
    expect(html).toContain("badge: 'D'");
    expect(html).toContain("badge: 'M'");
    expect(html).toContain('function openDiffDrawer(index)');
    expect(html).toContain("diffExcerptNote");
    expect(html).toContain("diffSummaryOnlyNote");
    expect(html).toContain("diffSummary");
    expect(html).toContain('history && Array.isArray(history.file_diffs)');
    expect(html).toContain('historyFileDiffForPath(history, path)');
    expect(html).toContain('function formatDiffHunkHeader(line)');
    expect(html).toContain("/^diff --git /.test(line)");
    expect(html).toContain("return '<span class=\"diff-drawer-line hunk\">'");
    expect(html).toContain('id="diff-drawer-detail"');
    expect(html).toContain("file.drawerMode === 'full' ? t('diffDetails') : t('diffSummary')");
    expect(html).toContain('getPresentation(issue).diffFiles');
    expect(html).toContain('extractDiffFilesFromHistory(state.history)');
    expect(html).toContain('(?:\\s*[:：]\\s*|\\s+)');
    expect(html).toContain('(?:删除|移除|新增|创建|添加|更新|修改|编辑|清空)(?:\\s*[:：]|\\s)');
  });

  test('covers state labels and progress states for waiting, blocked, retry, preparing, and cancellation flows', () => {
    const waitingOnChild = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'halted',
      governance_thread_state: 'waiting_on_child',
      session: null,
    }));
    const needsDecision = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      governance_thread_state: 'confirming',
      active_decision_kind: 'close_as_done',
      session: null,
    }));
    const retryScheduled = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: 'retry_scheduled',
      session: null,
    }));
    const blocked = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: 'failed',
      session: null,
      delivery_state: null,
      delivery_code: null,
      actions: {
        can_stop: false,
        can_retry: false,
        can_open_pr: false,
      },
    }));
    const preparing = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: 'mapping',
      session: null,
    }));
    const cancelled = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: 'cancelled',
      session: null,
    }));

    expect(waitingOnChild).toMatchObject({
      stateLabel: 'Waiting on child',
      progress: 34,
      dispatchStatus: 'Done',
    });
    expect(needsDecision.stateLabel).toBe('Needs decision');
    expect(retryScheduled.stateLabel).toBe('Retry scheduled');
    expect(blocked.stateLabel).toBe('Blocked');
    expect(preparing.stateLabel).toBe('Preparing');
    expect(cancelled.stateLabel).toBe('Cancelled');
  });

  test('truncates long fallback state labels when no known runtime state applies', () => {
    const presentation = buildRuntimeMiniAppIssuePresentation(createIssue({
      phase: 'DEV',
      tracker_state: 'Paused by operator because cleanup is required before continuing work',
      orchestrator_state: null as any,
      session: null,
    }));

    expect(presentation.stateLabel).toBe('Paused by operator because cleanup…');
  });

  test('summarizes shell-heavy activity feeds into compact user-facing labels', () => {
    const issue = createIssue({
      phase: 'DEV',
      orchestrator_state: 'dev_running',
      session: {
        session_id: 'session-commands',
        turn_count: 6,
        stage: 'coding',
        last_event: 'tool.completed',
        last_message: '正在推进 runtime Mini App 收尾。',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:21:00.000Z',
        tokens: { input_tokens: 1200, output_tokens: 480, total_tokens: 1680 },
        recent_tools: [
          {
            tool_name: 'Bash',
            status: 'completed',
            message: 'gh pr view 42',
            summary: null,
            path: null,
            timestamp: '2026-05-04T04:21:00.000Z',
          },
          {
            tool_name: 'Bash',
            status: 'completed',
            message: 'pytest -q',
            summary: null,
            path: null,
            timestamp: '2026-05-04T04:20:00.000Z',
          },
          {
            tool_name: 'Bash',
            status: 'completed',
            message: 'ls src/runtime',
            summary: null,
            path: null,
            timestamp: '2026-05-04T04:19:00.000Z',
          },
          {
            tool_name: 'Bash',
            status: 'completed',
            message: 'rm -rf docs && echo cleaned',
            summary: null,
            path: null,
            timestamp: '2026-05-04T04:18:00.000Z',
          },
          {
            tool_name: 'Bash',
            status: 'completed',
            message: 'cat > "/tmp/workspaces/INT-1/result.txt" << EOF',
            summary: null,
            path: null,
            timestamp: '2026-05-04T04:17:00.000Z',
          },
          {
            tool_name: 'Bash',
            status: 'completed',
            message: 'cat /tmp/workspaces/INT-1/notes.txt',
            summary: null,
            path: null,
            timestamp: '2026-05-04T04:16:00.000Z',
          },
        ],
        recent_files: [],
      },
    });

    const summaries = buildRuntimeMiniAppActivityFeed(issue).map((item) => item.summary);

    expect(summaries).toEqual(expect.arrayContaining([
      '查看 PR #42',
      '运行测试',
      '检查文件列表',
      'rm -rf docs，然后 echo cleaned',
      '写入 result.txt',
      '读取 notes.txt',
    ]));
  });

  test('handles JSON shell summaries, git status, generic tool labels, and anonymized command fallbacks', () => {
    const issue = createIssue({
      phase: 'DEV',
      orchestrator_state: 'dev_running',
      session: {
        session_id: 'session-tool-labels',
        turn_count: 6,
        stage: 'coding',
        last_event: 'tool.completed',
        last_message: '正在推进工具摘要整理。',
        started_at: '2026-05-04T04:15:00.000Z',
        last_event_at: '2026-05-04T04:21:00.000Z',
        tokens: { input_tokens: 1200, output_tokens: 480, total_tokens: 1680 },
        recent_tools: [
          {
            tool_name: 'Bash',
            status: 'started',
            message: '{"tool_name":"Bash","code":"tool_started","message":"Using Bash"}',
            summary: null,
            path: null,
            timestamp: '2026-05-04T04:21:00.000Z',
          },
          {
            tool_name: 'Bash',
            status: 'completed',
            message: 'git status > /dev/null 2> /dev/null',
            summary: null,
            path: null,
            timestamp: '2026-05-04T04:20:00.000Z',
          },
          {
            tool_name: 'Bash',
            status: 'completed',
            message: 'echo /Users/liupenghui/Documents/private.txt',
            summary: null,
            path: null,
            timestamp: '2026-05-04T04:19:00.000Z',
          },
          {
            tool_name: 'apply_patch',
            status: 'completed',
            message: '',
            summary: '',
            path: null,
            timestamp: '2026-05-04T04:18:00.000Z',
          },
          {
            tool_name: 'pytest',
            status: null as any,
            message: '',
            summary: 'Smoke suite',
            path: null,
            timestamp: '2026-05-04T04:17:00.000Z',
          },
          {
            tool_name: 'review_agent',
            status: 'completed',
            message: '',
            summary: '',
            path: null,
            timestamp: '2026-05-04T04:16:00.000Z',
          },
        ],
        recent_files: [],
      },
    });

    expect(buildRuntimeMiniAppActivityFeed(issue)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Bash', summary: 'Bash 正在运行', detail: 'workspace', tone: 'blue' }),
      expect.objectContaining({ label: 'Bash', summary: '检查 Git 状态' }),
      expect.objectContaining({ label: 'Bash', summary: 'echo private.txt' }),
      expect.objectContaining({ label: 'Edit', summary: '编辑 workspace' }),
      expect.objectContaining({ label: 'Test', summary: 'Smoke suite', tone: 'neutral' }),
      expect.objectContaining({ label: 'Review', summary: 'Review running' }),
    ]));
  });

  test('uses a graceful completed-feed fallback when final delivery copy is absent', () => {
    const feed = buildRuntimeMiniAppActivityFeed(createIssue({
      supervisor_locale: 'en',
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      delivery_summary: null,
      active_pr_number: null,
      session: null,
    }));

    expect(feed).toEqual([
      expect.objectContaining({
        label: 'Closed',
        summary: 'Issue is complete and final delivery is closed.',
        detail: 'UniUni2000/test2',
        tone: 'green',
      }),
    ]);
  });

  test('uses graceful live and completed presentation fallbacks when supervisor signals are missing', () => {
    const completed = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      delivery_summary: '',
      active_pr_number: null,
      session: null,
      riskDelta: '',
      risk_delta: '',
    }));
    const live = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'Todo',
      orchestrator_state: null as any,
      session: null,
      supervisor_plan_summary: '',
      governance_summary: '',
      delivery_summary: '',
      next_recommended_action: '',
      governance_expected_handoff: '',
      roundGoal: '',
      riskDelta: '',
      risk_delta: '',
      milestones: [],
    }));

    expect(completed.judgmentSummary).toBe('Plan thread is complete and final delivery is closed.');
    expect(completed.nextRecommendation).toBe('Completed. You can return to Telegram to start the next request.');
    expect(live.progress).toBe(18);
    expect(live.judgmentSummary).toBe('The system is advancing the highest-confidence next step and keeping child work ordered.');
    expect(live.nextRecommendation).toBe('Waiting for the supervisor to write the next action.');
    expect(live.roundGoal).toBe('Waiting for the next runtime signal.');
    expect(live.riskDelta).toBe('stable');
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

  test('summarizes generic runtime JSON instead of exposing long status payloads', () => {
    const rawTurn = JSON.stringify({
      turn: {
        id: 'adapter-turn-1',
        api_calls: 15,
        tokens: { input: 38337, output: 14067 },
      },
    });

    expect(normalizeRuntimeMiniAppSummary(rawTurn)).toBe('运行状态已更新。');
    expect(normalizeRuntimeMiniAppSummary(rawTurn, '', 120, 'en')).toBe('Runtime turn updated.');
  });

  test('summarizes issue token usage with platform-style uncached and cache read fields', () => {
    const usage = buildRuntimeMiniAppUsagePresentation(createIssue({
      usage: {
        input_tokens: 235134,
        output_tokens: 7258,
        total_tokens: 242392,
        uncached_input_tokens: 23283,
        cache_creation_input_tokens: 18315,
        cache_read_input_tokens: 193536,
      },
    }));

    expect(usage).toEqual({
      total: 242392,
      inputTotal: 235134,
      uncached: 41598,
      cacheRead: 193536,
      output: 7258,
    });
  });

  test('allows agent and milestone summaries to wrap inside their panels', () => {
    const html = renderRuntimeMiniAppPage('INT-143');

    expect(html).toContain('.agent-row span,');
    expect(html).toContain('white-space: normal;');
    expect(html).toContain('overflow-wrap: anywhere;');
  });

  test('allows overview signal text to wrap inside its card', () => {
    const html = renderRuntimeMiniAppPage('INT-143');

    expect(html).toContain('.signal-row > div');
    expect(html).toContain('.signal-row strong');
    expect(html).toContain('word-break: break-word;');
  });

  test('escapes diff stat paths before building client-side regexes', () => {
    const html = renderRuntimeMiniAppPage('INT-143');
    const helperStart = html.indexOf('function escapeRegExp(value)');
    const helperEnd = html.indexOf('        function diffStatsForPath', helperStart);
    const helperSource = html.slice(helperStart, helperEnd);
    const escapeRegExp = new Function(`${helperSource}; return escapeRegExp;`)() as (value: string) => string;

    const escapedPath = escapeRegExp('*.pyc');
    const pattern = new RegExp(
      '(?:^|\\n)\\|?\\s*' + escapedPath + '\\s*\\|\\s*[^|]+?\\|\\s*\\+(\\d+)\\s*-\\s*(\\d+)',
      'i',
    );

    expect(escapedPath).toBe('\\*\\.pyc');
    expect('| *.pyc | added | +7 -0'.match(pattern)?.slice(1)).toEqual(['7', '0']);
  });

  test('localizes known runtime-generated Chinese summaries for English mini app sessions', () => {
    const issue = createIssue({
      supervisor_locale: 'en',
      title: '[TES-50] smoke test: hello.py single-char append',
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      delivery_summary: 'TES-50 烟雾测试已成功完成。 hello.py 中添加了一个字符，并通过了编译验证。 PR #66 已审查批准，无进一步行动。',
      roundGoal: '当前计划「[TES-50] smoke test: hello.py single-char append」已经完成，不再向 dev agent 追加指令。',
      milestones: [
        {
          kind: 'completed',
          key: 'delivery:issue-143:completed',
          summary: 'TES-50 烟雾测试已成功完成。 hello.py 中添加了一个字符，并通过了编译验证。 PR #66 已审查批准，无进一步行动。',
          timestamp: '2026-05-04T04:24:01.817Z',
        },
      ],
    });

    const presentation = buildRuntimeMiniAppIssuePresentation(issue);
    const milestones = visibleRuntimeMiniAppMilestones(issue);

    expect(presentation.judgmentSummary).toContain('smoke test completed successfully');
    expect(presentation.roundGoal).toContain('Plan "[TES-50] smoke test: hello.py single-char append" is complete');
    expect(milestones[0]?.summary).toContain('PR #66 was approved');
    expect(milestones[0]?.summary).not.toContain('烟雾测试');

    const livePresentation = buildRuntimeMiniAppIssuePresentation(createIssue({
      supervisor_locale: 'en',
      phase: 'DEV',
      tracker_state: 'In Progress',
      orchestrator_state: 'dev_running',
      delivery_state: null,
      delivery_summary: null,
      roundGoal: [
        '继续推进计划「[TES-50] smoke test: hello.py single-char append」。',
        '完成标准：hello.py 追加一个 character；`python3 -m compileall .` 验证。',
        '历史提醒：## Review Decision: APPROVE。',
      ].join('\n'),
    }));
    expect(livePresentation.roundGoal).toContain('Continue advancing plan "[TES-50] smoke test: hello.py single-char append"');
    expect(livePresentation.roundGoal).toContain('Acceptance: hello.py appends one character; `python3 -m compileall .` verifies.');
    expect(livePresentation.roundGoal).toContain('History reminders: ## Review Decision: APPROVE.');
  });

  test('localizes the missing acceptance badge for English mini app sessions', () => {
    const html = renderRuntimeMiniAppPage('INT-143');

    expect(html).toContain("acceptanceMissingBadge: 'Missing'");
    expect(html).toContain("chip(String(value).toLowerCase().includes('missing') ? t('acceptanceMissingBadge') : '✓'");
  });
});
