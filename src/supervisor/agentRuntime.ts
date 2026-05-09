import type {
  RepoClaudeConversationRepository,
  SupervisorPendingActionRepository,
  SupervisorRunEventRepository,
  SupervisorRunRepository,
  SupervisorToolCallRepository,
  BotConversationPreferenceRepository,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import type { SupervisorPendingActionRecord } from '../database/types';
import type { TrackerProjectResolutionService } from '../tracker/projectResolution';
import type { BotCommandContext, BotCommandResponse } from '../bots/types';
import type {
  BotAssistantDecision,
  BotAssistantDiagnostics,
  BotAssistantIntent,
  BotIssueContextView,
  BotRuntimeCopilotContext,
} from '../bots/types';
import type { BotAssistantModel, BotAssistantModelOutput } from '../bots/model';
import { BotCommandService } from '../bots/commandService';
import { isTerminalIssue, isUserVisibleActiveIssue } from '../bots/issueVisibility';
import { buildIssueCardActionRows } from '../bots/issueCardActions';
import {
  classifySupervisorControlPlaneIntent,
  type IssueStateFilter,
  isIssueListQuestion,
  isSupervisorControlPlaneQuestion,
} from '../bots/controlPlaneIntent';
import {
  shouldUseReadOnlyClaudeForText,
  type SupervisorAgentResult,
  type SupervisorAgentService,
} from './supervisorAgent';
import {
  buildNoActionAssistantReply,
  formatDuplicateToolRecovery,
  formatPendingActionReminder,
  formatStepLimitRecovery,
  formatToolArgumentRejection,
  formatToolFailureRecovery,
  formatUnsupportedToolRecovery,
} from './assistantReliability';
import { buildSupervisorIssueVisualCard } from './issueVisualCard';
import { inferRuntimeLocaleFromText, type RuntimeLocale } from '../i18n/locale';

export type CardSpec = Record<string, unknown>;

export type SupervisorTurn =
  | {
      type: 'tool_call';
      tool: string;
      args: Record<string, unknown>;
      reason: string;
    }
  | {
      type: 'progress_update';
      message: string;
    }
  | {
      type: 'final_answer';
      message: string;
      cards?: CardSpec[];
    }
  | {
      type: 'clarify';
      question: string;
    }
  | {
      type: 'confirm_action';
      action: {
        tool: string;
        args: Record<string, unknown>;
        reason?: string;
      };
      summary: string;
    };

export type SupervisorModelLoop = (input: {
  runId: string;
  text: string;
  availableTools: SupervisorToolDefinition[];
  toolResults: SupervisorToolResult[];
  context: BotRuntimeCopilotContext;
}) => Promise<SupervisorTurn | string | null | undefined>;

export type SupervisorProgressHandler = (input: {
  runId: string;
  context: BotCommandContext;
  message: string;
}) => Promise<void> | void;

export interface SupervisorToolContext {
  runId: string;
  text: string;
  context: BotCommandContext;
  runtime: RuntimeControlPlane;
  commandService: BotCommandService;
  preferences: BotConversationPreferenceRepository | null;
  projectResolver: TrackerProjectResolutionService | null;
  supervisorAgentService: SupervisorAgentService | null;
  repoConversations: RepoClaudeConversationRepository | null;
}

export interface SupervisorToolResult {
  tool: string;
  ok: boolean;
  summary: string;
  message?: string;
  response?: BotCommandResponse;
  data?: Record<string, unknown>;
}

export interface SupervisorToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk: 'read' | 'low_write' | 'high_write';
  direct_execution_policy: 'always' | 'high_confidence' | 'confirm_by_default';
  execute(args: unknown, context: SupervisorToolContext): Promise<SupervisorToolResult>;
}

export interface SupervisorActionPolicyDecision {
  allowed: boolean;
  requires_confirmation: boolean;
  risk: SupervisorToolDefinition['risk'];
  reason: string;
}

export interface SupervisorAgentRuntimeServiceOptions {
  runtime: RuntimeControlPlane;
  commandService: BotCommandService;
  preferences?: BotConversationPreferenceRepository | null;
  projectResolver?: TrackerProjectResolutionService | null;
  runs: SupervisorRunRepository;
  events: SupervisorRunEventRepository;
  toolCalls: SupervisorToolCallRepository;
  pendingActions: SupervisorPendingActionRepository;
  repoConversations?: RepoClaudeConversationRepository | null;
  actionPolicy?: SupervisorActionPolicy;
  model?: SupervisorModelLoop;
  supervisorAgentService?: SupervisorAgentService | null;
  onProgress?: SupervisorProgressHandler;
  progressThrottleMs?: number;
  maxSteps?: number;
}

export interface SupervisorRuntimeRespondRequest {
  context: BotCommandContext;
  text: string;
  canWrite?: boolean;
}

const CONFIRM_WORDS = new Set(['确认', '批准', '是的', '是', '对', '对的', '没错', 'yes', 'y', 'ok', 'okay', '好', '执行', '继续', 'confirm']);
const CANCEL_WORDS = new Set(['取消', 'cancel', 'no', 'n', '停止']);

function compact(value: string, maxLength = 320): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function argsHash(args: Record<string, unknown>): string {
  const input = stableStringify(args);
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeIssueRef(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return /^int-\d+$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
}

function extractIssueIdentifiers(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (value: string | null | undefined) => {
    const normalized = value?.trim().toUpperCase();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    ids.push(normalized);
  };

  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]+)-(\d+)\b/gi)) {
    const rawPrefix = match[1]!;
    const prefix = rawPrefix.toUpperCase();
    if (rawPrefix === prefix || prefix === 'INT') {
      add(`${prefix}-${match[2]}`);
    }
  }
  if (/(?:issue|单|任务|int|怎么样|状态|进度|卡片|关闭|关掉|关了|关上|关停|取消|作废|废弃|不要了|不用了|不需要|清理|清掉|清除|收掉|处理掉|残留|垃圾|重试|重新执行|继续执行|status|progress|card|retry|rerun|stop|close|cleanup)/i.test(text)) {
    for (const match of text.matchAll(/(?<![A-Z0-9-])#?(\d{1,6})(?![A-Z0-9-])/gi)) {
      add(`INT-${match[1]}`);
    }
  }
  return ids;
}

function isConfirmation(text: string): boolean {
  return CONFIRM_WORDS.has(text.trim().toLowerCase());
}

function isCancellation(text: string): boolean {
  return CANCEL_WORDS.has(text.trim().toLowerCase());
}

function isDirectExecutionText(text: string): boolean {
  return /直接|不用确认|无需确认|马上|立刻|现在就|directly|no confirmation|right now|close it now/i.test(text);
}

function isStatusQuestion(text: string): boolean {
  return /怎么样|状态|进度|status|stuck|blocked|卡住|卡在哪|doing|progress/i.test(text);
}

function isRetryRequest(text: string): boolean {
  return /重试|重新执行|重新跑|继续执行|retry|rerun|re-run|restart/i.test(text);
}

function isStopRequest(text: string): boolean {
  return /停止|停掉|stop|cancel run|halt/i.test(text);
}

function isCloseRequest(text: string): boolean {
  return /关闭|关掉|关了|关上|取消|取消掉|作废|废弃|不要了|不用了|清理|清掉|清除|收掉|处理掉|残留|垃圾|close|cancel\s+(?:this\s+)?issue|cleanup|supersede|duplicate/i.test(text);
}

function isCreateIssueRequest(text: string): boolean {
  return /(?:创建|新建).{0,24}issue/i.test(text) ||
    /(?:帮我|请你|请|麻烦|我要|我想|直接|给我).{0,16}(?:建|开|提|创建|新建).{0,24}issue/i.test(text) ||
    /(?:^|[\s，。！？!?])(?:建|开|提)(?:一个|个|一条|条)?\s*issue\b/i.test(text) ||
    /\bcreate\s+(?:(?:an?|the|new|a\s+new)\s+)?issue\b/i.test(text) ||
    /\bopen\s+(?:(?:an?|new|a\s+new)\s+)issue\b/i.test(text) ||
    /\bopen\s+issue\s+(?:for|about|to)\b/i.test(text);
}

function isSupervisorAdvisoryQuestion(text: string): boolean {
  return /(?:建议|推荐).{0,32}(?:issue|任务|工单|单子)|(?:issue|任务|工单|单子).{0,32}(?:建议|推荐|最能提升|最值得|最应该|应该提|做什么|提什么)|做什么\s*(?:issue|任务|工单|单子).{0,32}(?:提升|最好|最值)|(?:让你|你来|由你|给你).{0,16}(?:提|建|开).{0,8}(?:issue|任务|工单|单子).{0,48}(?:什么|哪个|哪一个|最应该|最值得|提升)|what\s+(?:issue|task|ticket).{0,48}(?:recommend|improve|best|valuable)|(?:recommend|suggest).{0,48}(?:issue|task|ticket)/i.test(text);
}

function isIssueRecommendationFollowup(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return false;
  }
  return /就按你(?:的)?(?:来|建议|推荐)?/i.test(normalized) ||
    /按(?:你的|你刚才|刚才|上面|上次|这个|那个)?(?:建议|推荐).{0,24}(?:来|做|建|创建|开|提|issue|任务|工单|单子)?/i.test(normalized) ||
    /(?:建|创建|开|提).{0,24}(?:这个|那个|上个|刚才|上面|建议|推荐).{0,24}(?:issue|任务|工单|单子)/i.test(normalized) ||
    /(?:这个|那个|上个|刚才|上面|建议|推荐).{0,24}(?:issue|任务|工单|单子).{0,24}(?:建|创建|开|提)/i.test(normalized) ||
    /^(?:需要|可以|行|批准|yes|yep|sure)$/i.test(normalized) ||
    /(?:可以|行|好|好的|没问题).{0,16}(?:帮我|给我|替我|你).{0,12}(?:建|创建|新建|开|提)/i.test(normalized) ||
    /\b(?:go ahead|do it|create it|create that|create this|open it|open that|make it)\b/i.test(normalized);
}

