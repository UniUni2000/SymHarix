import type {
  BotAssistantIntent,
  BotCommandContext,
  BotCommandResponse,
  BotRuntimeCopilotContext,
} from '../bots/types';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import { assessIntakeCritic } from '../governance/intakeCritic';
import type {
  SupervisorApprovalMode,
  SupervisorDecisionKind,
  SupervisorIntakeMode,
  SupervisorPlanCard,
  SupervisorSessionRecord,
  SupervisorSessionState,
} from '../database/types';
import { SupervisorSessionEventRepository } from '../database/repositories/supervisorSessionEventRepository';
import { SupervisorSessionRepository } from '../database/repositories/supervisorSessionRepository';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import type {
  SupervisorExecutionIntent,
  SupervisorMaterializedPlan,
  SupervisorMilestone,
} from './types';

export interface SupervisorServiceResponseParams {
  context: BotCommandContext;
  text: string;
  intent: BotAssistantIntent | null;
  runtimeContext: BotRuntimeCopilotContext;
  canWrite: boolean;
}

const APPROVE_WORDS = ['确认', '按推荐继续', '批准', '开始执行', '继续'];
const EDIT_WORDS = ['改一下计划', '修改计划', '先别执行', '不要开始'];
const ALTERNATE_WORDS = ['换用备选方案', '换方案', '备选方案'];
const SCOPE_CHANGE_PATTERNS = [/顺便/, /另外/, /再加/, /改成/, /顺手/];

