import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  BotFollowupDeliveryStateRepository,
  BotFollowupMessageStateRepository,
  BotIssueFollowupRepository,
  BotPendingActionRepository,
  WorkItemRepository,
  initializeSchema,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import { buildGovernanceCardKey } from './governanceCards';
import { BotFollowupRepairService } from './followupRepair';

function createRootIssue(): RuntimeIssueView {
  return {
    issue_id: 'issue-root',
    work_item_id: 'wi-root',
    identifier: 'INT-44',
    title: 'Root issue',
    phase: 'DEV',
    tracker_state: 'Todo',
    orchestrator_state: 'halted',
    workspace_path: null,
    branch_name: null,
    github_repo: 'acme/repo',
    github_issue_number: 44,
    active_pr_number: null,
    session: null,
    governance_status: 'blocked',
    governance_decision: 'split_before_implement',
    governance_summary: 'Split this issue before dispatch.',
    governance_thread_state: 'waiting_on_child',
    governance_root_issue_id: 'issue-root',
    governance_root_issue_identifier: 'INT-44',
    governance_child_issues: [{
      issue_id: 'issue-child',
      issue_identifier: 'INT-45',
      title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      governance_decision: 'accept_with_rewrite',
      governance_summary: 'Needs rewrite.',
      queue_state: 'current',
    }],
    governance_current_child: {
      issue_id: 'issue-child',
      issue_identifier: 'INT-45',
      title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      governance_decision: 'accept_with_rewrite',
      governance_summary: 'Needs rewrite.',
      queue_state: 'current',
    },
    governance_child_queue: [{
      issue_id: 'issue-child',
      issue_identifier: 'INT-45',
      title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
      tracker_state: 'Todo',
      orchestrator_state: 'halted',
      governance_decision: 'accept_with_rewrite',
      governance_summary: 'Needs rewrite.',
      queue_state: 'current',
    }],
    next_recommended_action: '先处理治理子任务 INT-45',
    active_governance_suggestions: [],
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

describe('BotFollowupRepairService', () => {
  test('folds descendant followups back to the root issue and seeds a delivery baseline', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const workItems = new WorkItemRepository(db);
    const followups = new BotIssueFollowupRepository(db);
    const messageStates = new BotFollowupMessageStateRepository(db);
    const deliveryStates = new BotFollowupDeliveryStateRepository(db);
    const pendingActions = new BotPendingActionRepository(db);

    workItems.create({
      id: 'wi-root',
      linear_issue_id: 'issue-root',
      linear_identifier: 'INT-44',
      linear_title: 'Root issue',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
    });
    workItems.create({
      id: 'wi-child',
      linear_issue_id: 'issue-child',
      linear_identifier: 'INT-45',
      linear_title: 'Child issue',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: 'issue-root',
      governance_generation: 1,
    });

    followups.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-child',
      issue_identifier: 'INT-45',
      user_id: 'user-1',
      role: 'origin',
    });
    messageStates.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-child',
      issue_identifier: 'INT-45',
      message_id: '101',
      card_kind: 'governance_blocked',
      card_key: 'child-card',
      card_state: 'open',
    });
    pendingActions.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      issue_id: 'issue-child',
      user_id: 'user-1',
      intent_kind: 'split',
      normalized_payload: {
        command: 'split',
        issue_id: 'issue-child',
      },
      summary_message: 'Action: split child',
      expires_at: new Date('2026-01-01T00:15:00.000Z'),
      status: 'pending_confirm',
      message_id: '101',
      card_key: 'child-card',
    });

    const rootIssue = createRootIssue();
    const runtime = {
      getIssue: (id: string) => ['issue-root', 'INT-44'].includes(id) ? rootIssue : null,
      getOverview: () => ({
        generated_at: '2026-01-01T00:00:00.000Z',
        counts: { running: 0, retrying: 0, total: 1 },
        issues: [rootIssue],
      }),
    } as unknown as RuntimeControlPlane;

    const summary = new BotFollowupRepairService(
      runtime,
      workItems,
      followups,
      messageStates,
      deliveryStates,
      pendingActions,
    ).repair(new Date('2026-01-01T00:00:00.000Z'));

    expect(
      followups.findByConversation({
        transport: 'telegram',
        conversation_id: 'chat-1',
      }),
    ).toEqual([
      expect.objectContaining({
        issue_id: 'issue-root',
        issue_identifier: 'INT-44',
      }),
    ]);
    expect(
      messageStates.findByConversationIssue({
        transport: 'telegram',
        conversation_id: 'chat-1',
        issue_id: 'issue-child',
      }),
    ).toBeNull();
    expect(
      pendingActions.findByConversationIssue({
        transport: 'telegram',
        conversation_id: 'chat-1',
        issue_id: 'issue-child',
      }),
    ).toBeNull();
    expect(
      deliveryStates.findByKey({
        transport: 'telegram',
        conversation_id: 'chat-1',
        root_issue_id: 'issue-root',
        delivery_kind: 'governance_card',
      }),
    ).toEqual(expect.objectContaining({
      last_material_key: buildGovernanceCardKey(rootIssue),
    }));
    expect(summary).toEqual({
      expired_pending_actions_deleted: 0,
      descendant_followups_folded: 1,
      descendant_message_states_deleted: 1,
      descendant_pending_actions_deleted: 1,
      delivery_baselines_seeded: 1,
    });

    db.close();
  });
});