interface IssueRecommendationDraft {
  title: string;
  description: string;
}

function issueRecommendationDraftFromMessage(message: string | null): IssueRecommendationDraft | null {
  if (!message) {
    return null;
  }
  const lines = message.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const titleLineIndex = lines.findIndex((line) => /^我建议先做这个 issue[:：]/i.test(line));
  if (titleLineIndex < 0) {
    return null;
  }
  const title = lines[titleLineIndex]!.replace(/^我建议先做这个 issue[:：]\s*/i, '').trim();
  if (!title) {
    return null;
  }
  const bodyLines = lines.slice(titleLineIndex + 1);
  const description = [
    '来自上一次 Telegram 仓库建议。',
    ...bodyLines,
  ].filter(Boolean).join('\n');
  return {
    title,
    description: description || '来自上一次 Telegram 仓库建议。',
  };
}

function isContextualIssueReference(text: string): boolean {
  return /这个\s*(?:issue|单|任务)?|当前这个|上面这个|刚才(?:那个|这个)|this\s+issue|\bit\b/i.test(text);
}

function isSetProjectRequest(text: string): boolean {
  return /(?:set|switch|切换|设置|默认).{0,16}(?:project|项目)|(?:project|项目).{0,16}(?:to|为|成|设为|设置|切换|默认)/i.test(text);
}

function isRuntimeControlActionText(text: string): boolean {
  const issueId = extractIssueIdentifiers(text)[0] ?? null;
  if (issueId && (isRetryRequest(text) || isStopRequest(text) || isCloseRequest(text))) {
    return true;
  }
  if (isCreateIssueRequest(text)) {
    return true;
  }
  return Boolean(extractProjectSlug(text) && /默认项目设为|默认用|设置|切换|set|switch/i.test(text));
}

