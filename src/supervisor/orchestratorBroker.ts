import { randomUUID } from 'crypto';
import type {
  BotConversationPreferenceRepository,
  RepoClaudeConversationRepository,
  SupervisorPendingActionRepository,
  SupervisorRunEventRepository,
  SupervisorRunRepository,
  SupervisorToolCallRepository,
} from '../database';
import type { BotCommandService } from '../bots/commandService';
import type { BotCommandContext, BotCommandResponse } from '../bots/types';
import { inferRuntimeLocaleFromText } from '../i18n/locale';
import type { RuntimeControlPlane } from '../runtime/types';
import type { TrackerProjectResolutionService } from '../tracker/projectResolution';
import {
  SupervisorActionPolicy,
  argsHash,
  buildConfirmActions,
  buildConfirmationSummary,
  createSupervisorToolDefinitions,
  validateToolArgs,
  type SupervisorActionPolicyDecision,
  type SupervisorToolContext,
  type SupervisorToolDefinition,
  type SupervisorToolResult,
} from './agentRuntime';
import type { SupervisorAgentService } from './supervisorAgent';

export const SUPERVISOR_ORCHESTRATOR_TOOL_NAMES = [
  'list_orchestrator_capabilities',
  'get_pending_action',
  'list_issues',
  'diagnose_issue',
  'show_issue_card',
  'show_plan_card',
  'watch_issue',
  'unwatch_issue',
  'retry_issue',
  'stop_issue',
  'switch_repository',
  'set_default_project',
  'create_issue',
  'close_issue',
  'supersede_issue',
  'override_governance',
  'rewrite_governance',
  'split_governance',
  'execute_governance_suggestion',
  'dismiss_governance_suggestion',
] as const;

export type SupervisorOrchestratorToolName = typeof SUPERVISOR_ORCHESTRATOR_TOOL_NAMES[number];

export interface SupervisorOrchestratorBrokerOptions {
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
  supervisorAgentService?: SupervisorAgentService | null;
}

export interface SupervisorOrchestratorTurnKey {
  context: BotCommandContext;
  repoRef?: string | null;
}

export interface SupervisorOrchestratorTurnState extends SupervisorOrchestratorTurnKey {
  text: string;
  canWrite: boolean;
  activeIssueId?: string | null;
  runId?: string | null;
  capturedResponse?: BotCommandResponse | null;
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function compact(value: string | null | undefined, maxLength = 320): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function turnKey(input: SupervisorOrchestratorTurnKey): string {
  return [
    input.context.transport,
    input.context.recipient.conversation_id,
    input.repoRef ?? 'no-repo',
  ].join(':');
}

function issueReferenceFromText(text: string | null | undefined): string | null {
  const match = text?.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function toolToCapability(definition: SupervisorToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    risk: definition.risk,
    direct_execution_policy: definition.direct_execution_policy,
    input_schema: definition.input_schema,
  };
}

export class SupervisorOrchestratorBroker {
  private readonly actionPolicy: SupervisorActionPolicy;
  private readonly tools: Map<string, SupervisorToolDefinition>;
  private readonly turns = new Map<string, SupervisorOrchestratorTurnState>();

  constructor(private readonly options: SupervisorOrchestratorBrokerOptions) {
    this.actionPolicy = options.actionPolicy ?? new SupervisorActionPolicy();
    this.tools = new Map(createSupervisorToolDefinitions()
      .filter((tool) => (SUPERVISOR_ORCHESTRATOR_TOOL_NAMES as readonly string[]).includes(tool.name))
      .map((tool) => [tool.name, tool]));
  }

  beginTurn(input: SupervisorOrchestratorTurnState): void {
    this.turns.set(turnKey(input), {
      ...input,
      repoRef: input.repoRef ?? null,
      activeIssueId: input.activeIssueId ?? issueReferenceFromText(input.text),
      runId: input.runId ?? null,
      capturedResponse: null,
    });
  }

  consumeTurnResponse(input: SupervisorOrchestratorTurnKey): BotCommandResponse | null {
    const found = this.findTurn(input);
    const key = found?.key ?? turnKey(input);
    const turn = found?.turn ?? null;
    if (turn) {
      this.turns.delete(key);
    }
    return turn?.capturedResponse ?? null;
  }

