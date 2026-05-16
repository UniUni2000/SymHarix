import type { CreateIssueRequest, RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import { BotConversationPreferenceRepository, type BotIssueFollowupRepository } from '../database';
import {
  resolveRepositoryRouteReference,
  TrackerProjectResolutionService,
} from '../tracker/projectResolution';
import { inferRuntimeLocaleFromText, type RuntimeLocale } from '../i18n/locale';
import { BotSubscriptionService } from './subscriptions';
import { buildIssueCardActionRows } from './issueCardActions';
import { buildSupervisorIssueVisualCard } from '../supervisor/issueVisualCard';
import { getTelegramThemePreference } from './telegramThemePreference';
import type {
  BotCommandContext,
  BotCommandRequest,
  BotCommandResponse,
  BotCommandName,
  BotWatchPreset,
} from './types';

const WATCH_PRESETS: readonly BotWatchPreset[] = ['default', 'verbose', 'failures', 'status'];

function compact(value: string | null | undefined, maxLength = 120): string {
  if (!value) {
    return 'n/a';
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function listCommands(): string {
  return [
    'Commands:',
    'help',
    'clear [all]',
    'status [ISSUE-ID]',
    'new <title> (add description on the next line for Telegram)',
    'project [PROJECT-SLUG|REPO|clear]',
    'watch [default|verbose|failures|status] <ISSUE-ID>',
    'unwatch <ISSUE-ID>',
    'stop <ISSUE-ID>',
    'retry <ISSUE-ID>',
    'close <ISSUE-ID>',
    'supersede <OLD-ISSUE-ID> <NEW-ISSUE-ID>',
    'override <ISSUE-ID>',
    'rewrite <ISSUE-ID>',
    'split <ISSUE-ID>',
  ].join('\n');
}

function resolveIssue(runtime: RuntimeControlPlane, id: string | null | undefined): RuntimeIssueView | null {
  if (!id) {
    return null;
  }
  return runtime.getIssue(id);
}

function formatIssue(issue: RuntimeIssueView): string {
  const session = issue.session;
  const lines = [
    `${issue.identifier} · ${issue.title}`,
    `phase ${issue.phase} · tracker ${issue.tracker_state} · orchestrator ${issue.orchestrator_state || 'unknown'}`,
  ];

  if (session) {
    lines.push(
      `session ${session.stage || 'unknown'} · turns ${session.turn_count} · tokens ${session.tokens.total_tokens}`,
    );
  }

  if (issue.workspace_path) {
    lines.push(`workspace ${compact(issue.workspace_path, 90)}`);
  }
  if (issue.branch_name) {
    lines.push(`branch ${issue.branch_name}`);
  }

  const tool = session?.recent_tools[session.recent_tools.length - 1] || null;
  if (tool) {
    lines.push(
      `latest tool ${tool.tool_name} ${tool.status}${tool.summary ? ` · ${compact(tool.summary, 80)}` : ''}`,
    );
  }

  const file = session?.recent_files[session.recent_files.length - 1] || null;
  if (file) {
    lines.push(`latest file ${file.operation} · ${compact(file.path, 80)}`);
  }

  const timeline = issue.issue_id ? [] : [];
  void timeline;
  return lines.join('\n');
}

function formatGovernanceSuggestions(issue: RuntimeIssueView): string {
  const suggestions = issue.active_governance_suggestions ?? [];
  if (suggestions.length === 0) {
    return '';
  }

  return [
    'governance suggestions',
    ...suggestions.map((suggestion, index) => {
      const actions = [
        suggestion.can_execute ? 'execute' : null,
        suggestion.can_dismiss ? 'dismiss' : null,
      ].filter(Boolean).join('/');
      return `- [${index + 1}] ${suggestion.suggestion_type} · ${compact(suggestion.title, 80)} · id ${suggestion.id}${actions ? ` · ${actions}` : ''}`;
    }),
  ].join('\n');
}

function formatGovernanceSummary(issue: RuntimeIssueView): string {
  const parts = [
    issue.governance_summary ? `governance ${issue.governance_summary}` : null,
    formatGovernanceSuggestions(issue),
  ].filter(Boolean);
  return parts.join('\n');
}

function inferCommandLocale(params: {
  issue?: RuntimeIssueView | null;
  input?: CreateIssueRequest | null;
  rawText?: string | null;
}): RuntimeLocale {
  if (params.issue?.supervisor_locale === 'zh' || params.issue?.supervisor_locale === 'en') {
    return params.issue.supervisor_locale;
  }
  return inferRuntimeLocaleFromText([
    params.rawText,
    params.input?.title,
    params.input?.description,
  ].filter(Boolean).join('\n'));
}

function formatIssueCreatedMessage(params: {
  issue?: RuntimeIssueView | null;
  issueIdentifier?: string | null;
  input?: CreateIssueRequest | null;
  rawText?: string | null;
}): string {
  const locale = inferCommandLocale({
    issue: params.issue,
    input: params.input,
    rawText: params.rawText,
  });
  const identifier = params.issue?.identifier ?? params.issueIdentifier ?? (locale === 'en' ? 'the new issue' : '新任务');
  if (params.issue) {
    return locale === 'en'
      ? `Got it, created ${params.issue.identifier} · ${params.issue.title}`
      : `已收到，已创建 ${params.issue.identifier} · ${params.issue.title}`;
  }
  return locale === 'en'
    ? `Got it, created ${identifier}`
    : `已收到，已创建 ${identifier}`;
}

function cardThemeForContext(context: BotCommandContext): 'light' | 'dark' {
  if (context.transport !== 'telegram') {
    return 'light';
  }
  return getTelegramThemePreference(context.recipient.conversation_id) ?? 'light';
}

function parseWatchArgs(inlineArgs: string): {
  issue_id: string | null;
  watch_preset: BotWatchPreset | null;
} {
  const tokens = inlineArgs.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return {
      issue_id: null,
      watch_preset: null,
    };
  }

  const preset = tokens[0]?.toLowerCase() as BotWatchPreset | undefined;
  if (preset && WATCH_PRESETS.includes(preset)) {
    return {
      issue_id: tokens.slice(1).join(' ').trim() || null,
      watch_preset: preset,
    };
  }

  return {
    issue_id: inlineArgs || null,
    watch_preset: null,
  };
}

function formatOverview(runtime: RuntimeControlPlane): string {
  const overview = runtime.getOverview();
  const lines = [
    `SymHarix runtime · running ${overview.counts.running} · retrying ${overview.counts.retrying} · tracked ${overview.counts.total}`,
  ];

  if (overview.issues.length === 0) {
    lines.push('No tracked issues.');
    return lines.join('\n');
  }

  for (const issue of overview.issues.slice(0, 6)) {
    const session = issue.session;
    const parts = [
      `${issue.identifier}`,
      issue.phase,
      issue.tracker_state,
      issue.orchestrator_state || 'unknown',
    ];
    if (session?.stage) {
      parts.push(session.stage);
    }
    lines.push(`- ${parts.join(' · ')} · ${compact(issue.title, 60)}`);
  }

  return lines.join('\n');
}

export function parseTextCommand(text: string): BotCommandRequest {
  const trimmed = text.trim();
  if (!trimmed) {
    return { command: 'help', raw_text: text };
  }

  const [firstLine, ...restLines] = trimmed.split(/\r?\n/);
  const firstLineTrimmed = firstLine.trim();
  const commandToken = firstLineTrimmed.split(/\s+/)[0] || '';
  const normalizedCommand = commandToken.replace(/^\//, '').split('@')[0].toLowerCase();
  const inlineArgs = firstLineTrimmed.slice(commandToken.length).trim();
  const description = restLines.join('\n').trim() || null;

  const readIssueArg = () => inlineArgs || null;
  const readTwoIssueArgs = (): { issue_id: string | null; successor_issue_id: string | null } => {
    const [issueId, successorIssueId] = inlineArgs.split(/\s+/).filter(Boolean);
    return {
      issue_id: issueId ?? null,
      successor_issue_id: successorIssueId ?? null,
    };
  };

  switch (normalizedCommand) {
    case 'clear':
      return { command: 'clear', raw_text: text };
    case 'status':
      return { command: 'status', issue_id: readIssueArg(), raw_text: text };
    case 'stop':
      return { command: 'stop', issue_id: readIssueArg(), raw_text: text };
    case 'retry':
      return { command: 'retry', issue_id: readIssueArg(), raw_text: text };
    case 'close':
      return { command: 'close_issue', issue_id: readIssueArg(), raw_text: text };
    case 'supersede':
      return { command: 'supersede_issue', ...readTwoIssueArgs(), raw_text: text };
    case 'override':
      return { command: 'override', issue_id: readIssueArg(), raw_text: text };
    case 'rewrite':
      return { command: 'rewrite', issue_id: readIssueArg(), raw_text: text };
    case 'split':
      return { command: 'split', issue_id: readIssueArg(), raw_text: text };
    case 'watch':
      if (inlineArgs.toLowerCase().startsWith('off ')) {
        return { command: 'unwatch', issue_id: inlineArgs.slice(4).trim() || null, raw_text: text };
      }
      return {
        command: 'watch',
        ...parseWatchArgs(inlineArgs),
        raw_text: text,
      };
    case 'unwatch':
      return { command: 'unwatch', issue_id: readIssueArg(), raw_text: text };
    case 'new': {
      const [projectPart, titlePart] = inlineArgs.includes('|')
        ? inlineArgs.split('|', 2).map((part) => part.trim())
        : [null, inlineArgs];
      const title = titlePart || restLines.shift()?.trim() || '';
      const remainingDescription =
        inlineArgs && description ? description : restLines.join('\n').trim() || description;
      return {
        command: 'new',
        project_slug: projectPart || null,
        create_issue: {
          title,
          description: remainingDescription || null,
          project_slug: projectPart || null,
        },
        raw_text: text,
      };
    }
    case 'project':
      return {
        command: 'project',
        project_slug: inlineArgs || null,
        raw_text: text,
      };
    case 'help':
    case 'start':
      return { command: 'help', raw_text: text };
    default:
      return { command: 'help', raw_text: text };
  }
}

export class BotCommandService {
  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly subscriptions: BotSubscriptionService,
    private readonly canWrite: (context: BotCommandContext) => boolean = () => true,
    private readonly preferences: BotConversationPreferenceRepository | null = null,
    private readonly projectResolver: TrackerProjectResolutionService | null = null,
    private readonly followups: BotIssueFollowupRepository | null = null,
  ) {}

  async execute(
    context: BotCommandContext,
    request: BotCommandRequest,
  ): Promise<BotCommandResponse> {
    switch (request.command) {
      case 'status':
        return this.handleStatus(request.issue_id);
      case 'new':
        return this.handleNew(context, request.create_issue, request.raw_text);
      case 'project':
        return this.handleProject(context, request.project_slug);
      case 'watch':
        return this.handleWatch(context, request.issue_id, request.watch_preset);
      case 'unwatch':
        return this.handleUnwatch(context, request.issue_id);
      case 'stop':
        return this.handleStop(context, request.issue_id);
      case 'retry':
        return this.handleRetry(context, request.issue_id);
      case 'close_issue':
        return this.handleCloseIssue(context, request.issue_id, request.reason);
      case 'supersede_issue':
        return this.handleSupersedeIssue(
          context,
          request.issue_id,
          request.successor_issue_id,
          request.reason,
          request.retry_successor,
        );
      case 'override':
        return this.handleOverride(context, request.issue_id);
      case 'rewrite':
        return this.handleRewrite(context, request.issue_id);
      case 'split':
        return this.handleSplit(context, request.issue_id);
      case 'execute_governance_suggestion':
        return this.handleExecuteGovernanceSuggestion(context, request.issue_id, request.suggestion_id);
      case 'dismiss_governance_suggestion':
        return this.handleDismissGovernanceSuggestion(context, request.issue_id, request.suggestion_id);
      case 'clear':
        return {
          message: 'Clear is handled by the Telegram supervisor assistant.',
        };
      case 'help':
      default:
        return { message: listCommands() };
    }
  }

  async executeText(
    context: BotCommandContext,
    text: string,
  ): Promise<BotCommandResponse> {
    return this.execute(context, parseTextCommand(text));
  }

  private normalizeProjectSlugReference(projectSlug?: string | null): string | null {
    const normalized = projectSlug?.trim() || null;
    if (!normalized) {
      return null;
    }
    const routes = typeof this.projectResolver?.listConfiguredRoutes === 'function'
      ? this.projectResolver.listConfiguredRoutes()
      : [];
    return resolveRepositoryRouteReference(routes, normalized)?.route.project_slug ?? normalized;
  }

  private async handleStatus(issueId?: string | null): Promise<BotCommandResponse> {
    if (!issueId) {
      return { message: formatOverview(this.runtime) };
    }

    const issue = resolveIssue(this.runtime, issueId);
    if (!issue) {
      return {
        message: `Issue ${issueId} was not found.\n${listCommands()}`,
      };
    }

    const timeline = this.runtime.getTimeline(issue.issue_id, 5);
    const historyView = this.runtime.getHistoryView(issue.issue_id, 3);
    const summary = formatIssue(issue);
    const recentTimeline =
      timeline.length > 0
        ? `\nrecent timeline\n${timeline.map((event) => `- ${event.message}`).join('\n')}`
        : '';
    const digest =
      historyView
        ? `\nsummary\n- ${historyView.digest.headline}\n- ${historyView.digest.detail}${historyView.digest.history_blurb ? `\n- ${historyView.digest.history_blurb}` : ''}`
        : '';
    const recentHistory =
      historyView && historyView.entries.length > 0
        ? `\nhistory replay\n${historyView.entries.map((entry) => `- ${entry.title} · ${entry.summary}`).join('\n')}`
        : '';
    const governanceSuggestions = formatGovernanceSuggestions(issue);

    return {
      message: `${summary}${governanceSuggestions ? `\n${governanceSuggestions}` : ''}${digest}${recentTimeline}${recentHistory}`,
      issue_id: issue.issue_id,
    };
  }

  private async handleNew(
    context: BotCommandContext,
    input?: CreateIssueRequest | null,
    rawText?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }

    const title = input?.title?.trim() || '';
    if (!title) {
      return {
        message: `Issue title is required.\n${listCommands()}`,
      };
    }

    const defaultProjectSlug = this.preferences?.findByConversation({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    })?.default_project_slug ?? null;
    const requestedProjectSlug = this.normalizeProjectSlugReference(
      input?.project_slug?.trim() || defaultProjectSlug,
    );

    if (!requestedProjectSlug && !input?.project_id) {
      const availableProjects = this.projectResolver?.listConfiguredProjectSlugs() ?? [];
      return {
        message: availableProjects.length > 0
          ? `A default project is required before creating issues. Use /project <slug> or specify one in this request. Available projects: ${availableProjects.join(', ')}.`
          : 'A default project is required before creating issues. Use /project <slug> first.',
      };
    }

    if (requestedProjectSlug && this.projectResolver) {
      const resolved = await this.projectResolver.resolveProjectSlug(requestedProjectSlug);
      if (!resolved.project) {
        return {
          message: resolved.error || `Project slug "${requestedProjectSlug}" could not be resolved.`,
        };
      }
    }

    const result = await this.runtime.createIssue({
      title,
      description: input?.description ?? null,
      team_id: input?.team_id ?? null,
      project_slug: requestedProjectSlug,
      project_id: input?.project_id ?? null,
      state_id: input?.state_id ?? null,
    });

    if (!result.accepted) {
      return {
        message: `Create failed: ${result.message}`,
      };
    }

    const issue = (result.issue_id ? this.runtime.getIssue(result.issue_id) : null) ?? result.issue;
    if (result.accepted && result.issue_id && context.transport === 'telegram') {
      this.followups?.upsert({
        transport: context.transport,
        conversation_id: context.recipient.conversation_id,
        issue_id: result.issue_id,
        issue_identifier: result.issue_identifier ?? issue?.identifier ?? null,
        user_id: context.identity.user_id,
        role: 'origin',
      });
    }

    const message = formatIssueCreatedMessage({
      issue,
      issueIdentifier: result.issue_identifier,
      input,
      rawText,
    });
    if (issue) {
      const visual = buildSupervisorIssueVisualCard(issue, { theme: cardThemeForContext(context) });
      return {
        message,
        caption: visual.caption,
        format: 'telegram_html',
        media_key: visual.media_key,
        photo: visual.photo,
        show_caption_above_media: false,
        action_rows: buildIssueCardActionRows(issue),
        issue_id: result.issue_id ?? issue.issue_id,
      };
    }

    return {
      message,
      issue_id: result.issue_id,
    };
  }

  private async handleProject(
    context: BotCommandContext,
    projectSlug?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.preferences) {
      return {
        message: 'Project preferences are not configured for this SymHarix server.',
      };
    }

    const key = {
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
    } as const;
    const current = this.preferences.findByConversation(key);
    const normalized = this.normalizeProjectSlugReference(projectSlug);

    if (!normalized) {
      const available = this.projectResolver?.listConfiguredProjectSlugs() ?? [];
      return {
        message: current?.default_project_slug
          ? `Default project: ${current.default_project_slug}${available.length > 0 ? `\nAvailable projects: ${available.join(', ')}` : ''}`
          : `No default project is set.${available.length > 0 ? ` Available projects: ${available.join(', ')}` : ''}`,
      };
    }

    if (normalized.toLowerCase() === 'clear') {
      this.preferences.delete(key);
      return {
        message: 'Cleared the default project for this chat.',
      };
    }

    if (this.projectResolver) {
      const resolved = await this.projectResolver.resolveProjectSlug(normalized);
      if (!resolved.project) {
        return {
          message: resolved.error || `Project slug "${normalized}" could not be resolved.`,
        };
      }

      this.preferences.upsert({
        ...key,
        default_project_slug: normalized,
      });
      return {
        message: `Default project set to ${normalized}${resolved.route ? ` · ${resolved.route.github_repo_full}` : ''}`,
      };
    }

    this.preferences.upsert({
      ...key,
      default_project_slug: normalized,
    });
    return {
      message: `Default project set to ${normalized}`,
    };
  }

  private async handleWatch(
    context: BotCommandContext,
    issueId?: string | null,
    watchPreset?: BotWatchPreset | null,
  ): Promise<BotCommandResponse> {
    if (!this.subscriptions.canWatch(context.transport)) {
      return {
        message: `${context.transport} watch notifications are not configured on this SymHarix server.`,
      };
    }

    const issue = resolveIssue(this.runtime, issueId);
    if (!issue) {
      return {
        message: issueId
          ? `Issue ${issueId} was not found.`
          : `Issue id is required.\n${listCommands()}`,
      };
    }

    const { created } = this.subscriptions.watch({
      recipient: context.recipient,
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      user_id: context.identity.user_id,
      preset: watchPreset ?? 'default',
    });

    return {
      message: `${created ? 'Watching' : 'Already watching'} ${issue.identifier} · preset ${watchPreset ?? 'default'}\n${formatIssue(issue)}`,
      issue_id: issue.issue_id,
      watch_registered: true,
    };
  }

  private async handleUnwatch(
    context: BotCommandContext,
    issueId?: string | null,
  ): Promise<BotCommandResponse> {
    const issue = resolveIssue(this.runtime, issueId);
    const resolvedIssueId = issue?.issue_id ?? issueId ?? null;
    if (!resolvedIssueId) {
      return {
        message: `Issue id is required.\n${listCommands()}`,
      };
    }

    const removed = this.subscriptions.unwatch({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
      issue_id: resolvedIssueId,
    });

    return {
      message: removed
        ? `Stopped watching ${issue?.identifier || issueId}.`
        : `No active watch was registered for ${issue?.identifier || issueId}.`,
      issue_id: resolvedIssueId,
      watch_registered: false,
    };
  }

  private async handleStop(
    context: BotCommandContext,
    issueId?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }

    if (!issueId) {
      return {
        message: `Issue id is required.\n${listCommands()}`,
      };
    }

    const result = await this.runtime.stopIssue(issueId);
    this.registerOriginFollowup(context, result);
    const issue = (result.issue_id ? this.runtime.getIssue(result.issue_id) : null) ?? resolveIssue(this.runtime, issueId);
    if (issue) {
      const visual = buildSupervisorIssueVisualCard(issue, { theme: cardThemeForContext(context) });
      return {
        message: result.message,
        caption: visual.caption,
        format: 'telegram_html',
        media_key: visual.media_key,
        photo: visual.photo,
        show_caption_above_media: false,
        action_rows: buildIssueCardActionRows(issue),
        issue_id: result.issue_id,
      };
    }
    return {
      message: result.message,
      issue_id: result.issue_id,
    };
  }

  private async handleRetry(
    context: BotCommandContext,
    issueId?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }

    if (!issueId) {
      return {
        message: `Issue id is required.\n${listCommands()}`,
      };
    }

    const result = await this.runtime.retryIssue(issueId);
    this.registerOriginFollowup(context, result);
    return {
      message: result.message,
      issue_id: result.issue_id,
    };
  }

  private async handleCloseIssue(
    context: BotCommandContext,
    issueId?: string | null,
    reason?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }

    if (!issueId) {
      return {
        message: `Issue id is required.\n${listCommands()}`,
      };
    }

    const result = await this.runtime.closeIssue(issueId, {
      reason: reason ?? 'Closed from bot command.',
    });
    this.registerOriginFollowup(context, result);
    return {
      message: result.message,
      issue_id: result.issue_id,
    };
  }

  private async handleSupersedeIssue(
    context: BotCommandContext,
    issueId?: string | null,
    successorIssueId?: string | null,
    reason?: string | null,
    retrySuccessor?: boolean | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }

    if (!issueId || !successorIssueId) {
      return {
        message: `Old and successor issue ids are required.\n${listCommands()}`,
      };
    }

    const result = await this.runtime.closeIssue(issueId, {
      successor_issue_id: successorIssueId,
      reason: reason ?? 'Superseded from bot command.',
    });
    this.registerOriginFollowup(context, result);
    if (retrySuccessor) {
      const retryResult = await this.runtime.retryIssue(successorIssueId);
      this.registerOriginFollowup(context, retryResult);
      return {
        message: `${result.message}\n${retryResult.message}`,
        issue_id: retryResult.issue_id,
      };
    }
    return {
      message: result.message,
      issue_id: result.issue_id,
    };
  }

  private async handleOverride(
    context: BotCommandContext,
    issueId?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }

    if (!issueId) {
      return {
        message: `Issue id is required.\n${listCommands()}`,
      };
    }

    const result = await this.runtime.overrideGovernance(issueId);
    this.registerOriginFollowup(context, result);
    return {
      message: result.message,
      issue_id: result.issue_id,
    };
  }

  private async handleRewrite(
    context: BotCommandContext,
    issueId?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }

    if (!issueId) {
      return {
        message: `Issue id is required.\n${listCommands()}`,
      };
    }

    const result = await this.runtime.rewriteGovernance(issueId);
    this.registerOriginFollowup(context, result);
    return {
      message: result.message,
      issue_id: result.issue_id,
    };
  }

  private async handleSplit(
    context: BotCommandContext,
    issueId?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }

    if (!issueId) {
      return {
        message: `Issue id is required.\n${listCommands()}`,
      };
    }

    const result = await this.runtime.splitGovernance(issueId);
    this.registerOriginFollowup(context, result);
    return {
      message: result.message,
      issue_id: result.issue_id,
    };
  }

  private async handleExecuteGovernanceSuggestion(
    context: BotCommandContext,
    issueId?: string | null,
    suggestionId?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }
    if (!issueId || !suggestionId) {
      return {
        message: 'Issue id and suggestion id are required to execute a governance suggestion.',
      };
    }

    const result = await this.runtime.executeGovernanceSuggestion(issueId, suggestionId);
    this.registerOriginFollowup(context, result);
    return {
      message: result.message,
      issue_id: result.issue_id,
    };
  }

  private async handleDismissGovernanceSuggestion(
    context: BotCommandContext,
    issueId?: string | null,
    suggestionId?: string | null,
  ): Promise<BotCommandResponse> {
    if (!this.canWrite(context)) {
      return {
        message: `${context.transport} is configured as read-only for this user. Allowed commands: help, status, watch, unwatch.`,
      };
    }
    if (!issueId || !suggestionId) {
      return {
        message: 'Issue id and suggestion id are required to dismiss a governance suggestion.',
      };
    }

    const result = await this.runtime.dismissGovernanceSuggestion(issueId, suggestionId);
    this.registerOriginFollowup(context, result);
    return {
      message: result.message,
      issue_id: result.issue_id,
    };
  }

  private registerOriginFollowup(
    context: BotCommandContext,
    result: { accepted: boolean; issue_id: string | null; issue_identifier: string | null },
  ): void {
    if (!result.accepted || !result.issue_id || context.transport !== 'telegram') {
      return;
    }

    this.followups?.upsert({
      transport: context.transport,
      conversation_id: context.recipient.conversation_id,
      issue_id: result.issue_id,
      issue_identifier: result.issue_identifier,
      user_id: context.identity.user_id,
      role: 'origin',
    });
  }
}
