import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { AgentRunner } from '../agent/runner';
import type { BotCommandContext, BotCommandResponse } from '../bots/types';
import {
  SUPERVISOR_ORCHESTRATOR_TOOL_NAMES,
  type SupervisorOrchestratorBroker,
  type SupervisorOrchestratorToolName,
} from './orchestratorBroker';

export interface SupervisorClaudeWorkspace {
  transport: string;
  conversationId: string;
  repoRef: string | null;
  localPath: string | null;
}

export interface SupervisorClaudeSession {
  ask(prompt: string): Promise<BotCommandResponse | null>;
  dispose(): Promise<void> | void;
}

export interface SupervisorClaudeRuntimeServiceOptions {
  resolveWorkspace(input: {
    context: BotCommandContext;
    text: string;
  }): Promise<Pick<SupervisorClaudeWorkspace, 'repoRef' | 'localPath'>>;
  createSession?: (workspace: SupervisorClaudeWorkspace) => Promise<SupervisorClaudeSession>;
  command?: string;
  mcpConfig?: string | null;
  contextEndpoint?: string | null;
  orchestratorEndpoint?: string | null;
  contextToken?: string | null;
  orchestratorBridge?: Pick<SupervisorOrchestratorBroker, 'beginTurn' | 'consumeTurnResponse'> | null;
  projectRoot?: string;
  timeoutMs?: number;
  readTimeoutMs?: number;
}

export interface SupervisorClaudeRuntimeHandle {
  respond(request: SupervisorClaudeRuntimeRespondRequest): Promise<BotCommandResponse | null>;
  dispose?(): Promise<void> | void;
  setContextEndpoint?(endpoint: string | null): void;
  setOrchestratorEndpoint?(endpoint: string | null): void;
  setOrchestratorBridge?(bridge: Pick<SupervisorOrchestratorBroker, 'beginTurn' | 'consumeTurnResponse'> | null): void;
  getContextToken?(): string;
}

export interface SupervisorClaudeRuntimeRespondRequest {
  context: BotCommandContext;
  text: string;
  canWrite?: boolean;
}

export const SUPERVISOR_CONTEXT_TOOL_NAMES = [
  'mcp__supervisor-context__list_context_sources',
  'mcp__supervisor-context__get_runtime_overview',
  'mcp__supervisor-context__get_recent_completed_issues',
  'mcp__supervisor-context__get_issue',
  'mcp__supervisor-context__get_issue_history',
  'mcp__supervisor-context__get_issue_timeline',
  'mcp__supervisor-context__get_conversation_state',
  'mcp__supervisor-context__get_repo_route',
  'mcp__supervisor-context__prepare_repo_source',
  'mcp__supervisor-context__get_repo_profile',
  'mcp__supervisor-context__get_repo_understanding',
  'mcp__supervisor-context__search_supervisor_memory',
  'mcp__supervisor-context__get_plan_session',
  'mcp__supervisor-context__get_governance_signals',
  'mcp__supervisor-context__recommend_repo_issue',
] as const;

export const SUPERVISOR_ORCHESTRATOR_MCP_TOOL_NAMES = SUPERVISOR_ORCHESTRATOR_TOOL_NAMES.map((name) =>
  `mcp__supervisor-orchestrator__${name}`
) as Array<`mcp__supervisor-orchestrator__${SupervisorOrchestratorToolName}`>;

export const SUPERVISOR_CLAUDE_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'TodoRead',
  ...SUPERVISOR_CONTEXT_TOOL_NAMES,
  ...SUPERVISOR_ORCHESTRATOR_MCP_TOOL_NAMES,
];

