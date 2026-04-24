import {
  BotConversationPreferenceRepository,
  type BotFollowupMessageStateRepository,
  BotPendingActionRepository,
} from '../database';
import { logger } from '../logging';
import type { RuntimeControlPlane } from '../runtime/types';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { assessIntakeCritic } from '../governance/intakeCritic';
import type {
  BotAssistantDiagnostics,
  BotAssistantDecision,
  BotAssistantIntent,
  BotAssistantModelOutput,
  BotCommandContext,
  BotCommandRequest,
  BotCommandResponse,
  BotFocusedIssueContext,
  BotRuntimeCopilotContext,
} from './types';
import { BotCommandService } from './commandService';
import { buildGovernanceQuickActions, toGovernanceQuickActionIntent } from './governanceQuickActions';
import type { BotSubscriptionService } from './subscriptions';
import { BotRuntimeContextService } from './runtimeContext';
import { createBotAssistantModelFromEnv, type BotAssistantModel } from './model';

const CONFIRM_WORDS = new Set(['确认', 'yes', 'y', 'ok', 'okay', '好', '执行', '继续', 'confirm']);
const CANCEL_WORDS = new Set(['取消', 'cancel', 'no', 'n', '停止']);
const TRANSPARENT_FALLBACK_NOTICE = '当前自然语言模型暂不可用，已切换到简化理解模式。';
const SUGGESTION_TYPE_ALIASES: Record<string, string[]> = {
  cleanup: ['cleanup', '清理'],
  consolidation: ['consolidation', '整合', '收口'],
  architecture_alignment: ['architecture alignment', 'alignment', '架构对齐', 'realign'],
  constitution_update: ['constitution update', 'constitution_update', '宪法更新', 'constitution'],
  harness_adoption: ['harness adoption', 'harness_adoption', 'repo harness', 'harness'],
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function compact(value: string, maxLength = 300): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function extractIssueIdentifier(text: string): string | null {
  const match = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/i);
  return match ? match[0].toUpperCase() : null;
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
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function isConfirmation(text: string): boolean {
  return CONFIRM_WORDS.has(text.trim().toLowerCase());
}

function isCancellation(text: string): boolean {
  return CANCEL_WORDS.has(text.trim().toLowerCase());
}

function buildConfirmActions() {
  return [
    {
      label: '确认执行',
      callback_data: 'pending|confirm',
    },
    {
      label: '取消',
      callback_data: 'pending|cancel',
    },
  ] as const;
}

function coerceIntent(value: Record<string, unknown> | null): BotAssistantIntent | null {
  if (!value || typeof value.intent !== 'object' || value.intent === null) {
    return null;
  }

  const intent = value.intent as Record<string, unknown>;
  const kind = typeof intent.kind === 'string' ? intent.kind : null;
  if (!kind) {
    return null;
  }

  switch (kind) {
    case 'create_issue':
      if (typeof intent.title !== 'string' || !intent.title.trim()) {
        return null;
      }
      return {
        kind,
        title: intent.title.trim(),
        description:
          typeof intent.description === 'string' && intent.description.trim()
            ? intent.description.trim()
            : null,
        project_slug:
          typeof intent.project_slug === 'string' && intent.project_slug.trim()
            ? intent.project_slug.trim()
            : null,
      };
    case 'status':
    case 'watch':
    case 'unwatch':
    case 'stop':
    case 'retry':
    case 'override':
    case 'rewrite':
    case 'split':
      return {
        kind,
        issue_id:
          typeof intent.issue_id === 'string' && intent.issue_id.trim()
            ? intent.issue_id.trim()
            : null,
        ...(kind === 'watch' && typeof intent.watch_preset === 'string'
          ? { watch_preset: intent.watch_preset as 'default' | 'verbose' | 'failures' | 'status' }
          : {}),
      };
    case 'set_default_project':
      return {
        kind,
        project_slug:
          typeof intent.project_slug === 'string' && intent.project_slug.trim()
            ? intent.project_slug.trim()
            : null,
      };
    case 'execute_governance_suggestion':
    case 'dismiss_governance_suggestion':
      return {
        kind,
        issue_id:
          typeof intent.issue_id === 'string' && intent.issue_id.trim()
            ? intent.issue_id.trim()
            : null,
        suggestion_id:
          typeof intent.suggestion_id === 'string' && intent.suggestion_id.trim()
            ? intent.suggestion_id.trim()
            : null,
        suggestion_type:
          typeof intent.suggestion_type === 'string' && intent.suggestion_type.trim()
            ? intent.suggestion_type.trim()
            : null,
        ordinal:
          typeof intent.ordinal === 'number' && Number.isFinite(intent.ordinal)
            ? Math.max(1, Math.trunc(intent.ordinal))
            : null,
      };
    case 'show_default_project':
    case 'help':
      return { kind };
    case 'answer_question':
      if (typeof intent.answer !== 'string' || !intent.answer.trim()) {
        return null;
      }
      return {
        kind,
        answer: intent.answer.trim(),
      };
    case 'clarify':
      if (typeof intent.question !== 'string' || !intent.question.trim()) {
        return null;
      }
      return {
        kind,
        question: intent.question.trim(),
      };
    default:
      return null;
  }
}

function isDecisionOutput(value: BotAssistantModelOutput): value is BotAssistantDecision {
  return Boolean(value) && typeof value === 'object' && 'intent' in value;
}

function defaultDiagnostics(): BotAssistantDiagnostics {
  return {
    provider: null,
    model: null,
    configured: false,
    health: 'unconfigured',
    fallback_available: true,
    last_error_code: 'unconfigured',
  };
}

function normalizeModel(model?: BotAssistantModel): BotAssistantModel {
  if (model) {
    return {
      decide: model.decide.bind(model),
      getDiagnostics: model.getDiagnostics ? model.getDiagnostics.bind(model) : undefined,
    };
  }

  return createBotAssistantModelFromEnv();
}

function toPendingRequest(intent: BotAssistantIntent): BotCommandRequest | null {
  switch (intent.kind) {
    case 'create_issue':
      return {
        command: 'new',
        project_slug: intent.project_slug,
        create_issue: {
          title: intent.title,
          description: intent.description,
          project_slug: intent.project_slug,
        },
      };
    case 'watch':
      return {
        command: 'watch',
        issue_id: intent.issue_id,
        watch_preset: intent.watch_preset ?? null,
      };
    case 'unwatch':
    case 'stop':
    case 'retry':
    case 'override':
    case 'rewrite':
    case 'split':
      return {
        command: intent.kind,
        issue_id: intent.issue_id,
      };
    case 'set_default_project':
      return {
        command: 'project',
        project_slug: intent.project_slug || 'clear',
      };
    case 'execute_governance_suggestion':
      return {
        command: 'execute_governance_suggestion',
        issue_id: intent.issue_id,
        suggestion_id: intent.suggestion_id,
      };
    case 'dismiss_governance_suggestion':
      return {
        command: 'dismiss_governance_suggestion',
        issue_id: intent.issue_id,
        suggestion_id: intent.suggestion_id,
      };
    default:
      return null;
  }
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

function summarizeActiveIssues(context: BotRuntimeCopilotContext): string {
  if (context.overview.active_issues.length === 0) {
    return `当前没有活跃 issue。running=${context.overview.running}，retrying=${context.overview.retrying}。`;
  }

  return [
    `当前活跃 issue（running=${context.overview.running}，retrying=${context.overview.retrying}）：`,
    ...context.overview.active_issues.map((issue) => [
      `${issue.identifier} · ${issue.title}`,
      [issue.phase, issue.tracker_state, issue.orchestrator_state || 'unknown', issue.github_repo]
        .filter(Boolean)
        .join(' · '),
    ].join('\n')),
  ].join('\n');
}

function summarizeIssueActivity(focusIssue: BotFocusedIssueContext): string {
  const latestTimeline = focusIssue.recent_timeline[focusIssue.recent_timeline.length - 1] ?? null;
  return [
    `${focusIssue.issue.identifier} · ${focusIssue.issue.title}`,
    [focusIssue.issue.phase, focusIssue.issue.tracker_state, focusIssue.issue.orchestrator_state || 'unknown'].join(' · '),
    focusIssue.issue.github_repo ? `仓库：${focusIssue.issue.github_repo}` : null,
    focusIssue.issue.architectural_target ? `架构目标：${focusIssue.issue.architectural_target}` : null,
    focusIssue.issue.boundary_edges.length > 0 ? `边界：${focusIssue.issue.boundary_edges.join(' · ')}` : null,
    focusIssue.issue.import_edges.length > 0 ? `依赖边：${focusIssue.issue.import_edges.join(' · ')}` : null,
    focusIssue.issue.repo_harness_status
      ? `Harness：${focusIssue.issue.repo_harness_status.status}${focusIssue.issue.repo_harness_status.learning_confidence ? ` · learning=${focusIssue.issue.repo_harness_status.learning_confidence}` : ''} · commands=${focusIssue.issue.repo_harness_status.learned_command_count} · artifacts=${focusIssue.issue.repo_harness_status.learned_artifact_count} · hints=${focusIssue.issue.repo_harness_status.learned_runtime_hint_count}`
      : null,
    focusIssue.issue.fitness_signals.length > 0 ? `Fitness signals：${focusIssue.issue.fitness_signals.join(', ')}` : null,
    focusIssue.issue.session_stage
      ? `当前阶段：${focusIssue.issue.session_stage}${focusIssue.issue.session_message ? ` · ${focusIssue.issue.session_message}` : ''}`
      : null,
    focusIssue.governance?.suggestions?.length
      ? `治理建议：${focusIssue.governance.suggestions.map((suggestion, index) => `[${index + 1}] ${suggestion.suggestion_type} (${suggestion.id})`).join(' · ')}`
      : null,
    latestTimeline ? `最近事件：${latestTimeline.message}` : null,
    focusIssue.digest?.detail || null,
  ].filter(Boolean).join('\n');
}

function explainBlockedIssue(focusIssue: BotFocusedIssueContext): string {
  const governanceDetail = focusIssue.governance?.summary
    ? `治理判断：${focusIssue.governance.summary}`
    : null;
  const governanceSuggestion = focusIssue.governance?.suggestions?.[0]
    ? `建议：${focusIssue.governance.suggestions[0].summary}`
    : null;
  const latestTimeline = focusIssue.recent_timeline[focusIssue.recent_timeline.length - 1] ?? null;
  const reason =
    governanceDetail ||
    focusIssue.digest?.detail ||
    focusIssue.digest?.history_blurb ||
    latestTimeline?.message ||
    focusIssue.issue.session_message ||
    '当前没有更多可用的阻塞诊断。';

  return [
    `${focusIssue.issue.identifier} 当前看起来卡在 ${focusIssue.issue.orchestrator_state || focusIssue.issue.tracker_state}。`,
    focusIssue.issue.github_repo ? `仓库：${focusIssue.issue.github_repo}` : null,
    focusIssue.issue.architectural_target ? `当前命中的架构目标：${focusIssue.issue.architectural_target}` : null,
    focusIssue.issue.fitness_signals.length > 0 ? `相关 repo signals：${focusIssue.issue.fitness_signals.join(', ')}` : null,
    `原因：${reason}`,
    governanceSuggestion,
  ].filter(Boolean).join('\n');
}

function explainGovernanceNextStep(focusIssue: BotFocusedIssueContext): string {
  const governance = focusIssue.governance;
  if (!governance || (!governance.summary && governance.suggestions.length === 0)) {
    return [
      `${focusIssue.issue.identifier} 目前没有额外的治理改写建议。`,
      focusIssue.digest?.detail || '可以先看 runtime history 或 recent timeline 了解当前状态。',
    ].filter(Boolean).join('\n');
  }

  return [
    `${focusIssue.issue.identifier} 当前的治理状态是 ${governance.decision || governance.status || 'unknown'}。`,
    governance.thread_state === 'waiting_on_child' && governance.child_issues[0]
      ? `当前源单还在等治理子任务 ${governance.child_issues[0].issue_identifier}，所以不会继续自动开发。`
      : null,
    governance.summary ? `原因：${governance.summary}` : null,
    governance.suggestions[0] ? `建议：${governance.suggestions[0].summary}` : null,
    governance.suggestions[1] ? `备选：${governance.suggestions[1].summary}` : null,
    governance.child_issues.length > 0
      ? `治理子任务：${governance.child_issues.map((child) => `${child.issue_identifier} · ${child.title}`).join('；')}`
      : null,
    governance.next_recommended_action ? `下一步：${governance.next_recommended_action}` : null,
    governance.suggestions.length > 0
      ? `可引用建议：${governance.suggestions.map((suggestion, index) => `[${index + 1}] ${suggestion.suggestion_type} (${suggestion.id})`).join(' · ')}`
      : null,
  ].filter(Boolean).join('\n');
}

function explainGovernanceChildIssuePurpose(focusIssue: BotFocusedIssueContext): string {
  const firstChild = focusIssue.governance?.child_issues?.[0] ?? null;
  if (!firstChild) {
    return explainGovernanceNextStep(focusIssue);
  }

  return [
    `${firstChild.issue_identifier} 是为 ${focusIssue.issue.identifier} 拆出来的治理子任务。`,
    `用途：${firstChild.title}`,
    firstChild.governance_summary ? `当前状态：${firstChild.governance_summary}` : `当前状态：${firstChild.tracker_state}`,
    `为什么源单还没继续：${focusIssue.issue.identifier} 还在等待这个子任务先收口。`,
    focusIssue.governance?.next_recommended_action ? `最推荐下一步：${focusIssue.governance.next_recommended_action}` : null,
  ].filter(Boolean).join('\n');
}

function extractOrdinal(text: string): number | null {
  const normalized = text.toLowerCase();
  if (/\bfirst\b|1st|第一个|第一条|第1个|第1条/.test(normalized)) {
    return 1;
  }
  if (/\bsecond\b|2nd|第二个|第二条|第2个|第2条/.test(normalized)) {
    return 2;
  }

  const match = normalized.match(/第\s*(\d+)\s*(个|条)?/);
  if (!match?.[1]) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractBareOrdinal(text: string): number | null {
  const normalized = text.trim();
  const match = normalized.match(/^(?:[A-Z][A-Z0-9]+-\d+\s+)?([1-3])$/i);
  if (!match?.[1]) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function detectSuggestionType(text: string): string | null {
  const normalized = text.toLowerCase();
  for (const [type, aliases] of Object.entries(SUGGESTION_TYPE_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(alias.toLowerCase()))) {
      return type;
    }
  }
  return null;
}

function formatGovernanceSuggestionChoices(focusIssue: BotFocusedIssueContext): string {
  return focusIssue.governance?.suggestions.map((suggestion, index) => (
    `[${index + 1}] ${suggestion.suggestion_type} · ${suggestion.title} · id ${suggestion.id}`
  )).join('\n') ?? '';
}

function buildHeuristicDecision(
  text: string,
  context: BotRuntimeCopilotContext,
): BotAssistantDecision {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rest = lines.slice(1).join('\n').trim() || null;
  const issueId = extractIssueIdentifier(trimmed);
  const availableProjectSlugs = context.available_projects.map((item) => item.project_slug);
  const explicitProject = resolveProjectAlias(trimmed, context.available_projects);
  const focusIssue = context.focus_issue;
  const bareOrdinal = extractBareOrdinal(trimmed);

  if (bareOrdinal && focusIssue) {
    const runtimeLikeIssue = {
      issue_id: focusIssue.issue.issue_id,
      work_item_id: null,
      identifier: focusIssue.issue.identifier,
      title: focusIssue.issue.title,
      phase: focusIssue.issue.phase,
      tracker_state: focusIssue.issue.tracker_state,
      orchestrator_state: focusIssue.issue.orchestrator_state,
      workspace_path: null,
      branch_name: focusIssue.issue.branch_name,
      github_repo: focusIssue.issue.github_repo,
      github_issue_number: null,
      active_pr_number: focusIssue.issue.active_pr_number,
      session: null,
      repo_harness_status: null,
      constitution_status: null,
      change_pack_summary: null,
      task_status: null,
      evidence_summary: null,
      missing_requirements: [],
      architectural_target: focusIssue.issue.architectural_target,
      path_families: focusIssue.issue.path_families,
      boundary_edges: focusIssue.issue.boundary_edges,
      import_edges: focusIssue.issue.import_edges,
      governance_status: focusIssue.governance?.status ?? null,
      governance_decision: focusIssue.governance?.decision ?? null,
      governance_summary: focusIssue.governance?.summary ?? null,
      constitution_hits: [],
      fitness_signals: [],
      active_governance_suggestions: (focusIssue.governance?.suggestions ?? []).map((suggestion) => ({
        id: suggestion.id,
        suggestion_type: suggestion.suggestion_type as any,
        status: suggestion.status as any,
        title: suggestion.title,
        summary: suggestion.summary,
        can_execute: suggestion.can_execute,
        can_dismiss: suggestion.can_dismiss,
      })),
      governance_override: null,
      actions: {
        can_stop: false,
        can_retry: false,
        can_override_governance: Boolean(
          focusIssue.issue.orchestrator_state === 'halted' &&
          focusIssue.governance?.decision &&
          focusIssue.governance.decision !== 'accept',
        ),
        can_rewrite_governance: focusIssue.governance?.decision === 'accept_with_rewrite',
        can_split_governance: focusIssue.governance?.decision === 'split_before_implement',
        can_open_pr: false,
      },
      created_at: null,
      updated_at: null,
    } as const;
    const action = buildGovernanceQuickActions(runtimeLikeIssue as any)[bareOrdinal - 1];
    if (action) {
      return {
        intent: toGovernanceQuickActionIntent(action),
      };
    }
  }

  if (/如何设置默认项目|default project|怎么设置项目/i.test(trimmed)) {
    return {
      intent: {
        kind: 'answer_question',
        answer: context.default_project_slug
          ? `当前默认项目是 ${context.default_project_slug}。${availableProjectSlugs.length > 0 ? `可用项目：${availableProjectSlugs.join(', ')}。用 /project <slug> 可以切换。` : ''}`
          : availableProjectSlugs.length > 0
            ? `当前还没有默认项目。用 /project <slug> 设置，例如 /project ${availableProjectSlugs[0]}。可用项目：${availableProjectSlugs.join(', ')}。`
            : '当前还没有默认项目。用 /project <slug> 设置默认项目。',
      },
    };
  }

  if (/清空默认项目/i.test(trimmed)) {
    return {
      intent: {
        kind: 'set_default_project',
        project_slug: null,
      },
    };
  }

  if (/默认项目设为|以后都建到|默认用/i.test(trimmed) && explicitProject) {
    return {
      intent: {
        kind: 'set_default_project',
        project_slug: explicitProject,
      },
    };
  }

  if (/当前有哪些活跃 issue|当前有哪些 issue|what.?s running|active issues|现在在跑什么/i.test(trimmed)) {
    return {
      intent: {
        kind: 'answer_question',
        answer: summarizeActiveIssues(context),
      },
    };
  }

  if ((focusIssue && /现在在干嘛|现在在做什么|在做什么|what.*doing/i.test(trimmed)) || /^现在在干嘛/.test(trimmed)) {
    return {
      intent: {
        kind: 'answer_question',
        answer: focusIssue ? summarizeIssueActivity(focusIssue) : summarizeActiveIssues(context),
      },
    };
  }

  if (focusIssue && /为什么没跑|为什么没开始|卡在哪|卡住|stuck|blocked|why .*run/i.test(trimmed)) {
    return {
      intent: {
        kind: 'answer_question',
        answer: explainBlockedIssue(focusIssue),
      },
    };
  }

  if (focusIssue && /怎么改|怎么拆|如何修改|如何拆分|next step|what should.*do|how should.*rewrite/i.test(trimmed)) {
    return {
      intent: {
        kind: 'answer_question',
        answer: explainGovernanceNextStep(focusIssue),
      },
    };
  }

  if (
    focusIssue &&
    focusIssue.governance?.thread_state === 'waiting_on_child' &&
    /这个新单|这个子单|新单.*干嘛|子单.*干嘛|为什么创建.*子单|这个新 issue/i.test(trimmed)
  ) {
    return {
      intent: {
        kind: 'answer_question',
        answer: explainGovernanceChildIssuePurpose(focusIssue),
      },
    };
  }

  if (
    focusIssue &&
    focusIssue.governance?.status === 'blocked' &&
    /override|忽略治理|忽略拦截|强制继续|继续跑|继续执行|skip governance/i.test(trimmed)
  ) {
    return {
      intent: {
        kind: 'override',
        issue_id: focusIssue.issue.identifier,
      },
    };
  }

  if (
    focusIssue &&
    focusIssue.governance?.decision === 'accept_with_rewrite' &&
    /改写|重写|rewrite|按建议改写/i.test(trimmed)
  ) {
    return {
      intent: {
        kind: 'rewrite',
        issue_id: focusIssue.issue.identifier,
      },
    };
  }

  if (
    focusIssue &&
    focusIssue.governance?.decision === 'split_before_implement' &&
    /拆分|拆掉|split/i.test(trimmed)
  ) {
    return {
      intent: {
        kind: 'split',
        issue_id: focusIssue.issue.identifier,
      },
    };
  }

  const governanceActionWords = /治理建议|suggestion|cleanup|consolidation|constitution|harness|architecture/i.test(trimmed);
  if (governanceActionWords && /忽略|dismiss|skip|ignore/i.test(trimmed)) {
    return {
      intent: {
        kind: 'dismiss_governance_suggestion',
        issue_id: issueId || focusIssue?.issue.identifier || null,
        suggestion_id: focusIssue?.governance?.suggestions.find((suggestion) => trimmed.includes(suggestion.id.toLowerCase()))?.id ?? null,
        suggestion_type: detectSuggestionType(trimmed),
        ordinal: extractOrdinal(trimmed),
      },
    };
  }

  if (governanceActionWords && /执行|接受掉|接受|采纳|apply|execute|run/i.test(trimmed)) {
    return {
      intent: {
        kind: 'execute_governance_suggestion',
        issue_id: issueId || focusIssue?.issue.identifier || null,
        suggestion_id: focusIssue?.governance?.suggestions.find((suggestion) => trimmed.includes(suggestion.id.toLowerCase()))?.id ?? null,
        suggestion_type: detectSuggestionType(trimmed),
        ordinal: extractOrdinal(trimmed),
      },
    };
  }

  if (issueId && /现在怎么样|状态|status|进度|哪个仓库|分配到哪个仓库/i.test(trimmed)) {
    if (/哪个仓库|分配到哪个仓库/i.test(trimmed) && focusIssue) {
      return {
        intent: {
          kind: 'answer_question',
          answer: focusIssue.issue.github_repo
            ? `${focusIssue.issue.identifier} 当前路由到 ${focusIssue.issue.github_repo}。`
            : `${focusIssue.issue.identifier} 目前还没有分配到仓库，github_repo 还是空的。`,
        },
      };
    }

    return {
      intent: {
        kind: 'status',
        issue_id: issueId,
      },
    };
  }

  if (/写一个|创建.*issue|建单|新建任务|new\s+/i.test(trimmed)) {
    const title = lines[0] || trimmed;
    return {
      intent: {
        kind: 'create_issue',
        title,
        description: rest,
        project_slug: explicitProject || context.default_project_slug,
      },
    };
  }

  if (focusIssue && focusIssue.governance?.status === 'blocked') {
    return {
      intent: {
        kind: 'answer_question',
        answer: explainGovernanceNextStep(focusIssue),
      },
    };
  }

  return {
    intent: {
      kind: 'help',
    },
  };
}

function parseModelDecision(output: BotAssistantModelOutput): BotAssistantDecision | null {
  if (!output) {
    return null;
  }

  if (isDecisionOutput(output)) {
    return output;
  }

  if (typeof output === 'string') {
    const intent = coerceIntent(extractJsonObject(output));
    return intent ? { intent } : null;
  }

  return null;
}

function prefixFallbackNotice(message: string, diagnostics: BotAssistantDiagnostics, usedFallback: boolean): string {
  if (!usedFallback || diagnostics.health === 'healthy') {
    return message;
  }
  return `${TRANSPARENT_FALLBACK_NOTICE}\n${message}`;
}

function buildScopedHelp(context: BotRuntimeCopilotContext, originalText: string): string {
  const availableProjects = context.available_projects.map((project) => project.project_slug);
  return [
    '我主要负责 Symphony 控制面：建单、查状态、看仓库路由、设置默认项目、stop/retry/watch，以及治理相关的 rewrite/split/override。',
    context.default_project_slug ? `当前默认项目：${context.default_project_slug}` : null,
    availableProjects.length > 0 ? `可用项目：${availableProjects.join(', ')}` : null,
    context.overview.active_issues.length > 0 ? `当前活跃 issue 数：${context.overview.active_issues.length}` : null,
    `未识别请求：${compact(normalizeText(originalText), 160)}`,
    '你可以直接说“INT-31 现在怎么样了”、“仓库 test2 建一个 issue”、“执行第一个治理建议”，或者用 /project /status /new 这些命令。',
  ].filter(Boolean).join('\n');
}

function resolveGovernanceSuggestionIssue(
  runtime: RuntimeControlPlane,
  runtimeContext: BotRuntimeCopilotContext,
  requestedIssueId: string | null,
): ReturnType<RuntimeControlPlane['getIssue']> {
  if (requestedIssueId) {
    return runtime.getIssue(requestedIssueId);
  }

  if (runtimeContext.focus_issue) {
    return runtime.getIssue(runtimeContext.focus_issue.issue.issue_id);
  }

  if (runtimeContext.overview.active_issues.length === 1) {
    return runtime.getIssue(runtimeContext.overview.active_issues[0]!.issue_id);
  }

  return null;
}

function resolveGovernanceSuggestionSelection(params: {
  intent: Extract<BotAssistantIntent, { kind: 'execute_governance_suggestion' | 'dismiss_governance_suggestion' }>;
  issue: NonNullable<ReturnType<RuntimeControlPlane['getIssue']>>;
}): {
  suggestion: NonNullable<NonNullable<ReturnType<RuntimeControlPlane['getIssue']>>['active_governance_suggestions']>[number] | null;
  error: string | null;
} {
  const suggestions = params.issue.active_governance_suggestions ?? [];
  if (suggestions.length === 0) {
    return {
      suggestion: null,
      error: `${params.issue.identifier} 当前没有可操作的治理建议。`,
    };
  }

  if (params.intent.suggestion_id) {
    const suggestion = suggestions.find((item) => item.id === params.intent.suggestion_id) ?? null;
    return suggestion
      ? { suggestion, error: null }
      : { suggestion: null, error: `没有找到 suggestion id=${params.intent.suggestion_id}。` };
  }

  if (params.intent.suggestion_type) {
    const normalizedType = params.intent.suggestion_type.toLowerCase();
    const suggestion = suggestions.find((item) => item.suggestion_type.toLowerCase() === normalizedType) ?? null;
    return suggestion
      ? { suggestion, error: null }
      : { suggestion: null, error: `没有找到 type=${params.intent.suggestion_type} 的治理建议。` };
  }

  if (params.intent.ordinal) {
    const suggestion = suggestions[params.intent.ordinal - 1] ?? null;
    return suggestion
      ? { suggestion, error: null }
      : { suggestion: null, error: `没有第 ${params.intent.ordinal} 个治理建议。` };
  }

  return {
    suggestion: null,
    error: `请明确指定要操作的治理建议：\n${suggestions.map((item, index) => `[${index + 1}] ${item.suggestion_type} · ${item.title} · id ${item.id}`).join('\n')}`,
  };
}

export class BotAssistantService {
  private readonly runtimeContext: BotRuntimeContextService;
  private readonly model: BotAssistantModel;

  constructor(
    private readonly runtime: RuntimeControlPlane,
    private readonly commandService: BotCommandService,
    private readonly preferences: BotConversationPreferenceRepository | null,
    private readonly pendingActions: BotPendingActionRepository | null,
    private readonly projectResolver: TrackerProjectResolutionService | null,
    model?: BotAssistantModel,
    private readonly canWrite: (context: BotCommandContext) => boolean = () => true,
    subscriptions: Pick<BotSubscriptionService, 'listByConversation'> | null = null,
    followupMessageStates: BotFollowupMessageStateRepository | null = null,
  ) {
    this.model = normalizeModel(model);
    this.runtimeContext = new BotRuntimeContextService(
      runtime,
      preferences,
      projectResolver,
      subscriptions,
      followupMessageStates,
    );
  }

  getDiagnostics(): BotAssistantDiagnostics {
    return this.model.getDiagnostics?.() ?? defaultDiagnostics();
  }

  async respondToText(context: BotCommandContext, text: string): Promise<BotCommandResponse> {
    const normalized = text.trim();
    const pending = this.pendingActions
      ?.findLatestByConversation({
        transport: context.transport,
        conversation_id: context.recipient.conversation_id,
      }) ?? null;

    if (pending) {
      if (pending.expires_at.getTime() <= Date.now()) {
        this.pendingActions?.delete({
          transport: context.transport,
          conversation_id: context.recipient.conversation_id,
          issue_id: pending.issue_id,
        });
        return {
          message: 'The pending action expired. Please send the request again.',
        };
      }

      if (isConfirmation(normalized)) {
        const request = pending.normalized_payload as BotCommandRequest;
        this.pendingActions?.delete({
          transport: context.transport,
          conversation_id: context.recipient.conversation_id,
          issue_id: pending.issue_id,
        });
        return this.commandService.execute(context, request);
      }

      if (isCancellation(normalized)) {
        this.pendingActions?.delete({
          transport: context.transport,
          conversation_id: context.recipient.conversation_id,
          issue_id: pending.issue_id,
        });
        return {
          message: 'Cancelled the pending action.',
        };
      }

      return {
        message: `${pending.summary_message}\nReply with 确认 / 取消.`,
        actions: [...buildConfirmActions()],
      };
    }

    const runtimeContext = this.runtimeContext.buildContext(
      context,
      text,
      this.getDiagnostics(),
    );

    let decision: BotAssistantDecision | null = null;
    let modelDiagnostics = this.getDiagnostics();
    let usedFallback = false;

    try {
      const output = await this.model.decide({
        text,
        context: runtimeContext,
      });
      modelDiagnostics = this.getDiagnostics();
      decision = parseModelDecision(output);

      if (decision) {
        logger.info('Bot assistant model success', {
          transport: context.transport,
          conversation_id: context.recipient.conversation_id,
          intent_kind: decision.intent.kind,
        });
      } else {
        logger.warn('Bot assistant returned no actionable decision', {
          transport: context.transport,
          conversation_id: context.recipient.conversation_id,
          error_code: modelDiagnostics.last_error_code || 'unparseable_response',
        });
      }
    } catch (error) {
      modelDiagnostics = this.getDiagnostics();
      logger.warn('Bot assistant model error', {
        transport: context.transport,
        conversation_id: context.recipient.conversation_id,
        error_code: modelDiagnostics.last_error_code || 'provider_unavailable',
      }, error instanceof Error ? error : undefined);
    }

    const heuristic = buildHeuristicDecision(text, runtimeContext);
    if (!decision || decision.intent.kind === 'help') {
      if (!decision || heuristic.intent.kind !== 'help') {
        decision = heuristic;
        usedFallback = true;
        logger.info('Bot assistant fallback used', {
          transport: context.transport,
          conversation_id: context.recipient.conversation_id,
          intent_kind: heuristic.intent.kind,
          error_code: modelDiagnostics.last_error_code || null,
        });
      }
    }

    if (!decision) {
      usedFallback = true;
      logger.warn('Bot assistant fallback unrecognized', {
        transport: context.transport,
        conversation_id: context.recipient.conversation_id,
      });
      return {
        message: prefixFallbackNotice(
          buildScopedHelp(runtimeContext, text),
          modelDiagnostics,
          usedFallback,
        ),
      };
    }

    if (decision.intent.kind === 'help') {
      logger.warn('Bot assistant fallback unrecognized', {
        transport: context.transport,
        conversation_id: context.recipient.conversation_id,
      });
      return {
        message: prefixFallbackNotice(
          buildScopedHelp(runtimeContext, text),
          modelDiagnostics,
          usedFallback,
        ),
      };
    }

    const response = await this.handleIntent(
      context,
      decision.intent,
      text,
      runtimeContext,
    );

    return {
      ...response,
      message: prefixFallbackNotice(response.message, modelDiagnostics, usedFallback),
    };
  }

  private async handleIntent(
    context: BotCommandContext,
    intent: BotAssistantIntent,
    originalText: string,
    runtimeContext: BotRuntimeCopilotContext,
  ): Promise<BotCommandResponse> {
    switch (intent.kind) {
      case 'status':
        return this.commandService.execute(context, {
          command: 'status',
          issue_id: intent.issue_id,
        });
      case 'show_default_project':
        return this.commandService.execute(context, {
          command: 'project',
        });
      case 'execute_governance_suggestion':
      case 'dismiss_governance_suggestion': {
        if (!this.canWrite(context)) {
          return {
            message: `${context.transport} is configured as read-only for this user. Allowed actions here are status and help.`,
          };
        }

        const issue = resolveGovernanceSuggestionIssue(this.runtime, runtimeContext, intent.issue_id);
        if (!issue) {
          return {
            message: '我还不能确定你要操作哪一张 issue。请显式说出 issue id，或者先让我聚焦到唯一活跃 issue。',
          };
        }

        const { suggestion, error } = resolveGovernanceSuggestionSelection({ intent, issue });
        if (!suggestion) {
          return {
            message: error ?? `请明确指定要操作的治理建议：\n${formatGovernanceSuggestionChoices(runtimeContext.focus_issue!)}`,
          };
        }

        const request = toPendingRequest({
          ...intent,
          issue_id: issue.issue_id,
          suggestion_id: suggestion.id,
          suggestion_type: suggestion.suggestion_type,
          ordinal: null,
        });
        if (!request) {
          return {
            message: 'I could not understand that governance suggestion action.',
          };
        }

        const summary = [
          `Action: ${intent.kind === 'execute_governance_suggestion' ? 'execute governance suggestion' : 'dismiss governance suggestion'}`,
          `Issue: ${issue.identifier}`,
          issue.github_repo ? `Repo: ${issue.github_repo}` : null,
          `Suggestion: [${(issue.active_governance_suggestions ?? []).findIndex((item) => item.id === suggestion.id) + 1}] ${suggestion.suggestion_type}`,
          `Suggestion id: ${suggestion.id}`,
          `Title: ${suggestion.title}`,
          `Summary: ${compact(suggestion.summary, 160)}`,
          'Reply with: 确认 / 取消',
        ].filter(Boolean).join('\n');

        if (!this.pendingActions) {
          return this.commandService.execute(context, request);
        }

        this.pendingActions.upsert({
          transport: context.transport,
          conversation_id: context.recipient.conversation_id,
          user_id: context.identity.user_id,
          intent_kind: intent.kind,
          normalized_payload: request,
          summary_message: summary,
          expires_at: new Date(Date.now() + 15 * 60 * 1000),
        });

        return {
          message: summary,
          actions: [...buildConfirmActions()],
        };
      }
      case 'help':
        return {
          message: buildScopedHelp(runtimeContext, originalText),
        };
      case 'answer_question':
        return {
          message: intent.answer,
        };
      case 'clarify':
        return {
          message: intent.question,
        };
      case 'create_issue': {
        const resolvedProjectSlug = intent.project_slug || runtimeContext.default_project_slug;
        if (!resolvedProjectSlug) {
          const available = this.projectResolver?.listConfiguredProjectSlugs() ?? [];
          return {
            message: available.length > 0
              ? `I can create that issue, but this chat does not have a default project yet. Use /project <slug> first or mention one of: ${available.join(', ')}.`
              : 'I can create that issue, but this chat does not have a default project yet. Use /project <slug> first.',
          };
        }

        if (!this.canWrite(context)) {
          return {
            message: `${context.transport} is configured as read-only for this user. Allowed actions here are status and help.`,
          };
        }

        const resolved = await this.projectResolver?.resolveProjectSlug(resolvedProjectSlug);
        if (resolved && !resolved.project) {
          return {
            message: resolved.error || `Project slug "${resolvedProjectSlug}" could not be resolved.`,
          };
        }

        const request = toPendingRequest({
          ...intent,
          project_slug: resolvedProjectSlug,
        });
        if (!request || !this.pendingActions) {
          return this.commandService.execute(context, {
            command: 'new',
            create_issue: {
              title: intent.title,
              description: intent.description,
              project_slug: resolvedProjectSlug,
            },
          });
        }

        const summary = [
          'Action: create issue',
          `Project: ${resolvedProjectSlug}`,
          resolved?.route ? `Repo: ${resolved.route.github_repo_full}` : null,
          `Title: ${intent.title}`,
          intent.description ? `Description: ${compact(intent.description)}` : null,
        ];

        if (resolved?.route) {
          const governance = await assessIntakeCritic({
            issue: {
              id: 'preview',
              identifier: 'PREVIEW',
              title: intent.title,
              description: intent.description,
              priority: null,
              state: 'Todo',
              project_slug: resolved.route.project_slug,
              project_name: resolved.route.project_name,
              branch_name: null,
              url: null,
              labels: [],
              blocked_by: [],
              created_at: null,
              updated_at: null,
            },
            route: resolved.route,
            repositoryRoot: resolved.route.local_path,
          });

          if (governance.decision !== 'accept') {
            summary.push(`Governance: ${governance.decision}`);
            summary.push(`Dispatch: blocked until rewritten, split, or overridden (${governance.summary})`);
            if (governance.rewrite_title) {
              summary.push(`Suggested title: ${compact(governance.rewrite_title, 120)}`);
            }
            if (governance.split_suggestions[0]) {
              summary.push(`Suggested split: ${compact(governance.split_suggestions[0], 140)}`);
            }
          }
        }

        summary.push('Reply with: 确认 / 取消');

        const message = summary
          .filter(Boolean)
          .join('\n');

        this.pendingActions.upsert({
          transport: context.transport,
          conversation_id: context.recipient.conversation_id,
          user_id: context.identity.user_id,
          intent_kind: 'create_issue',
          normalized_payload: request,
          summary_message: message,
          expires_at: new Date(Date.now() + 15 * 60 * 1000),
        });

        return {
          message,
          actions: [...buildConfirmActions()],
        };
      }
      case 'watch':
      case 'unwatch':
      case 'stop':
      case 'retry':
      case 'override':
      case 'rewrite':
      case 'split':
      case 'set_default_project': {
        const request = toPendingRequest(intent);
        if (!request) {
          return {
            message: 'I could not understand that action.',
          };
        }

        if (!this.canWrite(context)) {
          return {
            message: `${context.transport} is configured as read-only for this user. Allowed actions here are status and help.`,
          };
        }

        if (intent.kind === 'set_default_project' && intent.project_slug) {
          const resolved = await this.projectResolver?.resolveProjectSlug(intent.project_slug);
          if (resolved && !resolved.project) {
            return {
              message: resolved.error || `Project slug "${intent.project_slug}" could not be resolved.`,
            };
          }
        }

        if (!this.pendingActions) {
          return this.commandService.execute(context, request);
        }

        const summary = [
          `Action: ${request.command}`,
          request.issue_id ? `Issue: ${request.issue_id}` : null,
          request.project_slug ? `Project: ${request.project_slug}` : null,
          request.project_slug === 'clear' ? 'Project: clear default project' : null,
          'Reply with: 确认 / 取消',
        ]
          .filter(Boolean)
          .join('\n');

        this.pendingActions.upsert({
          transport: context.transport,
          conversation_id: context.recipient.conversation_id,
          user_id: context.identity.user_id,
          intent_kind:
            intent.kind === 'set_default_project' ? 'set_default_project' : intent.kind,
          normalized_payload: request,
          summary_message: summary,
          expires_at: new Date(Date.now() + 15 * 60 * 1000),
        });

        return {
          message: summary,
          actions: [...buildConfirmActions()],
        };
      }
      default:
        return {
          message: buildScopedHelp(runtimeContext, originalText),
        };
    }
  }
}
