import type { BotTransportEventRepository, SupervisorSessionRepository } from '../database';
import type { SupervisorSessionRecord } from '../database/types';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import { logger } from '../logging';
import { buildSupervisorSessionFollowupMessage, type SupervisorSessionService } from './sessionService';
import {
  getBotMessageEditFailureKind,
  type BotRecipient,
  type BotTransport,
  type BotTransportMessage,
  type BotTransportNotifier,
} from '../bots/types';

const RESTORABLE_SESSION_STATES = new Set([
  'plan_ready',
  'awaiting_user_approval',
  'approved_for_materialization',
  'materialized',
  'executing',
  'awaiting_user_decision',
]);

const RENDERABLE_SESSION_STATES = new Set([
  ...RESTORABLE_SESSION_STATES,
  'completed',
  'cancelled',
]);

export interface SupervisorWorkerOptions {
  runtime: RuntimeControlPlane;
  sessionRepository: SupervisorSessionRepository;
  sessionService: SupervisorSessionService;
  notifiers: Partial<Record<BotTransport, BotTransportNotifier>>;
  transportEventRepository?: BotTransportEventRepository | null;
  editThrottleMs?: number;
}

export class SupervisorWorker {
  private readonly unsubscribe: () => void;
  private readonly inFlightMaterialKeys = new Set<string>();
  private readonly recentMaterialEdits = new Map<string, number>();

