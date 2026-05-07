import type {
  BotAssistantIntent,
  BotCommandContext,
  BotCommandResponse,
  BotRuntimeCopilotContext,
  SupervisorIntakeSource,
} from '../bots/types';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import { assessIntakeCritic } from '../governance/intakeCritic';
import type {
  SupervisorApprovalMode,
  SupervisorDecisionKind,
  SupervisorIntakeMode,
  SupervisorPlanCard,
  SupervisorSessionEventRecord,
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
import type {
  SupervisorRepoIntelligenceResolver,
  SupervisorRepoIntelligenceSnapshot,
} from './repoIntelligence';
import { describeSupervisorThread } from './threadSummary';
import { applySupervisorApprovalPolicy } from './approvalPolicy';
import {
  DefaultSupervisorExecutionOverseer,
  type SupervisorOversightAssessment,
  type SupervisorExecutionOverseer,
} from './executionOverseer';
import { buildSupervisorSessionVisualCard } from './sessionVisualCard';
import { isInternalSupervisorTurnBudgetFailure } from './milestoneVisibility';

export interface SupervisorServiceResponseParams {
  context: BotCommandContext;
  text: string;
  intent: BotAssistantIntent | null;
  runtimeContext: BotRuntimeCopilotContext;
  canWrite: boolean;
  source?: SupervisorIntakeSource;
}

export type SupervisorSessionAction = 'approve' | 'edit' | 'alternate' | 'focus' | 'cancel';

const APPROVE_WORDS = ['确认', '按推荐继续', '批准', '开始执行', '继续', '批准并开始'];
const EDIT_WORDS = ['改一下计划', '修改计划', '先别执行', '不要开始'];
const ALTERNATE_WORDS = ['换用备选方案', '换方案', '备选方案'];
const CANCEL_WORDS = ['取消当前计划', '取消这条计划', '结束当前计划', '放弃当前计划'];
const FOCUS_TEXT_PATTERN = /^(?:卡片给我|把卡片发我|把当前卡片发我|发我卡片|发一下卡片|当前卡片|查看当前计划|看当前计划|当前计划|查看计划卡|看计划卡|计划卡给我)$/i;
const NEW_THREAD_PREFIX = /^(新开线程|开启新线程|新建线程|另开线程)[:：\s]+/;
const SCOPE_CHANGE_PATTERNS = [/顺便/, /另外/, /再加/, /改成/, /顺手/];
const ACTIVE_SESSION_STATES = new Set<SupervisorSessionState>([
  'drafting',
  'clarifying',
  'plan_ready',
  'awaiting_user_approval',
  'approved_for_materialization',
  'materialized',
  'executing',
  'awaiting_user_decision',
]);

function emptyRuntimeContext(): BotRuntimeCopilotContext {
  return {
    default_project_slug: null,
    available_projects: [],
    repo_profile: null,
    watch_subscriptions: [],
    overview: {
      running: 0,
      retrying: 0,
      total: 0,
      active_issues: [],
    },
    focus_issue: null,
    assistant: {
      provider: null,
      model: null,
      configured: false,
      health: 'unconfigured',
      fallback_available: true,
      last_error_code: null,
    },
  };
}

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

function isInternalPlanDiagnostic(value: string): boolean {
  return /shadow harness|formal harness|\.symphony-constitution\.md|debt signal|冲突记忆/i.test(value);
}

function visiblePlanRisks(planCard: SupervisorPlanCard): string[] {
  return (planCard.known_risks ?? []).filter((risk) => !isInternalPlanDiagnostic(risk));
}

function lastOutcomeString(
  session: SupervisorSessionRecord,
  key: string,
): string | null {
  const value = session.last_material_outcome?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function runtimeIssueAppPath(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): string {
  const target = issue?.identifier || issue?.issue_id || session.root_issue_id;
  if (target) {
    return `/runtime/issues/${encodeURIComponent(target)}/app`;
  }
  return `/runtime?session=${encodeURIComponent(session.id)}`;
}

function isRetryableDeliveryDecision(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): boolean {
  return session.state === 'awaiting_user_decision' &&
    session.active_decision_kind === 'delivery_failure' &&
    Boolean(issue?.actions.can_retry) &&
    Boolean(issue?.delivery_state === 'delivery_failed' || issue?.delivery_code || issue?.orchestrator_state === 'failed');
}

function supervisorPrimaryAction(session: SupervisorSessionRecord, issue: RuntimeIssueView | null = null): {
  label: string;
  action: SupervisorSessionAction;
} {
  if (session.state === 'awaiting_user_approval' || session.state === 'plan_ready') {
    return { label: '批准并开始', action: 'approve' };
  }
  if (isRetryableDeliveryDecision(session, issue)) {
    return { label: '修复交付并重试', action: 'approve' };
  }
  if (session.state === 'awaiting_user_decision') {
    return { label: '按推荐继续', action: 'approve' };
  }
  if (session.state === 'completed') {
    return { label: '已完成', action: 'focus' };
  }
  if (session.state === 'cancelled') {
    return { label: '已取消', action: 'focus' };
  }
  return { label: '已批准开始', action: 'focus' };
}

function supervisorActionRows(
  session: SupervisorSessionRecord,
  issue: RuntimeIssueView | null,
  primaryLabel = supervisorPrimaryAction(session, issue).label,
  primaryAction: SupervisorSessionAction = supervisorPrimaryAction(session, issue).action,
): NonNullable<BotCommandResponse['action_rows']> {
  if (session.state === 'completed') {
    return [
      [
        { label: '已完成', style: 'success', callback_data: `sup|${session.id}|focus` },
        { label: '打开运行视图', style: 'primary', web_app: { url: runtimeIssueAppPath(session, issue) } },
      ],
    ];
  }

  return [
    [{ label: primaryLabel, style: 'success', callback_data: `sup|${session.id}|${primaryAction}` }],
    [
      { label: '改一下计划', callback_data: `sup|${session.id}|edit` },
      { label: '打开运行视图', style: 'primary', web_app: { url: runtimeIssueAppPath(session, issue) } },
    ],
  ];
}

function supervisorOutcomeMaterialParts(session: SupervisorSessionRecord): string[] {
  return [
    lastOutcomeString(session, 'pending_user_notification_summary')
      ? `notify:${compact(lastOutcomeString(session, 'pending_user_notification_summary'), 96)}`
      : null,
    lastOutcomeString(session, 'latest_dev_directive_kind')
      ? `directive:${lastOutcomeString(session, 'latest_dev_directive_kind')}`
      : null,
    lastOutcomeString(session, 'latest_dev_instruction')
      ? `instruction:${compact(lastOutcomeString(session, 'latest_dev_instruction'), 96)}`
      : null,
    lastOutcomeString(session, 'milestone_key')
      ? `milestone:${compact(lastOutcomeString(session, 'milestone_key'), 128)}`
      : null,
  ].filter((part): part is string => Boolean(part));
}

function runtimeIssueMaterialParts(issue: RuntimeIssueView | null): string[] {
  if (!issue) {
    return [];
  }
  const latestTools = (issue.session?.recent_tools ?? []).slice(-2).map((tool) => (
    `tool:${tool.tool_name}:${tool.status}:${compact(tool.summary ?? tool.message, 72)}:${tool.timestamp}`
  ));
  const latestFiles = (issue.session?.recent_files ?? []).slice(-2).map((file) => (
    `file:${file.operation}:${file.status}:${compact(file.path, 72)}:${file.timestamp}`
  ));
  const latestMilestones = (issue.milestones ?? []).slice(-2).map((milestone) => (
    `runtime-milestone:${milestone.kind}:${compact(milestone.summary, 72)}:${milestone.timestamp ?? ''}`
  ));
  const agentProgress = issue.agentRecentProgress ?? issue.agent_recent_progress ?? null;
  const recentAgentProgress = [
    ...(agentProgress?.dev ?? []),
    ...(agentProgress?.review ?? []),
  ].slice(-3).map((progress) => (
    `agent:${progress.status}:${compact(progress.summary, 72)}:${progress.timestamp ?? ''}`
  ));

  return [
    `phase:${issue.phase}`,
    `tracker:${issue.tracker_state}`,
    `orchestrator:${issue.orchestrator_state ?? ''}`,
    `delivery:${issue.delivery_state ?? ''}:${issue.delivery_code ?? ''}:${compact(issue.delivery_summary, 96)}`,
    `next:${compact(issue.next_recommended_action, 96)}`,
    `session:${issue.session?.stage ?? ''}:${compact(issue.session?.last_message, 96)}:${issue.session?.last_event_at ?? ''}`,
    issue.round ? `round:${issue.round.index}/${issue.round.total}:${compact(issue.round.goal, 72)}` : null,
    ...latestTools,
    ...latestFiles,
    ...latestMilestones,
    ...recentAgentProgress,
  ].filter((part): part is string => Boolean(part));
}

function buildMaterializedRootIssueTitle(planCard: SupervisorPlanCard): string {
  const combined = [
    planCard.title,
    planCard.user_goal,
    planCard.in_scope.join('\n'),
    planCard.acceptance.join('\n'),
  ].join('\n');
  if (/supervisor\s+live\s+e2e|supervisor-live-cleanup-approval/i.test(combined)) {
    if (/supervisor-live-cleanup-approval|破坏性清理审批/i.test(combined)) {
      return '验证破坏性清理审批 marker';
    }
  }
  return planCard.title;
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

function stripIssueRequestPhrases(value: string): string {
  return value
    .replace(/^(?:请)?(?:帮我)?(?:建立|创建|新建)\s*issue[:：\s]*/i, '')
    .replace(/^(?:请)?(?:帮我)?(?:建立|创建|新建)\s*(?:一个|一条)?\s*(?:issue|任务|工单)[:：\s]*/i, '')
    .replace(/^(?:issue|任务|工单)[:：\s]*/i, '')
    .trim();
}

function normalizeRequirementText(value: string): string {
  const normalized = normalizeTitle(value)
    .replace(NEW_THREAD_PREFIX, '')
    .replace(/^(?:请)?(?:帮我)?(?:建立|创建|新建)\s*issue[:：\s]*/i, '')
    .replace(/^(?:请)?(?:帮我)?(?:建立|创建|新建)\s*(?:一个|一条)?\s*(?:issue|任务|工单)[:：\s]*/i, '')
    .replace(/\bsupervisor\s+live\s+e2e\s+[a-z0-9_/-]*\d[a-z0-9_/-]*\b/gi, '')
    .replace(/\bnonce\s+\S+\b/gi, '')
    .replace(/请新建一条很小的验证任务[:：]\s*/g, '')
    .replace(/请先给\s*plan\s*card[，,、\s]*(?:不要直接建单)?[。.]?/gi, '')
    .replace(/先给(?:我)?(?:计划卡|计划|方案)[，,、\s]*(?:我)?(?:批准|确认|同意)后再(?:做|执行|开始|开跑)[。.]?/g, '')
    .replace(/(?:我)?(?:批准|确认|同意)后再(?:做|执行|开始|开跑)[。.]?/g, '')
    .replace(/不要直接(?:建单|做|执行|开跑)[。.]?/g, '')
    .replace(/别直接(?:建单|做|执行|开跑)[。.]?/g, '')
    .replace(/(?:^|[\s，,。.:：；;])plan\s*card\s*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s，,。.:：；;]+|[\s，,。.:：；;]+$/g, '');
  return normalized || stripIssueRequestPhrases(normalizeTitle(value));
}

function inferIssueTitleFromRequest(title: string, description: string | null): string {
  const normalized = normalizeRequirementText(title);
  const combined = `${normalized}\n${description || ''}`;

  if (/不同质量恒星|光度/.test(combined) && /随.*m|随参数\s*m|随质量\s*m|随\s*m\s*变化/i.test(combined)) {
    return '分析不同质量恒星的光度等参数随质量 M 的变化';
  }

  if (/研究|分析|计算|总结|整理/.test(normalized)) {
    return normalized;
  }

  return normalized;
}

function inferStructuredScope(
  title: string,
  description: string | null,
): {
  inScope?: string[];
  outOfScope?: string[];
  acceptance?: string[];
  executionStrategy?: string | null;
} | null {
  const combined = `${title}\n${description || ''}`;
  if (/不同质量恒星|光度/.test(combined) && /随.*m|随参数\s*m|随质量\s*m|随\s*m\s*变化/i.test(combined)) {
    return {
      inScope: [
        '整理不同质量恒星相关参数随质量 M 变化的主要公式、经验标度律或近似关系。',
        '给出一份可运行的 Python 计算脚本或绘图代码，展示关键参数随 M 的变化趋势。',
      ],
      outOfScope: [
        '不扩展成完整的恒星演化综述或超出当前仓库目标的大型科研项目。',
      ],
      acceptance: [
        '标明采用的主要标度律、假设条件或适用质量范围，避免把近似关系写成普适结论。',
        '至少包含一份可运行脚本或图表输出，能展示关键参数随 M 的变化。',
      ],
      executionStrategy: '先把理论关系和适用前提收口成一版结构化总结，再补最小可运行脚本或绘图代码作为验证产物。',
    };
  }
  return null;
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

function extractAcceptanceFromClarificationAnswer(answer: string): string[] | null {
  const normalized = answer.trim();
  if (!normalized || isDelegatingAcceptanceChoice(normalized)) {
    return null;
  }
  if (/验收|完成后|完成以后|可验证|测试|通过|输出|页面|命令|结果|应该/.test(normalized)) {
    return [compact(normalized, 220)];
  }
  return null;
}

function inferDelegatedClarificationAcceptance(title: string, description: string | null): string[] {
  return inferDefaultClarificationAcceptance(title, description) ?? [
    `完成 ${compact(title, 60)}，并给出可直接验证的结果。`,
    '把结果收成一张可批准的推荐计划卡，而不是继续追问细节。',
  ];
}

function isConversationalSupervisorProductRequest(title: string, description: string | null): boolean {
  const combined = `${title}\n${description || ''}`;
  return /supervisor/.test(combined)
    && /(自然语言|聊天|对话|issue|建单|推荐卡|telegram|slash)/i.test(combined);
}

function inferConversationalAcceptance(title: string, description: string | null): string[] | null {
  if (!isConversationalSupervisorProductRequest(title, description)) {
    return null;
  }
  return [
    '用户能直接在 Telegram 对话里收到显眼的推荐 issue 卡，并可以一键批准继续。',
    '普通聊天默认走 supervisor 的自然语言收需求流程，而不是退回机械补表单。',
    'slash 命令继续保留明确的机器路径，不和自然对话建单体验混在一起。',
  ];
}

function inferConversationalRecommendationSummary(title: string, description: string | null): string | null {
  if (!isConversationalSupervisorProductRequest(title, description)) {
    return null;
  }
  return '先把 Telegram 自然对话、推荐 issue 卡批准、slash 命令边界一起收进一张更像样的 issue，再进入后续执行。';
}

function inferConversationalExecutionStrategy(title: string, description: string | null): string | null {
  if (!isConversationalSupervisorProductRequest(title, description)) {
    return null;
  }
  return '先把 supervisor 的自然语言收需求、推荐卡展示和 slash 命令边界整理成一版可批准计划，再按批准结果推进实现与监管流程。';
}

function inferOutOfScope(title: string): string[] {
  if (/同时|并且|以及|一起|and/i.test(title)) {
    return ['这次不把所有并列目标一起并发推进。'];
  }
  return ['不顺手扩展到无关模块。'];
}

function buildRepoIntelligenceRisks(
  intelligence: SupervisorRepoIntelligenceSnapshot | null,
): string[] {
  if (!intelligence) {
    return [];
  }

  return [
    intelligence.harness_status === 'shadow'
      ? '当前仓库仍在使用 shadow harness，验证约束可能还不稳定。'
      : intelligence.harness_status === 'missing'
        ? '当前仓库还没有 formal harness，执行约束需要继续从运行结果里学习。'
        : null,
    intelligence.constitution_status === 'missing'
      ? '当前仓库还没有 .symphony-constitution.md，治理判断会偏保守。'
      : null,
    intelligence.related_conflict_count > 0
      ? `同仓最近已有 ${intelligence.related_conflict_count} 条相关冲突记忆。${compact(intelligence.top_conflict_summary, 90)}`
      : null,
    intelligence.related_debt_signal_count > 0
      ? `同仓最近已有 ${intelligence.related_debt_signal_count} 条相关 debt signal。${compact(intelligence.top_debt_summary, 90)}`
      : null,
  ].filter((value): value is string => Boolean(value));
}

function buildRepoExecutionHints(
  intelligence: SupervisorRepoIntelligenceSnapshot | null,
): string[] {
  if (!intelligence) {
    return [];
  }

  return [
    intelligence.decision_memory_count > 0
      ? `优先复用这个仓库最近 ${intelligence.decision_memory_count} 条已验证路径，避免重复试错。`
      : null,
    intelligence.harness_status !== 'formal'
      ? '先用可验证的小步提交收紧执行范围，再决定是否扩展。'
      : null,
  ].filter((value): value is string => Boolean(value));
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

function buildDestructiveApprovalPolicyText(
  session: SupervisorSessionRecord,
  issue: RuntimeIssueView,
): string {
  const plan = session.plan_card;
  return [
    plan?.title,
    plan?.user_goal,
    ...(plan?.in_scope ?? []),
    ...(plan?.out_of_scope ?? []),
    ...(plan?.acceptance ?? []),
    ...(plan?.known_risks ?? []),
    plan?.execution_strategy,
    issue.title,
    issue.next_recommended_action,
    issue.delivery_summary,
  ].filter((value): value is string => Boolean(value)).join('\n');
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

function isCancelText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return CANCEL_WORDS.some((word) => normalized.includes(word.toLowerCase()));
}

function isFocusText(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return FOCUS_TEXT_PATTERN.test(normalized)
    || /^(?:发|给|看看|看一下).{0,8}(?:当前|这张|这个|现有).{0,8}(?:卡片|计划卡|计划)$/i.test(normalized)
    || /^(?:当前|这张|这个|现有).{0,8}(?:卡片|计划卡).{0,8}(?:发我|给我|看看|看一下)$/i.test(normalized);
}

function isNewThreadText(text: string): boolean {
  return NEW_THREAD_PREFIX.test(text.trim());
}

function stripNewThreadPrefix(text: string): string {
  return text.trim().replace(NEW_THREAD_PREFIX, '').trim();
}

function isScopeChangeText(text: string): boolean {
  return SCOPE_CHANGE_PATTERNS.some((pattern) => pattern.test(text));
}

function explicitlyRequestsApprovalBeforeExecution(text: string, description: string | null): boolean {
  const combined = `${text}\n${description || ''}`;
  return /先.*(?:计划卡|计划|方案|plan\s*card).*(?:批准|确认|同意|approve|approval)|(?:批准|确认|同意|approve|approval)后再(?:做|执行|开始|开跑)|等我(?:批准|确认|同意|approve|approval)|plan\s*card|不要直接(?:做|执行|开跑)|别直接(?:做|执行|开跑)/i.test(combined);
}

function isPlanMemoryQuestion(text: string): boolean {
  return /计划|范围|验收|完成算什么|目标|为什么|子任务|子单|plan|scope|acceptance|goal/i.test(text);
}

function shouldRouteReadOnlyIntentToActiveSession(
  session: SupervisorSessionRecord,
  intent: BotAssistantIntent | null,
  text: string,
): boolean {
  if (
    isApprovalText(text) ||
    isEditText(text) ||
    isAlternateText(text) ||
    isCancelText(text) ||
    isFocusText(text) ||
    isScopeChangeText(text) ||
    isPlanMemoryQuestion(text)
  ) {
    return true;
  }
  if (!intent) {
    return session.state === 'clarifying' || session.state === 'drafting';
  }
  if (intent.kind === 'create_issue') {
    return true;
  }
  if (
    intent.kind === 'status' ||
    intent.kind === 'show_default_project' ||
    intent.kind === 'help' ||
    intent.kind === 'answer_question'
  ) {
    return false;
  }
  return session.state === 'clarifying' || session.state === 'drafting';
}

function shouldClarifyAcceptance(text: string, description: string | null): boolean {
  const combined = `${text}\n${description || ''}`;
  if (isRiskyCleanupRequest(combined)) {
    return false;
  }
  if (canInferConcreteAcceptanceFromTask(text, description)) {
    return false;
  }
  return !/验收|测试|verify|验证|输出|页面|命令|结果|完成后|应该/.test(combined);
}

function isDelegatingAcceptanceChoice(answer: string): boolean {
  return /你自己决定|你定|你看着办|你来定|你决定|随便|都可以|你拿主意|按你判断|别再问我|别再问了|不用再问|直接定吧|你直接决定/i.test(answer.trim());
}

function clarificationAnswerUpdatesGoal(question: string | null | undefined, answer: string): boolean {
  const normalizedQuestion = question || '';
  const normalizedAnswer = answer.trim();
  if (!normalizedQuestion || !normalizedAnswer) {
    return false;
  }
  if (/验收|完成以后|完成后|可验证|acceptance/i.test(normalizedQuestion)) {
    return false;
  }
  return /笔误|实际想|具体目标|清空的是|清理的是|删除的是|目标/i.test(normalizedQuestion);
}

function asksForRepoClarification(question: string | null | undefined): boolean {
  return /仓库|project slug|repo/i.test(question || '');
}

function isLikelyMultiObjective(text: string, description: string | null): boolean {
  const combined = `${text}\n${description || ''}`;
  if (/子任务|子单|拆分|顺序|排队|child queue|root \+ child|multiple|sequential|split/i.test(combined)) {
    return true;
  }
  const implementationText = stripLifecycleOnlySteps(combined);
  return /同时|一起|顺便|另外|两个|多个|also/i.test(implementationText);
}

function explicitlyForbidsSplitQueue(text: string, description: string | null): boolean {
  const combined = `${text}\n${description || ''}`;
  return /(?:不要|不需要|禁止|别).{0,12}(?:拆分|子任务|子单|child queue|split queue)|(?:root-only|单一\s*issue|一张\s*root-only|只创建一张).{0,24}(?:单|issue|任务)|(?:不要|不需要|禁止|别).{0,12}(?:创建|生成).{0,12}(?:child queue|子任务|子单)/i.test(combined);
}

function explicitlyRequestsSplitQueue(text: string, description: string | null): boolean {
  const combined = `${text}\n${description || ''}`;
  return /(?:要求|使用|需要|请|必须|拆成|拆分).{0,24}(?:root\s*\+\s*child|child queue|split queue|子任务|子单)|(?:root\s*\+\s*child|child queue|split queue)|顺序子任务/i.test(combined);
}

function isRiskyCleanupRequest(text: string): boolean {
  return /(?:清空|清理|删除|移除|删掉).*(?:残余|垃圾|遗留|多余|无用|文件|目录|仓库|项目)|(?:残余|垃圾|遗留|多余|无用).*(?:清空|清理|删除|移除|删掉)|把.+(?:清空|清理|删除|移除|删掉)/i.test(text);
}

function canInferConcreteAcceptanceFromTask(text: string, description: string | null): boolean {
  const combined = `${text}\n${description || ''}`;
  if (/理论公式|标度律|总结/i.test(combined) && /(python|脚本|绘图|plot|matplotlib|运行)/i.test(combined)) {
    return true;
  }
  if (/研究|分析|总结|整理/i.test(combined) && /(脚本|代码|图|图表|notebook|python)/i.test(combined)) {
    return true;
  }
  return false;
}

function inferDefaultClarificationAcceptance(
  title: string,
  description: string | null,
): string[] | null {
  const combined = `${title}\n${description || ''}`;
  if (/理论公式|标度律|总结/i.test(combined) && /(python|脚本|绘图|plot|matplotlib|运行)/i.test(combined)) {
    return [
      '总结不同质量恒星随 M 变化的主要理论公式或标度律，并说明适用范围。',
      '标明采用的主要标度律、假设条件或适用质量范围，避免把近似关系写成普适结论。',
      '至少包含一份可运行脚本或图表输出，能展示关键参数随 M 的变化。',
    ];
  }
  if (/体验|用户体验|易用性|可用性|交互/i.test(combined)) {
    return [
      '给出至少一个可直接验证的用户结果，并说明它相对当前体验的改善点。',
    ];
  }
  return null;
}

function stripLifecycleOnlySteps(value: string): string {
  return value
    .replace(/(?:创建|打开|提交|发起|更新)?\s*(?:PR|pull request|merge request)(?:\s*#?\d+)?/gi, '')
    .replace(/(?:review|delivery|review\/delivery|审阅|评审|交付|合并|merge|提交成功|提交|验收|验证|测试|跑测试|跑命令)/gi, '')
    .replace(/(?:创建|建立)\s*(?:issue|Issue|任务|单)(?:\s*描述)?/gi, '')
    .replace(/(?:确认|明确|限定).{0,12}(?:范围|边界|保留项|清理边界)/gi, '')
    .replace(/(?:生成|列出|提供).{0,20}(?:清单|证明|证据|文件列表|git diff)/gi, '')
    .replace(/(?:执行|完成).{0,8}(?:清理|删除|移除|重置)(?:操作|动作)?/gi, '');
}

function isFocusedCleanupPlan(planCard: SupervisorPlanCard): boolean {
  const combined = [
    planCard.user_goal,
    ...planCard.in_scope,
    ...planCard.acceptance,
    planCard.execution_strategy,
  ].join('\n');
  if (!isRiskyCleanupRequest(combined)) {
    return false;
  }
  if (/多\s*agent|多个\s*agent|并行|root\s*\+\s*child|child queue|split queue|子任务|子单|拆分|分阶段实现/i.test(planCard.user_goal)) {
    return false;
  }
  return /只保留|仅保留|空\s*README|readme|当前仓库|这个仓库|仓库内容|单个目录|docs?\s*(?:文件夹|目录)/i.test(combined);
}

function extractMarkdownPaths(value: string): string[] {
  return Array.from(new Set(
    [...value.matchAll(/(?:^|\s)([\w./-]+\.md)(?=[\s，。；,;]|$)/g)]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value)),
  ));
}

function isLifecycleOnlyScope(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return true;
  }
  const withoutLifecycle = stripLifecycleOnlySteps(normalized).replace(/[，。；,;/\s-]+/g, '');
  return withoutLifecycle.length === 0;
}

function supportsSplitQueue(planCard: SupervisorPlanCard): boolean {
  if (explicitlyForbidsSplitQueue(planCard.user_goal, planCard.execution_strategy)) {
    return false;
  }
  if (explicitlyRequestsSplitQueue(planCard.user_goal, null)) {
    return true;
  }
  if (isFocusedCleanupPlan(planCard)) {
    return false;
  }
  const visibleScopeText = [
    planCard.user_goal,
    ...planCard.in_scope,
  ].join('\n');
  const allPlanText = [
    visibleScopeText,
    planCard.execution_strategy,
    ...planCard.acceptance,
  ].join('\n');
  const visiblePaths = extractMarkdownPaths(visibleScopeText);
  if ((visiblePaths.length >= 2 ? visiblePaths : extractMarkdownPaths(allPlanText)).length >= 2) {
    return true;
  }
  const implementationScopes = planCard.in_scope
    .map((scope) => compact(stripLifecycleOnlySteps(scope), 120))
    .filter((scope) => scope && !isLifecycleOnlyScope(scope));
  if (implementationScopes.length >= 2) {
    return true;
  }
  return isLikelyMultiObjective(planCard.user_goal, planCard.execution_strategy)
    && implementationScopes.length >= 2;
}

export function deriveSupervisorMilestone(issue: RuntimeIssueView): SupervisorMilestone | null {
  const rootIssueId = issue.governance_root_issue_id ?? issue.issue_id;
  const isChildIssue = rootIssueId !== issue.issue_id;
  const childQueue = issue.governance_child_queue ?? [];
  const rootCancelled = !isChildIssue && (
    issue.orchestrator_state === 'cancelled' ||
    /^(cancelled|canceled)$/i.test(issue.tracker_state || '')
  );

  if (rootCancelled) {
    return {
      kind: 'cancelled',
      key: ['cancelled', issue.issue_id, issue.updated_at ?? '', issue.tracker_state ?? ''].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: '计划线程已取消。',
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: null,
    };
  }

  const rootDeliveryFailed = !isChildIssue && (
    issue.delivery_state === 'delivery_failed' ||
    issue.orchestrator_state === 'failed' ||
    Boolean(issue.delivery_code)
  );
  if (rootDeliveryFailed) {
    return {
      kind: 'delivery_failed',
      key: [
        'delivery_failed',
        issue.issue_id,
        issue.delivery_code ?? '',
        issue.delivery_summary ?? '',
        issue.orchestrator_state ?? '',
      ].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: issue.delivery_summary ?? issue.delivery_code ?? 'root 线程交付失败。',
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: issue.governance_current_child?.issue_id ?? null,
    };
  }

  const allChildrenCompleted = !isChildIssue
    && childQueue.length > 0
    && childQueue.every((child) => (
      child.queue_state === 'completed' ||
      child.orchestrator_state === 'completed' ||
      child.delivery_state === 'completed'
    ));
  const rootDeliveryFinalized = !isChildIssue && (
    issue.orchestrator_state === 'completed' ||
    issue.delivery_state === 'completed' ||
    /^(done|cancelled|canceled|duplicate)$/i.test(issue.tracker_state || '')
  );

  if (allChildrenCompleted && rootDeliveryFinalized) {
    return {
      kind: 'completed',
      key: [
        'completed_children',
        issue.issue_id,
        childQueue.map((child) => `${child.issue_id}:${child.queue_state ?? child.orchestrator_state ?? ''}`).join(','),
      ].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: '所有顺序子任务已完成，计划线程已完成。',
      delivery_state: issue.delivery_state ?? 'completed',
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: null,
    };
  }

  if (allChildrenCompleted) {
    return {
      kind: 'waiting_on_child',
      key: [
        'children_completed_waiting_root',
        issue.issue_id,
        childQueue.map((child) => `${child.issue_id}:${child.queue_state ?? child.orchestrator_state ?? ''}`).join(','),
      ].join('|'),
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      summary: '所有顺序子任务已完成，正在等待 root 线程做最终收尾；不会把 root 当作新的开发任务派发。',
      delivery_state: issue.delivery_state ?? null,
      delivery_code: issue.delivery_code ?? null,
      governance_thread_state: issue.governance_thread_state ?? null,
      current_child_issue_id: null,
    };
  }

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

export interface DraftInput {
  title: string;
  description: string | null;
  project_slug: string | null;
  acceptance_override?: string[] | null;
}

export interface PlanComputation {
  repoRef: string | null;
  intakeMode: SupervisorIntakeMode;
  approvalMode: SupervisorApprovalMode;
  state: SupervisorSessionState;
  planCard: SupervisorPlanCard;
}

export interface SupervisorPlanBrainInput {
  session: SupervisorSessionRecord;
  draft: DraftInput;
  runtimeContext: BotRuntimeCopilotContext;
  repoIntelligence: SupervisorRepoIntelligenceSnapshot | null;
  governancePreview: SupervisorPlanCard['governance_preview'];
  deterministicPlan: PlanComputation;
  recentEvents: SupervisorSessionEventRecord[];
}

export interface SupervisorPlanBrainResult {
  intakeMode?: SupervisorIntakeMode | null;
  approvalMode?: SupervisorApprovalMode | null;
  state?: SupervisorSessionState | null;
  planCard?: Partial<SupervisorPlanCard> | null;
  rationale?: string | null;
}

export interface SupervisorPlanBrain {
  refinePlan(input: SupervisorPlanBrainInput): Promise<SupervisorPlanBrainResult | null>;
}

function mergeStringList(
  override: string[] | null | undefined,
  fallback: string[],
): string[] {
  const values = Array.isArray(override) ? override : fallback;
  const normalized = values
    .map((value) => compact(value, 220))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

function mergePlanOption(
  override: Partial<SupervisorPlanCard['recommended_option']> | null | undefined,
  fallback: SupervisorPlanCard['recommended_option'],
): SupervisorPlanCard['recommended_option'] {
  if (!override) {
    return fallback;
  }
  return {
    label: compact(override.label, 48) || fallback.label,
    summary: compact(override.summary, 220) || fallback.summary,
  };
}

function buildSupervisorSplitChildPlans(planCard: SupervisorPlanCard): Array<{
  title: string;
  description: string;
}> {
  const visibleScopeText = [
    planCard.user_goal,
    ...planCard.in_scope,
  ].join('\n');
  const text = [
    visibleScopeText,
    planCard.execution_strategy,
  ].join('\n');
  const visiblePaths = extractMarkdownPaths(visibleScopeText);
  const paths = visiblePaths.length >= 2 ? visiblePaths : extractMarkdownPaths(text);
  const pathLimit = /两个|两张|2\s*个|2\s*张/i.test(text) ? 2 : 4;
  const targets = paths.length >= 2
    ? paths.slice(0, pathLimit).map((pathValue) => ({
        title: `完成 ${pathValue}`,
        purpose: `完成计划中的独立交付物 ${pathValue}`,
        acceptance: `${pathValue} 存在且内容符合 root 计划要求。`,
      }))
    : planCard.in_scope.length >= 2
      ? planCard.in_scope.slice(0, 4).map((scope, index) => ({
          title: `完成子任务 ${index + 1}: ${compact(scope, 64)}`,
          purpose: scope,
          acceptance: planCard.acceptance[index] ?? planCard.acceptance[0] ?? scope,
        }))
      : [
          {
            title: `完成第一阶段: ${compact(planCard.user_goal, 64)}`,
            purpose: planCard.in_scope[0] ?? planCard.user_goal,
            acceptance: planCard.acceptance[0] ?? '第一阶段可验证完成。',
          },
          {
            title: `完成第二阶段: ${compact(planCard.user_goal, 64)}`,
            purpose: planCard.in_scope[1] ?? planCard.user_goal,
            acceptance: planCard.acceptance[1] ?? planCard.acceptance[0] ?? '第二阶段可验证完成。',
          },
        ];

  return targets.map((target, index) => ({
    title: target.title,
    description: [
      `来源 root 计划：${planCard.title}`,
      `子任务序号：${index + 1}/${targets.length}`,
      `用途：${target.purpose}`,
      `验收标准：${target.acceptance}`,
      '执行规则：这是 Supervisor root + child queue 的一个顺序 child；只处理本子任务，不抢跑后续 sibling。',
    ].join('\n'),
  }));
}

function mergePlanCard(
  fallback: SupervisorPlanCard,
  override: Partial<SupervisorPlanCard> | null | undefined,
): SupervisorPlanCard {
  if (!override) {
    return fallback;
  }

  const forbidsSplitQueue = [
    fallback.user_goal,
    fallback.execution_strategy,
    ...fallback.in_scope,
    ...fallback.out_of_scope,
    ...fallback.acceptance,
  ].some((value) => explicitlyForbidsSplitQueue(value, null));
  const explicitlyRequestedSplitQueue = [
    fallback.user_goal,
    ...fallback.in_scope,
  ].some((value) => explicitlyRequestsSplitQueue(value, null));

  const candidate: SupervisorPlanCard = {
    ...fallback,
    title: compact(override.title, 120) || fallback.title,
    user_goal: compact(override.user_goal, 220) || fallback.user_goal,
    in_scope: mergeStringList(override.in_scope, fallback.in_scope),
    out_of_scope: mergeStringList(override.out_of_scope, fallback.out_of_scope),
    acceptance: mergeStringList(override.acceptance, fallback.acceptance),
    known_risks: mergeStringList(override.known_risks, fallback.known_risks),
    execution_strategy: compact(override.execution_strategy, 420) || fallback.execution_strategy,
    needs_user_approval: override.needs_user_approval ?? fallback.needs_user_approval,
    repo_ref: override.repo_ref ?? fallback.repo_ref,
    project_slug: override.project_slug ?? fallback.project_slug,
    clarification_question: override.clarification_question ?? fallback.clarification_question,
    materialization_mode: fallback.materialization_mode === 'root_with_split_queue'
      ? fallback.materialization_mode
      : forbidsSplitQueue
        ? 'root_only'
      : override.materialization_mode ?? fallback.materialization_mode,
    recommended_option: mergePlanOption(override.recommended_option, fallback.recommended_option),
    alternate_option: override.alternate_option === null
      ? null
      : override.alternate_option
        ? mergePlanOption(override.alternate_option, fallback.alternate_option ?? {
            label: '改一下计划',
            summary: '先把计划重写得更稳，再继续。',
          })
        : fallback.alternate_option,
    governance_preview: override.governance_preview ?? fallback.governance_preview,
  };
  return {
    ...candidate,
    materialization_mode: candidate.materialization_mode === 'root_with_split_queue'
      && !explicitlyRequestedSplitQueue
      && !supportsSplitQueue(candidate)
      ? 'root_only'
      : candidate.materialization_mode,
  };
}

function normalizePlanComputation(
  base: PlanComputation,
  refinement: SupervisorPlanBrainResult | null | undefined,
): PlanComputation {
  if (!refinement) {
    return base;
  }

  const planCard = mergePlanCard(base.planCard, refinement.planCard);
  let approvalMode = refinement.approvalMode ?? base.approvalMode;
  let state = refinement.state ?? base.state;
  if (base.approvalMode !== 'auto' && approvalMode === 'auto') {
    approvalMode = base.approvalMode;
    if (state === 'plan_ready') {
      state = 'awaiting_user_approval';
    }
  }
  if (planCard.clarification_question && state !== 'clarifying') {
    state = 'clarifying';
  } else if (approvalMode === 'explicit_user_approval' && state === 'plan_ready') {
    state = 'awaiting_user_approval';
  }

  return {
    repoRef: planCard.project_slug ?? base.repoRef,
    intakeMode: refinement.intakeMode ?? base.intakeMode,
    approvalMode,
    state,
    planCard: {
      ...planCard,
      needs_user_approval: approvalMode !== 'auto',
    },
  };
}

function hasRecentClarificationAnswer(events: SupervisorSessionEventRecord[]): boolean {
  return events.some((event) => event.event_kind === 'clarification_answer_recorded');
}

function shouldPreferDeterministicAfterClarification(
  recentEvents: SupervisorSessionEventRecord[],
  deterministicPlan: PlanComputation,
  computedPlan: PlanComputation,
): boolean {
  return (
    hasRecentClarificationAnswer(recentEvents) &&
    deterministicPlan.state !== 'clarifying' &&
    computedPlan.state === 'clarifying'
  );
}

export function buildSupervisorSessionFollowupMessage(
  session: SupervisorSessionRecord,
  issue: RuntimeIssueView | null = null,
): {
  message: string;
  format: 'telegram_html';
  action_rows: NonNullable<BotCommandResponse['action_rows']>;
  material_key: string;
  caption?: string;
  media_key?: string | null;
  photo?: BotCommandResponse['photo'];
} {
  const planCard = session.plan_card;
  const title = planCard?.title || issue?.title || '当前计划线程';
  const currentChild = issue?.governance_current_child
    ?? issue?.governance_child_queue?.find((child) => child.queue_state === 'current')
    ?? null;
  const queue = issue?.governance_child_queue ?? [];
  const waitingForApproval = session.state === 'awaiting_user_approval' || session.state === 'plan_ready';
  const waitingForDecision = session.state === 'awaiting_user_decision';
  const completed = session.state === 'completed';
  const cancelled = session.state === 'cancelled';
  const oversightSummary = lastOutcomeString(session, 'user_summary');
  const oversightInstruction = lastOutcomeString(session, 'dev_instruction');
  const notificationSummary = lastOutcomeString(session, 'pending_user_notification_summary');
  const latestDevInstruction = lastOutcomeString(session, 'latest_dev_instruction');
  const threadSummary = describeSupervisorThread({
    session,
    currentChild,
    childQueue: queue,
  });
  const materialKey = [
    'session',
    session.id,
    `v${session.plan_version}`,
    session.state,
    issue?.identifier ?? '',
    ...runtimeIssueMaterialParts(issue),
    currentChild?.issue_identifier ?? '',
    queue.map((child) => `${child.issue_identifier}:${child.queue_state ?? ''}`).join(','),
    ...supervisorOutcomeMaterialParts(session),
  ].join('|');

  const visual = buildSupervisorSessionVisualCard(session, issue, materialKey);
  const actionRows = session.root_issue_id || issue || waitingForApproval || waitingForDecision
    ? supervisorActionRows(session, issue)
    : [];

  return {
    format: 'telegram_html',
    material_key: materialKey,
    caption: visual?.caption,
    media_key: visual?.media_key,
    photo: visual?.photo,
    message: joinHtmlLines([
      waitingForApproval
        ? `<b>计划待你批准 · v${session.plan_version}</b>`
        : waitingForDecision
          ? `<b>执行中需要你决定 · ${escapeHtml(issue?.identifier || title)}</b>`
          : completed
            ? `<b>计划已完成 · ${escapeHtml(issue?.identifier || title)}</b>`
            : cancelled
              ? `<b>计划已取消 · ${escapeHtml(issue?.identifier || title)}</b>`
              : `<b>计划执行中 · ${escapeHtml(issue?.identifier || title)}</b>`,
      waitingForApproval
        ? '我已经把这条需求收成一条可执行计划线程。你一批准，我就会开始建单并推进。'
        : waitingForDecision
          ? escapeHtml(threadSummary)
          : completed
            ? escapeHtml(session.delivery_summary || issue?.delivery_summary || '这条计划线程已经完成，最终交付已闭环。')
            : cancelled
              ? escapeHtml(session.delivery_summary || '这条计划线程已经取消，不会继续自动推进。')
              : '我会继续推进，只在关键节点回来找你。',
      null,
      '<b>我已理解的计划</b>',
      escapeHtml(planCard?.title || title),
      '<b>用户目标</b>',
      escapeHtml(planCard?.user_goal || title),
      planCard?.repo_ref || issue?.github_repo ? '<b>仓库</b>' : null,
      planCard?.repo_ref || issue?.github_repo
        ? `<code>${escapeHtml(planCard?.repo_ref || issue?.github_repo || '')}</code>`
        : null,
      planCard ? '<b>本次范围</b>' : null,
      planCard ? escapeHtml(textList(planCard.in_scope, '按当前目标推进。')) : null,
      planCard ? '<b>验收标准</b>' : null,
      planCard ? escapeHtml(textList(planCard.acceptance, '结果可验证。')) : null,
      waitingForApproval && planCard ? '<b>批准后会发生什么</b>' : null,
      waitingForApproval && planCard ? escapeHtml(planCard.execution_strategy || '批准后我会开始物化并推进这条计划线程。') : null,
      waitingForDecision && oversightSummary ? '<b>监督判断</b>' : null,
      waitingForDecision && oversightSummary ? escapeHtml(oversightSummary) : null,
      !waitingForDecision && !completed && !cancelled && notificationSummary ? '<b>监督更新</b>' : null,
      !waitingForDecision && !completed && !cancelled && notificationSummary ? escapeHtml(compact(notificationSummary, 260)) : null,
      !waitingForDecision && !completed && !cancelled && latestDevInstruction ? '<b>下一轮指令</b>' : null,
      !waitingForDecision && !completed && !cancelled && latestDevInstruction ? escapeHtml(compact(latestDevInstruction, 260)) : null,
      !waitingForDecision && !completed && !cancelled && !latestDevInstruction && oversightInstruction ? '<b>Supervisor 下一步指令</b>' : null,
      !waitingForDecision && !completed && !cancelled && !latestDevInstruction && oversightInstruction ? escapeHtml(compact(oversightInstruction, 260)) : null,
      currentChild ? '<b>当前子任务</b>' : null,
      currentChild ? `${escapeHtml(currentChild.issue_identifier)} · ${escapeHtml(currentChild.title)}` : null,
      queue.length > 0 ? '<b>队列</b>' : null,
      queue.length > 0
        ? escapeHtml(queue.map((child) => `${child.issue_identifier}:${child.queue_state || 'queued'}`).join(' / '))
        : null,
      null,
      '<b>推荐下一步</b>',
      escapeHtml(
        completed
          ? '如果还要继续扩展，请直接发一条新需求。'
          : cancelled
            ? '如需恢复，请明确回复要重新启动哪张单。'
            : issue?.next_recommended_action || planCard?.recommended_option.summary || '继续推进当前计划线程。',
      ),
      null,
      waitingForApproval || waitingForDecision
        ? '点按钮继续，或者直接回复你的想法。'
        : completed || cancelled
          ? '这张卡会停留在这里作为结果记录。'
          : '我会继续盯关键节点，有需要你决定时再回来。',
    ]),
    action_rows: actionRows,
  };
}

export class SupervisorSessionService {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly projectResolver: TrackerProjectResolutionService | null,
    private readonly sessions: SupervisorSessionRepository,
    private readonly sessionEvents: SupervisorSessionEventRepository,
    private readonly repoIntelligenceResolver: SupervisorRepoIntelligenceResolver | null = null,
    private readonly planBrain: SupervisorPlanBrain | null = null,
    private readonly executionOverseer: SupervisorExecutionOverseer = new DefaultSupervisorExecutionOverseer(),
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

  private findActiveSessionsForConversation(context: BotCommandContext): SupervisorSessionRecord[] {
    return this.sessions.findAll().filter((session) => (
      session.transport === context.transport
      && session.conversation_id === context.recipient.conversation_id
      && ACTIVE_SESSION_STATES.has(session.state)
    ));
  }

  findById(id: string): SupervisorSessionRecord | null {
    return this.sessions.findById(id);
  }

  preemptActiveSessionsForNewThread(context: BotCommandContext, text: string): number {
    if (!isNewThreadText(text)) {
      return 0;
    }

    let cancelled = 0;
    for (const session of this.findActiveSessionsForConversation(context)) {
      this.sessions.update({
        id: session.id,
        state: 'cancelled',
        active_decision_kind: null,
        delivery_summary: '用户选择新开计划线程，旧线程已取消。',
      });
      this.stopSessionExecution(session);
      this.recordEvent(session.id, 'session_cancelled_for_new_thread_preemptive', {
        text,
      });
      cancelled += 1;
    }
    return cancelled;
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

  syncIssue(issue: RuntimeIssueView): void {
    this.syncFromIssue(issue);
  }

  async respond(params: SupervisorServiceResponseParams): Promise<BotCommandResponse | null> {
    const activeSession = this.findActiveSession(params.context);
    if (!activeSession) {
      if (params.source === 'telegram_chat') {
        if (params.intent?.kind === 'answer_question') {
          return { message: params.intent.answer };
        }
        if (params.intent?.kind === 'clarify') {
          return { message: params.intent.question };
        }
      }
      if (params.intent?.kind !== 'create_issue') {
        return null;
      }
      return this.startSession(params);
    }

    if (isCancelText(params.text)) {
      return this.cancelSession(activeSession, params.text);
    }

    if (isFocusText(params.text)) {
      return this.renderSessionMessage(
        activeSession,
        activeSession.root_issue_id ? this.runtime.getIssue(activeSession.root_issue_id) : null,
      );
    }

    if (!shouldRouteReadOnlyIntentToActiveSession(activeSession, params.intent, params.text)) {
      return null;
    }

    if (params.intent?.kind === 'create_issue' && isNewThreadText(params.text)) {
      for (const session of this.findActiveSessionsForConversation(params.context)) {
        this.sessions.update({
          id: session.id,
          state: 'cancelled',
          active_decision_kind: null,
          delivery_summary: '用户选择新开计划线程，旧线程已取消。',
        });
        this.stopSessionExecution(session);
        this.recordEvent(session.id, 'session_cancelled_for_new_thread', {
          text: params.text,
        });
      }
      const stripped = stripNewThreadPrefix(params.text);
      return this.startSession({
        ...params,
        text: stripped || params.intent.title,
        intent: {
          ...params.intent,
          title: stripped || params.intent.title,
        },
      });
    }

    const shouldContinueActiveSession =
      params.intent?.kind !== 'create_issue'
      || isApprovalText(params.text)
      || isEditText(params.text)
      || isAlternateText(params.text)
      || isFocusText(params.text)
      || isScopeChangeText(params.text)
      || (
        activeSession.state === 'clarifying'
        && clarificationAnswerUpdatesGoal(activeSession.plan_card?.clarification_question, params.text)
      );

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
        format: 'telegram_html',
        message: joinHtmlLines([
          '<b>当前会话已经有一条活跃计划线程</b>',
          escapeHtml(activeSession.plan_card?.title || '未命名计划'),
          null,
          '为了避免把两个需求混到一起，我不会静默新建第二条线程。',
          null,
          '<b>你可以这样继续</b>',
          '点「查看当前计划」继续旧线程；点「取消当前计划」结束旧线程；如果确实要换新需求，请回复：',
          `<code>新开线程 ${escapeHtml(params.intent.title)}</code>`,
        ]),
        action_rows: [
          [{ label: '查看当前计划', callback_data: `sup|${activeSession.id}|focus` }],
          [{ label: '取消当前计划', callback_data: `sup|${activeSession.id}|cancel` }],
        ],
      };
    }

    return this.continueSession(activeSession, params);
  }

  async respondToAction(params: {
    context: BotCommandContext;
    sessionId: string;
    action: SupervisorSessionAction;
    canWrite: boolean;
    runtimeContext?: BotRuntimeCopilotContext | null;
  }): Promise<BotCommandResponse> {
    const session = this.sessions.findById(params.sessionId);
    if (!session) {
      return {
        message: '这条计划卡状态已经丢失。请直接回复你想继续做什么，我会重新接上当前线程。',
      };
    }

    const text = params.action === 'approve'
      ? '批准并开始'
      : params.action === 'alternate'
        ? '换用备选方案'
        : params.action === 'focus'
          ? '查看当前计划'
          : params.action === 'cancel'
            ? '取消当前计划'
            : '改一下计划';

    if (params.action === 'focus') {
      return this.renderSessionMessage(
        session,
        session.root_issue_id ? this.runtime.getIssue(session.root_issue_id) : null,
      );
    }

    if (params.action === 'cancel') {
      return this.cancelSession(session, text);
    }

    return this.continueSession(session, {
      context: params.context,
      text,
      intent: null,
      runtimeContext: params.runtimeContext ?? emptyRuntimeContext(),
      canWrite: params.canWrite,
    });
  }

  private cancelSession(session: SupervisorSessionRecord, text: string): BotCommandResponse {
    const updated = this.sessions.update({
      id: session.id,
      state: 'cancelled',
      active_decision_kind: null,
      delivery_summary: '用户已取消这条计划线程。',
    })!;
    this.recordEvent(session.id, 'session_cancelled_by_user', {
      text,
    });
    this.stopSessionExecution(session);
    return this.renderSessionMessage(updated);
  }

  private stopSessionExecution(session: SupervisorSessionRecord): void {
    const issue = session.root_issue_id ? this.runtime.getIssue(session.root_issue_id) : null;
    const stopIssueId = issue?.governance_current_child?.issue_id
      ?? session.current_child_issue_id
      ?? session.root_issue_id;
    if (!stopIssueId) {
      return;
    }
    void this.runtime.stopIssue(stopIssueId).catch(() => {
      // Cancellation should always update the session card even when the runtime
      // stop path is already idle or the issue has disappeared.
    });
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

    return this.recomputeAndRespond(session, draft, params.runtimeContext, params.canWrite, params.source);
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
      const answerUpdatesGoal = !repoClarification
        && clarificationAnswerUpdatesGoal(planCard?.clarification_question, params.text);
      const delegatedAcceptanceChoice = !repoClarification
        && Boolean(planCard?.clarification_question)
        && isDelegatingAcceptanceChoice(params.text);
      const explicitClarifiedAcceptance = !repoClarification
        ? extractAcceptanceFromClarificationAnswer(params.text)
        : null;
      const delegatedAcceptance = delegatedAcceptanceChoice
        ? inferDelegatedClarificationAcceptance(
            planCard?.title || params.text,
            [
              planCard?.user_goal,
              ...(planCard?.in_scope ?? []),
              ...(planCard?.acceptance ?? []),
              params.text,
            ].filter((value): value is string => Boolean(value)).join('\n')
          )
        : null;
      const draft: DraftInput = {
        title: answerUpdatesGoal
          ? normalizeTitle(params.text)
          : planCard?.title || compact(params.text, 80) || '未命名计划',
        description: repoClarification
          ? planCard?.acceptance?.join('\n') || params.text
          : explicitClarifiedAcceptance
            ? [
                planCard?.user_goal || planCard?.title || null,
                `验收标准：${explicitClarifiedAcceptance.join('；')}`,
              ].filter((value): value is string => Boolean(value)).join('\n')
          : delegatedAcceptance
            ? [
                planCard?.user_goal || planCard?.title || null,
                ...(planCard?.in_scope ?? []),
                `默认验收：${delegatedAcceptance.join('；')}`,
              ].filter((value): value is string => Boolean(value)).join('\n')
          : answerUpdatesGoal
            ? [
                planCard?.user_goal || planCard?.title || null,
                `用户澄清：${params.text}`,
              ].filter((value): value is string => Boolean(value)).join('\n')
            : params.text,
        project_slug: session.repo_ref,
        acceptance_override: explicitClarifiedAcceptance ?? delegatedAcceptance ?? null,
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
          delegated_default_used: delegatedAcceptanceChoice,
        });
      }

      return this.recomputeAndRespond(session, draft, params.runtimeContext, params.canWrite, params.source);
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
    source?: SupervisorIntakeSource,
  ): Promise<BotCommandResponse> {
    const computedPlan = await this.computePlan(session, draft, runtimeContext, source);
    const shouldHoldRecommendationForTelegram = Boolean(
      source === 'telegram_chat'
      && computedPlan.approvalMode === 'auto'
      && computedPlan.state !== 'clarifying'
      && !session.root_issue_id,
    );
    const shouldPreserveApprovalGate = Boolean(
      session.approval_mode
      && session.approval_mode !== 'auto'
      && computedPlan.approvalMode === 'auto',
    );
    const computed: PlanComputation = shouldPreserveApprovalGate
      ? {
          ...computedPlan,
          approvalMode: session.approval_mode as SupervisorApprovalMode,
          state: 'awaiting_user_approval',
          planCard: {
            ...computedPlan.planCard,
            needs_user_approval: true,
          },
        }
      : shouldHoldRecommendationForTelegram
        ? {
            ...computedPlan,
            approvalMode: 'explicit_user_approval',
            state: 'awaiting_user_approval',
            planCard: {
              ...computedPlan.planCard,
              needs_user_approval: true,
            },
          }
      : computedPlan;
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
    session: SupervisorSessionRecord,
    draft: DraftInput,
    runtimeContext: BotRuntimeCopilotContext,
    source?: SupervisorIntakeSource,
  ): Promise<PlanComputation> {
    const requestTitle = normalizeRequirementText(draft.title);
    const requestDescription = draft.description ? normalizeRequirementText(draft.description) : null;
    const inferredIssueTitle = inferIssueTitleFromRequest(requestTitle, requestDescription);
    const structuredScope = inferStructuredScope(requestTitle, requestDescription);
    const explicitApprovalRequested = explicitlyRequestsApprovalBeforeExecution(draft.title, draft.description);
    const conversationalAcceptance = inferConversationalAcceptance(requestTitle, requestDescription);
    const inferredAcceptance = draft.acceptance_override
      ?? conversationalAcceptance
      ?? structuredScope?.acceptance
      ?? inferDefaultClarificationAcceptance(requestTitle, requestDescription);
    const repoRef = draft.project_slug
      || runtimeContext.default_project_slug
      || resolveProjectAlias(draft.title, runtimeContext.available_projects)
      || null;

    if (!repoRef) {
      const base: PlanComputation = {
        repoRef: null,
        intakeMode: 'clarify_then_plan',
        approvalMode: explicitApprovalRequested ? 'explicit_user_approval' : 'auto',
        state: 'clarifying',
        planCard: {
          title: inferredIssueTitle,
          user_goal: requestTitle,
          in_scope: structuredScope?.inScope ?? [requestTitle],
          out_of_scope: ['在确认仓库前，不启动真正执行。'],
          acceptance: inferAcceptance(requestTitle, requestDescription),
          known_risks: ['当前还没有绑定到明确仓库，因此无法读取治理上下文。'],
          execution_strategy: '先绑定仓库，再根据仓库约束完善计划。',
          needs_user_approval: explicitApprovalRequested,
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
      return this.refinePlanWithBrain(session, draft, runtimeContext, null, null, base);
    }

    const resolved = await this.projectResolver?.resolveProjectSlug(repoRef);
    const route = resolved?.route ?? null;
    const repoIntelligence = await this.repoIntelligenceResolver?.resolve({
      projectSlug: repoRef,
      route,
    }) ?? null;
    const governance = route
      ? await assessIntakeCritic({
          issue: {
            id: 'preview',
            identifier: 'PREVIEW',
            title: requestTitle,
            description: requestDescription,
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

    const riskyCleanup = isRiskyCleanupRequest(`${draft.title}\n${draft.description || ''}`);
    const splitQueueForbidden = explicitlyForbidsSplitQueue(draft.title, draft.description);
    const focusedCleanup = riskyCleanup && /只保留|仅保留|空\s*README|readme|当前仓库|这个仓库|仓库内容|docs?\s*(?:文件夹|目录)/i.test(`${draft.title}\n${draft.description || ''}`);
    const multiObjective = !splitQueueForbidden && !focusedCleanup && (
      governance?.decision === 'split_before_implement'
      || isLikelyMultiObjective(draft.title, draft.description)
    );
    const needsClarify = !inferredAcceptance
      && shouldClarifyAcceptance(draft.title, draft.description)
      && !multiObjective
      && !explicitApprovalRequested
      && governance?.decision !== 'accept_with_rewrite'
      && source !== 'telegram_chat';

    let intakeMode: SupervisorIntakeMode = 'direct_run';
    let approvalMode: SupervisorApprovalMode = 'auto';
    let state: SupervisorSessionState = 'plan_ready';

    if (explicitApprovalRequested || multiObjective || governance?.decision === 'accept_with_rewrite' || riskyCleanup) {
      intakeMode = 'plan_then_approve';
      approvalMode = 'explicit_user_approval';
      state = 'awaiting_user_approval';
    } else if (needsClarify) {
      intakeMode = 'clarify_then_plan';
      approvalMode = explicitApprovalRequested ? 'explicit_user_approval' : 'auto';
      state = 'clarifying';
    }

    const conversationalRecommendationSummary = inferConversationalRecommendationSummary(requestTitle, requestDescription);
    const recommendedOption = conversationalRecommendationSummary
      ? {
          label: '按推荐继续',
          summary: conversationalRecommendationSummary,
        }
      : multiObjective
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

    const base: PlanComputation = {
      repoRef,
      intakeMode,
      approvalMode,
      state,
      planCard: {
        title: governance?.rewrite_title?.trim() || inferredIssueTitle,
        user_goal: requestTitle,
        in_scope: structuredScope?.inScope ?? [requestTitle],
        out_of_scope: [
          ...(structuredScope?.outOfScope ?? inferOutOfScope(requestTitle)),
          splitQueueForbidden ? '不拆分、不创建 child queue；本轮只创建一张 root-only 验证单。' : null,
        ].filter((value): value is string => Boolean(value)),
        acceptance: inferredAcceptance ?? inferAcceptance(requestTitle, requestDescription),
        known_risks: [
          governance?.summary ? compact(governance.summary, 180) : null,
          riskyCleanup ? '这类清理可能删除文件，需要先确认范围和验收方式。' : null,
          needsClarify ? '当前验收条件还不够稳，需要先补清楚。' : null,
          ...buildRepoIntelligenceRisks(repoIntelligence),
        ].filter((value): value is string => Boolean(value)),
        execution_strategy: [
          inferConversationalExecutionStrategy(requestTitle, requestDescription)
            ? inferConversationalExecutionStrategy(requestTitle, requestDescription)
            : structuredScope?.executionStrategy
            ? structuredScope.executionStrategy
            : multiObjective
            ? '先把源目标收成 root thread，再只放行当前 child，其余 child 顺序排队。'
            : riskyCleanup && splitQueueForbidden
              ? '只创建一张 root-only 受控验证单，不扫描全仓，不创建 child queue；执行后用指定标记文件证明审批语义。'
            : riskyCleanup
              ? '先限定清理范围，执行后用 git diff / 文件列表证明只清掉残余内容。'
              : '保持单目标推进，避免顺手扩大范围。',
          ...buildRepoExecutionHints(repoIntelligence),
        ].join(' '),
        needs_user_approval: approvalMode !== 'auto',
        repo_ref: repoIntelligence?.repo_ref ?? route?.github_repo_full ?? repoRef,
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
    return this.refinePlanWithBrain(
      session,
      draft,
      runtimeContext,
      repoIntelligence,
      base.planCard.governance_preview,
      base,
    );
  }

  private async refinePlanWithBrain(
    session: SupervisorSessionRecord,
    draft: DraftInput,
    runtimeContext: BotRuntimeCopilotContext,
    repoIntelligence: SupervisorRepoIntelligenceSnapshot | null,
    governancePreview: SupervisorPlanCard['governance_preview'],
    deterministicPlan: PlanComputation,
  ): Promise<PlanComputation> {
    if (!this.planBrain) {
      return deterministicPlan;
    }

    const recentEvents = this.sessionEvents.listBySession(session.id).slice(-16);
    try {
      const refinement = await this.planBrain.refinePlan({
        session,
        draft,
        runtimeContext,
        repoIntelligence,
        governancePreview,
        deterministicPlan,
        recentEvents,
      });
      const refined = normalizePlanComputation(deterministicPlan, refinement);
      const computed = shouldPreferDeterministicAfterClarification(recentEvents, deterministicPlan, refined)
        ? deterministicPlan
        : refined;
      if (refinement) {
        this.recordEvent(session.id, 'plan_brain_applied', {
          rationale: refinement.rationale ?? null,
          state: computed.state,
          intake_mode: computed.intakeMode,
          approval_mode: computed.approvalMode,
          stale_clarification_suppressed: computed !== refined,
        });
      }
      return computed;
    } catch (error) {
      this.recordEvent(session.id, 'plan_brain_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return deterministicPlan;
    }
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
      title: buildMaterializedRootIssueTitle(planCard),
      description: [
        `用户目标：${planCard.user_goal}`,
        `本次范围：${planCard.in_scope.join('；')}`,
        `暂不处理：${planCard.out_of_scope.join('；')}`,
        `验收标准：${planCard.acceptance.join('；')}`,
        `执行方式：${planCard.execution_strategy}`,
      ].join('\n'),
      project_slug: planCard.project_slug,
      supervisor_execution_intent: executionIntent,
      defer_dispatch: planCard.materialization_mode === 'root_with_split_queue',
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
      outcome_kind: 'created',
      issue_id: createResult.issue_id,
      issue_identifier: createResult.issue_identifier,
    };

    if (planCard.materialization_mode === 'root_with_split_queue') {
      const childPlans = buildSupervisorSplitChildPlans(planCard);
      const childResults = [];
      for (let index = 0; index < childPlans.length; index += 1) {
        const childPlan = childPlans[index]!;
        const childResult = await this.runtime.createIssue({
          title: `[SUPERVISOR CHILD ${index + 1}/${childPlans.length} for ${createResult.issue_identifier || 'root'}] ${childPlan.title}`,
          description: childPlan.description,
          project_slug: planCard.project_slug,
          supervisor_execution_intent: executionIntent,
          governance_lineage: {
            root_issue_id: createResult.issue_id,
            parent_issue_id: createResult.issue_id,
            generation: 1,
          },
          defer_dispatch: index > 0,
        });
        childResults.push(childResult);
      }
      latestIssue = this.runtime.getIssue(createResult.issue_id) ?? latestIssue;
      materialOutcome = {
        ...materialOutcome,
        split_status: childResults.every((result) => result.accepted) ? 'accepted' : 'partial',
        created_child_issue_identifiers: childResults
          .map((result) => result.issue_identifier)
          .filter(Boolean),
      };
      if (childResults.every((result) => result.accepted)) {
        resultMessage = [
          `已创建 ${createResult.issue_identifier || '新任务'}，并按推荐拆成顺序子任务队列。`,
          `当前先处理 ${childResults[0]?.issue_identifier || '第一张 child'}；后续 ${childResults.slice(1).map((result) => result.issue_identifier).filter(Boolean).join('、') || 'child'} 会排队接力。`,
        ].join('\n');
      } else {
        resultMessage = `已创建 ${createResult.issue_identifier || '新任务'}，但自动创建 child queue 时有部分子任务失败。`;
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
        outcome_kind: 'plan_revision_approved',
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
    if (isRetryableDeliveryDecision(session, issue)) {
      result = await this.runtime.retryIssue(issue.issue_id);
    } else if (issue.governance_decision === 'split_before_implement' && issue.actions.can_split_governance) {
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
      active_decision_kind: result.accepted ? null : session.active_decision_kind,
      delivery_state: result.accepted && isRetryableDeliveryDecision(session, issue)
        ? null
        : latestIssue.delivery_state ?? session.delivery_state,
      delivery_summary: result.accepted && isRetryableDeliveryDecision(session, issue)
        ? result.message
        : latestIssue.delivery_summary ?? result.message,
      last_material_outcome: {
        ...(session.last_material_outcome ?? {}),
        outcome_kind: 'continued',
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
            `<b>一起补计划</b>`,
            '我正在帮你把这件事收成一个可执行计划，还差一点关键信息。',
            null,
            '<b>我已理解</b>',
            escapeHtml(planCard.title),
            null,
            '<b>目标仓库</b>',
            escapeHtml(planCard.repo_ref || '待确认'),
            null,
            '<b>还缺什么</b>',
            escapeHtml(planCard.clarification_question || '请补一句你最关心的验收结果。'),
            null,
            '直接回复即可，我会继续把它收成计划。',
          ]),
        },
        'clarifying',
      );
    }

    if (session.state === 'awaiting_user_approval' || session.state === 'plan_ready') {
      const visibleRisks = visiblePlanRisks(planCard);
      return this.withSessionMetadata(
        session,
        {
          format: 'telegram_html',
          message: joinHtmlLines([
            `<b>计划待你批准 · v${session.plan_version}</b>`,
            escapeHtml(planCard.needs_user_approval ? '我已经把这条需求收成一条可执行计划线程。你一批准，我就会开始建单并推进。' : '这是我准备自动执行的精简计划。'),
            null,
            '<b>我已理解的计划</b>',
            escapeHtml(planCard.title),
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
            '<b>验收标准</b>',
            escapeHtml(textList(planCard.acceptance, '结果可验证。')),
            visibleRisks.length > 0 ? null : null,
            visibleRisks.length > 0 ? '<b>已知风险</b>' : null,
            visibleRisks.length > 0 ? escapeHtml(textList(visibleRisks, '暂无明显风险。')) : null,
            null,
            '<b>推荐方案</b>',
            escapeHtml(`${planCard.recommended_option.label}：${planCard.recommended_option.summary}`),
            null,
            '<b>批准后会发生什么</b>',
            escapeHtml(planCard.execution_strategy || '批准后我会开始物化并推进这条计划线程。'),
            planCard.alternate_option ? '<b>备选方案</b>' : null,
            planCard.alternate_option ? escapeHtml(`${planCard.alternate_option.label}：${planCard.alternate_option.summary}`) : null,
            null,
            '点按钮继续，或者直接回复你的想法。',
          ]),
          action_rows: supervisorActionRows(session, issue, '批准并开始'),
        },
        'approval',
        issue,
      );
    }

    if (session.state === 'awaiting_user_decision') {
      return this.withSessionMetadata(
        session,
        {
          format: 'telegram_html',
          message: joinHtmlLines([
            `<b>执行中需要你决定 · ${escapeHtml(issue?.identifier || planCard.title)}</b>`,
            '这条计划线程在执行中遇到了一个需要你拍板的节点。',
            session.last_material_outcome?.user_summary ? '<b>监督判断</b>' : null,
            session.last_material_outcome?.user_summary ? escapeHtml(String(session.last_material_outcome.user_summary)) : null,
            null,
            '<b>当前计划</b>',
            escapeHtml(planCard.title),
            issue?.github_repo ? '<b>仓库</b>' : null,
            issue?.github_repo ? `<code>${escapeHtml(issue.github_repo)}</code>` : null,
            null,
            '<b>当前为什么停在这里</b>',
            escapeHtml(describeSupervisorThread({
              session,
              currentChild: issue?.governance_current_child
                ?? issue?.governance_child_queue?.find((child) => child.queue_state === 'current')
                ?? null,
              childQueue: issue?.governance_child_queue ?? [],
            })),
            null,
            '<b>推荐下一步</b>',
            escapeHtml(issue?.next_recommended_action || planCard.recommended_option.summary),
            issue?.governance_summary ? '<b>原因</b>' : null,
            issue?.governance_summary ? escapeHtml(compact(issue.governance_summary, 240)) : null,
            null,
            '点“按推荐继续”，或者直接回复你想怎么改。',
          ]),
          action_rows: supervisorActionRows(session, issue),
        },
        `decision:${issue?.identifier ?? 'none'}`,
        issue,
      );
    }

    if (session.state === 'cancelled') {
      return this.withSessionMetadata(
        session,
        {
          format: 'telegram_html',
          message: joinHtmlLines([
            `<b>计划已取消 · ${escapeHtml(planCard.title)}</b>`,
            escapeHtml(session.delivery_summary || '这条计划线程已经取消，不会继续自动推进。'),
            null,
            '如果你要换一个需求，请直接发送：',
            `<code>新开线程 ${escapeHtml(planCard.title)}</code>`,
          ]),
        },
        'cancelled',
        issue,
      );
    }

    return this.withSessionMetadata(
      session,
      {
        format: 'telegram_html',
        message: joinHtmlLines([
          `<b>计划执行中 · ${escapeHtml(planCard.title)}</b>`,
          `状态：${escapeHtml(session.state)}`,
          lastOutcomeString(session, 'pending_user_notification_summary') ? null : null,
          lastOutcomeString(session, 'pending_user_notification_summary') ? '<b>监督更新</b>' : null,
          lastOutcomeString(session, 'pending_user_notification_summary')
            ? escapeHtml(lastOutcomeString(session, 'pending_user_notification_summary')!)
            : null,
          lastOutcomeString(session, 'latest_dev_instruction') ? '<b>下一轮指令</b>' : null,
          lastOutcomeString(session, 'latest_dev_instruction')
            ? escapeHtml(lastOutcomeString(session, 'latest_dev_instruction')!)
            : null,
        ]),
        action_rows: supervisorActionRows(session, issue),
      },
      [
        session.state,
        ...supervisorOutcomeMaterialParts(session),
      ].filter(Boolean).join(':'),
      issue,
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
          `<b>计划执行中 · ${escapeHtml(issue?.identifier || planCard?.title || 'root')}</b>`,
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
          '我会继续推进，只在关键节点回来找你。',
          null,
          escapeHtml(issue?.next_recommended_action || '我会继续盯关键节点，有需要你决定时再回来。'),
        ]),
        action_rows: supervisorActionRows(session, issue),
      },
      `executing:${issue?.identifier ?? 'none'}:${currentChild?.issue_identifier ?? 'none'}:${queue.map((child) => `${child.issue_identifier}:${child.queue_state ?? ''}`).join(',')}`,
      issue,
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
          '<b>验收标准</b>',
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
    issue: RuntimeIssueView | null = null,
  ): BotCommandResponse {
    const visualIssue = issue ?? (session.root_issue_id ? this.runtime.getIssue(session.root_issue_id) : null);
    const fullMaterialKey = [
      'session',
      session.id,
      `v${session.plan_version}`,
      materialKey,
      ...runtimeIssueMaterialParts(visualIssue),
    ].filter(Boolean).join('|');
    const responseFormat = response.format ?? (session.transport === 'telegram' ? 'telegram_html' : undefined);
    const shouldRenderVisual =
      session.transport === 'telegram' &&
      Boolean(session.plan_card) &&
      materialKey !== 'clarifying' &&
      !materialKey.startsWith('plan-memory');
    const visual = shouldRenderVisual
      ? buildSupervisorSessionVisualCard(session, visualIssue, fullMaterialKey)
      : null;
    const visualCaption = visual?.caption;
    return {
      ...response,
      format: responseFormat,
      caption: response.caption ?? visualCaption,
      media_key: response.media_key ?? visual?.media_key,
      photo: response.photo ?? visual?.photo,
      show_caption_above_media: response.show_caption_above_media ?? (visual ? false : undefined),
      action_rows: response.action_rows ?? (visual ? supervisorActionRows(session, visualIssue) : undefined),
      session_id: session.id,
      material_key: fullMaterialKey,
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
    const session = this.sessions.findByRootIssueId(rootIssueId);
    if (!session) {
      return;
    }
    if (session.state === 'cancelled' || session.state === 'completed') {
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
    const userVisibleMilestone = isInternalSupervisorTurnBudgetFailure(milestone)
      ? null
      : milestone;

    const oversightResult = this.executionOverseer.assess({
      session,
      issue,
      milestone: userVisibleMilestone,
    });
    if (oversightResult && typeof (oversightResult as Promise<unknown>).then === 'function') {
      void (oversightResult as Promise<SupervisorOversightAssessment | null>)
        .then((oversight) => {
          const freshSession = this.sessions.findById(session.id);
          if (!freshSession) {
            return;
          }
          if (freshSession.state === 'cancelled' || freshSession.state === 'completed') {
            return;
          }
          this.applyIssueOversightUpdate(freshSession, issue, userVisibleMilestone, oversight);
        })
        .catch(() => {
          // The overseer owns fallback behavior; a rejected async brain must not break runtime event fanout.
        });
      return;
    }

    this.applyIssueOversightUpdate(
      session,
      issue,
      userVisibleMilestone,
      oversightResult as SupervisorOversightAssessment | null,
    );
  }

  private applyIssueOversightUpdate(
    session: SupervisorSessionRecord,
    issue: RuntimeIssueView,
    milestone: SupervisorMilestone | null,
    rawOversight: SupervisorOversightAssessment | null,
  ): void {
    const oversight = rawOversight
      ? applySupervisorApprovalPolicy({
          assessment: rawOversight,
          milestone_kind: milestone?.kind ?? null,
          delivery_code: issue.delivery_code ?? milestone?.delivery_code ?? null,
          delivery_summary: issue.delivery_summary ?? milestone?.summary ?? null,
          plan_title: session.plan_card?.title ?? issue.title,
          user_text: null,
          destructive_text: buildDestructiveApprovalPolicyText(session, issue),
        })
      : null;
    const rootIssueId = issue.governance_root_issue_id ?? issue.issue_id;
    const isRootIssueEvent = rootIssueId === issue.issue_id;
    const shouldMirrorRootDelivery =
      isRootIssueEvent &&
      (issue.delivery_state == null || issue.delivery_state !== 'delivery_failed');
    const userVisibleDeliveryFailure = issue.delivery_state === 'delivery_failed'
      && !isInternalSupervisorTurnBudgetFailure(milestone ?? {
        kind: 'delivery_failed',
        key: issue.delivery_code ?? issue.delivery_summary ?? '',
        summary: issue.delivery_summary ?? issue.delivery_code ?? null,
        delivery_code: issue.delivery_code ?? null,
      });
    const previousOversightKey = typeof session.last_material_outcome?.oversight_key === 'string'
      ? session.last_material_outcome.oversight_key
      : null;
    if (oversight && oversight.key !== previousOversightKey) {
      this.recordEvent(session.id, 'supervisor_oversight', {
        decision: oversight.decision,
        reason: oversight.reason,
        dev_instruction: oversight.dev_instruction,
        user_summary: oversight.user_summary,
        active_decision_kind: oversight.active_decision_kind,
        source: oversight.source ?? null,
        fallback_reason: oversight.fallback_reason ?? null,
        issue_id: issue.issue_id,
        issue_identifier: issue.identifier,
        milestone_kind: milestone?.kind ?? null,
        milestone_key: milestone?.key ?? null,
      });
    }

    let nextState = session.state;
    if (isRootIssueEvent && milestone?.kind === 'cancelled') {
      nextState = 'cancelled';
    } else if (isRootIssueEvent && (
      issue.orchestrator_state === 'completed' ||
      issue.delivery_state === 'completed' ||
      milestone?.kind === 'completed'
    )) {
      nextState = 'completed';
    } else if (oversight?.decision === 'ask_user') {
      nextState = 'awaiting_user_decision';
    } else if (milestone?.kind === 'child_failed') {
      nextState = 'awaiting_user_decision';
    } else if (isRootIssueEvent && (
      issue.governance_thread_state === 'blocked' ||
      issue.governance_thread_state === 'confirming' ||
      issue.governance_thread_state === 'child_failed'
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
      active_decision_kind: oversight?.decision === 'ask_user'
        ? oversight.active_decision_kind ?? 'delivery_failure'
        : nextState === 'awaiting_user_decision'
          ? session.active_decision_kind
          : null,
      delivery_state: shouldMirrorRootDelivery || userVisibleDeliveryFailure
        ? issue.delivery_state ?? session.delivery_state
        : session.delivery_state,
      delivery_summary: shouldMirrorRootDelivery || userVisibleDeliveryFailure
        ? issue.delivery_summary ?? session.delivery_summary
        : session.delivery_summary,
      last_material_outcome: {
        ...(session.last_material_outcome ?? {}),
        milestone_kind: milestone?.kind ?? session.last_material_outcome?.milestone_kind ?? null,
        milestone_key: milestone?.key ?? session.last_material_outcome?.milestone_key ?? null,
        governance_thread_state: issue.governance_thread_state ?? null,
        next_recommended_action: issue.next_recommended_action ?? null,
        oversight_key: oversight?.key ?? session.last_material_outcome?.oversight_key ?? null,
        supervisor_decision: oversight?.decision ?? session.last_material_outcome?.supervisor_decision ?? null,
        supervisor_reason: oversight?.reason ?? session.last_material_outcome?.supervisor_reason ?? null,
        dev_instruction: oversight?.dev_instruction ?? session.last_material_outcome?.dev_instruction ?? null,
        user_summary: oversight?.user_summary ?? session.last_material_outcome?.user_summary ?? null,
        oversight_source: oversight?.source ?? session.last_material_outcome?.oversight_source ?? null,
        oversight_fallback_reason: oversight?.fallback_reason ?? session.last_material_outcome?.oversight_fallback_reason ?? null,
      },
    });
  }
}
