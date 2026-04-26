import type {
  BotFollowupDeliveryStateRepository,
  BotFollowupMessageStateRepository,
  BotIssueFollowupRepository,
  BotPendingActionRepository,
  WorkItemRepository,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import { buildGovernanceCardKey, isGovernanceBlockedIssue } from './governanceCards';
import { classifyLifecycleNotification } from './followups';

export interface BotFollowupRepairSummary {
  expired_pending_actions_deleted: number;
  descendant_followups_folded: number;
  descendant_message_states_deleted: number;
  descendant_pending_actions_deleted: number;
  orphan_message_states_deleted: number;
  orphan_delivery_states_deleted: number;
  delivery_baselines_seeded: number;
}

function isGovernanceThreadActive(issue: RuntimeIssueView | null | undefined): boolean {
  if (!issue) {
    return false;
  }

  return ['waiting_on_child', 'child_failed'].includes(issue.governance_thread_state ?? '') || isGovernanceBlockedIssue(issue);
}

export class BotFollowupRepairService {
  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly workItems: WorkItemRepository | null,
    private readonly followups: BotIssueFollowupRepository | null,
    private readonly messageStates: BotFollowupMessageStateRepository | null,
    private readonly deliveryStates: BotFollowupDeliveryStateRepository | null,
    private readonly pendingActions: BotPendingActionRepository | null,
  ) {}

  repair(now: Date = new Date()): BotFollowupRepairSummary {
    return {
      expired_pending_actions_deleted: this.pendingActions?.deleteExpired(now) ?? 0,
      descendant_followups_folded: this.foldDescendantFollowupsToRoot(),
      orphan_message_states_deleted: this.deleteOrphanMessageStates(),
      descendant_message_states_deleted: this.deleteDescendantMessageStates(),
      descendant_pending_actions_deleted: this.deleteDescendantPendingActions(),
      orphan_delivery_states_deleted: this.deleteOrphanDeliveryStates(),
      delivery_baselines_seeded: this.seedDeliveryBaselines(),
    };
  }

  private hasKnownIssue(issueId: string, issueIdentifier?: string | null): boolean {
    if (!issueId || issueId === 'unknown' || issueIdentifier === 'UNKNOWN') {
      return false;
    }
    if (this.runtime.getIssue(issueId) || (issueIdentifier && this.runtime.getIssue(issueIdentifier))) {
      return true;
    }
    return Boolean(
      this.workItems?.findByLinearIssueId(issueId)
        ?? (issueIdentifier ? this.workItems?.findByIdentifier(issueIdentifier) : null),
    );
  }

  private resolveRoot(issueId: string, issueIdentifier?: string | null): {
    rootIssueId: string;
    rootIssueIdentifier: string | null;
  } {
    const workItem = this.workItems?.findByLinearIssueId(issueId)
      ?? (issueIdentifier ? this.workItems?.findByIdentifier(issueIdentifier) : null)
      ?? null;
    if (!workItem?.governance_root_issue_id) {
      return {
        rootIssueId: issueId,
        rootIssueIdentifier: issueIdentifier ?? workItem?.linear_identifier ?? null,
      };
    }

    const rootWorkItem = this.workItems?.findByLinearIssueId(workItem.governance_root_issue_id)
      ?? null;
    return {
      rootIssueId: workItem.governance_root_issue_id,
      rootIssueIdentifier: rootWorkItem?.linear_identifier ?? issueIdentifier ?? null,
    };
  }

  private foldDescendantFollowupsToRoot(): number {
    let folded = 0;
    for (const record of this.followups?.findAll() ?? []) {
      const root = this.resolveRoot(record.issue_id, record.issue_identifier);
      if (root.rootIssueId === record.issue_id) {
        continue;
      }

      this.followups?.delete({
        transport: record.transport,
        conversation_id: record.conversation_id,
        issue_id: record.issue_id,
        role: record.role,
      });
      this.followups?.upsert({
        transport: record.transport,
        conversation_id: record.conversation_id,
        issue_id: root.rootIssueId,
        issue_identifier: root.rootIssueIdentifier,
        user_id: record.user_id,
        role: record.role,
      });
      folded += 1;
    }
    return folded;
  }

  private deleteDescendantMessageStates(): number {
    let deleted = 0;
    for (const record of this.messageStates?.findAll() ?? []) {
      if (!this.hasKnownIssue(record.issue_id, record.issue_identifier)) {
        continue;
      }
      const root = this.resolveRoot(record.issue_id, record.issue_identifier);
      if (root.rootIssueId === record.issue_id) {
        continue;
      }
      this.messageStates?.delete({
        transport: record.transport,
        conversation_id: record.conversation_id,
        issue_id: record.issue_id,
      });
      deleted += 1;
    }
    return deleted;
  }

  private deleteOrphanMessageStates(): number {
    let deleted = 0;
    for (const record of this.messageStates?.findAll() ?? []) {
      if (this.hasKnownIssue(record.issue_id, record.issue_identifier)) {
        continue;
      }
      this.messageStates?.delete({
        transport: record.transport,
        conversation_id: record.conversation_id,
        issue_id: record.issue_id,
      });
      deleted += 1;
    }
    return deleted;
  }

  private deleteDescendantPendingActions(): number {
    let deleted = 0;
    for (const record of this.pendingActions?.findAll() ?? []) {
      if (!record.issue_id) {
        continue;
      }
      const root = this.resolveRoot(record.issue_id);
      if (root.rootIssueId === record.issue_id) {
        continue;
      }
      this.pendingActions?.delete({
        transport: record.transport,
        conversation_id: record.conversation_id,
        issue_id: record.issue_id,
      });
      deleted += 1;
    }
    return deleted;
  }

  private seedDeliveryBaselines(): number {
    const uniqueRoots = new Set<string>();
    for (const record of this.followups?.findAll() ?? []) {
      uniqueRoots.add(`${record.transport}:${record.conversation_id}:${record.issue_id}`);
    }

    let seeded = 0;
    for (const key of uniqueRoots) {
      const [transport, conversationId, rootIssueId] = key.split(':');
      const issue = this.runtime.getIssue(rootIssueId);
      if (!issue) {
        continue;
      }

      const messageState = this.messageStates?.findByConversationIssue({
        transport: transport as 'telegram' | 'discord',
        conversation_id: conversationId,
        issue_id: rootIssueId,
      }) ?? null;

      if (isGovernanceThreadActive(issue)) {
        this.deliveryStates?.upsert({
          transport: transport as 'telegram' | 'discord',
          conversation_id: conversationId,
          root_issue_id: rootIssueId,
          root_issue_identifier: issue.identifier,
          delivery_kind: 'governance_card',
          last_material_key: messageState?.card_key ?? buildGovernanceCardKey(issue),
          last_notification_class: null,
          last_message_id: messageState?.message_id ?? null,
        });
        seeded += 1;
        continue;
      }

      const notificationClass = classifyLifecycleNotification(issue);
      if (!notificationClass) {
        continue;
      }
      this.deliveryStates?.upsert({
        transport: transport as 'telegram' | 'discord',
        conversation_id: conversationId,
        root_issue_id: rootIssueId,
        root_issue_identifier: issue.identifier,
        delivery_kind: 'lifecycle_digest',
        last_material_key: `class:${notificationClass}`,
        last_notification_class: notificationClass,
        last_message_id: null,
      });
      seeded += 1;
    }
    return seeded;
  }

  private deleteOrphanDeliveryStates(): number {
    let deleted = 0;
    for (const record of this.deliveryStates?.findAll() ?? []) {
      if (this.hasKnownIssue(record.root_issue_id, record.root_issue_identifier)) {
        continue;
      }
      this.deliveryStates?.delete({
        transport: record.transport,
        conversation_id: record.conversation_id,
        root_issue_id: record.root_issue_id,
        delivery_kind: record.delivery_kind,
      });
      deleted += 1;
    }
    return deleted;
  }
}