export function buildSupervisorClaudeSystemPrompt(): string {
  return [
    'You are the top-level Supervisor Claude Code runtime for Telegram.',
    'You are the assistant brain, not a parser or a thin status formatter. Decide which context sources to inspect before answering.',
    'Your job is to maintain situational awareness across runtime, tracker, delivery, PR, repo, memory, plan/session, governance, and conversation context.',
    'Repository access is read-only. Never edit files, run installs, create commits, or mutate a checkout.',
    'Use supervisor-context tools for facts. Use supervisor-orchestrator tools for business actions, card delivery, approval state, and issue/orchestrator control.',
    'Business actions such as create, watch, unwatch, retry, stop, close, supersede, override, rewrite, and split must stay behind supervisor-orchestrator tools and confirmation policy.',
    'When the user asks for a card, call show_issue_card or show_plan_card. Do not describe an internal card protocol.',
    'When the user asks you to create/propose/open an issue, gather needed evidence, then call create_issue. The broker will produce the real confirmation UI when required.',
    'When unsure what action surface exists, call list_orchestrator_capabilities before guessing.',
    'Telegram text is user-facing. For ordinary answers, do not output raw JSON or internal protocol text.',
    'Use compact evidence in Telegram replies: name the high-signal sources checked, mention missing evidence, then give the answer or recommendation.',
    'Never answer by grabbing the first issue from an overview. Overview order can be distorted by sync or repair timestamps.',
    'For "latest", "recent", or "最近完成" questions, use get_recent_completed_issues or issue history/timeline evidence before answering.',
    'For issue status questions, distinguish tracker state, runtime/orchestrator state, delivery state, and PR/merge evidence when present.',
    'For pure control-plane status questions, inspect runtime context first and avoid unnecessary repository deep reads.',
    'For repo advisory questions, use supervisor-context tools and read-only repository inspection as needed.',
  ].join('\n');
}

function buildSupervisorMcpConfig(
  workspace: SupervisorClaudeWorkspace,
  contextEndpoint: string | null,
  orchestratorEndpoint: string | null,
  contextToken: string,
): string {
  return JSON.stringify({
    mcpServers: {
      'supervisor-context': {
        command: 'bun',
        args: ['run', 'src/supervisor/contextMcpServer.ts'],
        env: {
          ...(contextEndpoint ? { SYMPHONY_SUPERVISOR_CONTEXT_ENDPOINT: contextEndpoint } : {}),
          SYMPHONY_SUPERVISOR_CONTEXT_TOKEN: contextToken,
          SYMPHONY_SUPERVISOR_CONTEXT_TRANSPORT: workspace.transport,
          SYMPHONY_SUPERVISOR_CONTEXT_CONVERSATION_ID: workspace.conversationId,
          ...(workspace.repoRef ? { SYMPHONY_SUPERVISOR_CONTEXT_REPO_REF: workspace.repoRef } : {}),
        },
      },
      'supervisor-orchestrator': {
        command: 'bun',
        args: ['run', 'src/supervisor/orchestratorMcpServer.ts'],
        env: {
          ...(orchestratorEndpoint ? { SYMPHONY_SUPERVISOR_ORCHESTRATOR_ENDPOINT: orchestratorEndpoint } : {}),
          SYMPHONY_SUPERVISOR_ORCHESTRATOR_TOKEN: contextToken,
          SYMPHONY_SUPERVISOR_ORCHESTRATOR_TRANSPORT: workspace.transport,
          SYMPHONY_SUPERVISOR_ORCHESTRATOR_CONVERSATION_ID: workspace.conversationId,
          ...(workspace.repoRef ? { SYMPHONY_SUPERVISOR_ORCHESTRATOR_REPO_REF: workspace.repoRef } : {}),
        },
      },
    },
  });
}

