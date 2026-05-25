import type { CreateIssueRequest, RuntimeControlPlane, RuntimeStreamEvent } from '../runtime/types';

export type BotTransport = 'telegram' | 'discord' | 'feishu';
export type BotWatchPreset = 'default' | 'verbose' | 'failures' | 'status';
export type BotCommandName =
  | 'help'
  | 'clear'
  | 'status'
  | 'new'
  | 'project'
  | 'watch'
  | 'unwatch'
  | 'stop'
  | 'retry'
  | 'close_issue'
  | 'supersede_issue'
  | 'override'
  | 'rewrite'
  | 'split'
  | 'execute_governance_suggestion'
  | 'dismiss_governance_suggestion';

export interface BotIdentity {
  user_id: string | null;
  display_name: string | null;
}

export interface BotRecipient {
  transport: BotTransport;
  conversation_id: string;
  label?: string | null;
}

export interface BotTransportAction {
  label: string;
  style?: 'default' | 'primary' | 'success' | 'danger';
  callback_data?: string;
  url?: string;
  web_app?: {
    url: string;
  };
}

export type BotTransportMessageFormat = 'plain' | 'telegram_html';

export interface BotTransportMessageRef {
  provider_message_id: string;
}

export interface BotTransportPhoto {
  bytes?: Uint8Array;
  url?: string;
  file_id?: string;
  filename?: string;
  content_type?: string;
}

export interface BotTransportMessage {
  text: string;
  caption?: string;
  format?: BotTransportMessageFormat;
  media_key?: string | null;
  photo?: BotTransportPhoto | null;
  show_caption_above_media?: boolean;
  reply_to_message_id?: string | number | null;
  actions?: BotTransportAction[];
  action_rows?: BotTransportAction[][];
  force_card?: boolean;
}

export type BotMessageEditFailureKind =
  | 'not_modified'
  | 'message_not_found'
  | 'hard_failure';

export class BotMessageEditError extends Error {
  constructor(
    public readonly kind: BotMessageEditFailureKind,
    message: string,
    public readonly status: number | null = null,
    public readonly description: string | null = null,
  ) {
    super(message);
    this.name = 'BotMessageEditError';
  }
}

export function getBotMessageEditFailureKind(error: unknown): BotMessageEditFailureKind | null {
  return error instanceof BotMessageEditError ? error.kind : null;
}

export interface BotCommandContext {
  transport: BotTransport;
  recipient: BotRecipient;
  identity: BotIdentity;
  message_id?: string | number | null;
}

export interface BotCommandRequest {
  command: BotCommandName;
  issue_id?: string | null;
  successor_issue_id?: string | null;
  retry_successor?: boolean | null;
  suggestion_id?: string | null;
  project_slug?: string | null;
  watch_preset?: BotWatchPreset | null;
  create_issue?: CreateIssueRequest | null;
  reason?: string | null;
  raw_text?: string | null;
}

export interface BotCommandResponse {
  message: string;
  caption?: string;
  format?: BotTransportMessageFormat;
  media_key?: string | null;
  photo?: BotTransportPhoto | null;
  show_caption_above_media?: boolean;
  actions?: BotTransportAction[];
  action_rows?: BotTransportAction[][];
  watch_registered?: boolean;
  issue_id?: string | null;
  session_id?: string | null;
  material_key?: string | null;
}

export interface BotWatchSubscription {
  transport: BotTransport;
  conversation_id: string;
  issue_id: string;
  issue_identifier: string | null;
  user_id: string | null;
  preset: BotWatchPreset;
}

export interface BotTransportNotifier {
  sendMessage(recipient: BotRecipient, message: BotTransportMessage): Promise<BotTransportMessageRef>;
  editMessage(recipient: BotRecipient, messageRef: BotTransportMessageRef, message: BotTransportMessage): Promise<BotTransportMessageRef>;
}