  constructor(private readonly options: SupervisorWorkerOptions) {
    this.unsubscribe = this.options.runtime.subscribe((event) => {
      if (event.type !== 'issue') {
        return;
      }
      void this.handleIssueEvent(event.data.issue_id);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  async reconcile(): Promise<void> {
    const sessions = this.options.sessionRepository.findAll()
      .filter((session) => RESTORABLE_SESSION_STATES.has(session.state) || RENDERABLE_SESSION_STATES.has(session.state));

    for (const session of sessions) {
      if (session.root_issue_id) {
        const issue = this.options.runtime.getIssue(session.root_issue_id);
        if (issue) {
          this.options.sessionService.syncIssue(issue);
        }
      }
      await this.reconcileSession(session.id);
    }
  }

  async reconcileSession(sessionId: string): Promise<void> {
    const session = this.options.sessionRepository.findById(sessionId);
    if (!session || !RENDERABLE_SESSION_STATES.has(session.state)) {
      return;
    }

    const notifier = this.options.notifiers[session.transport];
    if (!notifier) {
      return;
    }

    const issue = session.root_issue_id
      ? this.options.runtime.getIssue(session.root_issue_id)
      : null;
    const card = buildSupervisorSessionFollowupMessage(session, issue);
    const recipient: BotRecipient = {
      transport: session.transport,
      conversation_id: session.conversation_id,
    };
    const message: BotTransportMessage = {
      text: card.message,
      caption: card.caption,
      format: card.format,
      media_key: card.media_key ?? undefined,
      photo: card.photo,
      action_rows: card.action_rows,
    };
    const coalesceKey = `${session.id}|${card.material_key}`;

    if (session.last_message_id && session.last_card_key === card.material_key) {
      return;
    }

    if (this.inFlightMaterialKeys.has(coalesceKey)) {
      return;
    }

    const throttleMs = this.options.editThrottleMs ?? 2_000;
    const lastEditAt = this.recentMaterialEdits.get(coalesceKey) ?? 0;
    if (session.last_message_id && Date.now() - lastEditAt < throttleMs) {
      this.options.sessionRepository.update({
        id: session.id,
        last_card_key: card.material_key,
      });
      return;
    }

    if (session.last_message_id) {
      this.inFlightMaterialKeys.add(coalesceKey);
      try {
        await notifier.editMessage(
          recipient,
          { provider_message_id: session.last_message_id },
          message,
        );
        this.options.sessionRepository.update({
          id: session.id,
          last_card_key: card.material_key,
        });
        this.recordTransportEvent({
          transport: session.transport,
          conversation_id: session.conversation_id,
          issue_id: issue?.issue_id ?? null,
          root_issue_id: session.root_issue_id ?? issue?.issue_id ?? null,
          source: 'followup_card',
          action: 'edit',
          result: 'success',
          message_id: session.last_message_id,
          material_key: card.material_key,
          error_message: null,
        });
        this.recentMaterialEdits.set(coalesceKey, Date.now());
        return;
      } catch (error) {
        const failureKind = getBotMessageEditFailureKind(error);
        if (failureKind === 'not_modified') {
          this.options.sessionRepository.update({
            id: session.id,
            last_card_key: card.material_key,
          });
          this.recordTransportEvent({
            transport: session.transport,
            conversation_id: session.conversation_id,
            issue_id: issue?.issue_id ?? null,
            root_issue_id: session.root_issue_id ?? issue?.issue_id ?? null,
            source: 'followup_card',
            action: 'edit',
            result: 'success',
            message_id: session.last_message_id,
            material_key: card.material_key,
            error_message: null,
          });
          this.recentMaterialEdits.set(coalesceKey, Date.now());
          return;
        }

        this.recordTransportEvent({
          transport: session.transport,
          conversation_id: session.conversation_id,
          issue_id: issue?.issue_id ?? null,
          root_issue_id: session.root_issue_id ?? issue?.issue_id ?? null,
          source: 'followup_card',
          action: 'edit',
          result: 'failed',
          message_id: session.last_message_id,
          material_key: card.material_key,
          error_message: error instanceof Error ? error.message : String(error),
        });
        if (failureKind !== 'message_not_found') {
          logger.warn('Supervisor worker kept the existing session card after edit failure', {
            session_id: session.id,
            transport: session.transport,
            conversation_id: session.conversation_id,
            message_id: session.last_message_id,
            failure_kind: failureKind ?? 'unknown',
          }, error instanceof Error ? error : undefined);
          return;
        }
      } finally {
        this.inFlightMaterialKeys.delete(coalesceKey);
      }
    }

    try {
      this.inFlightMaterialKeys.add(coalesceKey);
      const messageRef = await notifier.sendMessage(recipient, message);
      this.options.sessionRepository.update({
        id: session.id,
        last_message_id: messageRef.provider_message_id,
        last_card_key: card.material_key,
      });
      this.recordTransportEvent({
        transport: session.transport,
        conversation_id: session.conversation_id,
        issue_id: issue?.issue_id ?? null,
        root_issue_id: session.root_issue_id ?? issue?.issue_id ?? null,
        source: 'followup_card',
        action: session.last_message_id ? 'fallback' : 'send',
        result: 'success',
        message_id: messageRef.provider_message_id,
        material_key: card.material_key,
        error_message: null,
      });
      this.recentMaterialEdits.set(coalesceKey, Date.now());
    } catch (error) {
      logger.warn('Supervisor worker failed to send session card', {
        session_id: session.id,
        transport: session.transport,
        conversation_id: session.conversation_id,
      }, error instanceof Error ? error : undefined);
      this.recordTransportEvent({
        transport: session.transport,
        conversation_id: session.conversation_id,
        issue_id: issue?.issue_id ?? null,
        root_issue_id: session.root_issue_id ?? issue?.issue_id ?? null,
        source: 'followup_card',
        action: session.last_message_id ? 'fallback' : 'send',
        result: 'failed',
        message_id: session.last_message_id,
        material_key: card.material_key,
        error_message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlightMaterialKeys.delete(coalesceKey);
    }
  }

  private recordTransportEvent(record: {
    transport: BotTransport;
    conversation_id: string;
    issue_id: string | null;
    root_issue_id: string | null;
    source: 'followup_card';
    action: 'send' | 'edit' | 'fallback';
    result: 'success' | 'failed';
    message_id: string | null;
    material_key: string | null;
    error_message: string | null;
  }): void {
    this.options.transportEventRepository?.create(record);
  }

  private async handleIssueEvent(issueId: string): Promise<void> {
    const issue = this.options.runtime.getIssue(issueId);
    if (!issue) {
      return;
    }

    this.options.sessionService.syncIssue(issue);

    const rootIssueId = issue.governance_root_issue_id ?? issue.issue_id;
    const session = this.options.sessionRepository.findByRootIssueId(rootIssueId);
    if (!session || !RENDERABLE_SESSION_STATES.has(session.state) || !session.last_message_id) {
      return;
    }
    await this.reconcileSession(session.id);
  }
}