function contextSourceMap(): string {
  return [
    'Context source map:',
    '- list_context_sources: inventory of available supervisor context sources.',
    '- get_runtime_overview: compact current counts plus active, failed, and recent completed issue summaries.',
    '- get_recent_completed_issues: recent Done/non-cancelled completions ranked by review/PR delivery evidence; use this for "最近完成".',
    '- get_issue/get_issue_history/get_issue_timeline: detailed issue state, replay digest, and recent runtime events.',
    '- get_conversation_state: default project, focused issue, focused repo, pending actions, and recent supervisor runs.',
    '- get_repo_route/prepare_repo_source: project-to-repo routing and read-only source cache preparation.',
    '- get_repo_profile/get_repo_understanding: shallow repo index and cached Claude Code repo understanding.',
    '- search_supervisor_memory: prior execution patterns, failures, and repo-specific lessons.',
    '- get_plan_session: active Plan Card/session state for this Telegram conversation.',
    '- get_governance_signals: harness, constitution, decision/conflict/debt signals.',
    '- recommend_repo_issue: produce one evidence-backed next issue recommendation.',
    '',
    'Orchestrator business tool map:',
    '- list_orchestrator_capabilities: inspect available business/control actions, input schemas, risk levels, and confirmation policies.',
    '- get_pending_action: inspect the open pending confirmation for this conversation.',
    '- list_issues/diagnose_issue: read issue/orchestrator state and evidence.',
    '- show_issue_card/show_plan_card: deliver the real Telegram card UI.',
    '- watch_issue/unwatch_issue/retry_issue/stop_issue/set_default_project: low-risk writes, direct only when policy validates the target.',
    '- create_issue/close_issue/supersede_issue/governance tools: confirmation-gated writes.',
  ].join('\n');
}

function buildTurnPrompt(input: {
  text: string;
  workspace: SupervisorClaudeWorkspace;
  canWrite: boolean;
}): string {
  return [
    contextSourceMap(),
    '',
    `telegram_transport: ${input.workspace.transport}`,
    `conversation_id: ${input.workspace.conversationId}`,
    `repo_ref: ${input.workspace.repoRef ?? 'null'}`,
    `local_path: ${input.workspace.localPath ?? 'null'}`,
    `can_use_business_write_tools: ${input.canWrite}`,
    '',
    'Answer the user in their language. Use compact evidence by default.',
    `user_message: ${input.text}`,
  ].join('\n');
}

function sessionKey(workspace: SupervisorClaudeWorkspace): string {
  return [
    workspace.transport,
    workspace.conversationId,
    workspace.repoRef ?? 'no-repo',
  ].join(':');
}

export class SupervisorClaudeRuntimeService {
  private readonly sessions = new Map<string, SupervisorClaudeSession>();
  private contextEndpoint: string | null;
  private orchestratorEndpoint: string | null;
  private orchestratorBridge: Pick<SupervisorOrchestratorBroker, 'beginTurn' | 'consumeTurnResponse'> | null;
  private readonly contextToken: string;

  constructor(private readonly options: SupervisorClaudeRuntimeServiceOptions) {
    this.contextEndpoint = options.contextEndpoint
      ?? process.env.SYMPHONY_SUPERVISOR_CONTEXT_ENDPOINT
      ?? null;
    this.orchestratorEndpoint = options.orchestratorEndpoint
      ?? process.env.SYMPHONY_SUPERVISOR_ORCHESTRATOR_ENDPOINT
      ?? null;
    this.orchestratorBridge = options.orchestratorBridge ?? null;
    this.contextToken = options.contextToken ?? randomUUID();
  }

  setContextEndpoint(endpoint: string | null): void {
    this.contextEndpoint = endpoint?.trim() || null;
  }

  setOrchestratorEndpoint(endpoint: string | null): void {
    this.orchestratorEndpoint = endpoint?.trim() || null;
  }

  setOrchestratorBridge(bridge: Pick<SupervisorOrchestratorBroker, 'beginTurn' | 'consumeTurnResponse'> | null): void {
    this.orchestratorBridge = bridge;
  }

  getContextToken(): string {
    return this.contextToken;
  }