export interface BotTransportManifest {
  enabled: boolean;
  inbound_enabled: boolean;
  outbound_enabled: boolean;
  watch_supported: boolean;
  write_requires_operator: boolean;
  inbound_path: string;
  proactive_followups_supported?: boolean;
  inline_actions_supported?: boolean;
  operations_chat_configured?: boolean;
  health?: 'healthy' | 'degraded' | 'unconfigured';
  webhook_url?: string | null;
  public_base_url?: string | null;
  mini_app_base_url?: string | null;
  webhook_used_tunnel?: boolean | null;
  webhook_pending_update_count?: number | null;
  webhook_last_error_message?: string | null;
  webhook_last_error_at?: string | null;
  callback_ingress_recently_ok?: boolean;
}

export interface BotManifest {
  transports: Record<BotTransport, BotTransportManifest>;
  commands: readonly BotCommandName[];
  watch_presets: readonly BotWatchPreset[];
  assistant: BotAssistantDiagnostics;
  natural_language_enabled?: boolean;
  supervisor?: {
    active_sessions: Array<{
      session_id: string;
      transport: BotTransport;
      conversation_id: string;
      state: string;
      active_decision_kind: string | null;
      title: string | null;
      repo_ref: string | null;
      root_issue_id: string | null;
      updated_at: string;
    }>;
    agent_runtime?: {
      active_runs: Array<{
        run_id: string;
        transport: BotTransport;
        conversation_id: string;
        state: string;
        repo_ref: string | null;
        active_issue_id: string | null;
        step_count: number;
        updated_at: string;
      }>;
      pending_actions: Array<{
        run_id: string;
        tool_name: string;
        status: string;
        expires_at: string;
      }>;
    };
    repo_sources?: Array<{
      project_slug: string;
      repo_ref: string;
      configured_local_path: string | null;
      analysis_path: string | null;
      source_path: string | null;
      commit_sha: string | null;
      status: 'unknown' | 'ready' | 'failed';
      last_sync_error: string | null;
      updated_at: string | null;
    }>;
    repo_advisor_sessions?: Array<{
      transport: string;
      conversation_id: string;
      repo_ref: string | null;
      local_path: string;
      source_commit_sha: string | null;
      started_at: string;
      last_used_at: string;
      turn_count: number;
    }>;
  };
}

export interface BotGateway {
  getManifest(): BotManifest;
  initializeInboundIntegration?(params: {
    localBaseUrl: string;
    inboundPath?: string;
  }): Promise<void>;
  handleTelegramWebhook(body: unknown, headers?: Headers | Record<string, string | undefined>): Promise<{
    ok: boolean;
    status: number;
    body: Record<string, unknown>;
  }>;
  handleDiscordInteraction(rawBody: string, headers: Headers | Record<string, string | undefined>): Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
  handleSupervisorContextTool?(body: unknown, headers?: Headers | Record<string, string | undefined>): Promise<{
    ok: boolean;
    status: number;
    body: Record<string, unknown>;
  }>;
  handleSupervisorOrchestratorTool?(body: unknown, headers?: Headers | Record<string, string | undefined>): Promise<{
    ok: boolean;
    status: number;
    body: Record<string, unknown>;
  }>;
  dispose?(): void;
}

export interface RuntimeBackedBotComponent {
  runtime: RuntimeControlPlane;
}

export interface TelegramWebhookDiagnostics {
  health: 'healthy' | 'degraded' | 'unconfigured';
  webhook_url: string | null;
  webhook_pending_update_count: number | null;
  webhook_last_error_message: string | null;
  webhook_last_error_at: string | null;
  callback_ingress_recently_ok: boolean;
}

export interface TelegramCallbackAuditRecord {
  callback_id: string | null;
  chat_id: string | null;
  message_id: string | null;
  callback_data: string | null;
  issue_id: string | null;
  action_kind: string | null;
  result:
    | 'received'
    | 'parsed'
    | 'acked'
    | 'executing'
    | 'completed'
    | 'edited'
    | 'sent_fallback'
    | 'failed';
  error_message: string | null;
  timestamp: string;
}

