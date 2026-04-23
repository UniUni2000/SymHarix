import type { CreateIssueRequest, RuntimeControlPlane, RuntimeStreamEvent } from '../runtime/types';

export type BotTransport = 'telegram' | 'discord';
export type BotWatchPreset = 'default' | 'verbose' | 'failures' | 'status';
export type BotCommandName =
  | 'help'
  | 'status'
  | 'new'
  | 'project'
  | 'watch'
  | 'unwatch'
  | 'stop'
  | 'retry'
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

export interface BotCommandContext {
  transport: BotTransport;
  recipient: BotRecipient;
  identity: BotIdentity;
}

export interface BotCommandRequest {
  command: BotCommandName;
  issue_id?: string | null;
  suggestion_id?: string | null;
  project_slug?: string | null;
  watch_preset?: BotWatchPreset | null;
  create_issue?: CreateIssueRequest | null;
  raw_text?: string | null;
}

export interface BotCommandResponse {
  message: string;
  watch_registered?: boolean;
  issue_id?: string | null;
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
  sendMessage(recipient: BotRecipient, message: string): Promise<void>;
}

export interface BotTransportManifest {
  enabled: boolean;
  inbound_enabled: boolean;
  outbound_enabled: boolean;
  watch_supported: boolean;
  write_requires_operator: boolean;
  inbound_path: string;
}

export interface BotManifest {
  transports: Record<BotTransport, BotTransportManifest>;
  commands: readonly BotCommandName[];
  watch_presets: readonly BotWatchPreset[];
  assistant: BotAssistantDiagnostics;
  natural_language_enabled?: boolean;
}

export interface BotGateway {
  getManifest(): BotManifest;
  handleTelegramWebhook(body: unknown, headers?: Headers | Record<string, string | undefined>): Promise<{
    ok: boolean;
    status: number;
    body: Record<string, unknown>;
  }>;
  handleDiscordInteraction(rawBody: string, headers: Headers | Record<string, string | undefined>): Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
  dispose?(): void;
}

export interface RuntimeBackedBotComponent {
  runtime: RuntimeControlPlane;
}

export type RuntimeEventListener = (event: RuntimeStreamEvent) => void;

export type BotAssistantIntentKind =
  | 'create_issue'
  | 'status'
  | 'watch'
  | 'unwatch'
  | 'stop'
  | 'retry'
  | 'override'
  | 'rewrite'
  | 'split'
  | 'execute_governance_suggestion'
  | 'dismiss_governance_suggestion'
  | 'set_default_project'
  | 'show_default_project'
  | 'help'
  | 'answer_question'
  | 'clarify';

export type BotAssistantIntent =
  | {
      kind: 'create_issue';
      title: string;
      description: string | null;
      project_slug: string | null;
    }
  | {
    kind: 'status' | 'watch' | 'unwatch' | 'stop' | 'retry' | 'override' | 'rewrite' | 'split';
    issue_id: string | null;
    watch_preset?: BotWatchPreset | null;
  }
  | {
      kind: 'execute_governance_suggestion' | 'dismiss_governance_suggestion';
      issue_id: string | null;
      suggestion_id: string | null;
      suggestion_type: string | null;
      ordinal: number | null;
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
  session_stage: string | null;
  session_message: string | null;
  architectural_target: string | null;
  path_families: string[];
  boundary_edges: string[];
  import_edges: string[];
  fitness_signals: string[];
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
  }>;
}

export interface BotRuntimeCopilotContext {
  default_project_slug: string | null;
  available_projects: BotProjectRouteView[];
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