  async respond(request: SupervisorClaudeRuntimeRespondRequest): Promise<BotCommandResponse | null> {
    if (request.context.transport !== 'telegram') {
      return null;
    }
    const resolved = await this.options.resolveWorkspace({
      context: request.context,
      text: request.text,
    });
    const workspace: SupervisorClaudeWorkspace = {
      transport: request.context.transport,
      conversationId: request.context.recipient.conversation_id,
      repoRef: resolved.repoRef ?? null,
      localPath: resolved.localPath ?? this.options.projectRoot ?? process.cwd(),
    };
    const key = sessionKey(workspace);
    let session = this.sessions.get(key) ?? null;
    if (!session) {
      session = await (this.options.createSession ?? this.createDefaultSession.bind(this))(workspace);
      this.sessions.set(key, session);
    }
    this.orchestratorBridge?.beginTurn({
      context: request.context,
      text: request.text,
      repoRef: workspace.repoRef,
      canWrite: request.canWrite ?? true,
      activeIssueId: null,
    });
    const prompt = buildTurnPrompt({
      text: request.text,
      workspace,
      canWrite: request.canWrite ?? true,
    });
    try {
      const response = await session.ask(prompt);
      return this.orchestratorBridge?.consumeTurnResponse({
        context: request.context,
        repoRef: workspace.repoRef,
      }) ?? response;
    } catch (error) {
      this.orchestratorBridge?.consumeTurnResponse({
        context: request.context,
        repoRef: workspace.repoRef,
      });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.dispose()));
    this.sessions.clear();
  }

  private async createDefaultSession(workspace: SupervisorClaudeWorkspace): Promise<SupervisorClaudeSession> {
    const runner = new AgentRunner({
      codexCommand: this.options.command ?? 'node scripts/claude-adapter.cjs',
      approvalPolicy: 'on-request',
      threadSandbox: 'workspace-read',
      turnSandboxPolicy: JSON.stringify({ type: 'read-only', allowExternalResearch: false }),
      mcpConfig: this.options.mcpConfig ?? buildSupervisorMcpConfig(
        workspace,
        this.contextEndpoint,
        this.orchestratorEndpoint,
        this.contextToken,
      ),
      allowedTools: SUPERVISOR_CLAUDE_ALLOWED_TOOLS,
      systemPrompt: buildSupervisorClaudeSystemPrompt(),
      turnTimeoutMs: this.options.timeoutMs ?? 120_000,
      readTimeoutMs: this.options.readTimeoutMs ?? 5_000,
      stallTimeoutMs: this.options.timeoutMs ?? 120_000,
      projectRoot: this.options.projectRoot ?? process.cwd(),
    });
    const cwd = workspace.localPath ?? this.options.projectRoot ?? process.cwd();
    const child = runner.launch(cwd);
    const { threadId } = await runner.initializeSession(child, cwd);
    return new AgentRunnerSupervisorClaudeSession(runner, child, threadId, cwd);
  }
}

class AgentRunnerSupervisorClaudeSession implements SupervisorClaudeSession {
  constructor(
    private readonly runner: AgentRunner,
    private readonly child: ChildProcess,
    private readonly threadId: string,
    private readonly cwd: string,
  ) {}

  async ask(prompt: string): Promise<BotCommandResponse | null> {
    const result = await this.runner.runTurn(
      this.child,
      this.threadId,
      prompt,
      'Telegram Supervisor Claude Runtime',
      this.cwd,
      () => undefined,
      async (request) => {
        if (request.kind === 'approval') {
          const toolUseID = typeof request.raw.tool_use_id === 'string'
            ? request.raw.tool_use_id
            : undefined;
          return {
            response: {
              behavior: 'deny',
              message: 'Repository mutation is disabled in top-level Supervisor Claude runtime.',
              ...(toolUseID ? { toolUseID } : {}),
            },
          };
        }
        return { response: { action: 'cancel' } };
      },
    );
    if (!result.success) {
      return null;
    }
    const message = result.transcript
      .filter((entry) => entry.role === 'assistant' && entry.kind === 'message')
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    return message ? { message } : null;
  }

  dispose(): void {
    this.runner.stopSession(this.child);
  }
}