function compact(value: string | null | undefined, maxLength = 160): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function joinHtmlLines(lines: Array<string | null | undefined>): string {
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

function textList(values: string[] | null | undefined, fallback: string): string {
  const normalized = (values ?? []).map((value) => compact(value, 120)).filter(Boolean);
  return normalized.length > 0 ? normalized.join('；') : fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveProjectAlias(
  text: string,
  availableProjects: Array<{ project_slug: string; github_repo_full: string }>,
): string | null {
  const trimmed = text.trim();
  for (const project of availableProjects) {
    const identifiers = new Set<string>([
      project.project_slug,
      project.github_repo_full,
      project.github_repo_full.split('/').pop() || project.github_repo_full,
    ]);
    for (const identifier of identifiers) {
      if (!identifier) {
        continue;
      }
      const pattern = new RegExp(`(^|[^a-zA-Z0-9_-])${escapeRegExp(identifier)}([^a-zA-Z0-9_-]|$)`, 'i');
      if (pattern.test(trimmed)) {
        return project.project_slug;
      }
    }
  }
  return null;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function inferAcceptance(title: string, description: string | null): string[] {
  const fromDescription = String(description || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (fromDescription.length > 0) {
    return fromDescription.slice(0, 3);
  }
  return [`完成 ${title}，并让结果可验证。`];
}

function inferOutOfScope(title: string): string[] {
  if (/同时|并且|以及|一起|and/i.test(title)) {
    return ['这次不把所有并列目标一起并发推进。'];
  }
  return ['不顺手扩展到无关模块。'];
}

function buildScopeChangedPlanCard(
  previous: SupervisorPlanCard,
  scopeChangeText: string,
): SupervisorPlanCard {
  const addedScope = `新增范围候选：${compact(scopeChangeText, 140)}`;
  const existingScope = previous.in_scope ?? [];
  const existingRisks = previous.known_risks ?? [];
  return {
    ...previous,
    in_scope: existingScope.includes(addedScope)
      ? existingScope
      : [...existingScope, addedScope],
    known_risks: [
      ...existingRisks,
      '执行中出现范围变化，需要重新批准后再继续，避免静默漂移。',
    ],
    needs_user_approval: true,
    recommended_option: {
      label: '批准第新版计划',
      summary: '确认新增范围后，再继续推进执行线程。',
    },
    alternate_option: previous.alternate_option ?? {
      label: '改一下计划',
      summary: '如果新增范围不该进本轮，可以先重写计划。',
    },
  };
}

function isApprovalText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return APPROVE_WORDS.some((word) => normalized.includes(word.toLowerCase()));
}

function isEditText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return EDIT_WORDS.some((word) => normalized.includes(word.toLowerCase()));
}

function isAlternateText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return ALTERNATE_WORDS.some((word) => normalized.includes(word.toLowerCase()));
}

function isScopeChangeText(text: string): boolean {
  return SCOPE_CHANGE_PATTERNS.some((pattern) => pattern.test(text));
}

function isPlanMemoryQuestion(text: string): boolean {
  return /计划|范围|验收|完成算什么|目标|为什么|子任务|子单|plan|scope|acceptance|goal/i.test(text);
}

function shouldClarifyAcceptance(text: string, description: string | null): boolean {
  const combined = `${text}\n${description || ''}`;
  if (isRiskyCleanupRequest(combined)) {
    return false;
  }
  return !/验收|测试|verify|验证|输出|页面|命令|结果|完成后|应该/.test(combined);
}

function asksForRepoClarification(question: string | null | undefined): boolean {
  return /仓库|project slug|repo/i.test(question || '');
}

function isLikelyMultiObjective(text: string, description: string | null): boolean {
  const combined = `${text}\n${description || ''}`;
  return /同时|并且|以及|一起|顺便|另外|also|and/i.test(combined);
}

function isRiskyCleanupRequest(text: string): boolean {
  return /(?:清空|清理|删除|移除|删掉).*(?:残余|垃圾|遗留|多余|无用|文件|目录|仓库|项目)|(?:残余|垃圾|遗留|多余|无用).*(?:清空|清理|删除|移除|删掉)|把.+(?:清空|清理|删除|移除|删掉)/i.test(text);
}

function deriveSupervisorMilestone(issue: RuntimeIssueView): SupervisorMilestone | null {
  const rootIssueId = issue.governance_root_issue_id ?? issue.issue_id;
  const isChildIssue = rootIssueId !== issue.issue_id;
  if (isChildIssue && (issue.orchestrator_state === 'completed' || issue.delivery_state === 'completed')) {
    return {
      kind: 'child_completed',
      key: ['child_completed', rootIssueId, issue.issue_id, issue.updated_at ?? ''].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: issue.delivery_summary ?? `${issue.identifier} 已完成，等待 root thread 接力下一步。`,
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: issue.issue_id,
    };
  }

  if (isChildIssue && (issue.delivery_state === 'delivery_failed' || issue.orchestrator_state === 'failed')) {
    return {
      kind: 'child_failed',
      key: [
        'child_failed',
        rootIssueId,
        issue.issue_id,
        issue.delivery_code ?? '',
        issue.delivery_summary ?? '',
      ].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: issue.delivery_summary ?? issue.delivery_code ?? null,
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: issue.issue_id,
    };
  }

  if (issue.delivery_state === 'delivery_failed' || issue.delivery_code) {
    return {
      kind: 'delivery_failed',
      key: [
        'delivery_failed',
        issue.issue_id,
        issue.delivery_code ?? '',
        issue.delivery_summary ?? '',
      ].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: issue.delivery_summary ?? issue.delivery_code ?? null,
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: issue.governance_current_child?.issue_id ?? null,
    };
  }

  if (issue.orchestrator_state === 'completed' || issue.delivery_state === 'completed') {
    return {
      kind: 'completed',
      key: ['completed', issue.issue_id, issue.updated_at ?? ''].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: issue.delivery_summary ?? '计划线程已完成。',
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: issue.governance_current_child?.issue_id ?? null,
    };
  }

  if (issue.orchestrator_state === 'cancelled') {
    return {
      kind: 'cancelled',
      key: ['cancelled', issue.issue_id, issue.updated_at ?? ''].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: '计划线程已取消。',
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: issue.governance_current_child?.issue_id ?? null,
    };
  }

  if (issue.orchestrator_state === 'retry_scheduled') {
    return {
      kind: 'retrying',
      key: ['retrying', issue.issue_id].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: issue.delivery_summary ?? '当前进入重试队列。',
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: issue.governance_current_child?.issue_id ?? null,
    };
  }

  if (issue.governance_thread_state === 'waiting_on_child' || issue.governance_thread_state === 'child_failed') {
    return {
      kind: issue.governance_thread_state,
      key: [
        issue.governance_thread_state,
        issue.issue_id,
        issue.governance_current_child?.issue_id ?? '',
        issue.governance_child_queue?.map((child) => `${child.issue_id}:${child.queue_state ?? ''}`).join(',') ?? '',
      ].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: issue.next_recommended_action ?? null,
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: issue.governance_current_child?.issue_id ?? null,
    };
  }

  if (issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming') {
    return {
      kind: 'requires_user_decision',
      key: [
        'requires_user_decision',
        issue.issue_id,
        issue.governance_decision ?? '',
        issue.next_recommended_action ?? '',
      ].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: issue.next_recommended_action ?? issue.governance_summary ?? null,
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: issue.governance_current_child?.issue_id ?? null,
    };
  }

  return null;
}

function buildExecutionIntent(
  session: SupervisorSessionRecord,
  planCard: SupervisorPlanCard,
): SupervisorExecutionIntent {
  return {
    root_session_id: session.id,
    repo_ref: planCard.project_slug || session.repo_ref || planCard.repo_ref || 'unknown',
    plan_summary: planCard.title,
    acceptance_summary: textList(planCard.acceptance, '结果可验证。'),
    approved_execution_mode: planCard.materialization_mode,
    plan_card: planCard,
  };
}

function buildMaterializedPlan(
  intent: SupervisorExecutionIntent,
  issue: RuntimeIssueView | null,
  createResult: { issue_id: string | null; issue_identifier: string | null },
): SupervisorMaterializedPlan {
  const queue = issue?.governance_child_queue ?? [];
  return {
    ...intent,
    root_issue_id: createResult.issue_id ?? issue?.issue_id ?? '',
    root_issue_identifier: createResult.issue_identifier ?? issue?.identifier ?? null,
    current_child_issue_id: issue?.governance_current_child?.issue_id ?? null,
    child_queue: queue.map((child) => ({
      issue_id: child.issue_id,
      issue_identifier: child.issue_identifier,
      title: child.title,
      queue_state: child.queue_state ?? null,
    })),
  };
}

interface DraftInput {
  title: string;
  description: string | null;
  project_slug: string | null;
}

interface PlanComputation {
  repoRef: string | null;
  intakeMode: SupervisorIntakeMode;
  approvalMode: SupervisorApprovalMode;
  state: SupervisorSessionState;
  planCard: SupervisorPlanCard;
}

export function buildSupervisorSessionFollowupMessage(
  session: SupervisorSessionRecord,
  issue: RuntimeIssueView | null = null,
): {
  message: string;
  format: 'telegram_html';
  action_rows: NonNullable<BotCommandResponse['action_rows']>;
  material_key: string;
} {
  const planCard = session.plan_card;
  const title = planCard?.title || issue?.title || '当前计划线程';
  const currentChild = issue?.governance_current_child
    ?? issue?.governance_child_queue?.find((child) => child.queue_state === 'current')
    ?? null;
  const queue = issue?.governance_child_queue ?? [];
  const waitingForApproval = session.state === 'awaiting_user_approval' || session.state === 'plan_ready';
  const waitingForDecision = session.state === 'awaiting_user_decision';
  const materialKey = [
    'session',
    session.id,
    `v${session.plan_version}`,
    session.state,
    issue?.identifier ?? '',
    currentChild?.issue_identifier ?? '',
    queue.map((child) => `${child.issue_identifier}:${child.queue_state ?? ''}`).join(','),
  ].join('|');

  return {
    format: 'telegram_html',
    material_key: materialKey,
    message: joinHtmlLines([
      waitingForApproval
        ? `<b>计划待你批准 · v${session.plan_version}</b>`
        : waitingForDecision
          ? `<b>需要你决定 · ${escapeHtml(issue?.identifier || title)}</b>`
          : `<b>计划线程 · ${escapeHtml(issue?.identifier || title)}</b>`,
      waitingForApproval
        ? '这条需求需要你确认计划后再建单执行。'
        : waitingForDecision
          ? '执行线程遇到需要确认的治理节点。'
          : `当前状态：${escapeHtml(session.state)}`,
      null,
      '<b>用户目标</b>',
      escapeHtml(planCard?.user_goal || title),
      planCard?.repo_ref || issue?.github_repo ? '<b>仓库</b>' : null,
      planCard?.repo_ref || issue?.github_repo
        ? `<code>${escapeHtml(planCard?.repo_ref || issue?.github_repo || '')}</code>`
        : null,
      planCard ? '<b>本次范围</b>' : null,
      planCard ? escapeHtml(textList(planCard.in_scope, '按当前目标推进。')) : null,
      planCard ? '<b>完成算什么</b>' : null,
      planCard ? escapeHtml(textList(planCard.acceptance, '结果可验证。')) : null,
      currentChild ? '<b>当前子任务</b>' : null,
      currentChild ? `${escapeHtml(currentChild.issue_identifier)} · ${escapeHtml(currentChild.title)}` : null,
      queue.length > 0 ? '<b>队列</b>' : null,
      queue.length > 0
        ? escapeHtml(queue.map((child) => `${child.issue_identifier}:${child.queue_state || 'queued'}`).join(' / '))
        : null,
      null,
      '<b>推荐下一步</b>',
      escapeHtml(issue?.next_recommended_action || planCard?.recommended_option.summary || '继续推进当前计划线程。'),
      null,
      waitingForApproval || waitingForDecision
        ? '点按钮继续，或者直接回复你的想法。'
        : '我会继续盯关键节点，有需要你决定时再回来。',
    ]),
    action_rows: waitingForApproval || waitingForDecision
      ? [
          [{ label: '按推荐继续', callback_data: `sup|${session.id}|approve` }],
          [
            { label: '改一下计划', callback_data: `sup|${session.id}|edit` },
            { label: '换用备选方案', callback_data: `sup|${session.id}|alternate` },
          ],
        ]
      : [],
  };
}

export class SupervisorSessionService {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly projectResolver: TrackerProjectResolutionService | null,
    private readonly sessions: SupervisorSessionRepository,
    private readonly sessionEvents: SupervisorSessionEventRepository,
  ) {
    this.unsubscribe = this.runtime.subscribe((event) => {
      if (event.type === 'issue') {
        this.syncFromIssue(event.data);
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  hasActiveSession(context: BotCommandContext): boolean {
    return Boolean(this.sessions.findActiveByConversation({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    }));
  }

  findActiveSession(context: BotCommandContext): SupervisorSessionRecord | null {
    return this.sessions.findActiveByConversation({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    });
  }

  findById(id: string): SupervisorSessionRecord | null {
    return this.sessions.findById(id);
  }

  recordOutboundMessage(sessionId: string, messageId: string, cardKey: string | null = null): void {
    this.sessions.update({
      id: sessionId,
      last_message_id: messageId,
      last_card_key: cardKey ?? undefined,
    });
  }

  renderSessionCard(session: SupervisorSessionRecord, issue: RuntimeIssueView | null = null): BotCommandResponse {
    return this.renderSessionMessage(session, issue);
  }

  async respond(params: SupervisorServiceResponseParams): Promise<BotCommandResponse | null> {
    const activeSession = this.findActiveSession(params.context);
    if (!activeSession) {
      if (params.intent?.kind !== 'create_issue') {
        return null;
      }
      return this.startSession(params);
    }

    const shouldContinueActiveSession =
      params.intent?.kind !== 'create_issue'
      || isApprovalText(params.text)
      || isEditText(params.text)
      || isAlternateText(params.text)
      || isScopeChangeText(params.text);

    if (!shouldContinueActiveSession && params.intent?.kind === 'create_issue') {
      const incomingTitle = normalizeTitle(params.intent.title);
      const activeTitle = normalizeTitle(activeSession.plan_card?.title || '');
      if (incomingTitle && incomingTitle === activeTitle) {
        return this.renderSessionMessage(
          activeSession,
          activeSession.root_issue_id ? this.runtime.getIssue(activeSession.root_issue_id) : null,
        );
      }
      return {
        message: `当前会话里已经有一条活跃计划线程：${activeSession.plan_card?.title || '未命名计划'}。\n先把这条线程收口，或者直接回复你想怎么调整它。`,
      };
    }

    return this.continueSession(activeSession, params);
  }

  private async startSession(params: SupervisorServiceResponseParams): Promise<BotCommandResponse> {
    const intent = params.intent;
    if (!intent || intent.kind !== 'create_issue') {
      return {
        message: '我还没拿到可以起草计划的需求。',
      };
    }

    const session = this.sessions.create({
      id: crypto.randomUUID(),
      transport: params.context.transport,
      conversation_id: params.context.recipient.conversation_id,
      user_id: params.context.identity.user_id,
      state: 'drafting',
      plan_version: 1,
    });
    this.recordEvent(session.id, 'user_message', {
      text: params.text,
      intent_kind: intent.kind,
    });

    const draft: DraftInput = {
      title: normalizeTitle(intent.title),
      description: intent.description,
      project_slug: intent.project_slug,
    };

    return this.recomputeAndRespond(session, draft, params.runtimeContext, params.canWrite);
  }

  private async continueSession(
    session: SupervisorSessionRecord,
    params: SupervisorServiceResponseParams,
  ): Promise<BotCommandResponse> {
    this.recordEvent(session.id, 'user_message', {
      text: params.text,
      state: session.state,
    });

    if (session.state === 'awaiting_user_approval' || session.state === 'plan_ready') {
      if (isApprovalText(params.text)) {
        if (session.approval_mode === 'explicit_reapproval' && session.root_issue_id) {
          return this.approvePlanRevision(session, params.canWrite);
        }
        return this.materialize(session, params.canWrite);
      }
      if (isAlternateText(params.text) || isEditText(params.text)) {
        const updated = this.sessions.update({
          id: session.id,
          state: 'clarifying',
          active_decision_kind: 'plan_revision',
        })!;
        this.recordEvent(session.id, 'plan_revision_requested', {
          text: params.text,
        });
        return {
          ...this.withSessionMetadata(
            updated,
            {
              message: [
                `好的，我们先改计划。`,
                `当前计划：${updated.plan_card?.title || '未命名计划'}`,
                `你最想改哪一块：范围、验收、仓库，还是执行方式？`,
              ].join('\n'),
            },
            'revision',
          ),
        };
      }
      return this.renderSessionMessage(session);
    }

    if (session.state === 'clarifying' || session.state === 'drafting') {
      const planCard = session.plan_card;
      const repoClarification = asksForRepoClarification(planCard?.clarification_question);
      const draft: DraftInput = {
        title: planCard?.title || compact(params.text, 80) || '未命名计划',
        description: repoClarification
          ? planCard?.acceptance?.join('\n') || params.text
          : params.text,
        project_slug: session.repo_ref,
      };

      const resolvedProjectSlug = session.repo_ref
        || resolveProjectAlias(params.text, params.runtimeContext.available_projects)
        || params.runtimeContext.default_project_slug
        || null;
      draft.project_slug = resolvedProjectSlug;
      if (planCard?.clarification_question && !resolvedProjectSlug) {
        return {
          ...this.withSessionMetadata(
            session,
            {
              message: `我还没确定要落到哪个仓库。\n请直接回复 project slug 或仓库名，例如：test2。`,
            },
            'clarifying-repo',
          ),
        };
      }

      if (planCard?.clarification_question && !repoClarification) {
        this.recordEvent(session.id, 'clarification_answer_recorded', {
          question: planCard.clarification_question,
          answer: params.text,
        });
      }

      return this.recomputeAndRespond(session, draft, params.runtimeContext, params.canWrite);
    }

    if (session.state === 'executing') {
      if (isScopeChangeText(params.text)) {
        const nextPlanVersion = (session.plan_version ?? 1) + 1;
        const revisedPlanCard = session.plan_card
          ? buildScopeChangedPlanCard(session.plan_card, params.text)
          : null;
        const updated = this.sessions.update({
          id: session.id,
          state: 'awaiting_user_approval',
          approval_mode: 'explicit_reapproval',
          plan_version: nextPlanVersion,
          plan_card: revisedPlanCard ?? session.plan_card,
          active_decision_kind: 'plan_revision',
          last_material_outcome: {
            scope_change_text: params.text,
          },
        })!;
        this.recordEvent(session.id, 'scope_change_detected', {
          text: params.text,
          next_plan_version: nextPlanVersion,
        });
        return this.renderSessionMessage(updated);
      }

      const rootIssue = session.root_issue_id ? this.runtime.getIssue(session.root_issue_id) : null;
      if (isPlanMemoryQuestion(params.text)) {
        return this.renderPlanMemoryAnswer(session, rootIssue);
      }
      return {
        ...this.withSessionMetadata(
          session,
          {
            message: rootIssue
              ? `当前计划线程仍在执行。\n根任务：${rootIssue.identifier} · ${rootIssue.title}\n状态：${rootIssue.phase} · ${rootIssue.tracker_state} · ${rootIssue.orchestrator_state || 'unknown'}${rootIssue.next_recommended_action ? `\n下一步：${rootIssue.next_recommended_action}` : ''}`
              : `当前计划线程已经进入执行态，我会在关键节点再回来找你。`,
          },
          'executing',
        ),
      };
    }

    if (session.state === 'awaiting_user_decision') {
      if (isApprovalText(params.text)) {
        return this.executeRecommendedDecision(session, params.canWrite);
      }
      return this.renderSessionMessage(session, session.root_issue_id ? this.runtime.getIssue(session.root_issue_id) : null);
    }

    return this.renderSessionMessage(session);
  }

  private async recomputeAndRespond(
    session: SupervisorSessionRecord,
    draft: DraftInput,
    runtimeContext: BotRuntimeCopilotContext,
    canWrite: boolean,
  ): Promise<BotCommandResponse> {
    const computed = await this.computePlan(draft, runtimeContext);
    const updated = this.sessions.update({
      id: session.id,
      state: computed.state,
      repo_ref: computed.repoRef,
      intake_mode: computed.intakeMode,
      approval_mode: computed.approvalMode,
      plan_card: computed.planCard,
      active_decision_kind: computed.state === 'awaiting_user_approval' ? 'plan_approval' : null,
    })!;
    this.recordEvent(session.id, 'plan_card_generated', {
      state: updated.state,
      repo_ref: updated.repo_ref,
      intake_mode: updated.intake_mode,
      approval_mode: updated.approval_mode,
    });

    if (updated.approval_mode === 'auto' && updated.state !== 'clarifying') {
      return this.materialize(updated, canWrite);
    }

    return this.renderSessionMessage(updated);
  }

  private async computePlan(
    draft: DraftInput,
    runtimeContext: BotRuntimeCopilotContext,
  ): Promise<PlanComputation> {
    const repoRef = draft.project_slug
      || runtimeContext.default_project_slug
      || resolveProjectAlias(draft.title, runtimeContext.available_projects)
      || null;

    if (!repoRef) {
      return {
        repoRef: null,
        intakeMode: 'clarify_then_plan',
        approvalMode: 'explicit_user_approval',
        state: 'clarifying',
        planCard: {
          title: normalizeTitle(draft.title),
          user_goal: normalizeTitle(draft.title),
          in_scope: [normalizeTitle(draft.title)],
          out_of_scope: ['在确认仓库前，不启动真正执行。'],
          acceptance: inferAcceptance(draft.title, draft.description),
          known_risks: ['当前还没有绑定到明确仓库，因此无法读取治理上下文。'],
          execution_strategy: '先绑定仓库，再根据仓库约束完善计划。',
          needs_user_approval: true,
          repo_ref: null,
          project_slug: null,
          clarification_question: '告诉我这条需求应该落到哪个 project slug / 仓库。',
          materialization_mode: 'root_only',
          recommended_option: {
            label: '告诉我仓库',
            summary: '先绑定 repo，再继续计划和执行。',
          },
          alternate_option: {
            label: '改一下计划',
            summary: '如果这不是当前仓库的事，我们可以先重写目标。',
          },
          governance_preview: null,
        },
      };
    }

    const resolved = await this.projectResolver?.resolveProjectSlug(repoRef);
    const route = resolved?.route ?? null;
    const governance = route
      ? await assessIntakeCritic({
          issue: {
            id: 'preview',
            identifier: 'PREVIEW',
            title: draft.title,
            description: draft.description,
            priority: null,
            state: 'Todo',
            project_slug: repoRef,
            project_name: resolved?.project?.project_name ?? resolved?.route?.project_name ?? repoRef,
            branch_name: null,
            url: null,
            labels: [],
            blocked_by: [],
            created_at: null,
            updated_at: null,
          },
          route,
          repositoryRoot: route.local_path,
        })
      : null;

    const multiObjective = governance?.decision === 'split_before_implement'
      || isLikelyMultiObjective(draft.title, draft.description);
    const riskyCleanup = isRiskyCleanupRequest(`${draft.title}\n${draft.description || ''}`);
    const needsClarify = shouldClarifyAcceptance(draft.title, draft.description)
      && !multiObjective
      && governance?.decision !== 'accept_with_rewrite';

    let intakeMode: SupervisorIntakeMode = 'direct_run';
    let approvalMode: SupervisorApprovalMode = 'auto';
    let state: SupervisorSessionState = 'plan_ready';

    if (multiObjective || governance?.decision === 'accept_with_rewrite' || riskyCleanup) {
      intakeMode = 'plan_then_approve';
      approvalMode = 'explicit_user_approval';
      state = 'awaiting_user_approval';
    } else if (needsClarify) {
      intakeMode = 'clarify_then_plan';
      approvalMode = 'explicit_user_approval';
      state = 'clarifying';
    }

    const recommendedOption = multiObjective
      ? {
          label: '按推荐继续',
          summary: '先创建 root issue，再按拆分方案落成顺序 child queue。',
        }
      : riskyCleanup
        ? {
            label: '按推荐继续',
            summary: '先按计划建一张受控清理任务，执行前明确范围，避免误删有效文件。',
          }
        : governance?.decision === 'accept_with_rewrite'
        ? {
            label: '按推荐继续',
            summary: '先用更聚焦的标题和描述建单，再继续执行。',
          }
        : {
            label: '按推荐继续',
            summary: '按这张精简计划直接开跑。',
          };

    return {
      repoRef,
      intakeMode,
      approvalMode,
      state,
      planCard: {
        title: governance?.rewrite_title?.trim() || normalizeTitle(draft.title),
        user_goal: normalizeTitle(draft.title),
        in_scope: [normalizeTitle(draft.title)],
        out_of_scope: inferOutOfScope(draft.title),
        acceptance: inferAcceptance(draft.title, draft.description),
        known_risks: [
          governance?.summary ? compact(governance.summary, 180) : null,
          riskyCleanup ? '这类清理可能删除文件，需要先确认范围和验收方式。' : null,
          needsClarify ? '当前验收条件还不够稳，需要先补清楚。' : null,
        ].filter((value): value is string => Boolean(value)),
        execution_strategy: multiObjective
          ? '先把源目标收成 root thread，再只放行当前 child，其余 child 顺序排队。'
          : riskyCleanup
            ? '先限定清理范围，执行后用 git diff / 文件列表证明只清掉残余内容。'
          : '保持单目标推进，避免顺手扩大范围。',
        needs_user_approval: approvalMode !== 'auto',
        repo_ref: route?.github_repo_full ?? repoRef,
        project_slug: repoRef,
        clarification_question: needsClarify ? '这条需求完成以后，你最想看到的可验证结果是什么？' : null,
        materialization_mode: multiObjective ? 'root_with_split_queue' : 'root_only',
        recommended_option: recommendedOption,
        alternate_option: {
          label: '改一下计划',
          summary: '如果你不想按推荐路径走，我可以先把计划重写得更合适。',
        },
        governance_preview: governance
          ? {
              decision: governance.decision,
              summary: governance.summary,
              split_suggestions: governance.split_suggestions,
              rewrite_title: governance.rewrite_title,
              rewrite_description: governance.rewrite_description,
            }
          : null,
      },
    };
  }

  private async materialize(session: SupervisorSessionRecord, canWrite: boolean): Promise<BotCommandResponse> {
    if (!canWrite) {
      return {
        ...this.withSessionMetadata(
          session,
          {
            message: '当前 transport 没有写权限，所以我只能继续帮你起草计划，还不能真正建单执行。',
          },
          'write-blocked',
        ),
      };
    }

    const planCard = session.plan_card;
    if (!planCard || !planCard.project_slug) {
      return {
        ...this.withSessionMetadata(
          session,
          {
            message: '我还没拿到可物化的计划卡，先把仓库和计划补全。',
          },
          'missing-plan',
        ),
      };
    }

    this.sessions.update({
      id: session.id,
      state: 'approved_for_materialization',
      active_decision_kind: null,
    });
    const executionIntent = buildExecutionIntent(session, planCard);
    this.recordEvent(session.id, 'plan_approved', {
      plan_version: session.plan_version,
      project_slug: planCard.project_slug,
    });
    this.recordEvent(session.id, 'execution_intent_approved', {
      intent: executionIntent,
    });

    const createResult = await this.runtime.createIssue({
      title: planCard.title,
      description: [
        `用户目标：${planCard.user_goal}`,
        `本次范围：${planCard.in_scope.join('；')}`,
        `暂不处理：${planCard.out_of_scope.join('；')}`,
        `完成算什么：${planCard.acceptance.join('；')}`,
        `执行方式：${planCard.execution_strategy}`,
      ].join('\n'),
      project_slug: planCard.project_slug,
      supervisor_execution_intent: executionIntent,
    });

    if (!createResult.accepted || !createResult.issue_id) {
      this.sessions.update({
        id: session.id,
        state: 'awaiting_user_decision',
        delivery_summary: createResult.message,
        last_material_outcome: {
          materialize_error: createResult.message,
        },
      });
      this.recordEvent(session.id, 'materialize_failed', {
        message: createResult.message,
      });
      return {
        ...this.withSessionMetadata(
          this.sessions.findById(session.id) ?? session,
          {
            message: `建单没有成功：${createResult.message}\n你可以直接回复我想怎么改计划，或者稍后再试一次。`,
          },
          'materialize-failed',
        ),
      };
    }

    let latestIssue = this.runtime.getIssue(createResult.issue_id) ?? createResult.issue;
    let resultMessage = `已创建 ${createResult.issue_identifier || '新任务'}，并开始按计划推进。`;
    let materialOutcome: Record<string, unknown> = {
      issue_id: createResult.issue_id,
      issue_identifier: createResult.issue_identifier,
    };

    if (planCard.materialization_mode === 'root_with_split_queue') {
      const splitResult = await this.runtime.splitGovernance(createResult.issue_id);
      latestIssue = this.runtime.getIssue(createResult.issue_id) ?? latestIssue;
      materialOutcome = {
        ...materialOutcome,
        split_status: splitResult.status,
        governance_action: splitResult.governance_action ?? null,
      };
      if (splitResult.accepted) {
        resultMessage = [
          `已创建 ${createResult.issue_identifier || '新任务'}，并按推荐拆成顺序子任务队列。`,
          splitResult.governance_action?.user_summary || splitResult.message,
        ].join('\n');
      } else {
        resultMessage = `已创建 ${createResult.issue_identifier || '新任务'}，但自动拆分没有成功：${splitResult.message}`;
      }
    }

    const updated = this.sessions.update({
      id: session.id,
      state: 'executing',
      repo_ref: planCard.project_slug,
      root_issue_id: createResult.issue_id,
      current_child_issue_id: latestIssue?.governance_current_child?.issue_id ?? null,
      delivery_state: latestIssue?.delivery_state ?? null,
      delivery_summary: latestIssue?.delivery_summary ?? null,
      last_material_outcome: materialOutcome,
    }) ?? session;
    this.recordEvent(session.id, 'materialized', {
      issue_id: createResult.issue_id,
      issue_identifier: createResult.issue_identifier,
      current_child_issue_id: latestIssue?.governance_current_child?.issue_id ?? null,
    });
    this.recordEvent(session.id, 'materialized_plan_created', {
      plan: buildMaterializedPlan(executionIntent, latestIssue, createResult),
    });

    return this.renderMaterializedMessage(updated, latestIssue, resultMessage);
  }

  private approvePlanRevision(
    session: SupervisorSessionRecord,
    canWrite: boolean,
  ): BotCommandResponse {
    if (!canWrite) {
      return this.withSessionMetadata(
        session,
        {
          message: '当前 transport 没有写权限，所以我不能批准这次计划修订。',
        },
        'revision-write-blocked',
      );
    }

    const issue = session.root_issue_id ? this.runtime.getIssue(session.root_issue_id) : null;
    const updated = this.sessions.update({
      id: session.id,
      state: 'executing',
      active_decision_kind: null,
      delivery_state: issue?.delivery_state ?? session.delivery_state,
      delivery_summary: issue?.delivery_summary ?? session.delivery_summary,
      last_material_outcome: {
        ...(session.last_material_outcome ?? {}),
        plan_revision_approved_at: new Date().toISOString(),
        plan_version: session.plan_version,
      },
    }) ?? session;
    this.recordEvent(session.id, 'plan_revision_approved', {
      plan_version: session.plan_version,
      root_issue_id: session.root_issue_id,
      root_issue_identifier: issue?.identifier ?? null,
    });

    return this.renderMaterializedMessage(
      updated,
      issue,
      `第 ${session.plan_version} 版计划已批准。我会继续围绕原 root thread 推进，不会新建重复任务。`,
    );
  }

  private async executeRecommendedDecision(
    session: SupervisorSessionRecord,
    canWrite: boolean,
  ): Promise<BotCommandResponse> {
    if (!canWrite) {
      return this.withSessionMetadata(
        session,
        {
          message: '当前 transport 没有写权限，所以不能执行这一步。你可以继续改计划或联系 operator。',
        },
        'decision-write-blocked',
      );
    }

    const issue = session.root_issue_id ? this.runtime.getIssue(session.root_issue_id) : null;
    if (!issue) {
      return this.withSessionMetadata(
        session,
        {
          message: '我找不到这条计划对应的 root issue，先不要继续执行。',
        },
        'decision-missing-root',
      );
    }

    let result;
    if (issue.governance_decision === 'split_before_implement' && issue.actions.can_split_governance) {
      result = await this.runtime.splitGovernance(issue.issue_id);
    } else if (issue.governance_decision === 'accept_with_rewrite' && issue.actions.can_rewrite_governance) {
      result = await this.runtime.rewriteGovernance(issue.issue_id);
    } else {
      const suggestion = issue.active_governance_suggestions?.find((item) => item.can_execute) ?? null;
      if (suggestion) {
        result = await this.runtime.executeGovernanceSuggestion(issue.issue_id, suggestion.id);
      } else {
        return this.withSessionMetadata(
          session,
          {
            message: `${issue.identifier} 当前没有可自动执行的推荐治理动作。你可以直接回复想怎么改，或者显式要求强制继续。`,
          },
          'decision-no-action',
        );
      }
    }

    const latestIssue = this.runtime.getIssue(issue.issue_id) ?? issue;
    const nextState: SupervisorSessionState = result.accepted ? 'executing' : 'awaiting_user_decision';
    const updated = this.sessions.update({
      id: session.id,
      state: nextState,
      current_child_issue_id: latestIssue.governance_current_child?.issue_id ?? session.current_child_issue_id,
      delivery_state: latestIssue.delivery_state ?? session.delivery_state,
      delivery_summary: latestIssue.delivery_summary ?? result.message,
      last_material_outcome: {
        governance_action: result.governance_action ?? null,
        message: result.message,
        status: result.status,
      },
    }) ?? session;
    this.recordEvent(session.id, result.accepted ? 'execution_decision_applied' : 'execution_decision_failed', {
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      status: result.status,
      message: result.message,
      governance_action: result.governance_action ?? null,
    });

    return this.renderMaterializedMessage(
      updated,
      latestIssue,
      result.governance_action?.user_summary || result.message,
    );
  }

  private renderSessionMessage(
    session: SupervisorSessionRecord,
    issue: RuntimeIssueView | null = null,
  ): BotCommandResponse {
    const planCard = session.plan_card;
    if (!planCard) {
      return this.withSessionMetadata(session, {
        message: '这条计划线程还在起草中。',
      }, 'drafting');
    }

    if (session.state === 'clarifying') {
      return this.withSessionMetadata(
        session,
        {
          format: 'telegram_html',
          message: joinHtmlLines([
            `<b>继续补计划</b>`,
            '我正在帮你把这件事收成一个可执行计划。',
            null,
            '<b>当前理解</b>',
            escapeHtml(planCard.title),
            null,
            '<b>仓库</b>',
            escapeHtml(planCard.repo_ref || '待确认'),
            null,
            '<b>还缺什么</b>',
            escapeHtml(planCard.clarification_question || '请补一句你最关心的验收结果。'),
          ]),
        },
        'clarifying',
      );
    }

    if (session.state === 'awaiting_user_approval' || session.state === 'plan_ready') {
      return this.withSessionMetadata(
        session,
        {
          format: 'telegram_html',
          message: joinHtmlLines([
            `<b>计划待你批准 · v${session.plan_version}</b>`,
            escapeHtml(planCard.needs_user_approval ? '这条需求需要你确认计划后再建单执行。' : '这是我准备自动执行的精简计划。'),
            null,
            '<b>用户目标</b>',
            escapeHtml(planCard.user_goal),
            null,
            '<b>仓库</b>',
            escapeHtml(planCard.repo_ref || '待确认'),
            null,
            '<b>本次范围</b>',
            escapeHtml(textList(planCard.in_scope, '按当前目标推进。')),
            null,
            '<b>暂不处理</b>',
            escapeHtml(textList(planCard.out_of_scope, '不扩大到无关模块。')),
            null,
            '<b>完成算什么</b>',
            escapeHtml(textList(planCard.acceptance, '结果可验证。')),
            planCard.known_risks.length > 0 ? null : null,
            planCard.known_risks.length > 0 ? '<b>已知风险</b>' : null,
            planCard.known_risks.length > 0 ? escapeHtml(textList(planCard.known_risks, '暂无明显风险。')) : null,
            null,
            '<b>推荐方案</b>',
            escapeHtml(`${planCard.recommended_option.label}：${planCard.recommended_option.summary}`),
            planCard.alternate_option ? '<b>备选方案</b>' : null,
            planCard.alternate_option ? escapeHtml(`${planCard.alternate_option.label}：${planCard.alternate_option.summary}`) : null,
            null,
            '点按钮继续，或者直接回复你的想法。',
          ]),
          action_rows: [
            [{ label: '按推荐继续', callback_data: `sup|${session.id}|approve` }],
            [
              { label: '改一下计划', callback_data: `sup|${session.id}|edit` },
              { label: '换用备选方案', callback_data: `sup|${session.id}|alternate` },
            ],
          ],
        },
        'approval',
      );
    }

    if (session.state === 'awaiting_user_decision') {
      return this.withSessionMetadata(
        session,
        {
          format: 'telegram_html',
          message: joinHtmlLines([
            `<b>需要你决定 · ${escapeHtml(issue?.identifier || planCard.title)}</b>`,
            '执行线程遇到需要确认的治理节点。',
            null,
            '<b>当前计划</b>',
            escapeHtml(planCard.title),
            issue?.github_repo ? '<b>仓库</b>' : null,
            issue?.github_repo ? `<code>${escapeHtml(issue.github_repo)}</code>` : null,
            null,
            '<b>推荐下一步</b>',
            escapeHtml(issue?.next_recommended_action || planCard.recommended_option.summary),
            issue?.governance_summary ? '<b>原因</b>' : null,
            issue?.governance_summary ? escapeHtml(compact(issue.governance_summary, 240)) : null,
            null,
            '点“按推荐继续”，或者直接回复你想怎么改。',
          ]),
          action_rows: [
            [{ label: '按推荐继续', callback_data: `sup|${session.id}|approve` }],
            [{ label: '改一下计划', callback_data: `sup|${session.id}|edit` }],
          ],
        },
        `decision:${issue?.identifier ?? 'none'}`,
      );
    }

    return this.withSessionMetadata(
      session,
      {
        format: 'telegram_html',
        message: joinHtmlLines([
          `<b>计划线程 · ${escapeHtml(planCard.title)}</b>`,
          `状态：${escapeHtml(session.state)}`,
        ]),
      },
      session.state,
    );
  }

  private renderMaterializedMessage(
    session: SupervisorSessionRecord,
    issue: RuntimeIssueView | null,
    resultMessage: string,
  ): BotCommandResponse {
    const planCard = session.plan_card;
    const currentChild = issue?.governance_current_child
      ?? issue?.governance_child_queue?.find((child) => child.queue_state === 'current')
      ?? null;
    const queue = issue?.governance_child_queue ?? [];

    return this.withSessionMetadata(
      session,
      {
        format: 'telegram_html',
        message: joinHtmlLines([
          `<b>计划已进入执行 · ${escapeHtml(issue?.identifier || planCard?.title || 'root')}</b>`,
          escapeHtml(compact(resultMessage, 260)),
          null,
          planCard ? '<b>计划</b>' : null,
          planCard ? escapeHtml(planCard.title) : null,
          issue?.github_repo ? '<b>仓库</b>' : null,
          issue?.github_repo ? `<code>${escapeHtml(issue.github_repo)}</code>` : null,
          currentChild ? '<b>当前子任务</b>' : null,
          currentChild ? `${escapeHtml(currentChild.issue_identifier)} · ${escapeHtml(currentChild.title)}` : null,
          queue.length > 0 ? '<b>队列</b>' : null,
          queue.length > 0
            ? escapeHtml(queue.map((child) => `${child.issue_identifier}:${child.queue_state || 'queued'}`).join(' / '))
            : null,
          null,
          escapeHtml(issue?.next_recommended_action || '我会继续盯关键节点，有需要你决定时再回来。'),
        ]),
        action_rows: [],
      },
      `executing:${issue?.identifier ?? 'none'}:${currentChild?.issue_identifier ?? 'none'}:${queue.map((child) => `${child.issue_identifier}:${child.queue_state ?? ''}`).join(',')}`,
    );
  }

  private renderPlanMemoryAnswer(
    session: SupervisorSessionRecord,
    issue: RuntimeIssueView | null,
  ): BotCommandResponse {
    const planCard = session.plan_card;
    if (!planCard) {
      return this.withSessionMetadata(
        session,
        {
          message: '这条计划线程还没有形成稳定计划卡。',
        },
        'plan-memory-missing',
      );
    }

    const currentChild = issue?.governance_current_child
      ?? issue?.governance_child_queue?.find((child) => child.queue_state === 'current')
      ?? null;

    return this.withSessionMetadata(
      session,
      {
        format: 'telegram_html',
        message: joinHtmlLines([
          `<b>计划记忆 · v${session.plan_version}</b>`,
          '这是当前 Telegram 线程里我正在守住的执行计划。',
          null,
          '<b>用户目标</b>',
          escapeHtml(planCard.user_goal),
          null,
          '<b>本次范围</b>',
          escapeHtml(textList(planCard.in_scope, '按当前目标推进。')),
          null,
          '<b>暂不处理</b>',
          escapeHtml(textList(planCard.out_of_scope, '不扩大到无关模块。')),
          null,
          '<b>完成算什么</b>',
          escapeHtml(textList(planCard.acceptance, '结果可验证。')),
          currentChild ? '<b>当前子任务</b>' : null,
          currentChild ? `${escapeHtml(currentChild.issue_identifier)} · ${escapeHtml(currentChild.title)}` : null,
          null,
          '<b>下一步</b>',
          escapeHtml(issue?.next_recommended_action || planCard.recommended_option.summary),
        ]),
      },
      `plan-memory:${issue?.identifier ?? 'none'}:${currentChild?.issue_identifier ?? 'none'}`,
    );
  }

  private withSessionMetadata(
    session: SupervisorSessionRecord,
    response: BotCommandResponse,
    materialKey: string,
  ): BotCommandResponse {
    return {
      ...response,
      session_id: session.id,
      material_key: `session|${session.id}|v${session.plan_version}|${materialKey}`,
    };
  }

  private recordEvent(sessionId: string, eventKind: string, payload: Record<string, unknown>): void {
    this.sessionEvents.create({
      id: crypto.randomUUID(),
      session_id: sessionId,
      event_kind: eventKind,
      payload_json: payload,
    });
  }

  private syncFromIssue(issue: RuntimeIssueView): void {
    const rootIssueId = issue.governance_root_issue_id ?? issue.issue_id;
    const isRootIssueEvent = rootIssueId === issue.issue_id;
    const session = this.sessions.findByRootIssueId(rootIssueId);
    if (!session) {
      return;
    }

    const milestone = deriveSupervisorMilestone(issue);
    const previousMilestoneKey = typeof session.last_material_outcome?.milestone_key === 'string'
      ? session.last_material_outcome.milestone_key
      : null;
    if (milestone && milestone.key !== previousMilestoneKey) {
      this.recordEvent(session.id, 'orchestrator_milestone', {
        milestone_kind: milestone.kind,
        milestone_key: milestone.key,
        issue_id: milestone.issue_id,
        issue_identifier: milestone.issue_identifier,
        summary: milestone.summary,
        delivery_state: milestone.delivery_state ?? null,
        delivery_code: milestone.delivery_code ?? null,
        governance_thread_state: milestone.governance_thread_state ?? null,
        current_child_issue_id: milestone.current_child_issue_id ?? null,
      });
    }

    let nextState = session.state;
    if (isRootIssueEvent && (issue.orchestrator_state === 'completed' || issue.delivery_state === 'completed')) {
      nextState = 'completed';
    } else if (isRootIssueEvent && (
      issue.governance_thread_state === 'blocked' ||
      issue.governance_thread_state === 'confirming'
    )) {
      nextState = 'awaiting_user_decision';
    } else if (session.root_issue_id) {
      nextState = 'executing';
    }

    this.sessions.update({
      id: session.id,
      state: nextState,
      root_issue_id: session.root_issue_id ?? rootIssueId,
      current_child_issue_id: issue.governance_current_child?.issue_id ?? session.current_child_issue_id,
      delivery_state: isRootIssueEvent || issue.delivery_state === 'delivery_failed'
        ? issue.delivery_state ?? session.delivery_state
        : session.delivery_state,
      delivery_summary: isRootIssueEvent || issue.delivery_state === 'delivery_failed'
        ? issue.delivery_summary ?? session.delivery_summary
        : session.delivery_summary,
      last_material_outcome: {
        ...(session.last_material_outcome ?? {}),
        milestone_kind: milestone?.kind ?? session.last_material_outcome?.milestone_kind ?? null,
        milestone_key: milestone?.key ?? session.last_material_outcome?.milestone_key ?? null,
        governance_thread_state: issue.governance_thread_state ?? null,
        next_recommended_action: issue.next_recommended_action ?? null,
      },
    });
  }
}
