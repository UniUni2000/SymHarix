import type { RuntimeIssueView } from '../runtime/types';
import type { RuntimeLocale } from '../i18n/locale';
import type { BotAssistantIntent, BotTransportAction } from './types';

export type GovernanceQuickActionSpec =
  | {
      kind: 'execute_suggestion';
      issue_id: string;
      issue_identifier: string;
      suggestion_id: string;
      suggestion_type: string;
      ordinal: number;
      label: string;
      emphasis?: 'primary' | 'secondary' | 'danger';
      style?: 'default' | 'danger';
    }
  | {
      kind: 'rewrite' | 'split' | 'override';
      issue_id: string;
      issue_identifier: string;
      label: string;
      emphasis?: 'primary' | 'secondary' | 'danger';
      style?: 'default' | 'danger';
    };

function compact(value: string, maxLength = 18): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function isEnglishLocale(locale: RuntimeLocale | null | undefined): boolean {
  return locale === 'en';
}

function textForLocale(locale: RuntimeLocale | null | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

export function buildGovernanceQuickActions(issue: RuntimeIssueView): GovernanceQuickActionSpec[] {
  const actions: GovernanceQuickActionSpec[] = [];
  const firstSuggestion = issue.active_governance_suggestions?.find((suggestion) => suggestion.can_execute);
  const locale = issue.supervisor_locale;

  if (issue.governance_decision === 'split_before_implement' && issue.actions.can_split_governance) {
    actions.push({
      kind: 'split',
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      label: textForLocale(locale, '按方案拆成两个任务', 'Split into two tasks'),
      emphasis: 'primary',
    });
  }

  if (issue.governance_decision === 'accept_with_rewrite' && issue.actions.can_rewrite_governance) {
    actions.push({
      kind: 'rewrite',
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      label: textForLocale(locale, '按方案改写需求', 'Rewrite requirement'),
      emphasis: 'primary',
    });
  }

  if (actions.length === 0 && firstSuggestion) {
    actions.push({
      kind: 'execute_suggestion',
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      suggestion_id: firstSuggestion.id,
      suggestion_type: firstSuggestion.suggestion_type,
      ordinal: 1,
      label: textForLocale(
        locale,
        `执行建议：${compact(firstSuggestion.title || firstSuggestion.summary || firstSuggestion.suggestion_type)}`,
        `Run suggestion: ${compact(firstSuggestion.title || firstSuggestion.summary || firstSuggestion.suggestion_type)}`,
      ),
      emphasis: 'primary',
    });
  }

  if (
    issue.actions.can_rewrite_governance &&
    !actions.some((action) => action.kind === 'rewrite')
  ) {
    actions.push({
      kind: 'rewrite',
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      label: textForLocale(locale, '我想先改写需求', 'Rewrite first'),
      emphasis: 'secondary',
    });
  }

  if (issue.actions.can_override_governance) {
    actions.push({
      kind: 'override',
      issue_id: issue.issue_id,
      issue_identifier: issue.identifier,
      label: textForLocale(locale, '强制继续开发', 'Force continue'),
      emphasis: 'danger',
      style: 'danger',
    });
  }

  return actions;
}

export function toGovernanceQuickActionIntent(action: GovernanceQuickActionSpec): BotAssistantIntent {
  switch (action.kind) {
    case 'execute_suggestion':
      return {
        kind: 'execute_governance_suggestion',
        issue_id: action.issue_identifier,
        suggestion_id: action.suggestion_id,
        suggestion_type: action.suggestion_type,
        ordinal: action.ordinal,
      };
    case 'rewrite':
      return {
        kind: 'rewrite',
        issue_id: action.issue_identifier,
      };
    case 'split':
      return {
        kind: 'split',
        issue_id: action.issue_identifier,
      };
    case 'override':
      return {
        kind: 'override',
        issue_id: action.issue_identifier,
      };
  }
}

export function toGovernanceQuickActionButtons(issue: RuntimeIssueView): BotTransportAction[] {
  return buildGovernanceQuickActions(issue).map((action, index) => ({
    label: action.label,
    style: action.style,
    callback_data: `govsel|${issue.identifier}|${index + 1}`,
  }));
}

export function toGovernanceQuickActionRows(issue: RuntimeIssueView): BotTransportAction[][] {
  return buildGovernanceQuickActions(issue).map((action, index) => ([{
    label: action.label,
    style: action.style,
    callback_data: `govsel|${issue.identifier}|${index + 1}`,
  }]));
}

export function resolveGovernanceQuickActionByOrdinal(
  issue: RuntimeIssueView,
  ordinal: number,
): GovernanceQuickActionSpec | null {
  return buildGovernanceQuickActions(issue)[ordinal - 1] ?? null;
}
