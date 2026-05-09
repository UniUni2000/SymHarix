import type { RuntimeIssueView } from '../runtime/types';
import type { BotTransportAction } from './types';
import { inferRuntimeLocaleFromText, type RuntimeLocale } from '../i18n/locale';
import { isTerminalIssue } from './issueVisibility';

function runtimeIssueAppPath(issue: RuntimeIssueView): string {
  return `/runtime/issues/${encodeURIComponent(issue.identifier || issue.issue_id)}/app`;
}

function textForLocale(locale: RuntimeLocale | null | undefined, zh: string, en: string): string {
  return locale === 'en' ? en : zh;
}

function issueLocale(issue: RuntimeIssueView): RuntimeLocale {
  return issue.supervisor_locale ?? inferRuntimeLocaleFromText([
    issue.title,
    issue.supervisor_plan_summary,
    issue.delivery_summary,
    issue.next_recommended_action,
  ].filter(Boolean).join('\n'));
}

function primaryIssueCardAction(issue: RuntimeIssueView, locale: RuntimeLocale): BotTransportAction {
  const stateText = `${issue.tracker_state} ${issue.orchestrator_state ?? ''}`;
  if (/cancelled|canceled/i.test(stateText)) {
    return {
      label: textForLocale(locale, '已取消', 'Cancelled'),
      style: 'success',
      callback_data: `rt|${issue.identifier}|refresh`,
    };
  }
  if (isTerminalIssue(issue)) {
    return {
      label: textForLocale(locale, '已完成', 'Completed'),
      style: 'success',
      callback_data: `rt|${issue.identifier}|refresh`,
    };
  }
  if (issue.actions.can_stop) {
    return {
      label: textForLocale(locale, '停止', 'Stop'),
      style: 'danger',
      callback_data: `rt|${issue.identifier}|stop`,
    };
  }
  if (issue.actions.can_retry) {
    return {
      label: textForLocale(locale, '重试', 'Retry'),
      style: 'success',
      callback_data: `rt|${issue.identifier}|retry`,
    };
  }
  return {
    label: textForLocale(locale, '刷新卡片', 'Refresh Card'),
    callback_data: `rt|${issue.identifier}|refresh`,
  };
}

export function buildIssueCardActionRows(issue: RuntimeIssueView): BotTransportAction[][] {
  const locale = issueLocale(issue);
  return [
    [primaryIssueCardAction(issue, locale)],
    [
      {
        label: textForLocale(locale, '刷新卡片', 'Refresh Card'),
        callback_data: `rt|${issue.identifier}|refresh`,
      },
      {
        label: textForLocale(locale, '打开运行视图', 'Open Runtime View'),
        style: 'primary',
        web_app: { url: runtimeIssueAppPath(issue) },
      },
    ],
  ];
}