export type RuntimeEventListener = (event: RuntimeStreamEvent) => void;

export type SupervisorIntakeSource =
  | 'telegram_chat'
  | 'feishu_chat'
  | 'slash_command'
  | 'inline_action';

export type BotAssistantIntentKind =
  | 'list_issues'
  | 'list_repositories'
  | 'read_repo_with_claude'
  | 'create_issue'
  | 'status'
  | 'show_issue_card'
  | 'watch'
  | 'unwatch'
  | 'stop'
  | 'retry'
  | 'close_issue'
  | 'supersede_issue'
  | 'override'
  | 'rewrite'
  | 'split'
  | 'execute_governance_suggestion'
  | 'dismiss_governance_suggestion'
  | 'switch_repository'
  | 'set_default_project'
  | 'show_default_project'
  | 'help'
  | 'answer_question'
  | 'clarify';

export type BotAssistantIntent =
  | {
      kind: 'list_issues';
      active_only: boolean | null;
      state_filter: string | null;
      repo_ref?: string | null;
      project_slug?: string | null;
    }
  | {
      kind: 'list_repositories';
    }
  | {
      kind: 'read_repo_with_claude';
      question: string | null;
      repo_ref?: string | null;
      project_slug?: string | null;
    }
  | {
      kind: 'create_issue';
      title: string;
      description: string | null;
      project_slug: string | null;
    }
  | {
      kind: 'status' | 'watch' | 'unwatch' | 'stop' | 'retry' | 'close_issue' | 'override' | 'rewrite' | 'split';
      issue_id: string | null;
      watch_preset?: BotWatchPreset | null;
      reason?: string | null;
    }
  | {
      kind: 'show_issue_card';
      issue_id: string | null;
    }
  | {
      kind: 'supersede_issue';
      issue_id: string | null;
      successor_issue_id: string | null;
      reason: string | null;
      retry_successor?: boolean | null;
    }
  | {
      kind: 'execute_governance_suggestion' | 'dismiss_governance_suggestion';
      issue_id: string | null;
      suggestion_id: string | null;
      suggestion_type: string | null;
      ordinal: number | null;
    }
  | {
      kind: 'switch_repository';
      repo_ref: string | null;
      project_slug?: string | null;
    }
  | {
      kind: 'set_default_project';
      project_slug: string | null;
    }
  | {
      kind: 'show_default_project' | 'help';
    }
  | {
      kind: 'answer_question';
      answer: string;
    }
  | {
      kind: 'clarify';
      question: string;
    };

export interface BotAssistantDecision {
  intent: BotAssistantIntent;
}

export type BotAssistantHealth = 'healthy' | 'degraded' | 'unconfigured';

export interface BotAssistantDiagnostics {
  provider: string | null;
  model: string | null;
  configured: boolean;
  health: BotAssistantHealth;
  fallback_available: boolean;
  last_error_code: string | null;
  last_error_message?: string | null;
}

export type BotAssistantModelOutput = BotAssistantDecision | string | null;

export interface BotProjectRouteView {
  project_slug: string;
  github_repo_full: string;
}

export interface BotWatchStateView {
  issue_id: string;
  issue_identifier: string | null;
  preset: BotWatchPreset;
}

export interface BotRepoProfileView {
  repo_ref: string;
  summary: string;
  project_type: string;
  tech_stack: string[];
  key_paths: string[];
  signals: {
    readme_title: string | null;
    package_name: string | null;
    package_scripts: string[];
    top_level_directories: string[];
    top_level_files?: string[];
    sample_paths?: string[];
    key_file_summaries?: Array<{
      path: string;
      summary: string;
    }>;
  };
  last_indexed_at: string;
}

