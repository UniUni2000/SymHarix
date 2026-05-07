import type {
  RepoClaudeConversationRepository,
  SupervisorPendingActionRepository,
  SupervisorRunEventRepository,
  SupervisorRunRepository,
  SupervisorToolCallRepository,
  BotConversationPreferenceRepository,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import type { TrackerProjectResolutionService } from '../tracker/projectResolution';
import type { BotCommandContext, BotCommandResponse, BotTransportAction } from '../bots/types';
import { BotCommandService } from '../bots/commandService';
import {
  shouldUseReadOnlyClaudeForText,
  type SupervisorAgentService,
} from './supervisorAgent';

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
}) => Promise<SupervisorTurn | string | null | undefined>;

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
  maxSteps?: number;
}

export interface SupervisorRuntimeRespondRequest {
  context: BotCommandContext;
  text: string;
  canWrite?: boolean;
}

const CONFIRM_WORDS = new Set(['确认', 'yes', 'y', 'ok', 'okay', '好', '执行', '继续', 'confirm']);
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

  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/gi)) {
    add(match[1]);
  }
  if (/(?:issue|单|任务|int|怎么样|状态|进度|卡片|关闭|关掉|关了|关上|关停|取消|作废|废弃|不要了|不用了|不需要|重试|重新执行|继续执行|status|progress|card|retry|rerun|stop|close)/i.test(text)) {
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

function isIssueListQuestion(text: string): boolean {
  return /有哪些\s*issue|什么\s*issue|issue\s*列表|list\s+issues?|what issues/i.test(text);
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
  return /关闭|关掉|关了|关上|作废|废弃|不要了|不用了|close|supersede|duplicate/i.test(text);
}

function isCreateIssueRequest(text: string): boolean {
  return /创建.*issue|新建.*issue|提.*issue|建.*issue|create.*issue|open.*issue/i.test(text);
}

function isSetProjectRequest(text: string): boolean {
  return /(?:set|switch|切换|设置|默认).{0,16}(?:project|项目)|(?:project|项目).{0,16}(?:to|为|成|设为|设置|切换|默认)/i.test(text);
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
  return isIssueListQuestion(text) ||
    isStatusQuestion(text) ||
    isShowCardRequest(text) ||
    shouldUseReadOnlyClaudeForText(text) ||
    /readme|仓库|代码|文件|repo|repository/i.test(text);
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatIssueLine(issue: RuntimeIssueView): string {
  const bits = [
    issue.identifier,
    issue.phase,
    issue.tracker_state,
    issue.orchestrator_state ?? 'unknown',
  ];
  return `${bits.join(' · ')} · ${compact(issue.title, 80)}`;
}

function summarizeIssues(issues: RuntimeIssueView[]): string {
  if (issues.length === 0) {
    return '当前没有 tracked issues。';
  }
  return [
    `当前有 ${issues.length} 个 tracked issues：`,
    ...issues.slice(0, 8).map((issue) => `- ${formatIssueLine(issue)}`),
  ].join('\n');
}

function buildConfirmActions(): BotTransportAction[] {
  return [
    {
      label: '确认',
      style: 'danger',
      callback_data: 'pending|confirm',
    },
    {
      label: '取消',
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

function buildConfirmationSummary(toolName: string, args: Record<string, unknown>, reason: string): string {
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
    'Reply with: 确认 / 取消',
  ].filter(Boolean).join('\n');
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

  constructor(private readonly options: SupervisorAgentRuntimeServiceOptions) {
    this.actionPolicy = options.actionPolicy ?? new SupervisorActionPolicy();
    this.tools = new Map(createSupervisorToolDefinitions().map((tool) => [tool.name, tool]));
    this.maxSteps = options.maxSteps ?? 16;
  }

  recoverStartupState(): number {
    const staleRuns = this.options.runs.listActive().filter((run) => run.state === 'running');
    const recovered = this.options.runs.recoverStaleRunning();
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
        this.options.pendingActions.update({
          id: existingPending.id,
          status: 'cancelled',
        });
        this.options.events.create({
          run_id: existingPending.run_id,
          event_kind: 'confirmation_cancelled',
          message: 'User cancelled the pending action.',
        });
        this.options.runs.update({
          id: existingPending.run_id,
          state: 'cancelled',
          final_message: 'Cancelled the pending action.',
        });
        return {
          message: 'Cancelled the pending action.',
        };
      }
      if (!isReadOnlyText(request.text) && this.detectControlTurn(request.text)) {
        this.options.pendingActions.update({
          id: existingPending.id,
          status: 'cancelled',
        });
      } else if (!isReadOnlyText(request.text)) {
        return {
          message: `${existingPending.summary_message}\nReply with 确认 / 取消.`,
          actions: buildConfirmActions(),
        };
      }
    }

    return this.executeRun(request);
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
    const deterministicTurns = this.options.model ? null : this.planDeterministicTurns(request.text, run);
    let deterministicIndex = 0;

    for (let step = 0; step < this.maxSteps; step += 1) {
      this.options.runs.update({
        id: run.id,
        step_count: step + 1,
      });

      const rawTurn = deterministicTurns
        ? deterministicTurns[deterministicIndex++]
        : await this.options.model?.({
            runId: run.id,
            text: request.text,
            availableTools: [...this.tools.values()],
            toolResults,
          });
      const turn = parseStructuredTurn(rawTurn);

      if (!turn) {
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
        this.options.events.create({
          run_id: run.id,
          event_kind: 'progress_message',
          message: turn.message,
        });
        this.options.runs.update({
          id: run.id,
          last_progress_at: new Date(),
        });
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
          summary: turn.summary,
        });
      }

      const hash = argsHash(turn.args);
      const previous = this.options.toolCalls.findLatestByRunToolArgs(run.id, turn.tool, hash);
      if (previous) {
        const message = `I already checked ${turn.tool} with the same inputs, so I am stopping the loop and summarizing what I found.`;
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
        return this.completeRun(run.id, {
          message: result.message ?? result.summary,
        }, 'failed');
      }
    }

    return this.completeRun(run.id, {
      message: 'I reached the supervisor runtime step limit and stopped cleanly. Please ask for the conclusion or narrow the request.',
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
    if (!definition) {
      return {
        tool: params.turn.tool,
        ok: false,
        summary: `Unsupported supervisor tool: ${params.turn.tool}`,
        message: `Unsupported supervisor tool: ${params.turn.tool}`,
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
          summary: buildConfirmationSummary(definition.name, params.turn.args, policy.reason),
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
        message,
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
      actions: buildConfirmActions(),
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

  private finalResponseFromToolResults(results: SupervisorToolResult[], text: string): BotCommandResponse {
    const last = results[results.length - 1] ?? null;
    if (!last) {
      const greeting = /^(你好|您好|hello|hi|hey|在吗|在么)/i.test(text.trim())
        ? '你好，我在。你可以直接问我 issue 状态、仓库内容，或者让我起草下一步计划。'
        : '我还不能确定要做什么。你可以直接问 issue 状态、仓库内容，或明确一个控制动作。';
      return { message: greeting };
    }
    if (last.response) {
      return last.response;
    }
    return {
      message: last.message ?? last.summary,
    };
  }

  private detectControlTurn(text: string): SupervisorTurn | null {
    const issueIds = extractIssueIdentifiers(text);
    if (isRetryRequest(text) && issueIds[0]) {
      return {
        type: 'tool_call',
        tool: 'retry_issue',
        args: { issue_id: issueIds[0] },
        reason: 'User explicitly asked to retry an issue.',
      };
    }
    if (isStopRequest(text) && issueIds[0]) {
      return {
        type: 'tool_call',
        tool: 'stop_issue',
        args: { issue_id: issueIds[0] },
        reason: 'User explicitly asked to stop an issue.',
      };
    }
    if (isCloseRequest(text) && issueIds[0]) {
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
        args: { issue_id: issueIds[0] },
        reason: 'User asked to close an issue.',
      };
    }
    return null;
  }

  private planDeterministicTurns(text: string, run: ReturnType<SupervisorRunRepository['create']>): SupervisorTurn[] {
    const control = this.detectControlTurn(text);
    if (control) {
      return [control];
    }
    const issueId = extractIssueIdentifiers(text)[0] ?? run.active_issue_id ?? null;
    if (isIssueListQuestion(text)) {
      return [{
        type: 'tool_call',
        tool: 'list_issues',
        args: {},
        reason: 'User asked for the current issue list.',
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
  ): SupervisorToolDefinition => ({
    name,
    description: `Execute ${command} through the runtime control plane.`,
    input_schema: {
      type: 'object',
      properties: {
        issue_id: { type: 'string' },
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
  });

  return [
    {
      name: 'list_issues',
      description: 'List current runtime issues as a concise summary.',
      input_schema: { type: 'object', properties: {} },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (_args, context) => {
        const issues = context.runtime.getOverview().issues;
        const message = summarizeIssues(issues);
        return {
          tool: 'list_issues',
          ok: true,
          summary: message,
          message,
          data: { issue_count: issues.length },
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
        return {
          tool: 'show_issue_card',
          ok: true,
          summary: message,
          response: {
            message,
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
      name: 'summarize_issue_list',
      description: 'Summarize the current issue list without card flooding.',
      input_schema: { type: 'object', properties: {} },
      risk: 'read',
      direct_execution_policy: 'always',
      execute: async (_args, context) => {
        const message = summarizeIssues(context.runtime.getOverview().issues);
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
        const message =
          result.mode === 'repo_answer'
            ? result.answer
            : result.mode === 'chat_reply'
              ? result.message
              : result.mode === 'clarify'
                ? result.question
                : '仓库分析已完成，但需要进一步确认下一步。';
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