function extractProjectSlug(text: string): string | null {
  const patterns = [
    /(?:set|switch)\s+(?:default\s+)?project\s*(?:to)?\s*([A-Za-z0-9_.:-]+)/i,
    /(?:切换|设置|默认).{0,8}(?:project|项目).{0,4}(?:为|成|到|设为|设置为)?\s*([A-Za-z0-9_.:-]+)/i,
    /(?:project|项目)\s*(?:to|为|成|设为|设置为|切换到|默认(?:为|到)?)\s*([A-Za-z0-9_.:-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const slug = match?.[1]?.trim();
    if (slug) {
      return slug;
    }
  }
  return null;
}

function isShowCardRequest(text: string): boolean {
  return /卡片|card/i.test(text);
}

function isReadOnlyText(text: string): boolean {
  if (isRuntimeControlActionText(text)) {
    return false;
  }
  return isSupervisorControlPlaneQuestion(text) ||
    isIssueListQuestion(text) ||
    isStatusQuestion(text) ||
    isShowCardRequest(text) ||
    shouldUseReadOnlyClaudeForText(text) ||
    /readme|仓库|代码|文件|repo|repository/i.test(text);
}

function formatSupervisorAgentResult(result: SupervisorAgentResult): string {
  switch (result.mode) {
    case 'chat_reply':
      return result.message;
    case 'repo_answer':
      return result.answer;
    case 'clarify':
      return result.question;
    case 'issue_recommendation':
      return [
        `我建议先做这个 issue：${result.title}`,
        result.summary,
        `下一步：${result.nextStep}`,
      ].filter(Boolean).join('\n');
    case 'artifact_ideation':
      return [
        `我建议先做这个 artifact：${result.title}`,
        result.recommendation,
        `原因：${result.rationale}`,
        `下一步：${result.nextStep}`,
      ].filter(Boolean).join('\n');
    case 'handoff_to_session':
      return result.handoffMessage;
  }
}

function supervisorAgentResultToTurn(result: SupervisorAgentResult): SupervisorTurn {
  if (result.mode === 'clarify') {
    return {
      type: 'clarify',
      question: result.question,
    };
  }
  return {
    type: 'final_answer',
    message: formatSupervisorAgentResult(result),
  };
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatIssueLine(issue: RuntimeIssueView, options: { includeExternal?: boolean } = {}): string {
  const bits = [
    issue.identifier,
    issue.phase,
    issue.tracker_state,
    issue.orchestrator_state ?? 'unknown',
  ];
  const external = options.includeExternal
    ? [
        issue.github_repo ? `repo=${issue.github_repo}` : null,
        issue.github_issue_number ? `gh#${issue.github_issue_number}` : null,
        issue.active_pr_number ? `pr#${issue.active_pr_number}` : null,
        issue.branch_name ? `branch=${issue.branch_name}` : null,
      ].filter(Boolean).join(' · ')
    : null;
  return [
    `${bits.join(' · ')} · ${compact(issue.title, 80)}`,
    external || null,
  ].filter(Boolean).join(' · ');
}

function isEnglishLocale(locale: RuntimeLocale | null | undefined): boolean {
  return locale === 'en';
}

function textForLocale(locale: RuntimeLocale | null | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function issueLocale(issue: RuntimeIssueView): RuntimeLocale {
  return issue.supervisor_locale ?? inferRuntimeLocaleFromText([
    issue.title,
    issue.supervisor_plan_summary,
    issue.delivery_summary,
    issue.next_recommended_action,
  ].filter(Boolean).join('\n'));
}

function issueMatchesStateFilter(issue: RuntimeIssueView, filter: IssueStateFilter | null): boolean {
  switch (filter) {
    case 'active':
      return isUserVisibleActiveIssue(issue);
    case 'open':
      return !isTerminalIssue(issue);
    case 'failed':
      return /failed|halted|blocked/i.test(issue.orchestrator_state ?? '') ||
        issue.delivery_state === 'delivery_failed';
    case 'cancelled':
      return /cancelled|canceled/i.test(issue.tracker_state) ||
        /cancelled|canceled/i.test(issue.orchestrator_state ?? '');
    case 'completed':
      return /done|completed|closed/i.test(issue.tracker_state) ||
        /completed/i.test(issue.orchestrator_state ?? '');
    case 'review':
      return issue.phase === 'REVIEW' || /review|审核|评审/i.test(issue.tracker_state);
    default:
      return true;
  }
}

function summarizeIssues(
  issues: RuntimeIssueView[],
  options: { activeOnly?: boolean; stateFilter?: IssueStateFilter | null; includeExternal?: boolean } = {},
): string {
  const stateFilter = options.stateFilter ?? (options.activeOnly ? 'active' : null);
  const visibleIssues = issues.filter((issue) => issueMatchesStateFilter(issue, stateFilter));
  const label = stateFilter === 'active'
    ? '活跃 issue'
    : stateFilter
      ? `${stateFilter} issue`
      : 'tracked issues';
  if (visibleIssues.length === 0) {
    return `当前没有${stateFilter === 'active' ? '活跃 issue' : ` ${label}`}。`;
  }
  return [
    stateFilter === 'active'
      ? `当前有 ${visibleIssues.length} 个活跃 issue：`
      : `当前有 ${visibleIssues.length} 个 ${label}：`,
    ...visibleIssues.slice(0, 8).map((issue) => `- ${formatIssueLine(issue, { includeExternal: options.includeExternal })}`),
  ].join('\n');
}

function summarizeControlPlane(context: SupervisorToolContext): string {
  const overview = context.runtime.getOverview();
  const issues = overview.issues;
  const activeIssues = issues.filter(isUserVisibleActiveIssue);
  const failedIssues = issues.filter((issue) => issueMatchesStateFilter(issue, 'failed'));
  const externalIssues = issues.filter((issue) =>
    issue.github_repo || issue.github_issue_number || issue.active_pr_number || issue.branch_name
  );
  const defaultProject = context.preferences?.findByConversation({
    transport: context.context.transport,
    conversation_id: context.context.recipient.conversation_id,
  })?.default_project_slug ?? null;
  const routes = context.projectResolver?.listConfiguredProjectSlugs() ?? [];

  return [
    '当前 supervisor 控制面：',
    `Issues: total=${overview.counts.total}, running=${overview.counts.running}, retrying=${overview.counts.retrying}, active=${activeIssues.length}, failed=${failedIssues.length}`,
    defaultProject ? `Default project: ${defaultProject}` : 'Default project: not set',
    routes.length > 0 ? `Configured projects: ${routes.join(', ')}` : null,
    activeIssues[0] ? 'Active:' : null,
    ...activeIssues.slice(0, 5).map((issue) => `- ${formatIssueLine(issue, { includeExternal: true })}`),
    !activeIssues[0] && failedIssues[0] ? 'Failed / blocked:' : null,
    ...(!activeIssues[0] ? failedIssues.slice(0, 5).map((issue) => `- ${formatIssueLine(issue, { includeExternal: true })}`) : []),
    externalIssues[0] ? 'External surfaces seen in runtime:' : null,
    ...externalIssues.slice(0, 5).map((issue) => `- ${issue.identifier}: ${[
      issue.github_repo ? `repo=${issue.github_repo}` : null,
      issue.github_issue_number ? `gh#${issue.github_issue_number}` : null,
      issue.active_pr_number ? `pr#${issue.active_pr_number}` : null,
      issue.branch_name ? `branch=${issue.branch_name}` : null,
    ].filter(Boolean).join(', ')}`),
  ].filter(Boolean).join('\n');
}

function buildConfirmActions(locale: RuntimeLocale | null | undefined = null): BotTransportAction[] {
  return [
    {
      label: textForLocale(locale, '确认', 'Confirm'),
      style: 'danger',
      callback_data: 'pending|confirm',
    },
    {
      label: textForLocale(locale, '取消', 'Cancel'),
      style: 'default',
      callback_data: 'pending|cancel',
    },
  ];
}

function routeRepoRef(params: {
  preferences: BotConversationPreferenceRepository | null;
  projectResolver: TrackerProjectResolutionService | null;
  context: BotCommandContext;
  issue: RuntimeIssueView | null;
}): {
  repoRef: string | null;
  localPath: string | null;
  route: ReturnType<TrackerProjectResolutionService['listConfiguredRoutes']>[number] | null;
} {
  const routes = params.projectResolver?.listConfiguredRoutes() ?? [];
  const defaultProjectSlug = params.preferences?.findByConversation({
    transport: params.context.transport,
    conversation_id: params.context.recipient.conversation_id,
  })?.default_project_slug ?? null;
  const route = (
    params.issue?.github_repo
      ? routes.find((item) => item.github_repo_full === params.issue?.github_repo) ?? null
      : null
  ) || (
    defaultProjectSlug
      ? routes.find((item) => item.project_slug === defaultProjectSlug) ?? null
      : null
  ) || (routes[0] ?? null);

  return {
    repoRef: params.issue?.github_repo ?? route?.github_repo_full ?? null,
    localPath: route?.local_path ?? null,
    route,
  };
}

function parseStructuredTurn(value: SupervisorTurn | string | null | undefined): SupervisorTurn | null {
  if (!value) {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }
  try {
    const parsed = JSON.parse(value) as SupervisorTurn;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function isBotAssistantDecision(value: BotAssistantModelOutput): value is BotAssistantDecision {
  return Boolean(value) && typeof value === 'object' && 'intent' in value;
}

function coerceToolRouterIntent(value: Record<string, unknown> | null): BotAssistantIntent | null {
  if (!value || typeof value.intent !== 'object' || value.intent === null) {
    return null;
  }
  const intent = value.intent as Record<string, unknown>;
  const kind = typeof intent.kind === 'string' ? intent.kind : null;
  const issueId = typeof intent.issue_id === 'string' && intent.issue_id.trim()
    ? intent.issue_id.trim()
    : null;
  if (!kind) {
    return null;
  }

  switch (kind) {
    case 'create_issue':
      return typeof intent.title === 'string' && intent.title.trim()
        ? {
            kind,
            title: intent.title.trim(),
            description: typeof intent.description === 'string' && intent.description.trim()
              ? intent.description.trim()
              : null,
            project_slug: typeof intent.project_slug === 'string' && intent.project_slug.trim()
              ? intent.project_slug.trim()
              : null,
          }
        : null;
    case 'show_issue_card':
      return { kind, issue_id: issueId };
    case 'status':
    case 'watch':
    case 'unwatch':
    case 'stop':
    case 'retry':
    case 'close_issue':
    case 'override':
    case 'rewrite':
    case 'split':
      return {
        kind,
        issue_id: issueId,
        ...(kind === 'watch' && typeof intent.watch_preset === 'string'
          ? { watch_preset: intent.watch_preset as 'default' | 'verbose' | 'failures' | 'status' }
          : {}),
        ...(typeof intent.reason === 'string' && intent.reason.trim()
          ? { reason: intent.reason.trim() }
          : {}),
      };
    case 'supersede_issue':
      return {
        kind,
        issue_id: issueId,
        successor_issue_id: typeof intent.successor_issue_id === 'string' && intent.successor_issue_id.trim()
          ? intent.successor_issue_id.trim()
          : null,
        reason: typeof intent.reason === 'string' && intent.reason.trim()
          ? intent.reason.trim()
          : null,
        retry_successor: intent.retry_successor === true,
      };
    case 'set_default_project':
      return {
        kind,
        project_slug: typeof intent.project_slug === 'string' && intent.project_slug.trim()
          ? intent.project_slug.trim()
          : null,
      };
    case 'show_default_project':
    case 'help':
      return { kind };
    case 'answer_question':
      return typeof intent.answer === 'string' && intent.answer.trim()
        ? { kind, answer: intent.answer.trim() }
        : null;
    case 'clarify':
      return typeof intent.question === 'string' && intent.question.trim()
        ? { kind, question: intent.question.trim() }
        : null;
    case 'execute_governance_suggestion':
    case 'dismiss_governance_suggestion':
      return {
        kind,
        issue_id: issueId,
        suggestion_id: typeof intent.suggestion_id === 'string' && intent.suggestion_id.trim()
          ? intent.suggestion_id.trim()
          : null,
        suggestion_type: typeof intent.suggestion_type === 'string' && intent.suggestion_type.trim()
          ? intent.suggestion_type.trim()
          : null,
        ordinal: typeof intent.ordinal === 'number' && Number.isFinite(intent.ordinal)
          ? Math.max(1, Math.trunc(intent.ordinal))
          : null,
      };
    default:
      return null;
  }
}

function parseToolRouterDecision(output: BotAssistantModelOutput): BotAssistantDecision | null {
  if (!output) {
    return null;
  }
  if (isBotAssistantDecision(output)) {
    return output;
  }
  if (typeof output !== 'string') {
    return null;
  }
  const intent = coerceToolRouterIntent(extractJsonObject(output));
  return intent ? { intent } : null;
}

function issueIdFromIntent(input: {
  intentIssueId?: string | null;
  context: BotRuntimeCopilotContext;
}): string | null {
  return input.intentIssueId
    ?? input.context.focus_issue?.issue.identifier
    ?? input.context.overview.active_issues[0]?.identifier
    ?? null;
}

function botIntentToSupervisorTurn(
  intent: BotAssistantIntent,
  input: Parameters<SupervisorModelLoop>[0],
): SupervisorTurn | null {
  switch (intent.kind) {
    case 'show_issue_card': {
      const issueId = issueIdFromIntent({ intentIssueId: intent.issue_id, context: input.context });
      return issueId
        ? {
            type: 'tool_call',
            tool: 'show_issue_card',
            args: { issue_id: issueId },
            reason: 'LLM router selected the issue card tool.',
          }
        : {
            type: 'clarify',
            question: '你想看哪张 issue 卡片？可以直接说 INT-xxx，或者先问我当前活跃 issue。',
          };
    }
    case 'status': {
      const issueId = issueIdFromIntent({ intentIssueId: intent.issue_id, context: input.context });
      return issueId
        ? {
            type: 'tool_call',
            tool: 'diagnose_issue',
            args: { issue_id: issueId },
            reason: 'LLM router selected issue diagnosis.',
          }
        : {
            type: 'tool_call',
            tool: 'list_issues',
            args: { active_only: true, state_filter: 'active' },
            reason: 'LLM router selected active issue status.',
          };
    }
    case 'create_issue':
      return {
        type: 'tool_call',
        tool: 'create_issue',
        args: {
          title: intent.title,
          description: intent.description,
          project_slug: intent.project_slug,
        },
        reason: 'LLM router selected issue creation.',
      };
    case 'retry':
      return {
        type: 'tool_call',
        tool: 'retry_issue',
        args: { issue_id: issueIdFromIntent({ intentIssueId: intent.issue_id, context: input.context }) },
        reason: 'LLM router selected retry.',
      };
    case 'stop':
      return {
        type: 'tool_call',
        tool: 'stop_issue',
        args: { issue_id: issueIdFromIntent({ intentIssueId: intent.issue_id, context: input.context }) },
        reason: 'LLM router selected stop.',
      };
    case 'close_issue':
      return {
        type: 'tool_call',
        tool: 'close_issue',
        args: { issue_id: issueIdFromIntent({ intentIssueId: intent.issue_id, context: input.context }) },
        reason: 'LLM router selected close.',
      };
    case 'supersede_issue':
      return {
        type: 'tool_call',
        tool: 'supersede_issue',
        args: {
          issue_id: issueIdFromIntent({ intentIssueId: intent.issue_id, context: input.context }),
          successor_issue_id: intent.successor_issue_id,
          reason: intent.reason,
        },
        reason: 'LLM router selected supersede.',
      };
    case 'set_default_project':
      return {
        type: 'tool_call',
        tool: 'set_default_project',
        args: { project_slug: intent.project_slug },
        reason: 'LLM router selected default project update.',
      };
    case 'override':
      return {
        type: 'tool_call',
        tool: 'override_governance',
        args: { issue_id: issueIdFromIntent({ intentIssueId: intent.issue_id, context: input.context }) },
        reason: 'LLM router selected governance override.',
      };
    case 'rewrite':
      return {
        type: 'tool_call',
        tool: 'rewrite_governance',
        args: { issue_id: issueIdFromIntent({ intentIssueId: intent.issue_id, context: input.context }) },
        reason: 'LLM router selected governance rewrite.',
      };
    case 'split':
      return {
        type: 'tool_call',
        tool: 'split_governance',
        args: { issue_id: issueIdFromIntent({ intentIssueId: intent.issue_id, context: input.context }) },
        reason: 'LLM router selected governance split.',
      };
    case 'answer_question':
      return { type: 'final_answer', message: intent.answer };
    case 'clarify':
      return { type: 'clarify', question: intent.question };
    case 'show_default_project':
      return {
        type: 'tool_call',
        tool: 'summarize_control_plane',
        args: { intent_kind: 'default_project' },
        reason: 'LLM router selected default project summary.',
      };
    case 'help':
      return { type: 'final_answer', message: buildNoActionAssistantReply(input.text) };
    default:
      return null;
  }
}

export function createSupervisorToolRouterModel(model: BotAssistantModel): SupervisorModelLoop {
  return async (input) => {
    if (input.toolResults.length > 0) {
      return null;
    }
    const output = await model.decide({
      text: input.text,
      context: input.context,
    });
    const decision = parseToolRouterDecision(output);
    return decision ? botIntentToSupervisorTurn(decision.intent, input) : null;
  };
}

function buildConfirmationSummary(
  toolName: string,
  args: Record<string, unknown>,
  reason: string,
  locale: RuntimeLocale | null | undefined = null,
): string {
  const issueId = firstString(args.issue_id);
  const successorIssueId = firstString(args.successor_issue_id);
  const title = firstString(args.title);
  const project = firstString(args.project_slug);
  return [
    `Action: ${toolName.replace(/_/g, ' ')}`,
    issueId ? `Issue: ${issueId}` : null,
    successorIssueId ? `Successor: ${successorIssueId}` : null,
    project ? `Project: ${project}` : null,
    title ? `Title: ${title}` : null,
    `Reason: ${reason}`,
    textForLocale(locale, 'Reply with: 确认 / 取消', 'Reply with: Confirm / Cancel'),
  ].filter(Boolean).join('\n');
}

function validateToolArgs(definition: SupervisorToolDefinition, args: Record<string, unknown>): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return `Invalid args for ${definition.name}: args must be an object.`;
  }

  const schema = definition.input_schema;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, { type?: unknown }>
    : {};

  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      return `Invalid args for ${definition.name}: ${key} is required.`;
    }
  }

  for (const [key, property] of Object.entries(properties)) {
    if (!(key in args) || args[key] === undefined || args[key] === null) {
      continue;
    }
    const expectedType = property.type;
    if (expectedType === 'string' && typeof args[key] !== 'string') {
      return `Invalid args for ${definition.name}: ${key} must be a string.`;
    }
    if (expectedType === 'number' && typeof args[key] !== 'number') {
      return `Invalid args for ${definition.name}: ${key} must be a number.`;
    }
    if (expectedType === 'boolean' && typeof args[key] !== 'boolean') {
      return `Invalid args for ${definition.name}: ${key} must be a boolean.`;
    }
    if (expectedType === 'object' && (
      typeof args[key] !== 'object' ||
      Array.isArray(args[key]) ||
      args[key] === null
    )) {
      return `Invalid args for ${definition.name}: ${key} must be an object.`;
    }
  }

  return null;
}

function toBotIssueContextView(issue: RuntimeIssueView): BotIssueContextView {
  return {
    issue_id: issue.issue_id,
    identifier: issue.identifier,
    title: issue.title,
    phase: issue.phase,
    tracker_state: issue.tracker_state,
    orchestrator_state: issue.orchestrator_state,
    github_repo: issue.github_repo,
    branch_name: issue.branch_name,
    active_pr_number: issue.active_pr_number,
    session: issue.session
      ? {
          session_id: issue.session.session_id,
          turn_count: issue.session.turn_count,
          stage: issue.session.stage,
          last_event: issue.session.last_event,
          last_message: issue.session.last_message,
          started_at: issue.session.started_at,
          last_event_at: issue.session.last_event_at,
          tokens: issue.session.tokens,
          recent_tools: issue.session.recent_tools,
          recent_files: issue.session.recent_files,
        }
      : null,
    session_stage: issue.session?.stage ?? null,
    session_message: issue.session?.last_message ?? null,
    supervisor_session_state: issue.supervisor_session_state ?? null,
    supervisor_plan_summary: issue.supervisor_plan_summary ?? null,
    architectural_target: issue.architectural_target ?? null,
    path_families: issue.path_families ?? [],
    boundary_edges: issue.boundary_edges ?? [],
    import_edges: issue.import_edges ?? [],
    fitness_signals: (issue.fitness_signals ?? []).map((signal) => signal.summary),
    governance_root_issue_identifier: issue.governance_root_issue_identifier ?? null,
    governance_thread_state: issue.governance_thread_state ?? null,
    governance_child_issues: (issue.governance_child_issues ?? []).map((child) => ({
      issue_id: child.issue_id,
      issue_identifier: child.issue_identifier,
      title: child.title,
      tracker_state: child.tracker_state,
      orchestrator_state: child.orchestrator_state,
      governance_decision: child.governance_decision,
      governance_summary: child.governance_summary,
      delivery_code: child.delivery_code,
      delivery_summary: child.delivery_summary,
    })),
    next_recommended_action: issue.next_recommended_action ?? null,
    governance_pause_reason: issue.governance_pause_reason ?? null,
    governance_expected_handoff: issue.governance_expected_handoff ?? null,
    governance_queued_child_identifiers: issue.governance_queued_child_identifiers ?? [],
    delivery_state: issue.delivery_state ?? null,
    delivery_code: issue.delivery_code ?? null,
    delivery_summary: issue.delivery_summary ?? null,
    repo_harness_status: issue.repo_harness_status
      ? {
          status: issue.repo_harness_status.status,
          learning_confidence: issue.repo_harness_status.learning_confidence ?? null,
          learned_command_count: issue.repo_harness_status.learned_command_count ?? 0,
          learned_artifact_count: issue.repo_harness_status.learned_artifact_count ?? 0,
          learned_runtime_hint_count: issue.repo_harness_status.learned_runtime_hint_count ?? 0,
        }
      : null,
  };
}

export class SupervisorActionPolicy {
  evaluate(params: {
    definition: SupervisorToolDefinition;
    args: Record<string, unknown>;
    context: SupervisorToolContext;
    canWrite: boolean;
    text: string;
  }): SupervisorActionPolicyDecision {
    const { definition } = params;
    if (definition.risk === 'read') {
      return {
        allowed: true,
        requires_confirmation: false,
        risk: definition.risk,
        reason: 'Read-only supervisor tool.',
      };
    }

    if (!params.canWrite) {
      return {
        allowed: false,
        requires_confirmation: false,
        risk: definition.risk,
        reason: `${params.context.context.transport} is not allowed to execute write actions.`,
      };
    }

    if (definition.risk === 'low_write') {
      const stateReason = this.validateLowRiskWrite(params.definition.name, params.args, params.context);
      if (stateReason) {
        return {
          allowed: true,
          requires_confirmation: true,
          risk: definition.risk,
          reason: stateReason,
        };
      }
      return {
        allowed: true,
        requires_confirmation: false,
        risk: definition.risk,
        reason: 'Low-risk write with unique valid target and explicit user intent.',
      };
    }

    const stateReason = this.validateHighRiskWrite(params.definition.name, params.args, params.context);
    if (stateReason) {
      return {
        allowed: false,
        requires_confirmation: false,
        risk: definition.risk,
        reason: stateReason,
      };
    }
    return {
      allowed: true,
      requires_confirmation: !isDirectExecutionText(params.text),
      risk: definition.risk,
      reason: isDirectExecutionText(params.text)
        ? 'High-risk write explicitly requested for direct execution and backend validation passed.'
        : 'High-risk write requires confirmation by default.',
    };
  }

  private validateLowRiskWrite(
    toolName: string,
    args: Record<string, unknown>,
    context: SupervisorToolContext,
  ): string | null {
    if (toolName === 'set_default_project') {
      const projectSlug = firstString(args.project_slug);
      if (!projectSlug) {
        return 'Project slug is missing.';
      }
      const routes = context.projectResolver?.listConfiguredProjectSlugs() ?? [];
      return routes.length === 0 || routes.includes(projectSlug) ? null : `Project ${projectSlug} is not configured.`;
    }

    const issueId = firstString(args.issue_id);
    if (!issueId) {
      return 'Issue id is missing.';
    }
    const issue = context.runtime.getIssue(issueId);
    if (!issue) {
      return `Issue ${issueId} was not found.`;
    }
    if (toolName === 'retry_issue' && !issue.actions.can_retry) {
      return `${issue.identifier} is not currently retryable.`;
    }
    if (toolName === 'stop_issue' && !issue.actions.can_stop) {
      return `${issue.identifier} is not currently running.`;
    }
    return null;
  }

  private validateHighRiskWrite(
    toolName: string,
    args: Record<string, unknown>,
    context: SupervisorToolContext,
  ): string | null {
    if (toolName === 'create_issue') {
      return firstString(args.title) ? null : 'Issue title is missing.';
    }
    const issueId = firstString(args.issue_id);
    if (!issueId) {
      return 'Issue id is missing.';
    }
    return context.runtime.getIssue(issueId) ? null : `Issue ${issueId} was not found.`;
  }
}

export class SupervisorAgentRuntimeService {
  private readonly actionPolicy: SupervisorActionPolicy;
  private readonly tools: Map<string, SupervisorToolDefinition>;
  private readonly maxSteps: number;
  private readonly progressThrottleMs: number;

  constructor(private readonly options: SupervisorAgentRuntimeServiceOptions) {
    this.actionPolicy = options.actionPolicy ?? new SupervisorActionPolicy();
    this.tools = new Map(createSupervisorToolDefinitions().map((tool) => [tool.name, tool]));
    this.maxSteps = options.maxSteps ?? 16;
    this.progressThrottleMs = Math.max(0, options.progressThrottleMs ?? 8_000);
  }

  recoverStartupState(): number {
    const activeRuns = this.options.runs.listActive();
    const staleRuns = activeRuns.filter((run) => run.state === 'running');
    let recovered = this.options.runs.recoverStaleRunning();
    if (staleRuns.length > 0) {
      for (const run of staleRuns) {
        this.options.events.create({
          run_id: run.id,
          event_kind: 'run_recovered',
          message: 'Run recovered during startup.',
        });
      }
    }
    this.options.pendingActions.deleteExpired();
    const now = new Date();
    for (const run of activeRuns) {
      if (run.state !== 'waiting_confirmation') {
        continue;
      }
      const hasOpenPendingAction = this.options.pendingActions.findByRun(run.id).some((pending) =>
        pending.status === 'pending_confirm' && pending.expires_at > now
      );
      if (hasOpenPendingAction) {
        continue;
      }
      this.options.runs.update({
        id: run.id,
        state: 'cancelled',
        final_message: 'Pending confirmation was no longer available during startup recovery.',
      });
      this.options.events.create({
        run_id: run.id,
        event_kind: 'confirmation_cancelled',
        message: 'Pending confirmation was no longer available during startup recovery.',
      });
      recovered += 1;
    }
    return recovered;
  }

  async respond(request: SupervisorRuntimeRespondRequest): Promise<BotCommandResponse> {
    this.options.pendingActions.deleteExpired();
    const existingPending = this.options.pendingActions.findOpenByConversation({
      transport: request.context.transport,
      conversation_id: request.context.recipient.conversation_id,
    });

    if (existingPending) {
      if (isConfirmation(request.text)) {
        return this.executePendingAction(request, existingPending.id);
      }
      if (isCancellation(request.text)) {
        this.cancelPendingAction(existingPending, 'User cancelled the pending action.', 'Cancelled the pending action.');
        return {
          message: 'Cancelled the pending action.',
        };
      }
      if (!isReadOnlyText(request.text) && this.detectControlTurn(request.text)) {
        this.cancelPendingAction(
          existingPending,
          'Pending action superseded by a new control action.',
          'Superseded by a newer control action.',
        );
      } else if (!isReadOnlyText(request.text)) {
        const locale = inferRuntimeLocaleFromText(request.text);
        return {
          message: formatPendingActionReminder(existingPending.summary_message, locale),
          actions: buildConfirmActions(locale),
        };
      }
    }

    return this.executeRun(request);
  }

  private cancelPendingAction(
    pending: SupervisorPendingActionRecord,
    eventMessage: string,
    finalMessage: string,
  ): void {
    this.options.pendingActions.update({
      id: pending.id,
      status: 'cancelled',
    });
    this.options.events.create({
      run_id: pending.run_id,
      event_kind: 'confirmation_cancelled',
      message: eventMessage,
    });
    this.options.runs.update({
      id: pending.run_id,
      state: 'cancelled',
      final_message: finalMessage,
    });
  }

  private async executePendingAction(
    request: SupervisorRuntimeRespondRequest,
    pendingActionId: string,
  ): Promise<BotCommandResponse> {
    const pending = this.options.pendingActions.findById(pendingActionId);
    if (!pending) {
      return {
        message: 'The pending action is no longer available.',
      };
    }

    this.options.pendingActions.update({
      id: pending.id,
      status: 'executing',
    });
    const run = this.createRun({
      ...request,
      text: `confirm ${pending.tool_name}`,
    });
    this.options.events.create({
      run_id: run.id,
      event_kind: 'confirmation_accepted',
      message: `Accepted pending ${pending.tool_name}.`,
      payload: {
        pending_action_id: pending.id,
        original_run_id: pending.run_id,
      },
    });

    const result = await this.executeTool({
      runId: run.id,
      turn: {
        type: 'tool_call',
        tool: pending.tool_name,
        args: pending.tool_args,
        reason: pending.reason,
      },
      request,
      canWrite: request.canWrite ?? true,
      skipConfirmation: true,
    });
    this.options.pendingActions.update({
      id: pending.id,
      status: result.ok ? 'completed' : 'failed',
    });
    return this.completeRun(run.id, result.response ?? {
      message: result.message ?? result.summary,
    }, result.ok ? 'completed' : 'failed');
  }

  private async executeRun(request: SupervisorRuntimeRespondRequest): Promise<BotCommandResponse> {
    const run = this.createRun(request);
    const toolResults: SupervisorToolResult[] = [];
    let deterministicTurns: SupervisorTurn[] | null = this.options.model
      ? null
      : await this.planDeterministicTurns(request.text, run, request);
    let deterministicIndex = 0;
    let repairAttempts = 0;
    let useDeterministicFallback = !this.options.model;
    const getDeterministicTurns = async (): Promise<SupervisorTurn[]> => {
      deterministicTurns ??= await this.planDeterministicTurns(request.text, run, request);
      return deterministicTurns;
    };

    for (let step = 0; step < this.maxSteps; step += 1) {
      this.options.runs.update({
        id: run.id,
        step_count: step + 1,
      });

      const rawTurn = useDeterministicFallback
        ? (await getDeterministicTurns())[deterministicIndex++]
        : await this.options.model?.({
            runId: run.id,
            text: request.text,
            availableTools: [...this.tools.values()],
            toolResults,
            context: this.buildRuntimeCopilotContext(request, run),
          });
      const turn = parseStructuredTurn(rawTurn);

      if (!turn) {
        if (this.options.model && !useDeterministicFallback && toolResults.length === 0) {
          useDeterministicFallback = true;
          deterministicIndex = 0;
          this.options.events.create({
            run_id: run.id,
            event_kind: 'model_fallback',
            message: 'LLM router returned no usable turn; falling back to deterministic runtime router.',
          });
          continue;
        }
        const final = this.finalResponseFromToolResults(toolResults, request.text);
        return this.completeRun(run.id, final, 'completed');
      }

      this.options.events.create({
        run_id: run.id,
        event_kind: 'model_turn',
        message: turn.type,
        payload: turn as unknown as Record<string, unknown>,
      });

      if (turn.type === 'progress_update') {
        const previousRun = this.options.runs.findById(run.id);
        this.options.events.create({
          run_id: run.id,
          event_kind: 'progress_message',
          message: turn.message,
        });
        this.options.runs.update({
          id: run.id,
          last_progress_at: new Date(),
        });
        if (this.shouldEmitProgress(previousRun?.last_progress_at ?? null)) {
          await this.options.onProgress?.({
            runId: run.id,
            context: request.context,
            message: turn.message,
          });
        }
        continue;
      }

      if (turn.type === 'final_answer') {
        return this.completeRun(run.id, {
          message: turn.message,
        }, 'completed');
      }

      if (turn.type === 'clarify') {
        return this.completeRun(run.id, {
          message: turn.question,
        }, 'completed');
      }

      if (turn.type === 'confirm_action') {
        const locale = inferRuntimeLocaleFromText(request.text);
        return this.requestConfirmation({
          runId: run.id,
          request,
          toolName: turn.action.tool,
          args: turn.action.args,
          policy: {
            allowed: true,
            requires_confirmation: true,
            risk: this.tools.get(turn.action.tool)?.risk ?? 'high_write',
            reason: turn.action.reason ?? 'Confirmation requested by supervisor model.',
          },
          summary: turn.summary || buildConfirmationSummary(turn.action.tool, turn.action.args, turn.action.reason ?? 'Confirmation requested by supervisor model.', locale),
        });
      }

      const hash = argsHash(turn.args);
      const previous = this.options.toolCalls.findLatestByRunToolArgs(run.id, turn.tool, hash);
      if (previous) {
        const previousResult = [...toolResults].reverse().find((result) => result.tool === turn.tool);
        const message = formatDuplicateToolRecovery(
          previousResult?.message ?? previousResult?.summary ?? null,
          inferRuntimeLocaleFromText(request.text),
        );
        this.options.events.create({
          run_id: run.id,
          event_kind: 'final_answer',
          message,
          payload: {
            duplicate_tool: turn.tool,
            args_hash: hash,
          },
        });
        return this.completeRun(run.id, { message }, 'completed');
      }

      const result = await this.executeTool({
        runId: run.id,
        turn,
        request,
        canWrite: request.canWrite ?? true,
      });
      if (result.response?.actions) {
        return result.response;
      }
      toolResults.push(result);
      if (!result.ok) {
        if (this.options.model && repairAttempts < 1 && step + 1 < this.maxSteps) {
          repairAttempts += 1;
          this.options.events.create({
            run_id: run.id,
            event_kind: 'model_repair_requested',
            message: result.summary,
            payload: {
              failed_tool: result.tool,
            },
          });
          continue;
        }
        return this.completeRun(run.id, {
          message: result.message ?? result.summary,
        }, 'failed');
      }
    }

    return this.completeRun(run.id, {
      message: formatStepLimitRecovery(inferRuntimeLocaleFromText(request.text)),
    }, 'failed');
  }

  private createRun(request: SupervisorRuntimeRespondRequest) {
    const explicitIssueId = extractIssueIdentifiers(request.text)[0] ?? null;
    const previousFocus = !explicitIssueId && (isShowCardRequest(request.text) || isStatusQuestion(request.text))
      ? this.options.runs.findLatestByConversation({
          transport: request.context.transport,
          conversation_id: request.context.recipient.conversation_id,
        })?.active_issue_id ?? null
      : null;
    const issueId = explicitIssueId ?? previousFocus;
    const issue = issueId ? this.options.runtime.getIssue(issueId) : null;
    const route = routeRepoRef({
      preferences: this.options.preferences ?? null,
      projectResolver: this.options.projectResolver ?? null,
      context: request.context,
      issue,
    });
    const run = this.options.runs.create({
      id: crypto.randomUUID(),
      transport: request.context.transport,
      conversation_id: request.context.recipient.conversation_id,
      user_id: request.context.identity.user_id,
      state: 'running',
      repo_ref: route.repoRef,
      active_issue_id: issue?.issue_id ?? issueId,
      user_message: request.text,
    });
    this.options.events.create({
      run_id: run.id,
      event_kind: 'user_message',
      message: request.text,
    });
    return run;
  }

  private async executeTool(params: {
    runId: string;
    turn: Extract<SupervisorTurn, { type: 'tool_call' }>;
    request: SupervisorRuntimeRespondRequest;
    canWrite: boolean;
    skipConfirmation?: boolean;
  }): Promise<SupervisorToolResult> {
    const definition = this.tools.get(params.turn.tool);
    const locale = inferRuntimeLocaleFromText(params.request.text);
    if (!definition) {
      return {
        tool: params.turn.tool,
        ok: false,
        summary: `Unsupported supervisor tool: ${params.turn.tool}`,
        message: formatUnsupportedToolRecovery(locale),
      };
    }

    const validationError = validateToolArgs(definition, params.turn.args);
    if (validationError) {
      this.options.events.create({
        run_id: params.runId,
        event_kind: 'tool_call_rejected',
        message: validationError,
        payload: {
          tool: definition.name,
          args: params.turn.args,
        },
      });
      return {
        tool: definition.name,
        ok: false,
        summary: validationError,
        message: formatToolArgumentRejection(definition.name, validationError, locale),
      };
    }

    const policyContext = this.buildToolContext(params.runId, params.request);
    const policy = this.actionPolicy.evaluate({
      definition,
      args: params.turn.args,
      context: policyContext,
      canWrite: params.canWrite,
      text: params.request.text,
    });
    if (!policy.allowed) {
      return {
        tool: definition.name,
        ok: false,
        summary: policy.reason,
        message: policy.reason,
      };
    }
    if (policy.requires_confirmation && !params.skipConfirmation) {
      return {
        tool: definition.name,
        ok: true,
        summary: policy.reason,
        response: this.requestConfirmation({
          runId: params.runId,
          request: params.request,
          toolName: definition.name,
          args: params.turn.args,
          policy,
          summary: buildConfirmationSummary(definition.name, params.turn.args, policy.reason, inferRuntimeLocaleFromText(params.request.text)),
        }),
      };
    }

    const hash = argsHash(params.turn.args);
    const call = this.options.toolCalls.create({
      run_id: params.runId,
      tool_name: definition.name,
      args_hash: hash,
      args: params.turn.args,
      risk: definition.risk,
      status: 'started',
      idempotency_key: `${params.runId}|${definition.name}|${hash}`,
    });
    this.options.events.create({
      run_id: params.runId,
      event_kind: 'tool_call_started',
      message: definition.name,
      payload: {
        args: params.turn.args,
        reason: params.turn.reason,
      },
    });

    const started = Date.now();
    try {
      const result = await definition.execute(params.turn.args, policyContext);
      this.options.toolCalls.update({
        id: call.id,
        status: result.ok ? 'completed' : 'failed',
        duration_ms: Date.now() - started,
        result_summary: result.summary,
      });
      this.options.events.create({
        run_id: params.runId,
        event_kind: result.ok ? 'tool_call_completed' : 'tool_call_failed',
        message: result.summary,
        payload: result.data ?? null,
      });
      if (result.ok) {
        this.rememberRunIssueFocus(params.runId, result.response?.issue_id ?? result.data?.issue_identifier ?? null);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.toolCalls.update({
        id: call.id,
        status: 'failed',
        duration_ms: Date.now() - started,
        result_summary: message,
      });
      this.options.events.create({
        run_id: params.runId,
        event_kind: 'tool_call_failed',
        message,
      });
      return {
        tool: definition.name,
        ok: false,
        summary: message,
        message: formatToolFailureRecovery(definition.name, locale),
      };
    }
  }

  private requestConfirmation(params: {
    runId: string;
    request: SupervisorRuntimeRespondRequest;
    toolName: string;
    args: Record<string, unknown>;
    policy: SupervisorActionPolicyDecision;
    summary: string;
  }): BotCommandResponse {
    this.options.pendingActions.create({
      run_id: params.runId,
      transport: params.request.context.transport,
      conversation_id: params.request.context.recipient.conversation_id,
      user_id: params.request.context.identity.user_id,
      tool_name: params.toolName,
      tool_args: params.args,
      policy_decision: params.policy as unknown as Record<string, unknown>,
      reason: params.policy.reason,
      summary_message: params.summary,
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
    });
    this.options.events.create({
      run_id: params.runId,
      event_kind: 'confirmation_requested',
      message: params.summary,
      payload: {
        tool_name: params.toolName,
        args: params.args,
        policy: params.policy,
      },
    });
    this.options.runs.update({
      id: params.runId,
      state: 'waiting_confirmation',
      final_message: params.summary,
    });
    return {
      message: params.summary,
      actions: buildConfirmActions(inferRuntimeLocaleFromText(params.request.text)),
    };
  }

  private completeRun(
    runId: string,
    response: BotCommandResponse,
    state: 'completed' | 'failed' | 'cancelled' | 'summarized_early',
  ): BotCommandResponse {
    this.options.events.create({
      run_id: runId,
      event_kind: 'final_answer',
      message: response.message,
    });
    this.options.runs.update({
      id: runId,
      state,
      final_message: response.message,
    });
    return response;
  }

  private buildToolContext(runId: string, request: SupervisorRuntimeRespondRequest): SupervisorToolContext {
    return {
      runId,
      text: request.text,
      context: request.context,
      runtime: this.options.runtime,
      commandService: this.options.commandService,
      preferences: this.options.preferences ?? null,
      projectResolver: this.options.projectResolver ?? null,
      supervisorAgentService: this.options.supervisorAgentService ?? null,
      repoConversations: this.options.repoConversations ?? null,
    };
  }

  private rememberRunIssueFocus(runId: string, issueRef: unknown): void {
    const rawIssueRef = firstString(issueRef);
    if (!rawIssueRef) {
      return;
    }
    const issue = this.options.runtime.getIssue(rawIssueRef);
    this.options.runs.update({
      id: runId,
      active_issue_id: issue?.issue_id ?? rawIssueRef,
    });
  }

  private buildRuntimeCopilotContext(
    request: SupervisorRuntimeRespondRequest,
    run: ReturnType<SupervisorRunRepository['create']>,
  ): BotRuntimeCopilotContext {
    const overview = this.options.runtime.getOverview();
    const activeIssues = overview.issues
      .filter(isUserVisibleActiveIssue)
      .map((issueView) => toBotIssueContextView(issueView));
    const latestRun = this.options.runs.findById(run.id) ?? run;
    const focusedRuntimeIssue = latestRun.active_issue_id
      ? this.options.runtime.getIssue(latestRun.active_issue_id)
      : null;
    const focusedIssue = focusedRuntimeIssue
      ? this.buildFocusedIssueContext(focusedRuntimeIssue)
      : null;
    const routes = this.options.projectResolver?.listConfiguredRoutes() ?? [];
    const preference = this.options.preferences?.findByConversation({
      transport: request.context.transport,
      conversation_id: request.context.recipient.conversation_id,
    }) ?? null;
    const diagnostics: BotAssistantDiagnostics = {
      provider: 'supervisor-runtime',
      model: this.options.model ? 'tool-router' : null,
      configured: Boolean(this.options.model),
      health: this.options.model ? 'healthy' : 'unconfigured',
      fallback_available: true,
      last_error_code: this.options.model ? null : 'unconfigured',
    };

    return {
      default_project_slug: preference?.default_project_slug ?? null,
      available_projects: routes.map((route) => ({
        project_slug: route.project_slug,
        github_repo_full: route.github_repo_full,
      })),
      repo_profile: null,
      repo_understanding: null,
      watch_subscriptions: [],
      overview: {
        running: overview.counts.running,
        retrying: overview.counts.retrying,
        total: overview.counts.total,
        active_issues: activeIssues,
      },
      focus_issue: focusedIssue,
      assistant: diagnostics,
    };
  }

  private buildFocusedIssueContext(issue: RuntimeIssueView): BotRuntimeCopilotContext['focus_issue'] {
    const history = this.options.runtime.getHistoryView(issue.issue_id, 3);
    const timeline = this.options.runtime.getTimeline(issue.issue_id, 4);
    return {
      issue: toBotIssueContextView(issue),
      digest: history
        ? {
            headline: history.digest.headline,
            detail: history.digest.detail,
            history_blurb: history.digest.history_blurb,
            updated_at: history.digest.updated_at,
          }
        : null,
      governance: {
        status: issue.governance_status ?? null,
        decision: issue.governance_decision ?? null,
        summary: issue.governance_summary ?? null,
        root_issue_identifier: issue.governance_root_issue_identifier ?? null,
        thread_state: issue.governance_thread_state ?? null,
        child_issues: (issue.governance_child_issues ?? []).map((child) => ({
          issue_identifier: child.issue_identifier,
          title: child.title,
          tracker_state: child.tracker_state,
          governance_decision: child.governance_decision,
          governance_summary: child.governance_summary,
        })),
        next_recommended_action: issue.next_recommended_action ?? null,
        pause_reason: issue.governance_pause_reason ?? null,
        expected_handoff: issue.governance_expected_handoff ?? null,
        queued_child_identifiers: issue.governance_queued_child_identifiers ?? [],
        suggestions: (issue.active_governance_suggestions ?? []).map((suggestion) => ({
          id: suggestion.id,
          suggestion_type: suggestion.suggestion_type,
          status: suggestion.status,
          title: suggestion.title,
          summary: suggestion.summary,
          can_execute: suggestion.can_execute,
          can_dismiss: suggestion.can_dismiss,
        })),
      },
      recent_timeline: timeline.map((event) => ({
        timestamp: event.timestamp,
        message: event.message,
        code: event.code,
        tool_name: event.tool_name,
        level: event.level,
        category: event.category,
        detail: event.detail,
      })),
    };
  }

  private shouldEmitProgress(lastProgressAt: Date | null): boolean {
    if (!this.options.onProgress) {
      return false;
    }
    if (!lastProgressAt) {
      return true;
    }
    return Date.now() - lastProgressAt.getTime() >= this.progressThrottleMs;
  }

  private finalResponseFromToolResults(results: SupervisorToolResult[], text: string): BotCommandResponse {
    const last = results[results.length - 1] ?? null;
    if (!last) {
      return { message: buildNoActionAssistantReply(text) };
    }
    if (last.response) {
      return last.response;
    }
    return {
      message: last.message ?? last.summary,
    };
  }

  private detectControlTurn(text: string, contextualIssueId: string | null = null): SupervisorTurn | null {
    const issueIds = extractIssueIdentifiers(text);
    const targetIssueId = issueIds[0] ?? contextualIssueId;
    if (isRetryRequest(text) && targetIssueId) {
      return {
        type: 'tool_call',
        tool: 'retry_issue',
        args: { issue_id: targetIssueId },
        reason: 'User explicitly asked to retry an issue.',
      };
    }
    if (isStopRequest(text) && targetIssueId) {
      return {
        type: 'tool_call',
        tool: 'stop_issue',
        args: { issue_id: targetIssueId },
        reason: 'User explicitly asked to stop an issue.',
      };
    }
    if (isCloseRequest(text) && targetIssueId) {
      if (issueIds.length >= 2 && /承接|替代|supersede|duplicate|继续|开发/i.test(text)) {
        return {
          type: 'tool_call',
          tool: 'supersede_issue',
          args: {
            issue_id: issueIds[0],
            successor_issue_id: issueIds[1],
          },
          reason: 'User asked to supersede one issue with another.',
        };
      }
      return {
        type: 'tool_call',
        tool: 'close_issue',
        args: { issue_id: targetIssueId },
        reason: 'User asked to close an issue.',
      };
    }
    return null;
  }

  private resolveContextualIssueId(text: string, run: ReturnType<SupervisorRunRepository['create']>): string | null {
    if (extractIssueIdentifiers(text)[0] || !isContextualIssueReference(text)) {
      return null;
    }

    const focusedIssue = run.active_issue_id ? this.options.runtime.getIssue(run.active_issue_id) : null;
    if (focusedIssue) {
      return focusedIssue.identifier;
    }

    const visibleIssues = this.options.runtime.getOverview().issues.filter(isUserVisibleActiveIssue);
    const candidates = isRetryRequest(text)
      ? visibleIssues.filter((issue) => issue.actions.can_retry)
      : isStopRequest(text)
        ? visibleIssues.filter((issue) => issue.actions.can_stop)
        : isCloseRequest(text)
          ? visibleIssues.filter((issue) => !isTerminalIssue(issue))
          : visibleIssues;

    return candidates.length === 1 ? candidates[0].identifier : null;
  }

  private async planSupervisorAdvisoryTurns(
    text: string,
    run: ReturnType<SupervisorRunRepository['create']>,
    request: SupervisorRuntimeRespondRequest,
  ): Promise<SupervisorTurn[]> {
    if (!isSupervisorAdvisoryQuestion(text)) {
      return [];
    }

    const issueId = extractIssueIdentifiers(text)[0] ?? run.active_issue_id ?? null;
    const issue = issueId ? this.options.runtime.getIssue(issueId) : null;
    const route = routeRepoRef({
      preferences: this.options.preferences,
      projectResolver: this.options.projectResolver,
      context: request.context,
      issue,
    });
    const result = this.options.supervisorAgentService
      ? await this.options.supervisorAgentService.respond({
          localPath: route.localPath,
          repoRef: route.repoRef,
          defaultRepoRef: route.repoRef,
          userText: text,
          projectContext: route.route ? `default_project=${route.route.project_slug}` : null,
          route: route.route,
          runtimeContext: {
            source: 'telegram_chat',
            transport: request.context.transport,
            conversationId: request.context.recipient.conversation_id,
            defaultProjectSlug: route.route?.project_slug ?? null,
            activeIssueId: issue?.identifier ?? null,
          },
        }).catch(() => null)
      : null;

    if (result) {
      return [supervisorAgentResultToTurn(result)];
    }

    return [{
      type: 'tool_call',
      tool: 'read_repo_with_claude',
      args: { question: text },
      reason: 'User asked for a repo-aware issue recommendation.',
    }];
  }

  private findLatestIssueRecommendationDraft(request: SupervisorRuntimeRespondRequest): IssueRecommendationDraft | null {
    const runs = this.options.runs.listByConversation({
      transport: request.context.transport,
      conversation_id: request.context.recipient.conversation_id,
    });
    for (const run of runs) {
      const draft = issueRecommendationDraftFromMessage(run.final_message);
      if (draft) {
        return draft;
      }
    }
    return null;
  }

  private planIssueRecommendationFollowupTurn(
    text: string,
    request: SupervisorRuntimeRespondRequest,
  ): Extract<SupervisorTurn, { type: 'tool_call' }> | null {
    if (!isIssueRecommendationFollowup(text)) {
      return null;
    }
    const draft = this.findLatestIssueRecommendationDraft(request);
    if (!draft) {
      return null;
    }
    return {
      type: 'tool_call',
      tool: 'create_issue',
      args: {
        title: draft.title,
        description: draft.description,
      },
      reason: 'User approved the most recent issue recommendation.',
    };
  }

  private async planDeterministicTurns(
    text: string,
    run: ReturnType<SupervisorRunRepository['create']>,
    request: SupervisorRuntimeRespondRequest,
  ): Promise<SupervisorTurn[]> {
    const issueRecommendationFollowupTurn = this.planIssueRecommendationFollowupTurn(text, request);
    if (issueRecommendationFollowupTurn) {
      return [issueRecommendationFollowupTurn];
    }

    const supervisorAdvisoryTurns = await this.planSupervisorAdvisoryTurns(text, run, request);
    if (supervisorAdvisoryTurns.length > 0) {
      return supervisorAdvisoryTurns;
    }

    if (isCreateIssueRequest(text)) {
      return [{
        type: 'tool_call',
        tool: 'create_issue',
        args: {
          title: compact(text.replace(/^(帮我|请你|请|麻烦|我要|我想)/, ''), 100),
          description: text,
        },
        reason: 'User asked to create a new issue.',
      }];
    }

    const contextualIssueId = this.resolveContextualIssueId(text, run);
    const control = this.detectControlTurn(text, contextualIssueId);
    if (control) {
      return [control];
    }
    const issueId = extractIssueIdentifiers(text)[0] ?? run.active_issue_id ?? null;
    const controlPlaneIntent = classifySupervisorControlPlaneIntent(text);
    if (controlPlaneIntent?.kind === 'issue_list') {
      return [{
        type: 'tool_call',
        tool: 'list_issues',
        args: {
          active_only: controlPlaneIntent.activeOnly,
          state_filter: controlPlaneIntent.stateFilter,
        },
        reason: controlPlaneIntent.activeOnly
          ? 'User asked for the current active issue list.'
          : 'User asked for the current issue list.',
      }];
    }
    if (
      (controlPlaneIntent?.kind === 'external_sync' || controlPlaneIntent?.kind === 'issue_status') &&
      controlPlaneIntent.issueRef
    ) {
      return controlPlaneIntent.kind === 'issue_status'
        ? [
            {
              type: 'tool_call',
              tool: 'get_issue',
              args: { issue_id: controlPlaneIntent.issueRef },
              reason: 'User asked for one issue control-plane status.',
            },
            {
              type: 'tool_call',
              tool: 'diagnose_issue',
              args: { issue_id: controlPlaneIntent.issueRef },
              reason: 'Issue status answers need runtime diagnosis.',
            },
          ]
        : [{
            type: 'tool_call',
            tool: 'get_issue',
            args: { issue_id: controlPlaneIntent.issueRef },
            reason: 'User asked about mapped GitHub/Linear/control-plane surfaces for one issue.',
          }];
    }
    if (controlPlaneIntent) {
      return [{
        type: 'tool_call',
        tool: 'summarize_control_plane',
        args: { intent_kind: controlPlaneIntent.kind },
        reason: 'User asked for supervisor control-plane state.',
      }];
    }
    if (isShowCardRequest(text) && issueId) {
      return [{
        type: 'tool_call',
        tool: 'show_issue_card',
        args: { issue_id: issueId },
        reason: 'User asked to see the issue card.',
      }];
    }
    if (issueId && isStatusQuestion(text)) {
      return [
        {
          type: 'tool_call',
          tool: 'get_issue',
          args: { issue_id: issueId },
          reason: 'User asked for issue status.',
        },
        {
          type: 'tool_call',
          tool: 'diagnose_issue',
          args: { issue_id: issueId },
          reason: 'Issue status answers need runtime diagnosis.',
        },
      ];
    }
    if (isSetProjectRequest(text)) {
      const projectSlug = extractProjectSlug(text);
      return [{
        type: 'tool_call',
        tool: 'set_default_project',
        args: projectSlug ? { project_slug: projectSlug } : {},
        reason: 'User asked to set the default project for this conversation.',
      }];
    }
    if (shouldUseReadOnlyClaudeForText(text) || /readme|仓库|代码|文件|repo|repository/i.test(text)) {
      return [{
        type: 'tool_call',
        tool: 'read_repo_with_claude',
        args: { question: text },
        reason: 'User asked for repository understanding.',
      }];
    }
    return [];
  }
}

function createSupervisorToolDefinitions(): SupervisorToolDefinition[] {
  const commandTool = (
    name: string,
    command: Parameters<BotCommandService['execute']>[1]['command'],
    risk: SupervisorToolDefinition['risk'],
  ): SupervisorToolDefinition => {
    const required = command === 'project'
      ? ['project_slug']
      : command === 'new'
        ? ['title']
        : ['issue_id'];
    return {
      name,
      description: `Execute ${command} through the runtime control plane.`,
      input_schema: {
        type: 'object',
        required,
        properties: {
          issue_id: { type: 'string' },
          successor_issue_id: { type: 'string' },
          project_slug: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      risk,
      direct_execution_policy: risk === 'read' ? 'always' : risk === 'low_write' ? 'high_confidence' : 'confirm_by_default',
      execute: async (args, context) => {
        const record = args as Record<string, unknown>;
        const response = await context.commandService.execute(context.context, {
          command,
          issue_id: firstString(record.issue_id),
          successor_issue_id: firstString(record.successor_issue_id),
          project_slug: firstString(record.project_slug),
          create_issue: command === 'new'
            ? {
                title: firstString(record.title) ?? 'Untitled issue',
                description: firstString(record.description),
                project_slug: firstString(record.project_slug),
              }
            : null,
          reason: firstString(record.reason),
        });
        return {
          tool: name,
          ok: true,
          summary: response.message,
          message: response.message,
          response,
        };
      },
    };
  };

  return [
    {
      name: 'list_issues',
      description: 'List current runtime issues as a concise summary. Set active_only=true for active/running issue questions.',
      input_schema: {
        type: 'object',
        properties: {
          active_only: { type: 'boolean' },
          state_filter: { type: 'string' },
        },
      },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (args, context) => {
        const issues = context.runtime.getOverview().issues;
        const record = args as Record<string, unknown>;
        const activeOnly = record.active_only === true;
        const stateFilter = typeof record.state_filter === 'string'
          ? record.state_filter as IssueStateFilter
          : activeOnly
            ? 'active'
            : null;
        const visibleIssues = issues.filter((issue) => issueMatchesStateFilter(issue, stateFilter));
        const message = summarizeIssues(issues, { activeOnly, stateFilter });
        return {
          tool: 'list_issues',
          ok: true,
          summary: message,
          message,
          data: { issue_count: visibleIssues.length, active_only: activeOnly, state_filter: stateFilter },
        };
      },
    },
    {
      name: 'get_issue',
      description: 'Fetch one runtime issue by identifier or id.',
      input_schema: {
        type: 'object',
        required: ['issue_id'],
        properties: { issue_id: { type: 'string' } },
      },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (args, context) => {
        const issueId = normalizeIssueRef((args as Record<string, unknown>).issue_id);
        const issue = issueId ? context.runtime.getIssue(issueId) : null;
        if (!issue) {
          return {
            tool: 'get_issue',
            ok: false,
            summary: `Issue ${issueId ?? ''} was not found.`,
          };
        }
        const message = formatIssueLine(issue);
        return {
          tool: 'get_issue',
          ok: true,
          summary: message,
          message,
          data: { issue_identifier: issue.identifier },
        };
      },
    },
    {
      name: 'diagnose_issue',
      description: 'Summarize runtime history and likely next action for one issue.',
      input_schema: {
        type: 'object',
        required: ['issue_id'],
        properties: { issue_id: { type: 'string' } },
      },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (args, context) => {
        const issueId = normalizeIssueRef((args as Record<string, unknown>).issue_id);
        const issue = issueId ? context.runtime.getIssue(issueId) : null;
        if (!issue) {
          return {
            tool: 'diagnose_issue',
            ok: false,
            summary: `Issue ${issueId ?? ''} was not found.`,
          };
        }
        const history = context.runtime.getHistoryView(issue.issue_id, 3);
        const timeline = context.runtime.getTimeline(issue.issue_id, 4);
        const message = [
          `${issue.identifier} · ${issue.title}`,
          `State: ${issue.phase} · ${issue.tracker_state} · ${issue.orchestrator_state ?? 'unknown'}`,
          history?.digest.detail ? `Evidence: ${history.digest.detail}` : null,
          timeline[0] ? `Latest event: ${timeline[timeline.length - 1]?.message ?? timeline[0].message}` : null,
          issue.actions.can_retry ? 'Recommended next step: retry is available.' : null,
          issue.actions.can_stop ? 'Recommended next step: stop is available if this run is wrong.' : null,
        ].filter(Boolean).join('\n');
        return {
          tool: 'diagnose_issue',
          ok: true,
          summary: message,
          message,
          data: { issue_identifier: issue.identifier },
        };
      },
    },
    {
      name: 'get_issue_history',
      description: 'Fetch the compact issue history replay.',
      input_schema: {
        type: 'object',
        required: ['issue_id'],
        properties: { issue_id: { type: 'string' } },
      },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (args, context) => {
        const issueId = normalizeIssueRef((args as Record<string, unknown>).issue_id);
        const history = issueId ? context.runtime.getHistoryView(issueId, 5) : null;
        const message = history
          ? [history.digest.headline, history.digest.detail, ...(history.entries ?? []).map((entry) => `- ${entry.title}: ${entry.summary}`)].join('\n')
          : `Issue ${issueId ?? ''} history was not found.`;
        return {
          tool: 'get_issue_history',
          ok: Boolean(history),
          summary: message,
          message,
        };
      },
    },
    {
      name: 'show_issue_card',
      description: 'Render the focused issue as a Telegram-friendly card summary.',
      input_schema: {
        type: 'object',
        required: ['issue_id'],
        properties: { issue_id: { type: 'string' } },
      },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (args, context) => {
        const issueId = normalizeIssueRef((args as Record<string, unknown>).issue_id);
        const issue = issueId ? context.runtime.getIssue(issueId) : null;
        if (!issue) {
          return {
            tool: 'show_issue_card',
            ok: false,
            summary: `Issue ${issueId ?? ''} was not found.`,
          };
        }
        const message = [
          `Issue Card · ${issue.identifier}`,
          issue.title,
          `${issue.phase} · ${issue.tracker_state} · ${issue.orchestrator_state ?? 'unknown'}`,
          issue.github_repo ? `Repo: ${issue.github_repo}` : null,
        ].filter(Boolean).join('\n');
        const visual = buildSupervisorIssueVisualCard(issue);
        return {
          tool: 'show_issue_card',
          ok: true,
          summary: message,
          response: {
            message,
            caption: visual.caption,
            format: 'telegram_html',
            media_key: visual.media_key,
            photo: visual.photo,
            show_caption_above_media: false,
            action_rows: buildIssueCardActionRows(issue),
            issue_id: issue.issue_id,
          },
        };
      },
    },
    {
      name: 'show_plan_card',
      description: 'Show the active supervisor plan card when one exists.',
      input_schema: { type: 'object', properties: {} },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async () => ({
        tool: 'show_plan_card',
        ok: true,
        summary: 'No active plan card is currently attached to this runtime run.',
        message: '当前没有可展示的 supervisor plan card。',
      }),
    },
    {
      name: 'summarize_control_plane',
      description: 'Summarize supervisor runtime/control-plane state including issues, routes, mapped GitHub/Linear surfaces, and active work.',
      input_schema: {
        type: 'object',
        properties: {
          intent_kind: { type: 'string' },
        },
      },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (_args, context) => {
        const message = summarizeControlPlane(context);
        return {
          tool: 'summarize_control_plane',
          ok: true,
          summary: message,
          message,
        };
      },
    },
    {
      name: 'summarize_issue_list',
      description: 'Summarize the current issue list without card flooding. Set active_only=true for active/running issue questions.',
      input_schema: {
        type: 'object',
        properties: {
          active_only: { type: 'boolean' },
          state_filter: { type: 'string' },
        },
      },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (args, context) => {
        const record = args as Record<string, unknown>;
        const activeOnly = record.active_only === true;
        const stateFilter = typeof record.state_filter === 'string'
          ? record.state_filter as IssueStateFilter
          : activeOnly
            ? 'active'
            : null;
        const message = summarizeIssues(context.runtime.getOverview().issues, { activeOnly, stateFilter });
        return {
          tool: 'summarize_issue_list',
          ok: true,
          summary: message,
          message,
        };
      },
    },
    {
      name: 'read_repo_with_claude',
      description: 'Ask read-only Claude Code for repository understanding through the shared source cache.',
      input_schema: {
        type: 'object',
        required: ['question'],
        properties: { question: { type: 'string' } },
      },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (args, context) => {
        const issueId = extractIssueIdentifiers(context.text)[0] ?? null;
        const issue = issueId ? context.runtime.getIssue(issueId) : null;
        const route = routeRepoRef({
          preferences: context.preferences,
          projectResolver: context.projectResolver,
          context: context.context,
          issue,
        });
        if (!route.repoRef) {
          return {
            tool: 'read_repo_with_claude',
            ok: false,
            summary: 'No repository route is configured for this conversation.',
            message: '这个聊天还没有默认项目或仓库路由。请先设置 /project <slug>。',
          };
        }
        const question = firstString((args as Record<string, unknown>).question) ?? context.text;
        const result = await context.supervisorAgentService?.respond({
          localPath: route.localPath,
          repoRef: route.repoRef,
          defaultRepoRef: route.repoRef,
          userText: question,
          forceReadOnlyClaude: true,
          projectContext: route.route ? `default_project=${route.route.project_slug}` : null,
          route: route.route,
          runtimeContext: {
            source: 'telegram_chat',
            transport: context.context.transport,
            conversationId: context.context.recipient.conversation_id,
            defaultProjectSlug: route.route?.project_slug ?? null,
            activeIssueId: issue?.identifier ?? null,
          },
        });
        context.repoConversations?.upsert({
          transport: context.context.transport,
          conversation_id: context.context.recipient.conversation_id,
          repo_ref: route.repoRef,
          backend_session_id: null,
          status: result ? 'active' : 'failed',
        });
        if (!result) {
          return {
            tool: 'read_repo_with_claude',
            ok: false,
            summary: 'Read-only Claude Code did not return an answer.',
            message: '仓库只读分析暂时没有返回结果。',
          };
        }
        const message = formatSupervisorAgentResult(result);
        return {
          tool: 'read_repo_with_claude',
          ok: true,
          summary: compact(message),
          message,
          data: { repo_ref: route.repoRef },
        };
      },
    },
    {
      name: 'clear_repo_conversation',
      description: 'Clear read-only Claude Code memory for this conversation and repository.',
      input_schema: {
        type: 'object',
        properties: { repo_ref: { type: 'string' } },
      },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (args, context) => {
        const repoRef = firstString((args as Record<string, unknown>).repo_ref);
        const cleared = repoRef && context.repoConversations
          ? context.repoConversations.clearByConversationRepo({
              transport: context.context.transport,
              conversation_id: context.context.recipient.conversation_id,
              repo_ref: repoRef,
            })
          : context.repoConversations?.clearByConversation({
              transport: context.context.transport,
              conversation_id: context.context.recipient.conversation_id,
            }) ?? 0;
        return {
          tool: 'clear_repo_conversation',
          ok: true,
          summary: `Cleared ${cleared} repo Claude conversations.`,
          message: cleared > 0 ? `已清空 ${cleared} 个仓库 Claude 会话。` : '当前没有可清空的仓库 Claude 会话。',
        };
      },
    },
    commandTool('retry_issue', 'retry', 'low_write'),
    commandTool('stop_issue', 'stop', 'low_write'),
    commandTool('set_default_project', 'project', 'low_write'),
    commandTool('create_issue', 'new', 'high_write'),
    commandTool('close_issue', 'close_issue', 'high_write'),
    commandTool('supersede_issue', 'supersede_issue', 'high_write'),
    commandTool('override_governance', 'override', 'high_write'),
    commandTool('rewrite_governance', 'rewrite', 'high_write'),
    commandTool('split_governance', 'split', 'high_write'),
  ];
}