  async callTool(
    name: SupervisorOrchestratorToolName,
    args: Record<string, unknown>,
    request: { context: BotCommandContext; text?: string; repoRef?: string | null; canWrite?: boolean },
  ): Promise<SupervisorToolResult> {
    if (name === 'list_orchestrator_capabilities') {
      const capabilities = this.listCapabilities();
      return {
        tool: name,
        ok: true,
        summary: `Supervisor orchestrator exposes ${capabilities.length} business tools.`,
        data: { capabilities },
      };
    }
    if (name === 'get_pending_action') {
      return this.getPendingAction(request.context);
    }

    const definition = this.tools.get(name);
    if (!definition) {
      return {
        tool: name,
        ok: false,
        summary: `Unknown supervisor orchestrator tool: ${name}`,
      };
    }

    const turn = this.getOrCreateTurn(request);
    const normalizedArgs = this.withFocusedIssueArg(definition, args, turn);
    const validationError = validateToolArgs(definition, normalizedArgs);
    if (validationError) {
      return {
        tool: name,
        ok: false,
        summary: validationError,
      };
    }

    const runId = this.ensureRun(turn, normalizedArgs);
    const toolContext: SupervisorToolContext = {
      runId,
      text: turn.text,
      context: request.context,
      runtime: this.options.runtime,
      commandService: this.options.commandService,
      preferences: this.options.preferences ?? null,
      projectResolver: this.options.projectResolver ?? null,
      supervisorAgentService: this.options.supervisorAgentService ?? null,
      repoConversations: this.options.repoConversations ?? null,
    };
    const decision = this.actionPolicy.evaluate({
      definition,
      args: normalizedArgs,
      context: toolContext,
      canWrite: turn.canWrite,
      text: turn.text,
    });
    if (!decision.allowed) {
      const message = decision.reason;
      this.completeRun(runId, false, message);
      return {
        tool: name,
        ok: false,
        summary: message,
        message,
      };
    }
    if (decision.requires_confirmation) {
      const result = this.requestConfirmation({
        runId,
        definition,
        args: normalizedArgs,
        decision,
        turn,
      });
      this.capture(turn, result.response);
      return result;
    }

    const result = await this.executeTool({
      runId,
      definition,
      args: normalizedArgs,
      context: toolContext,
    });
    if (result.response) {
      this.capture(turn, result.response);
    }
    if (result.ok && result.response?.issue_id) {
      this.options.runs.update({
        id: runId,
        active_issue_id: result.response.issue_id,
      });
      turn.activeIssueId = result.response.issue_id;
    }
    this.completeRun(runId, result.ok, result.message ?? result.summary);
    return result;
  }

  private listCapabilities(): Array<Record<string, unknown>> {
    const definitions = [...this.tools.values()].map(toolToCapability);
    return [
      {
        name: 'list_orchestrator_capabilities',
        description: 'List all business/control tools, their risk levels, and when confirmation is required.',
        risk: 'read',
        direct_execution_policy: 'always',
      },
      {
        name: 'get_pending_action',
        description: 'Read the open confirmation pending for this conversation, if any.',
        risk: 'read',
        direct_execution_policy: 'always',
      },
      ...definitions,
    ];
  }

  private getPendingAction(context: BotCommandContext): SupervisorToolResult {
    const pending = this.options.pendingActions.findOpenByConversation({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    });
    if (!pending) {
      return {
        tool: 'get_pending_action',
        ok: true,
        summary: 'No open pending action for this conversation.',
        data: { pending_action: null },
      };
    }
    return {
      tool: 'get_pending_action',
      ok: true,
      summary: pending.summary_message,
      data: {
        pending_action: {
          id: pending.id,
          tool_name: pending.tool_name,
          tool_args: pending.tool_args,
          reason: pending.reason,
          summary_message: pending.summary_message,
          expires_at: pending.expires_at.toISOString(),
          status: pending.status,
        },
      },
    };
  }

  private getOrCreateTurn(request: {
    context: BotCommandContext;
    text?: string;
    repoRef?: string | null;
    canWrite?: boolean;
  }): SupervisorOrchestratorTurnState {
    const explicitKey = turnKey({
      context: request.context,
      repoRef: request.repoRef ?? null,
    });
    let key = explicitKey;
    let turn = this.findTurn({
      context: request.context,
      repoRef: request.repoRef ?? null,
    })?.turn ?? null;
    if (!turn) {
      turn = {
        context: request.context,
        repoRef: request.repoRef ?? null,
        text: request.text ?? '',
        canWrite: request.canWrite ?? true,
        activeIssueId: issueReferenceFromText(request.text) ?? null,
        runId: null,
        capturedResponse: null,
      };
      key = explicitKey;
      this.turns.set(key, turn);
    }
    return turn;
  }

  private findTurn(input: SupervisorOrchestratorTurnKey): { key: string; turn: SupervisorOrchestratorTurnState } | null {
    const exactKey = turnKey(input);
    const exactTurn = this.turns.get(exactKey);
    if (exactTurn) {
      return { key: exactKey, turn: exactTurn };
    }
    if (input.repoRef) {
      return null;
    }
    const prefix = `${input.context.transport}:${input.context.recipient.conversation_id}:`;
    for (const [candidateKey, candidateTurn] of this.turns) {
      if (candidateKey.startsWith(prefix)) {
        return { key: candidateKey, turn: candidateTurn };
      }
    }
    return null;
  }

  private withFocusedIssueArg(
    definition: SupervisorToolDefinition,
    args: Record<string, unknown>,
    turn: SupervisorOrchestratorTurnState,
  ): Record<string, unknown> {
    const normalized = { ...args };
    const schema = definition.input_schema;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    if (!required.includes('issue_id') || firstString(normalized.issue_id)) {
      return normalized;
    }
    const latestRun = this.options.runs.findLatestByConversation({
      transport: turn.context.transport,
      conversation_id: turn.context.recipient.conversation_id,
    });
    const focusedIssue = turn.activeIssueId
      ?? latestRun?.active_issue_id
      ?? issueReferenceFromText(turn.text);
    if (focusedIssue) {
      normalized.issue_id = focusedIssue;
    }
    return normalized;
  }

