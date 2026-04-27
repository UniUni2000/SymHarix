import { describe, expect, test } from 'bun:test';
import type { RuntimeIssueView, RuntimeTimelineEvent } from '../runtime/types';
import type { SupervisorSessionRecord } from '../database/types';
import { SupervisorDevConversationService } from './devConversation';

function createSession(): SupervisorSessionRecord {
  return {
    id: 'session-1',
    transport: 'telegram',
    conversation_id: 'chat-1',
    user_id: 'user-1',
    state: 'executing',
    repo_ref: 'UniUni2000/test2',
    intake_mode: 'plan_then_approve',
    approval_mode: 'explicit_user_approval',
    plan_card: {
      title: '清理仓库残余文件',
      user_goal: '把仓库残余文件清空',
      in_scope: ['识别并删除临时残余文件'],
      out_of_scope: ['不删除业务源码和配置密钥'],
      acceptance: ['git status 只剩预期变更', '说明删除清单'],
      known_risks: [],
      execution_strategy: '先审计，再最小删除，再补证据。',
      needs_user_approval: true,
      repo_ref: 'UniUni2000/test2',
      project_slug: 'test2',
      clarification_question: null,
      materialization_mode: 'root_only',
      recommended_option: { label: '批准并开始', summary: '按计划执行。' },
      alternate_option: null,
      governance_preview: null,
    },
    plan_version: 1,
    root_issue_id: 'issue-1',
    root_work_item_id: 'work-1',
    current_child_issue_id: null,
    active_decision_kind: null,
    delivery_state: null,
    delivery_summary: null,
    last_material_outcome: null,
    last_message_id: null,
    last_card_key: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function createIssue(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-1',
    work_item_id: 'work-1',
    identifier: 'INT-60',
    title: '清理仓库残余文件',
    phase: 'DEV',
    tracker_state: 'In Progress',
    orchestrator_state: 'retry_scheduled',
    workspace_path: '/tmp/workspace',
    branch_name: 'symharix-demo/int-60-cleanup',
    github_repo: 'UniUni2000/test2',
    github_issue_number: 60,
    active_pr_number: 12,
    session: null,
    governance_status: null,
    governance_decision: null,
    governance_summary: null,
    governance_root_issue_id: 'issue-1',
    governance_root_issue_identifier: 'INT-60',
    governance_thread_state: 'executing',
    governance_child_issues: [],
    governance_current_child: null,
    governance_child_queue: [],
    next_recommended_action: '继续按计划推进。',
    delivery_state: null,
    delivery_code: null,
    delivery_summary: null,
    active_governance_suggestions: [],
    actions: { can_stop: true, can_retry: true, can_open_pr: false },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function event(message: string): RuntimeTimelineEvent {
  return {
    id: crypto.randomUUID(),
    issue_id: 'issue-1',
    issue_identifier: 'INT-60',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'message',
    message,
  } as RuntimeTimelineEvent;
}

describe('SupervisorDevConversationService', () => {
  test('asks the dev agent for missing evidence before allowing another retry', () => {
    const service = new SupervisorDevConversationService();

    const directive = service.buildDirective({
      session: createSession(),
      issue: createIssue({
        evidence_summary: {
          satisfied: 2,
          total: 4,
          missing: ['删除清单', 'git status 证明'],
          requirements: [],
        },
      }),
      timeline: [event('Turn failed after cleanup without evidence.')],
      memories: [],
    });

    expect(directive.directive_kind).toBe('request_evidence');
    expect(directive.required_evidence).toContain('删除清单');
    expect(directive.instruction).toContain('补齐证据');
  });

  test('pauses for user when delivery failed after proof was satisfied', () => {
    const service = new SupervisorDevConversationService();

    const directive = service.buildDirective({
      session: createSession(),
      issue: createIssue({
        delivery_state: 'delivery_failed',
        delivery_code: 'dirty_workspace_no_commit',
        delivery_summary: '证据已满足，但没有可提交代码。',
      }),
      timeline: [event('Delivery failed: dirty workspace no commit.')],
      memories: [],
    });

    expect(directive.directive_kind).toBe('pause_for_user');
    expect(directive.stop_conditions).toContain('用户确认交付恢复策略');
    expect(directive.instruction).toContain('不要继续重试');
  });

  test('repairs PR branch/source-of-truth drift before another dev retry', () => {
    const service = new SupervisorDevConversationService();

    const directive = service.buildDirective({
      session: createSession(),
      issue: createIssue({
        delivery_state: 'delivery_failed',
        delivery_code: 'review_submit_failed',
        delivery_summary: 'GitHub review failed because PR head sha no longer matches runtime branch.',
      }),
      timeline: [
        event('PR head mismatch: runtime branch symharix-demo/int-60-cleanup differs from PR head feature/old.'),
      ],
      memories: [],
    });

    expect(directive.directive_kind).toBe('repair_delivery');
    expect(directive.instruction).toContain('runtime branch');
    expect(directive.instruction).toContain('PR head');
    expect(directive.required_evidence).toContain('PR/head 状态');
  });

  test('turns review failures into concrete rework instructions instead of generic retry', () => {
    const service = new SupervisorDevConversationService();

    const directive = service.buildDirective({
      session: createSession(),
      issue: createIssue({
        phase: 'REVIEW',
        orchestrator_state: 'failed',
        delivery_summary: 'Review requested changes.',
      }),
      timeline: [
        event('## Review Decision: REQUEST_CHANGES'),
        event('Missing verification evidence for deleted files.'),
      ],
      memories: [],
    });

    expect(directive.directive_kind).toBe('request_evidence');
    expect(directive.instruction).toContain('review');
    expect(directive.instruction).toContain('REQUEST_CHANGES');
    expect(directive.stop_conditions).toContain('review 再次要求修改');
  });

  test('keeps big-plan child handoff focused on the current child and queued siblings', () => {
    const service = new SupervisorDevConversationService();

    const directive = service.buildDirective({
      session: createSession(),
      issue: createIssue({
        governance_thread_state: 'waiting_on_child',
        governance_current_child: {
          issue_id: 'child-1',
          issue_identifier: 'INT-61',
          title: '清理 docs 残余',
          tracker_state: 'In Progress',
          orchestrator_state: 'dev_running',
          governance_decision: 'accept',
          governance_summary: null,
          queue_state: 'current',
        },
        governance_child_queue: [
          {
            issue_id: 'child-1',
            issue_identifier: 'INT-61',
            title: '清理 docs 残余',
            tracker_state: 'In Progress',
            orchestrator_state: 'dev_running',
            governance_decision: 'accept',
            governance_summary: null,
            queue_state: 'current',
          },
          {
            issue_id: 'child-2',
            issue_identifier: 'INT-62',
            title: '清理 test 残余',
            tracker_state: 'Todo',
            orchestrator_state: 'halted',
            governance_decision: 'accept',
            governance_summary: null,
            queue_state: 'queued',
          },
        ],
      }),
      timeline: [event('Root is waiting on current child.')],
      memories: [],
    });

    expect(directive.directive_kind).toBe('continue_dev');
    expect(directive.instruction).toContain('当前只推进子单 INT-61');
    expect(directive.instruction).toContain('INT-62');
    expect(directive.instruction).toContain('排队');
  });
});
