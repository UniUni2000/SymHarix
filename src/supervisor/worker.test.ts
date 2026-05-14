import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  BotTransportEventRepository,
  SupervisorSessionEventRepository,
  SupervisorSessionRepository,
  initializeSchema,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeStreamEvent } from '../runtime/types';
import type {
  BotRecipient,
  BotTransportMessage,
  BotTransportMessageRef,
  BotTransportNotifier,
} from '../bots/types';
import { BotMessageEditError } from '../bots/types';
import { SupervisorSessionService } from './sessionService';
import { SupervisorWorker } from './worker';
import { SupervisorSessionCardLock } from './sessionCardLock';

function createIssueView(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-root',
    work_item_id: 'wi-root',
    identifier: 'INT-1',
    title: 'Root issue',
    phase: 'DEV',
    tracker_state: 'In Progress',
    orchestrator_state: 'halted',
    workspace_path: null,
    branch_name: null,
    github_repo: 'UniUni2000/test2',
    github_issue_number: null,
    active_pr_number: null,
    session: null,
    governance_status: 'blocked',
    governance_decision: 'split_before_implement',
    governance_summary: 'Split this issue before dispatch.',
    governance_root_issue_id: 'issue-root',
    governance_root_issue_identifier: 'INT-1',
    governance_thread_state: 'waiting_on_child',
    governance_child_issues: [],
    governance_current_child: {
      issue_id: 'issue-child',
      issue_identifier: 'INT-2',
      title: 'Current child',
      tracker_state: 'Todo',
      orchestrator_state: 'discovering',
      governance_decision: null,
      governance_summary: null,
      queue_state: 'current',
      delivery_state: null,
      delivery_code: null,
      delivery_summary: null,
    },
    governance_child_queue: [],
    next_recommended_action: '先处理治理子任务 INT-2',
    delivery_state: null,
    delivery_code: null,
    delivery_summary: null,
    active_governance_suggestions: [],
    actions: {
      can_stop: false,
      can_retry: true,
      can_override_governance: true,
      can_rewrite_governance: true,
      can_split_governance: true,
      can_open_pr: false,
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createRuntimeHarness(initialIssue: RuntimeIssueView | null = null): {
  runtime: RuntimeControlPlane;
  emitIssue: (issue: RuntimeIssueView) => void;
} {
  let currentIssue = initialIssue;
  const listeners = new Set<(event: RuntimeStreamEvent) => void>();
  return {
    emitIssue: (issue) => {
      currentIssue = issue;
      listeners.forEach((listener) => listener({
        type: 'issue',
        data: issue,
      }));
    },
    runtime: {
    getOverview: () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: currentIssue ? 1 : 0 },
      issues: currentIssue ? [currentIssue] : [],
    }),
    getIssue: (id: string) => {
      if (!currentIssue) {
        return null;
      }
      return [currentIssue.issue_id, currentIssue.identifier].includes(id) ? currentIssue : null;
    },
    getTimeline: () => [],
    getHistoryView: () => null,
    createIssue: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
      issue: null,
    }),
    stopIssue: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    retryIssue: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    overrideGovernance: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    rewriteGovernance: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    splitGovernance: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    executeGovernanceSuggestion: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    dismissGovernanceSuggestion: async () => ({
      accepted: false,
      status: 'rejected',
      message: 'unsupported',
      issue_id: null,
      issue_identifier: null,
    }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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

class SlowEditNotifier extends MemoryNotifier {
  async editMessage(
    recipient: BotRecipient,
    messageRef: BotTransportMessageRef,
    message: BotTransportMessage,
  ): Promise<BotTransportMessageRef> {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return super.editMessage(recipient, messageRef, message);
  }
}

class DeferredSendNotifier extends MemoryNotifier {
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

class HardFailEditNotifier extends MemoryNotifier {
  async editMessage(): Promise<BotTransportMessageRef> {
    throw new BotMessageEditError('hard_failure', 'cannot edit media message', 400, 'Bad Request');
  }
}

async function waitForNotifier(
  notifier: MemoryNotifier,
  expectedEdits: number,
  expectedMessages: number,
): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (notifier.edits.length >= expectedEdits && notifier.messages.length >= expectedMessages) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('SupervisorWorker', () => {
  test('restores awaiting-approval session cards on reconcile without duplicating the same card twice', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const transportEvents = new BotTransportEventRepository(db);
    const { runtime } = createRuntimeHarness(null);
    const notifier = new MemoryNotifier();
    const sessionService = new SupervisorSessionService(runtime, null, sessions, events);
    const worker = new SupervisorWorker({
      runtime,
      sessionService,
      sessionRepository: sessions,
      transportEventRepository: transportEvents,
      notifiers: {
        telegram: notifier,
      },
    });

    const session = sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_approval',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      plan_card: {
        title: 'Runtime cleanup',
        user_goal: 'Runtime cleanup',
        in_scope: ['清理 runtime 主链'],
        out_of_scope: ['不顺手改 bot'],
        acceptance: ['清理完成且结果可验证'],
        known_risks: ['需要先批准'],
        execution_strategy: '先批准计划再物化 root issue。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '批准后开始执行。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    await worker.reconcile();
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]?.message.text).toContain('计划待你批准');
    expect(notifier.messages[0]?.message.text).toContain('我已理解的计划');
    expect(notifier.messages[0]?.message.text).toContain('批准后会发生什么');
    expect(notifier.messages[0]?.message.action_rows?.[0]?.[0]?.label).toBe('批准并开始');
    expect(sessions.findById(session.id)?.last_message_id).toBe('msg-1');
    const firstEventCount = transportEvents.findAll().length;

    await worker.reconcile();
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.edits).toHaveLength(0);
    expect(transportEvents.findAll()).toHaveLength(firstEventCount);
  });

  test('edits the existing executing session card when the material key changes for the same root thread', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const transportEvents = new BotTransportEventRepository(db);
    const issue = createIssueView();
    const { runtime } = createRuntimeHarness(issue);
    const notifier = new MemoryNotifier();
    const sessionService = new SupervisorSessionService(runtime, null, sessions, events);
    const worker = new SupervisorWorker({
      runtime,
      sessionService,
      sessionRepository: sessions,
      transportEventRepository: transportEvents,
      notifiers: {
        telegram: notifier,
      },
    });

    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-root',
      current_child_issue_id: 'issue-child',
      last_message_id: 'msg-existing',
      last_card_key: 'session|session-1|stale',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['按顺序执行 child queue'],
        out_of_scope: ['不并发执行 sibling child'],
        acceptance: ['当前 child 完成后自动接力'],
        known_risks: [],
        execution_strategy: 'root 保持等待，当前 child 先推进。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进当前 child。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    await worker.reconcileSession('session-1');

    expect(notifier.messages).toHaveLength(0);
    expect(notifier.edits).toHaveLength(1);
    expect(notifier.edits[0]?.message.text).toContain('当前子任务');
    expect(notifier.edits[0]?.messageRef.provider_message_id).toBe('msg-existing');
    expect(sessions.findById('session-1')?.last_message_id).toBe('msg-existing');
    expect(sessions.findById('session-1')?.last_card_key).toContain('session|session-1|v2|executing');
  });

  test('does not send duplicate initial supervisor cards while the first send is in flight', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const issue = createIssueView();
    const { runtime } = createRuntimeHarness(issue);
    let releaseSend: (() => void) | null = null;
    const notifier = new DeferredSendNotifier(new Promise((resolve) => {
      releaseSend = resolve;
    }));
    const sessionService = new SupervisorSessionService(runtime, null, sessions, events);
    const worker = new SupervisorWorker({
      runtime,
      sessionService,
      sessionRepository: sessions,
      notifiers: {
        telegram: notifier,
      },
    });

    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-root',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['按顺序执行'],
        out_of_scope: ['不重复发卡'],
        acceptance: ['只保留一张初始卡'],
        known_risks: [],
        execution_strategy: '执行中保持单卡。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const first = worker.reconcileSession('session-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await worker.reconcileSession('session-1');
    releaseSend?.();
    await first;

    expect(notifier.messages).toHaveLength(1);
    expect(sessions.findById('session-1')?.last_message_id).toBe('msg-1');

    worker.dispose();
    db.close();
  });

  test('does not send an initial supervisor card while Gateway owns the session card lock', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const issue = createIssueView();
    const { runtime } = createRuntimeHarness(issue);
    const notifier = new MemoryNotifier();
    const sessionService = new SupervisorSessionService(runtime, null, sessions, events);
    const sessionCardLock = new SupervisorSessionCardLock();
    const worker = new SupervisorWorker({
      runtime,
      sessionService,
      sessionRepository: sessions,
      notifiers: {
        telegram: notifier,
      },
      sessionCardLock,
    });

    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-root',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['按顺序执行'],
        out_of_scope: ['不重复发卡'],
        acceptance: ['只保留引用用户消息的卡'],
        known_risks: [],
        execution_strategy: '执行中保持单卡。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });
    const release = sessionCardLock.acquire({
      transport: 'telegram',
      conversation_id: 'chat-1',
      session_id: 'session-1',
    });

    await worker.reconcileSession('session-1');
    expect(notifier.messages).toHaveLength(0);

    sessions.update({
      id: 'session-1',
      last_message_id: 'msg-from-gateway',
      last_card_key: 'session|session-1|gateway',
    });
    release();
    await worker.reconcileSession('session-1');

    expect(notifier.messages).toHaveLength(0);
    expect(notifier.edits).toHaveLength(1);
    expect(notifier.edits[0]?.messageRef.provider_message_id).toBe('msg-from-gateway');

    worker.dispose();
    db.close();
  });

  test('does not send an initial supervisor card when the conversation already has an active card', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const issue = createIssueView();
    const { runtime } = createRuntimeHarness(issue);
    const notifier = new MemoryNotifier();
    const sessionService = new SupervisorSessionService(runtime, null, sessions, events);
    const worker = new SupervisorWorker({
      runtime,
      sessionService,
      sessionRepository: sessions,
      notifiers: {
        telegram: notifier,
      },
    });

    sessions.create({
      id: 'session-existing',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-existing',
      last_message_id: 'msg-existing',
      last_card_key: 'session|session-existing|v2|executing',
      plan_card: {
        title: 'Existing issue',
        user_goal: 'Existing issue',
        in_scope: ['已有运行面板'],
        out_of_scope: ['不新增面板'],
        acceptance: ['复用现有面板'],
        known_risks: [],
        execution_strategy: '保持单卡。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '继续',
          summary: '继续推进。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-root',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['新增 issue'],
        out_of_scope: ['重复运行面板'],
        acceptance: ['不发第二张初始卡'],
        known_risks: [],
        execution_strategy: '已有面板时静默。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '继续',
          summary: '继续推进。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    await worker.reconcileSession('session-1');

    expect(notifier.messages).toHaveLength(0);
    expect(notifier.edits).toHaveLength(0);
    expect(sessions.findById('session-1')?.last_message_id).toBeNull();

    worker.dispose();
    db.close();
  });

  test('keeps one supervisor card when a Telegram edit fails with a hard error', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const transportEvents = new BotTransportEventRepository(db);
    const issue = createIssueView({
      session: {
        session_id: 'live-1',
        turn_count: 2,
        stage: 'coding',
        last_event: 'tool',
        last_message: '正在检查删除范围。',
        started_at: '2026-01-01T00:00:00.000Z',
        last_event_at: '2026-01-01T00:02:00.000Z',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        recent_tools: [],
        recent_files: [],
      },
    });
    const { runtime } = createRuntimeHarness(issue);
    const notifier = new HardFailEditNotifier();
    const sessionService = new SupervisorSessionService(runtime, null, sessions, events);
    const worker = new SupervisorWorker({
      runtime,
      sessionService,
      sessionRepository: sessions,
      transportEventRepository: transportEvents,
      notifiers: {
        telegram: notifier,
      },
    });

    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-root',
      last_message_id: 'msg-existing',
      last_card_key: 'session|session-1|stale',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['删除 docs 目录'],
        out_of_scope: ['不删除 GitHub 仓库'],
        acceptance: ['变更可验证'],
        known_risks: [],
        execution_strategy: '单 issue 执行并交付证据。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '继续',
          summary: '继续推进。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    await worker.reconcileSession('session-1');

    expect(notifier.messages).toHaveLength(0);
    expect(sessions.findById('session-1')?.last_message_id).toBe('msg-existing');
    expect(sessions.findById('session-1')?.last_card_key).toBe('session|session-1|stale');
    expect(transportEvents.findAll().map((event) => event.action)).toEqual(['edit']);
    expect(transportEvents.findAll()[0]?.result).toBe('failed');
  });

  test('coalesces concurrent reconciles for the same session material key into one edit', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const issue = createIssueView({
      governance_thread_state: 'executing',
      next_recommended_action: '继续推进。',
    });
    const { runtime } = createRuntimeHarness(issue);
    const sessions = new SupervisorSessionRepository(db);
    const sessionEvents = new SupervisorSessionEventRepository(db);
    const transportEvents = new BotTransportEventRepository(db);
    const sessionService = new SupervisorSessionService(runtime, null, sessions, sessionEvents);
    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      state: 'executing',
      root_issue_id: issue.issue_id,
      last_message_id: 'msg-1',
      last_card_key: 'old-key',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['Do root issue'],
        out_of_scope: [],
        acceptance: ['Done'],
        known_risks: [],
        execution_strategy: 'Continue.',
        needs_user_approval: false,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '继续', summary: '继续推进。' },
        alternate_option: null,
        governance_preview: null,
      },
    });
    const notifier = new SlowEditNotifier();
    const worker = new SupervisorWorker({
      runtime,
      sessionRepository: sessions,
      sessionService,
      transportEventRepository: transportEvents,
      notifiers: { telegram: notifier },
    });

    await Promise.all([
      worker.reconcileSession('session-1'),
      worker.reconcileSession('session-1'),
      worker.reconcileSession('session-1'),
    ]);

    expect(notifier.edits).toHaveLength(1);
    worker.dispose();
  });

  test('proactively refreshes the same supervisor card when runtime publishes a new root-thread milestone', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const transportEvents = new BotTransportEventRepository(db);
    const issue = createIssueView({
      governance_thread_state: 'waiting_on_child',
      next_recommended_action: '先处理治理子任务 INT-2',
    });
    const { runtime, emitIssue } = createRuntimeHarness(issue);
    const notifier = new MemoryNotifier();
    const sessionService = new SupervisorSessionService(runtime, null, sessions, events);
    const worker = new SupervisorWorker({
      runtime,
      sessionService,
      sessionRepository: sessions,
      transportEventRepository: transportEvents,
      notifiers: {
        telegram: notifier,
      },
    });

    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-root',
      current_child_issue_id: 'issue-child',
      last_message_id: 'msg-existing',
      last_card_key: 'session|session-1|v2|executing|INT-1|INT-2|INT-2:current',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['按顺序执行 child queue'],
        out_of_scope: ['不并发执行 sibling child'],
        acceptance: ['当前 child 完成后自动接力'],
        known_risks: [],
        execution_strategy: 'root 保持等待，当前 child 先推进。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进当前 child。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    emitIssue(createIssueView({
      governance_thread_state: 'child_failed',
      next_recommended_action: 'INT-2 当前失败，先处理它再继续源计划。',
      delivery_state: 'delivery_failed',
      delivery_code: 'review_submit_failed',
      delivery_summary: 'INT-2 交付卡在 review 提交。',
      governance_current_child: {
        issue_id: 'issue-child',
        issue_identifier: 'INT-2',
        title: 'Current child',
        tracker_state: 'In Progress',
        orchestrator_state: 'failed',
        governance_decision: null,
        governance_summary: null,
        queue_state: 'failed',
        delivery_state: 'delivery_failed',
        delivery_code: 'review_submit_failed',
        delivery_summary: 'INT-2 交付卡在 review 提交。',
      },
      governance_child_queue: [
        {
          issue_id: 'issue-child',
          issue_identifier: 'INT-2',
          title: 'Current child',
          tracker_state: 'In Progress',
          orchestrator_state: 'failed',
          governance_decision: null,
          governance_summary: null,
          queue_state: 'failed',
          delivery_state: 'delivery_failed',
          delivery_code: 'review_submit_failed',
          delivery_summary: 'INT-2 交付卡在 review 提交。',
        },
      ],
    }));
    await waitForNotifier(notifier, 1, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(notifier.edits).toHaveLength(1);
    expect(notifier.edits[0]?.messageRef.provider_message_id).toBe('msg-existing');
    expect(notifier.edits[0]?.message.text).toContain('INT-2');
    expect(notifier.edits[0]?.message.text).toContain('需要你决定');
    expect(notifier.messages).toHaveLength(0);
    expect(sessions.findById('session-1')?.state).toBe('awaiting_user_decision');
    expect(sessions.findById('session-1')?.last_card_key).toContain('awaiting_user_decision');
    expect(sessions.findById('session-1')?.last_card_key).toContain('milestone:delivery_failed');
    expect(sessions.findById('session-1')?.last_material_outcome?.last_milestone_summary_key).toBeUndefined();
  });

  test('keeps supervisor turn-budget delivery failures internal instead of sending a scary milestone card', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const transportEvents = new BotTransportEventRepository(db);
    const issue = createIssueView({
      governance_thread_state: null,
      governance_current_child: null,
      governance_child_queue: [],
      delivery_state: 'delivery_failed',
      delivery_code: null,
      delivery_summary: 'supervisor_turn_budget_exhausted',
      orchestrator_state: 'halted',
    });
    const { runtime, emitIssue } = createRuntimeHarness(issue);
    const notifier = new MemoryNotifier();
    const sessionService = new SupervisorSessionService(runtime, null, sessions, events);
    const worker = new SupervisorWorker({
      runtime,
      sessionService,
      sessionRepository: sessions,
      transportEventRepository: transportEvents,
      notifiers: {
        telegram: notifier,
      },
    });

    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-root',
      last_message_id: 'msg-existing',
      last_card_key: 'session|session-1|stale',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['按顺序执行 child queue'],
        out_of_scope: [],
        acceptance: ['完成 root issue'],
        known_risks: [],
        execution_strategy: '继续推进。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    emitIssue(issue);
    await waitForNotifier(notifier, 1, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(notifier.edits).toHaveLength(1);
    expect(notifier.messages).toHaveLength(0);
    expect(sessions.findById('session-1')?.last_material_outcome?.last_milestone_summary_key).toBeUndefined();
  });

  test('reconciles an executing session to completed when the root issue is already done', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const sessions = new SupervisorSessionRepository(db);
    const events = new SupervisorSessionEventRepository(db);
    const transportEvents = new BotTransportEventRepository(db);
    const issue = createIssueView({
      orchestrator_state: 'completed',
      tracker_state: 'Done',
      delivery_state: 'completed',
      delivery_summary: 'PR 已合并，计划线程完成。',
      governance_thread_state: null,
      governance_current_child: null,
      governance_child_queue: [],
    });
    const { runtime } = createRuntimeHarness(issue);
    const notifier = new MemoryNotifier();
    const sessionService = new SupervisorSessionService(runtime, null, sessions, events);
    const worker = new SupervisorWorker({
      runtime,
      sessionService,
      sessionRepository: sessions,
      transportEventRepository: transportEvents,
      notifiers: {
        telegram: notifier,
      },
    });

    sessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'test2',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-root',
      last_message_id: 'msg-existing',
      last_card_key: 'session|session-1|v1|executing|INT-1||',
      plan_card: {
        title: 'Root issue',
        user_goal: 'Root issue',
        in_scope: ['新增文档并测试'],
        out_of_scope: ['不扩展无关模块'],
        acceptance: ['PR 合并后完成'],
        known_risks: [],
        execution_strategy: '单步执行并验证。',
        needs_user_approval: true,
        repo_ref: 'UniUni2000/test2',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: {
          label: '批准并开始',
          summary: '开始执行。',
        },
        alternate_option: null,
        governance_preview: null,
      },
    });

    await worker.reconcile();

    expect(sessions.findById('session-1')?.state).toBe('completed');
    expect(sessions.findById('session-1')?.delivery_state).toBe('completed');
    expect(notifier.edits).toHaveLength(1);
    expect(notifier.edits[0]?.message.text).toContain('计划已完成');
    expect(notifier.edits[0]?.messageRef.provider_message_id).toBe('msg-existing');
  });
});
