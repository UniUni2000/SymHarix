import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  BotFollowupDeliveryStateRepository,
  BotFollowupMessageStateRepository,
  BotIssueFollowupRepository,
  BotTransportEventRepository,
  GovernanceSuggestionRepository,
  SupervisorSessionRepository,
  WorkItemRepository,
  initializeSchema,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeStreamEvent } from '../runtime/types';
import type {
  BotRecipient,
  BotTransportMessage,
  BotTransportMessageRef,
  BotTransportNotifier,
} from './types';
import { BotFollowupService } from './followups';

function createRuntimeControlPlane(): RuntimeControlPlane & { emit: (event: RuntimeStreamEvent) => void } {
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  const issue: RuntimeIssueView = {
    issue_id: 'issue-1',
    work_item_id: 'wi-1',
    identifier: 'INT-1',
    title: 'Governance blocked issue',
    phase: 'DEV',
    tracker_state: 'Todo',
    orchestrator_state: 'halted',
    workspace_path: null,
    branch_name: null,
    github_repo: 'acme/repo',
    github_issue_number: 10,
    active_pr_number: null,
    session: null,
    governance_status: 'advisory',
    governance_decision: 'split_before_implement',
    governance_summary: 'Split this issue before dispatch.',
    active_governance_suggestions: [
      {
        id: 'suggestion-1',
        suggestion_type: 'cleanup',
        status: 'pending',
        title: 'Create a cleanup follow-up',
        summary: 'Split the cleanup work into a dedicated governance issue.',
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

  return {
    getOverview: () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: {
        running: 0,
        retrying: 0,
        total: 1,
      },
      issues: [issue],
    }),
    getIssue: (id: string) => ['issue-1', 'INT-1'].includes(id) ? issue : null,
    getTimeline: () => [],
    getHistoryView: () => ({
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      digest: {
        headline: 'INT-1 · DEV · halted',
        detail: 'Dispatch blocked by governance.',
        history_blurb: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      entries: [],
    }),
    createIssue: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Created',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      issue,
    }),
    stopIssue: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Stopped',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    retryIssue: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Retried',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    overrideGovernance: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Overridden',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    rewriteGovernance: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Rewritten',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    splitGovernance: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Split',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    executeGovernanceSuggestion: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Executed suggestion',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    dismissGovernanceSuggestion: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'Dismissed suggestion',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

class MemoryNotifier implements BotTransportNotifier {
  public readonly messages: Array<{ recipient: BotRecipient; message: BotTransportMessage }> = [];
  public readonly edits: Array<{ recipient: BotRecipient; messageRef: BotTransportMessageRef; message: BotTransportMessage }> = [];

  async sendMessage(recipient: BotRecipient, message: BotTransportMessage): Promise<BotTransportMessageRef> {
    this.messages.push({ recipient, message });
    return {
      provider_message_id: `msg-${this.messages.length}`,
    };
  }

  async editMessage(
    recipient: BotRecipient,
    messageRef: BotTransportMessageRef,
    message: BotTransportMessage,
  ): Promise<BotTransportMessageRef> {
    this.edits.push({ recipient, messageRef, message });
    return messageRef;
  }
}

class DeferredNotifier extends MemoryNotifier {
  constructor(private readonly sendGate: Promise<void>) {
    super();
  }

  override async sendMessage(recipient: BotRecipient, message: BotTransportMessage): Promise<BotTransportMessageRef> {
    this.messages.push({ recipient, message });
    await this.sendGate;
    return {
      provider_message_id: `msg-${this.messages.length}`,
    };
  }
}

describe('BotFollowupService', () => {
  test('deduplicates origin and ops recipients when they point to the same Telegram chat', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-shared',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      telegramOperationsChatId: 'chat-shared',
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'issue',
      data: runtime.getIssue('issue-1')!,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);

    service.dispose();
    db.close();
  });

  test('pushes governance action cards to origin conversation and ops chat', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      telegramOperationsChatId: 'chat-ops',
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-1',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:01:00.000Z',
        level: 'warn',
        category: 'diagnostic',
        code: 'governance_blocked',
        message: 'Split this issue before dispatch.',
        turn: null,
        tool_name: null,
        detail: {
          decision: 'split_before_implement',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(2);
    expect(notifier.edits).toHaveLength(0);
    expect(notifier.messages[0]?.message.format).toBe('telegram_html');
    expect(notifier.messages[0]?.message.text).toContain('<b>待你处理 · INT-1</b>');
    expect(notifier.messages[0]?.message.text).toContain('这张单已被治理拦住');
    expect(notifier.messages[0]?.message.action_rows?.[0]?.[0]?.label).toBe('按方案拆成两个任务');
    expect(notifier.messages[0]?.message.action_rows?.[1]?.[0]?.label).toBe('强制继续开发');
    expect(notifier.messages[0]?.message.action_rows?.[1]?.[0]?.style).toBe('danger');
    expect(notifier.messages[1]?.recipient.conversation_id).toBe('chat-ops');

    service.dispose();
    db.close();
  });

  test('suppresses follow-up digests for an active supervisor session and leaves card edits to SupervisorWorker', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);
    const sessions = new SupervisorSessionRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-origin',
      user_id: 'user-1',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-1',
      plan_card: {
        title: 'Governance blocked issue',
        user_goal: 'Governance blocked issue',
        in_scope: ['Governance blocked issue'],
        out_of_scope: ['不顺手扩展到无关模块。'],
        acceptance: ['完成 blocked issue，并让结果可验证。'],
        known_risks: ['当前治理层要求先拆分。'],
        execution_strategy: 'Create the root thread first.',
        needs_user_approval: true,
        repo_ref: 'acme/repo',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '按推荐先拆分后执行。',
        },
        alternate_option: {
          label: '改一下计划',
          summary: '先改计划再执行。',
        },
        governance_preview: {
          decision: 'split_before_implement',
          summary: 'Split this issue before dispatch.',
          split_suggestions: ['Split runtime and bot work.'],
          rewrite_title: null,
          rewrite_description: null,
        },
      },
      last_message_id: 'msg-99',
      last_card_key: 'session|old',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
      supervisorSessionRepository: sessions,
    });

    runtime.emit({
      type: 'issue',
      data: runtime.getIssue('issue-1')!,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(0);
    expect(notifier.edits).toHaveLength(0);

    service.dispose();
    db.close();
  });

  test('does not post textual governance cards for supervisor-managed child queues', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const issue = runtime.getIssue('issue-1')!;
    Object.assign(issue, {
      identifier: 'INT-150',
      title: '清空仓库，只保留 README',
      governance_thread_state: 'waiting_on_child',
      governance_child_queue: [
        {
          issue_id: 'issue-2',
          issue_identifier: 'INT-151',
          title: '[SUPERVISOR CHILD 1/4 for INT-150] 完成子任务 1',
          tracker_state: 'Todo',
          orchestrator_state: 'discovering',
          governance_decision: null,
          governance_summary: null,
          queue_state: 'current',
          delivery_state: null,
          delivery_code: null,
          delivery_summary: null,
        },
      ],
      governance_current_child: {
        issue_id: 'issue-2',
        issue_identifier: 'INT-151',
        title: '[SUPERVISOR CHILD 1/4 for INT-150] 完成子任务 1',
        tracker_state: 'Todo',
        orchestrator_state: 'discovering',
        governance_decision: null,
        governance_summary: null,
        queue_state: 'current',
        delivery_state: null,
        delivery_code: null,
        delivery_summary: null,
      },
      next_recommended_action: '先处理治理子任务 INT-151',
      supervisor_session_state: 'executing',
      supervisor_plan_summary: '清空仓库，只保留 README',
      supervisor_job_state: 'running',
    });
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-150',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      telegramOperationsChatId: 'chat-ops',
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({ type: 'issue', data: issue });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(0);
    expect(notifier.edits).toHaveLength(0);

    service.dispose();
    db.close();
  });

  test('does not edit supervisor cards from followups when runtime issue events repeat', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);
    const sessions = new SupervisorSessionRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-origin',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'direct_run',
      approval_mode: 'auto',
      plan_version: 1,
      root_issue_id: 'issue-1',
      plan_card: {
        title: 'Clean leftover files',
        user_goal: 'Clean leftover files',
        in_scope: ['清理残留文件'],
        out_of_scope: ['不删除有效源码'],
        acceptance: ['残留文件被清理并通过验证'],
        known_risks: [],
        execution_strategy: '小步清理并验证。',
        needs_user_approval: false,
        repo_ref: 'acme/repo',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '自动执行',
          summary: '直接执行小任务。',
        },
        alternate_option: null,
        governance_preview: null,
      },
      last_message_id: 'msg-existing',
      last_card_key: 'session|stale',
      last_material_outcome: {
        latest_dev_directive_kind: 'request_evidence',
        latest_dev_instruction: '下一轮请补齐 git status 和测试证据。',
        pending_user_notification_job_id: 'job-1',
        pending_user_notification_summary: '当前需要补证据后再继续。',
      },
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
      supervisorSessionRepository: sessions,
    });

    runtime.emit({ type: 'issue', data: runtime.getIssue('issue-1')! });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.edits).toHaveLength(0);

    sessions.update({
      id: 'session-1',
      last_material_outcome: {
        latest_dev_directive_kind: 'request_evidence',
        latest_dev_instruction: '下一轮请补齐 git status 和测试证据。',
        pending_user_notification_job_id: 'job-2',
        pending_user_notification_summary: '当前需要补证据后再继续。',
      },
    });
    runtime.emit({ type: 'issue', data: runtime.getIssue('issue-1')! });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.edits).toHaveLength(0);

    service.dispose();
    db.close();
  });

  test('keeps completed supervisor threads on the existing plan card instead of sending a lifecycle done digest', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const issue = runtime.getIssue('issue-1')!;
    Object.assign(issue, {
      title: 'Supervisor plan completed',
      tracker_state: 'Done',
      orchestrator_state: 'completed',
      governance_status: null,
      governance_decision: null,
      governance_summary: null,
      delivery_state: 'completed',
      delivery_summary: 'PR 已合并，计划线程完成。',
    });
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);
    const sessions = new SupervisorSessionRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-origin',
      user_id: 'user-1',
      state: 'completed',
      repo_ref: 'acme/repo',
      intake_mode: 'direct_run',
      approval_mode: 'auto',
      plan_version: 1,
      root_issue_id: 'issue-1',
      delivery_state: 'completed',
      delivery_summary: 'PR 已合并，计划线程完成。',
      last_message_id: 'msg-existing',
      last_card_key: 'session|session-1|stale',
      plan_card: {
        title: 'Supervisor plan completed',
        user_goal: 'Complete the supervisor plan',
        in_scope: ['完成文档和验证'],
        out_of_scope: ['不扩展其他模块'],
        acceptance: ['PR 合并后完成'],
        known_risks: [],
        execution_strategy: '单步执行并验证。',
        needs_user_approval: false,
        repo_ref: 'acme/repo',
        project_slug: 'repo',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '自动执行',
          summary: '直接执行小任务。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
      supervisorSessionRepository: sessions,
    });

    runtime.emit({
      type: 'issue',
      data: issue,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.edits).toHaveLength(0);
    expect(notifier.messages).toHaveLength(0);

    service.dispose();
    db.close();
  });

  test('updates the root governance card instead of opening a descendant governance card', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const listeners = new Set<(event: RuntimeStreamEvent) => void>();
    const rootIssue: RuntimeIssueView = {
      ...createRuntimeControlPlane().getIssue('issue-1')!,
      identifier: 'INT-36',
      title: '[GOVERNANCE LIVE] Root issue',
      governance_root_issue_identifier: 'INT-36',
      governance_thread_state: 'blocked',
      governance_child_issues: [],
      next_recommended_action: '按方案拆成两个任务',
    } as RuntimeIssueView;
    const childIssue: RuntimeIssueView = {
      ...rootIssue,
      issue_id: 'issue-2',
      work_item_id: 'wi-2',
      identifier: 'INT-38',
      title: '[GOVERNANCE FOLLOW-UP for INT-36] Runtime cleanup',
      tracker_state: 'Todo',
      governance_decision: 'accept_with_rewrite',
      governance_summary: 'INT-38 still needs a rewrite before dispatch.',
      governance_root_issue_identifier: 'INT-36',
      governance_thread_state: 'blocked',
      next_recommended_action: '先改写 INT-38',
    } as RuntimeIssueView;

    const runtime: RuntimeControlPlane & { emit: (event: RuntimeStreamEvent) => void } = {
      getOverview: () => ({
        generated_at: '2026-01-01T00:00:00.000Z',
        counts: { running: 0, retrying: 0, total: 2 },
        issues: [rootIssue, childIssue],
      }),
      getIssue: (id: string) => {
        if (['issue-1', 'INT-36'].includes(id)) {
          return rootIssue;
        }
        if (['issue-2', 'INT-38'].includes(id)) {
          return childIssue;
        }
        return null;
      },
      getTimeline: () => [],
      getHistoryView: () => null,
      createIssue: async () => ({ accepted: true, status: 'accepted', message: 'Created', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier, issue: rootIssue }),
      stopIssue: async () => ({ accepted: true, status: 'accepted', message: 'Stopped', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      retryIssue: async () => ({ accepted: true, status: 'accepted', message: 'Retried', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      overrideGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Overridden', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      rewriteGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Rewritten', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      splitGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Split', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      executeGovernanceSuggestion: async () => ({ accepted: true, status: 'accepted', message: 'Executed suggestion', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      dismissGovernanceSuggestion: async () => ({ accepted: true, status: 'accepted', message: 'Dismissed suggestion', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      createStream: () => new ReadableStream<Uint8Array>(),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event) => {
        for (const listener of listeners) {
          listener(event);
        }
      },
    };
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-root',
      issue_id: 'issue-1',
      issue_identifier: 'INT-36',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'issue',
      data: rootIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    rootIssue.governance_thread_state = 'waiting_on_child';
    rootIssue.governance_child_issues = [{
      issue_id: 'issue-2',
      issue_identifier: 'INT-38',
      title: childIssue.title,
      tracker_state: childIssue.tracker_state,
      orchestrator_state: childIssue.orchestrator_state,
      governance_decision: childIssue.governance_decision ?? null,
      governance_summary: childIssue.governance_summary ?? null,
    }];
    rootIssue.next_recommended_action = '先处理治理子任务 INT-38';

    runtime.emit({
      type: 'issue',
      data: childIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(notifier.edits).toHaveLength(1);
    expect(notifier.edits[0]?.message.text).toContain('治理子任务 INT-38');
    expect(
      messageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: 'chat-root',
        issue_id: 'issue-1',
      })?.card_state,
    ).toBe('waiting_on_child');
    expect(
      messageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: 'chat-root',
        issue_id: 'issue-2',
      }),
    ).toBeNull();

    service.dispose();
    db.close();
  });

  test('edits the existing blocked card instead of sending a duplicate message when governance details change', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-1',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:01:00.000Z',
        level: 'warn',
        category: 'diagnostic',
        code: 'governance_blocked',
        message: 'Split this issue before dispatch.',
        turn: null,
        tool_name: null,
        detail: {
          decision: 'split_before_implement',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const updatedIssue = runtime.getIssue('issue-1');
    if (!updatedIssue) {
      throw new Error('Expected issue-1 to exist');
    }
    updatedIssue.governance_summary = 'Split this issue into runtime cleanup and Telegram UX cleanup before dispatch.';
    updatedIssue.active_governance_suggestions = [
      {
        id: 'suggestion-2',
        suggestion_type: 'architecture_alignment',
        status: 'pending',
        title: 'Split INT-1 before implementation',
        summary: 'Separate runtime cleanup from Telegram UX cleanup.',
        can_execute: true,
        can_dismiss: true,
      },
    ];

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-2',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:02:00.000Z',
        level: 'warn',
        category: 'diagnostic',
        code: 'governance_blocked',
        message: updatedIssue.governance_summary,
        turn: null,
        tool_name: null,
        detail: {
          decision: 'split_before_implement',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(notifier.edits).toHaveLength(1);
    expect(notifier.edits[0]?.messageRef.provider_message_id).toBe('msg-1');
    expect(notifier.edits[0]?.message.format).toBe('telegram_html');
    expect(notifier.edits[0]?.message.text).toContain('runtime cleanup');

    service.dispose();
    db.close();
  });

  test('only pushes high-signal ordinary lifecycle updates once per notification class', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const ordinaryIssue = runtime.getIssue('issue-1');
    if (!ordinaryIssue) {
      throw new Error('Expected issue-1 to exist');
    }
    ordinaryIssue.title = 'Ordinary lifecycle issue';
    ordinaryIssue.tracker_state = 'In Progress';
    ordinaryIssue.orchestrator_state = 'discovering';
    ordinaryIssue.governance_status = null;
    ordinaryIssue.governance_decision = null;
    ordinaryIssue.governance_summary = null;
    ordinaryIssue.active_governance_suggestions = [];
    ordinaryIssue.actions = {
      can_stop: true,
      can_retry: true,
      can_override_governance: false,
      can_rewrite_governance: false,
      can_split_governance: false,
      can_open_pr: false,
    };

    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        orchestrator_state: 'discovering',
      },
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        orchestrator_state: 'retry_scheduled',
      },
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        orchestrator_state: 'dev_running',
      },
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        orchestrator_state: 'retry_scheduled',
      },
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        orchestrator_state: 'failed',
      },
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        tracker_state: 'Done',
        orchestrator_state: 'completed',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(3);
    expect(notifier.messages[0]?.message.text).toContain('INT-1');
    expect(notifier.messages[1]?.message.text).toContain('INT-1');
    expect(notifier.messages[2]?.message.text).toContain('INT-1');

    service.dispose();
    db.close();
  });

  test('persists lifecycle dedupe across service restarts and records outbound delivery audits', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const ordinaryIssue = runtime.getIssue('issue-1');
    if (!ordinaryIssue) {
      throw new Error('Expected issue-1 to exist');
    }

    ordinaryIssue.title = 'Ordinary lifecycle issue';
    ordinaryIssue.tracker_state = 'In Progress';
    ordinaryIssue.orchestrator_state = 'retry_scheduled';
    ordinaryIssue.governance_status = null;
    ordinaryIssue.governance_decision = null;
    ordinaryIssue.governance_summary = null;
    ordinaryIssue.active_governance_suggestions = [];
    ordinaryIssue.actions = {
      can_stop: false,
      can_retry: true,
      can_override_governance: false,
      can_rewrite_governance: false,
      can_split_governance: false,
      can_open_pr: false,
    };

    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);
    const deliveryStates = new BotFollowupDeliveryStateRepository(db);
    const transportEvents = new BotTransportEventRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const firstService = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
      deliveryStateRepository: deliveryStates,
      transportEventRepository: transportEvents,
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        orchestrator_state: 'retry_scheduled',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(
      deliveryStates.findByKey({
        transport: 'telegram',
        conversation_id: 'chat-origin',
        root_issue_id: 'issue-1',
        delivery_kind: 'lifecycle_digest',
      }),
    ).toEqual(expect.objectContaining({
      last_notification_class: 'retrying',
      last_material_key: 'class:retrying',
    }));
    expect(
      transportEvents.findByRootIssue({
        transport: 'telegram',
        conversation_id: 'chat-origin',
        root_issue_id: 'issue-1',
      }),
    ).toEqual([
      expect.objectContaining({
        source: 'lifecycle_digest',
        action: 'send',
        result: 'success',
      }),
    ]);

    firstService.dispose();

    const secondService = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
      deliveryStateRepository: deliveryStates,
      transportEventRepository: transportEvents,
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        orchestrator_state: 'retry_scheduled',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);

    secondService.dispose();
    db.close();
  });

  test('suppresses duplicate retrying digests while the first lifecycle send is still in flight', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const ordinaryIssue = runtime.getIssue('issue-1');
    if (!ordinaryIssue) {
      throw new Error('Expected issue-1 to exist');
    }

    ordinaryIssue.title = 'Ordinary lifecycle issue';
    ordinaryIssue.tracker_state = 'In Progress';
    ordinaryIssue.orchestrator_state = 'retry_scheduled';
    ordinaryIssue.governance_status = null;
    ordinaryIssue.governance_decision = null;
    ordinaryIssue.governance_summary = null;
    ordinaryIssue.active_governance_suggestions = [];
    ordinaryIssue.actions = {
      can_stop: false,
      can_retry: true,
      can_override_governance: false,
      can_rewrite_governance: false,
      can_split_governance: false,
      can_open_pr: false,
    };

    let releaseSend: (() => void) | null = null;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const notifier = new DeferredNotifier(sendGate);
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);
    const deliveryStates = new BotFollowupDeliveryStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
      deliveryStateRepository: deliveryStates,
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        orchestrator_state: 'retry_scheduled',
      },
    });
    runtime.emit({
      type: 'issue',
      data: {
        ...ordinaryIssue,
        orchestrator_state: 'retry_scheduled',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSend?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(
      deliveryStates.findByKey({
        transport: 'telegram',
        conversation_id: 'chat-origin',
        root_issue_id: 'issue-1',
        delivery_kind: 'lifecycle_digest',
      }),
    ).toEqual(expect.objectContaining({
      last_notification_class: 'retrying',
    }));

    service.dispose();
    db.close();
  });

  test('suppresses duplicate governance card sends while the first card send is still in flight', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const issue = runtime.getIssue('issue-1');
    if (!issue) {
      throw new Error('Expected issue-1 to exist');
    }
    issue.governance_thread_state = 'waiting_on_child';
    issue.governance_current_child = {
      issue_id: 'issue-child-1',
      issue_identifier: 'INT-2',
      title: 'Current child',
      tracker_state: 'In Progress',
      orchestrator_state: 'dev_running',
      governance_decision: null,
      governance_summary: null,
      queue_state: 'current',
      delivery_state: null,
      delivery_code: null,
      delivery_summary: null,
    };
    issue.governance_child_queue = [issue.governance_current_child];
    issue.next_recommended_action = '先处理治理子任务 INT-2';

    let releaseSend: (() => void) | null = null;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const notifier = new DeferredNotifier(sendGate);
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);
    const deliveryStates = new BotFollowupDeliveryStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
      deliveryStateRepository: deliveryStates,
    });

    runtime.emit({ type: 'issue', data: issue });
    runtime.emit({ type: 'issue', data: issue });

    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSend?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(
      messageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: 'chat-origin',
        issue_id: 'issue-1',
      })?.message_id,
    ).toBe('msg-1');

    service.dispose();
    db.close();
  });

  test('keeps the waiting-on-child root card stable while child issues retry and resume', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const listeners = new Set<(event: RuntimeStreamEvent) => void>();
    const rootIssue: RuntimeIssueView = {
      ...createRuntimeControlPlane().getIssue('issue-1')!,
      identifier: 'INT-44',
      title: '[GOVERNANCE LIVE] Root issue',
      governance_root_issue_identifier: 'INT-44',
      governance_thread_state: 'waiting_on_child',
      governance_child_issues: [{
        issue_id: 'issue-2',
        issue_identifier: 'INT-45',
        title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
        tracker_state: 'Todo',
        orchestrator_state: 'halted',
        governance_decision: 'accept_with_rewrite',
        governance_summary: 'INT-45 still needs a rewrite before dispatch.',
      }],
      next_recommended_action: '先处理治理子任务 INT-45；后续会按顺序接力。',
    } as RuntimeIssueView;
    const childIssue: RuntimeIssueView = {
      ...rootIssue,
      issue_id: 'issue-2',
      work_item_id: 'wi-2',
      identifier: 'INT-45',
      title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
      tracker_state: 'Todo',
      governance_decision: 'accept_with_rewrite',
      governance_summary: 'INT-45 still needs a rewrite before dispatch.',
      governance_root_issue_identifier: 'INT-44',
      governance_thread_state: 'blocked',
      next_recommended_action: '先改写 INT-45',
    } as RuntimeIssueView;

    const runtime: RuntimeControlPlane & { emit: (event: RuntimeStreamEvent) => void } = {
      getOverview: () => ({
        generated_at: '2026-01-01T00:00:00.000Z',
        counts: { running: 0, retrying: 0, total: 2 },
        issues: [rootIssue, childIssue],
      }),
      getIssue: (id: string) => {
        if (['issue-1', 'INT-44'].includes(id)) {
          return rootIssue;
        }
        if (['issue-2', 'INT-45'].includes(id)) {
          return childIssue;
        }
        return null;
      },
      getTimeline: () => [],
      getHistoryView: () => null,
      createIssue: async () => ({ accepted: true, status: 'accepted', message: 'Created', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier, issue: rootIssue }),
      stopIssue: async () => ({ accepted: true, status: 'accepted', message: 'Stopped', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      retryIssue: async () => ({ accepted: true, status: 'accepted', message: 'Retried', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      overrideGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Overridden', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      rewriteGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Rewritten', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      splitGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Split', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      executeGovernanceSuggestion: async () => ({ accepted: true, status: 'accepted', message: 'Executed suggestion', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      dismissGovernanceSuggestion: async () => ({ accepted: true, status: 'accepted', message: 'Dismissed suggestion', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      createStream: () => new ReadableStream<Uint8Array>(),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event) => {
        for (const listener of listeners) {
          listener(event);
        }
      },
    };
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-root',
      issue_id: 'issue-1',
      issue_identifier: 'INT-44',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'issue',
      data: rootIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    childIssue.tracker_state = 'In Progress';
    childIssue.orchestrator_state = 'retry_scheduled';
    childIssue.governance_decision = 'accept';
    childIssue.governance_summary = 'INT-45 is retrying after a failed attempt.';
    rootIssue.governance_child_issues = [{
      issue_id: 'issue-2',
      issue_identifier: 'INT-45',
      title: childIssue.title,
      tracker_state: childIssue.tracker_state,
      orchestrator_state: childIssue.orchestrator_state,
      governance_decision: childIssue.governance_decision ?? null,
      governance_summary: childIssue.governance_summary ?? null,
    }];

    runtime.emit({
      type: 'issue',
      data: childIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    childIssue.orchestrator_state = 'dev_running';
    childIssue.governance_summary = 'INT-45 resumed after retry.';
    rootIssue.governance_child_issues = [{
      issue_id: 'issue-2',
      issue_identifier: 'INT-45',
      title: childIssue.title,
      tracker_state: childIssue.tracker_state,
      orchestrator_state: childIssue.orchestrator_state,
      governance_decision: childIssue.governance_decision ?? null,
      governance_summary: childIssue.governance_summary ?? null,
    }];

    runtime.emit({
      type: 'issue',
      data: childIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(notifier.edits).toHaveLength(0);
    expect(
      messageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: 'chat-root',
        issue_id: 'issue-1',
      })?.message_id,
    ).toBe('msg-1');

    service.dispose();
    db.close();
  });

  test('updates the root governance card once when the current child hits a delivery failure', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const listeners = new Set<(event: RuntimeStreamEvent) => void>();
    const rootIssue: RuntimeIssueView = {
      ...createRuntimeControlPlane().getIssue('issue-1')!,
      identifier: 'INT-44',
      title: '[GOVERNANCE LIVE] Root issue',
      governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
      governance_root_issue_identifier: 'INT-44',
      governance_thread_state: 'waiting_on_child',
      governance_child_issues: [{
        issue_id: 'issue-2',
        issue_identifier: 'INT-45',
        title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
        tracker_state: 'In Progress',
        orchestrator_state: 'failed',
        governance_decision: 'accept',
        governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
      }],
      governance_current_child: {
        issue_id: 'issue-2',
        issue_identifier: 'INT-45',
        title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
        tracker_state: 'In Progress',
        orchestrator_state: 'failed',
        governance_decision: 'accept',
        governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
        queue_state: 'current',
      },
      governance_child_queue: [{
        issue_id: 'issue-2',
        issue_identifier: 'INT-45',
        title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
        tracker_state: 'In Progress',
        orchestrator_state: 'failed',
        governance_decision: 'accept',
        governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
        queue_state: 'current',
      }],
      next_recommended_action: '先处理治理子任务 INT-45',
    } as RuntimeIssueView;
    const childIssue: RuntimeIssueView = {
      ...rootIssue,
      issue_id: 'issue-2',
      work_item_id: 'wi-2',
      identifier: 'INT-45',
      title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
      governance_root_issue_identifier: 'INT-44',
      governance_thread_state: null,
      governance_child_issues: [],
      governance_current_child: null,
      governance_child_queue: [],
      delivery_state: 'delivery_failed',
      delivery_summary: '证据已满足，但交付卡在 dirty workspace；当前还没能创建 PR。',
    } as RuntimeIssueView;

    const runtime: RuntimeControlPlane & { emit: (event: RuntimeStreamEvent) => void } = {
      getOverview: () => ({
        generated_at: '2026-01-01T00:00:00.000Z',
        counts: { running: 0, retrying: 0, total: 2 },
        issues: [rootIssue, childIssue],
      }),
      getIssue: (id: string) => {
        if (['issue-1', 'INT-44'].includes(id)) {
          return rootIssue;
        }
        if (['issue-2', 'INT-45'].includes(id)) {
          return childIssue;
        }
        return null;
      },
      getTimeline: () => [],
      getHistoryView: () => null,
      createIssue: async () => ({ accepted: true, status: 'accepted', message: 'Created', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier, issue: rootIssue }),
      stopIssue: async () => ({ accepted: true, status: 'accepted', message: 'Stopped', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      retryIssue: async () => ({ accepted: true, status: 'accepted', message: 'Retried', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      overrideGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Overridden', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      rewriteGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Rewritten', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      splitGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Split', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      executeGovernanceSuggestion: async () => ({ accepted: true, status: 'accepted', message: 'Executed suggestion', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      dismissGovernanceSuggestion: async () => ({ accepted: true, status: 'accepted', message: 'Dismissed suggestion', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      createStream: () => new ReadableStream<Uint8Array>(),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event) => {
        for (const listener of listeners) {
          listener(event);
        }
      },
    };
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-root',
      issue_id: 'issue-1',
      issue_identifier: 'INT-44',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'issue',
      data: rootIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.emit({
      type: 'issue',
      data: childIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.emit({
      type: 'issue',
      data: childIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(notifier.edits).toHaveLength(1);
    expect(notifier.edits[0]?.message.text).toContain('dirty workspace');
    expect(notifier.edits[0]?.message.text).not.toContain('No .symphony-constitution.md found yet');

    service.dispose();
    db.close();
  });

  test('surfaces a single root-card failure update when the current child fails and does not churn back on retry', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const listeners = new Set<(event: RuntimeStreamEvent) => void>();
    const rootIssue: RuntimeIssueView = {
      ...createRuntimeControlPlane().getIssue('issue-1')!,
      identifier: 'INT-48',
      title: '[GOVERNANCE LIVE] Root issue',
      governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
      governance_root_issue_identifier: 'INT-48',
      governance_thread_state: 'waiting_on_child',
      governance_child_issues: [{
        issue_id: 'issue-2',
        issue_identifier: 'INT-49',
        title: '[GOVERNANCE FOLLOW-UP for INT-48] Bot cleanup',
        tracker_state: 'In Progress',
        orchestrator_state: 'dev_running',
        governance_decision: 'accept',
        governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
        queue_state: 'current',
      }],
      governance_current_child: {
        issue_id: 'issue-2',
        issue_identifier: 'INT-49',
        title: '[GOVERNANCE FOLLOW-UP for INT-48] Bot cleanup',
        tracker_state: 'In Progress',
        orchestrator_state: 'dev_running',
        governance_decision: 'accept',
        governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
        queue_state: 'current',
      },
      governance_child_queue: [{
        issue_id: 'issue-2',
        issue_identifier: 'INT-49',
        title: '[GOVERNANCE FOLLOW-UP for INT-48] Bot cleanup',
        tracker_state: 'In Progress',
        orchestrator_state: 'dev_running',
        governance_decision: 'accept',
        governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
        queue_state: 'current',
      }],
      next_recommended_action: '先处理治理子任务 INT-49',
    } as RuntimeIssueView;
    const childIssue: RuntimeIssueView = {
      ...rootIssue,
      issue_id: 'issue-2',
      work_item_id: 'wi-2',
      identifier: 'INT-49',
      title: '[GOVERNANCE FOLLOW-UP for INT-48] Bot cleanup',
      governance_root_issue_identifier: 'INT-48',
      governance_thread_state: null,
      governance_child_issues: [],
      governance_current_child: null,
      governance_child_queue: [],
      delivery_state: null,
      delivery_summary: null,
    } as RuntimeIssueView;

    const runtime: RuntimeControlPlane & { emit: (event: RuntimeStreamEvent) => void } = {
      getOverview: () => ({
        generated_at: '2026-01-01T00:00:00.000Z',
        counts: { running: 0, retrying: 0, total: 2 },
        issues: [rootIssue, childIssue],
      }),
      getIssue: (id: string) => {
        if (['issue-1', 'INT-48'].includes(id)) {
          return rootIssue;
        }
        if (['issue-2', 'INT-49'].includes(id)) {
          return childIssue;
        }
        return null;
      },
      getTimeline: () => [],
      getHistoryView: () => null,
      createIssue: async () => ({ accepted: true, status: 'accepted', message: 'Created', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier, issue: rootIssue }),
      stopIssue: async () => ({ accepted: true, status: 'accepted', message: 'Stopped', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      retryIssue: async () => ({ accepted: true, status: 'accepted', message: 'Retried', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      overrideGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Overridden', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      rewriteGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Rewritten', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      splitGovernance: async () => ({ accepted: true, status: 'accepted', message: 'Split', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      executeGovernanceSuggestion: async () => ({ accepted: true, status: 'accepted', message: 'Executed suggestion', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      dismissGovernanceSuggestion: async () => ({ accepted: true, status: 'accepted', message: 'Dismissed suggestion', issue_id: rootIssue.issue_id, issue_identifier: rootIssue.identifier }),
      createStream: () => new ReadableStream<Uint8Array>(),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event) => {
        for (const listener of listeners) {
          listener(event);
        }
      },
    };
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-root',
      issue_id: 'issue-1',
      issue_identifier: 'INT-48',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'issue',
      data: rootIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    childIssue.orchestrator_state = 'failed';
    runtime.emit({
      type: 'issue',
      data: childIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    childIssue.orchestrator_state = 'retry_scheduled';
    runtime.emit({
      type: 'issue',
      data: childIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    childIssue.orchestrator_state = 'dev_running';
    runtime.emit({
      type: 'issue',
      data: childIssue,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(notifier.edits).toHaveLength(1);
    expect(notifier.edits[0]?.message.text).toContain('当前子任务');
    expect(notifier.edits[0]?.message.text).toContain('执行失败');
    expect(
      messageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: 'chat-root',
        issue_id: 'issue-1',
      })?.message_id,
    ).toBe('msg-1');

    service.dispose();
    db.close();
  });

  test('suppresses normal lifecycle digests while a blocked governance card is open and resolves the same card when the issue unblocks', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-1',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:01:00.000Z',
        level: 'warn',
        category: 'diagnostic',
        code: 'governance_blocked',
        message: 'Split this issue before dispatch.',
        turn: null,
        tool_name: null,
        detail: {
          decision: 'split_before_implement',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-2',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:02:00.000Z',
        level: 'info',
        category: 'diagnostic',
        code: 'turn_completed',
        message: 'Completed another turn.',
        turn: 1,
        tool_name: null,
        detail: {},
      },
    });

    runtime.emit({
      type: 'issue',
      data: {
        ...runtime.getIssue('issue-1')!,
        orchestrator_state: 'dev_running',
        governance_status: null,
        governance_decision: null,
        governance_summary: null,
        active_governance_suggestions: [],
        actions: {
          can_stop: true,
          can_retry: false,
          can_override_governance: false,
          can_rewrite_governance: false,
          can_split_governance: false,
          can_open_pr: false,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);
    expect(notifier.edits).toHaveLength(1);
    expect(notifier.edits[0]?.message.format).toBe('telegram_html');
    expect(notifier.edits[0]?.message.text).toContain('<b>已处理 · INT-1</b>');
    expect(notifier.edits[0]?.message.action_rows ?? []).toHaveLength(0);

    service.dispose();
    db.close();
  });

  test('does not double-send when the origin conversation matches the operations chat', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'shared-chat',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      telegramOperationsChatId: 'shared-chat',
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-1',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:01:00.000Z',
        level: 'warn',
        category: 'diagnostic',
        code: 'governance_blocked',
        message: 'Split this issue before dispatch.',
        turn: null,
        tool_name: null,
        detail: {
          decision: 'split_before_implement',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(1);

    service.dispose();
    db.close();
  });

  test('does not push degraded governance boilerplate as a standalone timeline digest', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const runtime = createRuntimeControlPlane();
    const issue = runtime.getIssue('issue-1')!;
    issue.governance_status = 'degraded';
    issue.governance_decision = 'accept';
    issue.governance_summary = 'No .symphony-constitution.md found yet, so governance is running in degraded mode.';
    issue.orchestrator_state = 'dev_running';
    issue.actions = {
      can_stop: true,
      can_retry: false,
      can_override_governance: false,
      can_rewrite_governance: false,
      can_split_governance: false,
      can_open_pr: false,
    };
    const notifier = new MemoryNotifier();
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-origin',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      user_id: 'user-1',
      role: 'origin',
    });

    const service = new BotFollowupService(runtime, {
      telegram: notifier,
    }, followups, messageStates, {
      bootstrapCurrentGovernanceCards: false,
    });

    runtime.emit({
      type: 'timeline',
      data: {
        id: 'event-degraded',
        issue_id: 'issue-1',
        issue_identifier: 'INT-1',
        timestamp: '2026-01-01T00:01:00.000Z',
        level: 'info',
        category: 'diagnostic',
        code: 'governance_assessed',
        message: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
        turn: null,
        tool_name: null,
        detail: {},
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.messages).toHaveLength(0);

    service.dispose();
    db.close();
  });
});