export interface BotRepoUnderstandingView {
  repo_ref: string;
  commit_sha: string;
  summary: string;
  understanding: {
    project_purpose: string;
    tech_stack: string[];
    key_paths: string[];
    architecture_notes: string[];
    artifact_opportunities: string[];
    test_commands: string[];
    risks: string[];
  };
  evidence_paths: string[];
  source: 'cache' | 'claude_code' | 'fallback';
}

export interface BotIssueContextView {
  issue_id: string;
  identifier: string;
  title: string;
  phase: string;
  tracker_state: string;
  orchestrator_state: string | null;
  github_repo: string | null;
  branch_name: string | null;
  active_pr_number: number | null;
  session: {
    session_id: string | null;
    turn_count: number;
    stage: string | null;
    last_event: string | null;
    last_message: string | null;
    started_at: string | null;
    last_event_at: string | null;
    tokens: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      uncached_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    recent_tools: Array<{
      tool_name: string;
      status: string;
      message: string;
      summary: string | null;
      path: string | null;
      timestamp: string;
    }>;
    recent_files: Array<{
      path: string;
      operation: string;
      status: string;
      timestamp: string;
    }>;
  } | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    uncached_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
  session_stage: string | null;
  session_message: string | null;
  supervisor_session_state?: string | null;
  supervisor_plan_summary?: string | null;
  architectural_target: string | null;
  path_families: string[];
  boundary_edges: string[];
  import_edges: string[];
  fitness_signals: string[];
  governance_root_issue_identifier: string | null;
  governance_thread_state: string | null;
  governance_child_issues: Array<{
    issue_id: string;
    issue_identifier: string;
    title: string;
    tracker_state: string;
    orchestrator_state: string | null;
    governance_decision: string | null;
    governance_summary: string | null;
    delivery_code?: string | null;
    delivery_summary?: string | null;
  }>;
  next_recommended_action: string | null;
  governance_pause_reason?: string | null;
  governance_expected_handoff?: string | null;
  governance_queued_child_identifiers?: string[];
  delivery_state?: string | null;
  delivery_code?: string | null;
  delivery_summary?: string | null;
  repo_harness_status: {
    status: string;
    learning_confidence: string | null;
    learned_command_count: number;
    learned_artifact_count: number;
    learned_runtime_hint_count: number;
  } | null;
}

export interface BotFocusedIssueContext {
  issue: BotIssueContextView;
  digest: {
    headline: string;
    detail: string;
    history_blurb: string | null;
    updated_at: string | null;
  } | null;
  governance: {
    status: string | null;
    decision: string | null;
    summary: string | null;
    root_issue_identifier?: string | null;
    thread_state?: string | null;
    child_issues?: Array<{
      issue_identifier: string;
      title: string;
      tracker_state: string;
      governance_decision: string | null;
      governance_summary: string | null;
    }>;
    next_recommended_action?: string | null;
    pause_reason?: string | null;
    expected_handoff?: string | null;
    queued_child_identifiers?: string[];
    suggestions: Array<{
      id: string;
      suggestion_type: string;
      status: string;
      title: string;
      summary: string;
      can_execute: boolean;
      can_dismiss: boolean;
    }>;
  } | null;
  recent_timeline: Array<{
    timestamp: string;
    message: string;
    code: string;
    tool_name: string | null;
    level: string;
    category: string;
    detail?: Record<string, unknown> | null;
  }>;
}

export interface BotRuntimeCopilotContext {
  default_project_slug: string | null;
  available_projects: BotProjectRouteView[];
  recent_messages?: Array<{
    user_message: string;
    final_message: string | null;
    repo_ref: string | null;
    active_issue_id: string | null;
    state: string;
  }>;
  repo_profile: BotRepoProfileView | null;
  repo_understanding: BotRepoUnderstandingView | null;
  watch_subscriptions: BotWatchStateView[];
  overview: {
    running: number;
    retrying: number;
    total: number;
    active_issues: BotIssueContextView[];
  };
  focus_issue: BotFocusedIssueContext | null;
  assistant: BotAssistantDiagnostics;
}