  private ensureRun(turn: SupervisorOrchestratorTurnState, args: Record<string, unknown>): string {
    if (turn.runId && this.options.runs.findById(turn.runId)) {
      return turn.runId;
    }
    const issueRef = turn.activeIssueId ?? firstString(args.issue_id) ?? null;
    const issue = issueRef ? this.options.runtime.getIssue(issueRef) : null;
    const run = this.options.runs.create({
      id: randomUUID(),
      transport: turn.context.transport,
      conversation_id: turn.context.recipient.conversation_id,
      user_id: turn.context.identity.user_id,
      state: 'running',
      repo_ref: turn.repoRef ?? issue?.github_repo ?? null,
      active_issue_id: issue?.issue_id ?? issueRef,
      user_message: turn.text,
    });
    turn.runId = run.id;
    this.options.events.create({
      run_id: run.id,
      event_kind: 'user_message',
      message: turn.text || null,
    });
    return run.id;
  }

  private requestConfirmation(input: {
    runId: string;
    definition: SupervisorToolDefinition;
    args: Record<string, unknown>;
    decision: SupervisorActionPolicyDecision;
    turn: SupervisorOrchestratorTurnState;
  }): SupervisorToolResult {
    const locale = inferRuntimeLocaleFromText(input.turn.text);
    const summary = buildConfirmationSummary(
      input.definition.name,
      input.args,
      input.decision.reason,
      locale,
    );
    const pending = this.options.pendingActions.create({
      run_id: input.runId,
      transport: input.turn.context.transport,
      conversation_id: input.turn.context.recipient.conversation_id,
      user_id: input.turn.context.identity.user_id,
      tool_name: input.definition.name,
      tool_args: input.args,
      policy_decision: {
        allowed: input.decision.allowed,
        requires_confirmation: input.decision.requires_confirmation,
        risk: input.decision.risk,
        reason: input.decision.reason,
      },
      reason: input.decision.reason,
      summary_message: summary,
      expires_at: new Date(Date.now() + 15 * 60_000),
    });
    this.options.runs.update({
      id: input.runId,
      state: 'waiting_confirmation',
      final_message: summary,
    });
    this.options.events.create({
      run_id: input.runId,
      event_kind: 'confirmation_requested',
      message: summary,
      payload: {
        pending_action_id: pending.id,
        tool_name: input.definition.name,
      },
    });
    const response: BotCommandResponse = {
      message: summary,
      actions: buildConfirmActions(locale),
    };
    return {
      tool: input.definition.name,
      ok: true,
      summary,
      message: summary,
      response,
      data: {
        pending_action_id: pending.id,
      },
    };
  }

  private async executeTool(input: {
    runId: string;
    definition: SupervisorToolDefinition;
    args: Record<string, unknown>;
    context: SupervisorToolContext;
  }): Promise<SupervisorToolResult> {
    const startedAt = Date.now();
    const toolCall = this.options.toolCalls.create({
      run_id: input.runId,
      tool_name: input.definition.name,
      args_hash: argsHash(input.args),
      args: input.args,
      risk: input.definition.risk,
      status: 'started',
    });
    this.options.events.create({
      run_id: input.runId,
      event_kind: 'tool_call_started',
      message: input.definition.name,
      payload: { args: input.args },
    });

    try {
      const result = await input.definition.execute(input.args, input.context);
      const durationMs = Date.now() - startedAt;
      this.options.toolCalls.update({
        id: toolCall.id,
        status: result.ok ? 'completed' : 'failed',
        duration_ms: durationMs,
        result_summary: compact(result.summary),
      });
      this.options.events.create({
        run_id: input.runId,
        event_kind: result.ok ? 'tool_call_completed' : 'tool_call_failed',
        message: compact(result.summary),
        payload: {
          tool_name: input.definition.name,
          ok: result.ok,
          duration_ms: durationMs,
        },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.toolCalls.update({
        id: toolCall.id,
        status: 'failed',
        duration_ms: Date.now() - startedAt,
        result_summary: compact(message),
      });
      this.options.events.create({
        run_id: input.runId,
        event_kind: 'tool_call_failed',
        message: compact(message),
        payload: { tool_name: input.definition.name },
      });
      return {
        tool: input.definition.name,
        ok: false,
        summary: message,
        message,
      };
    }
  }

  private capture(turn: SupervisorOrchestratorTurnState, response: BotCommandResponse | undefined | null): void {
    if (!response) {
      return;
    }
    turn.capturedResponse = response;
  }

  private completeRun(runId: string, ok: boolean, finalMessage: string): void {
    const run = this.options.runs.findById(runId);
    if (!run || run.state === 'waiting_confirmation') {
      return;
    }
    this.options.runs.update({
      id: runId,
      state: ok ? 'completed' : 'failed',
      final_message: finalMessage,
    });
    this.options.events.create({
      run_id: runId,
      event_kind: 'final_answer',
      message: compact(finalMessage),
    });
  }
}
