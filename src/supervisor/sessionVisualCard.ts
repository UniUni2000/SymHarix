import { Resvg } from '@resvg/resvg-js';
import type { SupervisorSessionRecord } from '../database/types';
import type { BotTransportPhoto } from '../bots/types';
import type { RuntimeIssueView } from '../runtime/types';
import type { SupervisorMilestone } from './types';
import { isInternalSupervisorTurnBudgetFailure } from './milestoneVisibility';
import { localizeKnownRuntimeText, type RuntimeLocale } from '../i18n/locale';

export interface SupervisorSessionVisualCard {
  media_key: string;
  caption: string;
  photo: BotTransportPhoto;
}

export interface SupervisorMilestoneSummaryCard {
  media_key: string;
  caption: string;
  photo: BotTransportPhoto;
}

function escapeSvg(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function compact(value: string | null | undefined, maxLength: number): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function safeFilenamePart(value: string): string {
  return value
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'issue';
}

function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const normalized = compact(value, maxChars * maxLines).trim();
  if (!normalized) {
    return [];
  }
  const lines: string[] = [];
  let current = '';
  for (const char of normalized) {
    const next = `${current}${char}`;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = char;
    } else {
      current = next;
    }
    if (lines.length >= maxLines) {
      break;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines;
}

function textLines(params: {
  x: number;
  y: number;
  lines: string[];
  size: number;
  fill?: string;
  weight?: number;
  lineHeight?: number;
  opacity?: number;
}): string {
  const fill = params.fill ?? '#f7fbff';
  const weight = params.weight ?? 500;
  const lineHeight = params.lineHeight ?? Math.round(params.size * 1.38);
  const opacity = params.opacity ?? 1;
  return params.lines.map((line, index) => (
    `<text x="${params.x}" y="${params.y + index * lineHeight}" fill="${fill}" opacity="${opacity}" font-size="${params.size}" font-weight="${weight}">${escapeSvg(line)}</text>`
  )).join('');
}

function stageProgress(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): {
  plan: number;
  dispatch: number;
  execution: number;
  review: number;
} {
  const waitingForApproval = session.state === 'awaiting_user_approval' || session.state === 'plan_ready';
  const hasIssue = Boolean(issue);
  const executing = session.state === 'executing' || session.state === 'awaiting_user_decision';
  const done = isCompletedIssue(session, issue);
  const deliveryBlocked = session.state === 'awaiting_user_decision' ||
    issue?.delivery_state === 'delivery_failed' ||
    issue?.orchestrator_state === 'failed';
  return {
    plan: session.plan_card ? 100 : 0,
    dispatch: waitingForApproval ? 0 : hasIssue ? 100 : 0,
    execution: done ? 100 : deliveryBlocked ? 82 : executing ? 42 : 0,
    review: done ? 100 : issue?.phase === 'REVIEW' || issue?.orchestrator_state === 'review_running' ? 65 : 0,
  };
}

function stageTone(value: number, active: boolean): { fill: string; stroke: string; text: string } {
  if (value >= 100) {
    return { fill: '#55E49D', stroke: '#55E49D', text: '#7BEAAD' };
  }
  if (active) {
    return { fill: '#183851', stroke: '#57B8FF', text: '#8BD2FF' };
  }
  return { fill: '#122333', stroke: '#52687B', text: '#94A7B6' };
}

function isCompletedIssue(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): boolean {
  return session.state === 'completed' ||
    issue?.delivery_state === 'completed' ||
    issue?.orchestrator_state === 'completed' ||
    /^(done|completed)$/i.test(issue?.tracker_state || '');
}

function isEnglishLocale(locale: RuntimeLocale | null | undefined): boolean {
  return locale === 'en';
}

function textForLocale(locale: RuntimeLocale | null | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function localizedKnown(value: string, locale: RuntimeLocale | null | undefined): string {
  return isEnglishLocale(locale) ? localizeKnownRuntimeText(value, locale) : value;
}

function statusLabel(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): string {
  const locale = session.supervisor_locale;
  if (isCompletedIssue(session, issue)) return textForLocale(locale, '已完成', 'Completed');
  if (session.state === 'awaiting_user_approval' || session.state === 'plan_ready') {
    return textForLocale(locale, '计划待批准', 'Plan awaiting approval');
  }
  if (session.state === 'awaiting_user_decision') return textForLocale(locale, '需要决策', 'Needs decision');
  if (session.state === 'cancelled') return textForLocale(locale, '已取消', 'Cancelled');
  if (issue?.orchestrator_state === 'failed' || issue?.delivery_state === 'delivery_failed') {
    return textForLocale(locale, '需要处理', 'Needs recovery');
  }
  return textForLocale(locale, '执行中', 'Running');
}

function confidenceLabel(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): string {
  if (session.state === 'awaiting_user_decision' || issue?.governance_status === 'blocked') {
    return 'Needs Judgment';
  }
  if ((session.plan_card?.known_risks ?? []).length > 0) {
    return 'High Confidence';
  }
  return 'Ready';
}

function outcomeString(session: SupervisorSessionRecord, key: string): string | null {
  const value = session.last_material_outcome?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function materializationPrefix(session: SupervisorSessionRecord): string {
  const outcomeKind = outcomeString(session, 'outcome_kind');
  if (outcomeKind === 'continued' || outcomeKind === 'plan_revision_approved') {
    return textForLocale(session.supervisor_locale, '已继续执行', 'Continued');
  }
  return textForLocale(session.supervisor_locale, '已创建', 'Created');
}

function outcomeNumber(session: SupervisorSessionRecord, key: string): number | null {
  const value = session.last_material_outcome?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function complexityLabel(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): string {
  const explicit = outcomeString(session, 'complexity');
  if (explicit && /^L[1-4]$/i.test(explicit)) {
    return explicit.toUpperCase();
  }
  if (issue?.complexity) {
    return issue.complexity;
  }
  if (session.plan_card?.materialization_mode === 'root_with_split_queue' || (issue?.governance_child_queue ?? []).length > 0) {
    return 'L4';
  }
  return 'L2';
}

function riskSummary(value: string, locale: RuntimeLocale | null | undefined): string {
  const normalized = value.toLowerCase();
  if (/误删|delete|destructive|清理|破坏/.test(normalized)) {
    return textForLocale(locale, '高 · 需确认范围', 'High · confirm scope');
  }
  if (/blocked|失败|failed|高风险|high/.test(normalized)) {
    return textForLocale(locale, '高 · 需要处理', 'High · needs action');
  }
  return textForLocale(locale, '中等 · 需确认边界', 'Medium · confirm boundary');
}

type RecentToolActivity = NonNullable<RuntimeIssueView['session']>['recent_tools'][number];
type RecentFileActivity = NonNullable<RuntimeIssueView['session']>['recent_files'][number];

function stripShellNoise(value: string): string {
  return value
    .replace(/\s+2>\/dev\/null\b/g, '')
    .replace(/\s+>/g, ' >')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileNameFromPath(value: string | null | undefined): string {
  const normalized = String(value || '')
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .trim();
  if (!normalized) {
    return 'file';
  }
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) || normalized;
}

function compactPath(value: string | null | undefined, maxLength = 34): string {
  const normalized = String(value || '')
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .trim();
  if (!normalized) {
    return '';
  }
  const worktreeMatch = normalized.match(/\/worktrees\/[^/]+\/(.+)$/);
  const repoMatch = normalized.match(/\/(?:src|docs|test|tests|scripts|packages|app|lib|bin|config)\/.+$/);
  const relative = worktreeMatch?.[1] ?? repoMatch?.[0]?.replace(/^\//, '') ?? normalized;
  return compact(relative, maxLength);
}

function summarizeToolActivity(tool: RecentToolActivity): string {
  const raw = stripShellNoise(tool.summary || tool.message || tool.tool_name);
  const lower = raw.toLowerCase();
  const prMatch = raw.match(/\bgh\s+pr\s+view\s+(\d+)/i);
  if (prMatch) {
    return `View PR #${prMatch[1]}`;
  }
  if (/\bgit\s+status\b/.test(lower)) {
    return 'Check Git status';
  }
  if (/\bgit\s+diff\b/.test(lower)) {
    return 'Review code changes';
  }
  const writeMatch = raw.match(/\b(?:cat|tee)\s*>\s*["']?([^"'<\s]+)/i);
  if (writeMatch) {
    return `Write ${fileNameFromPath(writeMatch[1])}`;
  }
  const readMatch = raw.match(/\b(?:cat|sed|nl|less)\s+["']?([^"'<\s]+)/i);
  if (readMatch) {
    return `Read ${fileNameFromPath(readMatch[1])}`;
  }
  const removeMatch = raw.match(/\brm\s+-[rf]+\s+["']?([^"'<\s]+)/i);
  if (removeMatch) {
    return `Delete ${fileNameFromPath(removeMatch[1])}`;
  }
  return compact(raw, 44);
}

function summarizeFileActivity(file: RecentFileActivity): string {
  const verb = file.operation === 'read'
    ? 'Read'
    : file.operation === 'write'
      ? 'Write'
      : file.operation === 'edit'
        ? 'Edit'
        : 'View';
  const path = compactPath(file.path, 28) || fileNameFromPath(file.path);
  return `${verb} ${path}`;
}

function splitPlanItems(values: string[] | null | undefined, fallback: string, maxItems: number, maxLength = 42): string[] {
  const source = values && values.length > 0 ? values : [fallback];
  const items = source
    .flatMap((value) => String(value || '').split(/[；;]\s*/))
    .map((value) => compact(value, maxLength))
    .filter(Boolean);
  const unique = Array.from(new Set(items));
  return (unique.length > 0 ? unique : [fallback]).slice(0, maxItems);
}

function bulletRows(params: {
  x: number;
  y: number;
  items: string[];
  maxChars: number;
  maxLines: number;
  bulletFill?: string;
  textFill?: string;
  size?: number;
  rowHeight?: number;
}): string {
  const size = params.size ?? 24;
  const rowHeight = params.rowHeight ?? 38;
  const bulletFill = params.bulletFill ?? '#58E7A1';
  const textFill = params.textFill ?? '#EAF2FB';
  const rows: string[] = [];
  let cursorY = params.y;
  let usedLines = 0;
  for (const item of params.items) {
    if (usedLines >= params.maxLines) {
      break;
    }
    const lines = wrapText(item, params.maxChars, Math.min(2, params.maxLines - usedLines));
    if (lines.length === 0) {
      continue;
    }
    rows.push(`<circle cx="${params.x}" cy="${cursorY - 8}" r="6" fill="${bulletFill}"/>`);
    rows.push(textLines({
      x: params.x + 22,
      y: cursorY,
      lines,
      size,
      fill: textFill,
      weight: 610,
      lineHeight: rowHeight,
    }));
    usedLines += lines.length;
    cursorY += rowHeight * lines.length + 10;
  }
  return rows.join('');
}

function phaseGlyph(done: boolean, active: boolean): string {
  if (done) {
    return '<path d="M14 28l9 10 18-22" stroke="#10251B" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
  }
  if (active) {
    return '<circle cx="28" cy="28" r="10" fill="#8BD2FF"/>';
  }
  return '';
}

function roundParts(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): { index: number; total: number } {
  const index = outcomeNumber(session, 'round_index') ?? issue?.round?.index ?? (issue?.phase === 'REVIEW' ? 2 : 1);
  const total = outcomeNumber(session, 'round_total') ?? issue?.round?.total ?? (complexityLabel(session, issue) === 'L4' ? 4 : 2);
  return {
    index: Math.max(1, index),
    total: Math.max(1, total),
  };
}

function roundLabel(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): string {
  const round = roundParts(session, issue);
  return `Round ${round.index}/${round.total}`;
}

function roundGoal(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): string {
  const locale = session.supervisor_locale;
  if (isCompletedIssue(session, issue)) {
    return localizedKnown(
      issue?.delivery_summary ?? session.delivery_summary ?? textForLocale(locale, '计划线程已完成，最终交付已闭环。', 'Plan thread completed and final delivery is closed.'),
      locale,
    );
  }
  const latestInstruction = session.last_material_outcome?.latest_dev_instruction;
  const goal = outcomeString(session, 'round_goal')
    ?? issue?.roundGoal
    ?? issue?.round?.goal
    ?? issue?.next_recommended_action
    ?? (typeof latestInstruction === 'string' && latestInstruction.trim() ? latestInstruction.trim() : null)
    ?? session.plan_card?.recommended_option.summary
    ?? textForLocale(locale, '继续推进当前计划线程。', 'Continue advancing the current plan thread.');
  return localizedKnown(goal, locale);
}

export function buildSupervisorSessionVisualCardSvg(session: SupervisorSessionRecord, issue: RuntimeIssueView | null): string {
  const locale = session.supervisor_locale;
  const plan = session.plan_card;
  const identifier = issue?.identifier || session.root_issue_id || 'Plan Card';
  const title = issue?.title || plan?.title || textForLocale(locale, '当前计划线程', 'Current plan thread');
  const repo = issue?.github_repo || plan?.repo_ref || session.repo_ref || 'repo pending';
  const waitingForApproval = session.state === 'awaiting_user_approval' || session.state === 'plan_ready';
  const completed = isCompletedIssue(session, issue);
  const deliveryBlocked = session.state === 'awaiting_user_decision' ||
    issue?.delivery_state === 'delivery_failed' ||
    issue?.orchestrator_state === 'failed';
  const liveMode = !waitingForApproval && !completed && session.state !== 'cancelled';
  const notificationSummary = outcomeString(session, 'pending_user_notification_summary')
    ?? outcomeString(session, 'user_summary')
    ?? null;
  const latestInstruction = outcomeString(session, 'latest_dev_instruction')
    ?? outcomeString(session, 'dev_instruction')
    ?? null;
  const latestTool = issue?.session?.recent_tools?.at(-1) ?? null;
  const latestFile = issue?.session?.recent_files?.at(-1) ?? null;
  const rawJudgment = isCompletedIssue(session, issue)
    ? issue?.delivery_summary || session.delivery_summary || textForLocale(locale, '计划线程已完成，最终交付已闭环。', 'Plan thread completed and final delivery is closed.')
    : deliveryBlocked
      ? notificationSummary
        || issue?.delivery_summary
        || session.delivery_summary
        || textForLocale(locale, '证据已满足，但交付动作需要处理。', 'Evidence is satisfied, but delivery needs attention.')
    : notificationSummary
      || issue?.session?.last_message
      || issue?.next_recommended_action
      || plan?.recommended_option.summary
      || issue?.delivery_summary
      || session.delivery_summary
      || plan?.execution_strategy
      || textForLocale(locale, '继续推进当前计划线程。', 'Continue advancing the current plan thread.');
  const judgment = localizedKnown(rawJudgment, locale);
  const risk = localizedKnown(
    (plan?.known_risks ?? [])[0] || issue?.governance_summary || textForLocale(locale, '跨层改动，先锁定验收标准。', 'Cross-layer change; lock acceptance criteria first.'),
    locale,
  );
  const progressValue = stageProgress(session, issue);
  const childCount = Math.max(0, issue?.governance_child_queue?.length ?? 0);
  const splitCount = Math.max(3, childCount);
  const complexity = complexityLabel(session, issue);
  const complexityText = deliveryBlocked
    ? textForLocale(locale, '证据已满足，交付动作需要处理。', 'Evidence is satisfied; delivery needs attention.')
    : liveMode
      ? `${roundLabel(session, issue)} ${textForLocale(locale, '运行中，主卡同步 Mini App 进展。', 'is running; the card mirrors Mini App progress.')}`
    : plan?.materialization_mode === 'root_with_split_queue' || childCount > 0
    ? textForLocale(locale, `复杂度 ${complexity}，拆成 ${splitCount} 个顺序子任务。`, `Complexity ${complexity}; split into ${splitCount} ordered child tasks.`)
    : textForLocale(locale, `复杂度 ${complexity}，按当前计划推进。`, `Complexity ${complexity}; proceed with the current plan.`);
  const goal = roundGoal(session, issue) || judgment;
  const status = `${complexity} · ${statusLabel(session, issue).replace(/^计划/, '').replace(/^Plan /, '')}`;
  const statusWidth = Math.max(190, Math.min(330, status.length * 22 + 48));
  const confidence = confidenceLabel(session, issue);
  const confidenceWidth = Math.max(230, Math.min(330, confidence.length * 16 + 64));
  const railFillEnd = progressValue.execution > 0
    ? 824
    : progressValue.dispatch > 0
      ? 414
      : progressValue.plan > 0
        ? 30
        : 0;
  const dispatchActive = progressValue.dispatch > 0;
  const executionActive = progressValue.execution > 0;
  const planTone = stageTone(progressValue.plan, progressValue.plan > 0);
  const dispatchTone = stageTone(progressValue.dispatch, dispatchActive);
  const executionTone = stageTone(progressValue.execution, executionActive);
  const agentProgress = issue?.agentRecentProgress ?? issue?.agent_recent_progress ?? null;
  const phaseProgress = issue?.phase === 'REVIEW'
    ? agentProgress?.review ?? []
    : agentProgress?.dev ?? [];
  const recentPhaseProgress = phaseProgress
    .slice(-2)
    .map((item) => item.summary)
    .filter((value): value is string => Boolean(value && value.trim()));
  const liveProgressItems = [
    ...recentPhaseProgress,
    judgment,
    latestTool ? summarizeToolActivity(latestTool) : null,
    latestFile ? summarizeFileActivity(latestFile) : null,
  ].filter((value): value is string => Boolean(value && value.trim()));
  const liveNextItems = [
    issue?.next_recommended_action,
    latestInstruction,
    deliveryBlocked ? textForLocale(locale, '等待用户确认交付处理方式。', 'Waiting for the user to choose delivery recovery.') : null,
  ].filter((value): value is string => Boolean(value && value.trim()));
  const scopeItems = liveMode
    ? splitPlanItems(liveProgressItems.map((value) => localizedKnown(value, locale)), judgment, 3, 46)
    : splitPlanItems(plan?.in_scope.map((value) => localizedKnown(value, locale)), localizedKnown(plan?.user_goal || title, locale), 3, 46);
  const acceptanceItems = liveMode
    ? splitPlanItems(liveNextItems.map((value) => localizedKnown(value, locale)), localizedKnown(plan?.recommended_option.summary || textForLocale(locale, '继续推进当前计划线程。', 'Continue advancing the current plan thread.'), locale), 2, 32)
    : splitPlanItems(plan?.acceptance.map((value) => localizedKnown(value, locale)), textForLocale(locale, `完成 ${title}，结果可验证。`, `Complete ${title}; make the result verifiable.`), 2, 32);
  const outOfScopeItems = liveMode
    ? splitPlanItems([session.delivery_summary || issue?.delivery_summary || notificationSummary || risk].map((value) => localizedKnown(value, locale)), risk, 2, 42)
    : splitPlanItems(plan?.out_of_scope.map((value) => localizedKnown(value, locale)), textForLocale(locale, '不扩大到无关仓库、分支或历史记录。', 'Do not expand to unrelated repositories, branches, or history.'), 2, 42);
  const riskItems = splitPlanItems(plan?.known_risks.map((value) => localizedKnown(value, locale)), risk, 2, 42);
  const leftPanelTitle = liveMode ? textForLocale(locale, '当前进展', 'Current Progress') : textForLocale(locale, '本次范围', 'Scope');
  const rightPanelTitle = liveMode ? (deliveryBlocked ? textForLocale(locale, '需要决定', 'Decision Needed') : textForLocale(locale, '下一步', 'Next Step')) : textForLocale(locale, '验收标准', 'Acceptance Criteria');
  const riskPanelTitle = deliveryBlocked ? textForLocale(locale, '交付阻塞', 'Delivery Blocker') : liveMode ? textForLocale(locale, '运行信号', 'Runtime Signals') : textForLocale(locale, '边界与风险', 'Boundaries & Risks');
  const middlePhaseLabel = liveMode ? textForLocale(locale, '开发', 'Dev') : textForLocale(locale, '调度', 'Dispatch');
  const finalPhaseLabel = completed
    ? textForLocale(locale, '交付', 'Delivery')
    : issue?.phase === 'REVIEW'
      ? 'Review'
      : deliveryBlocked
        ? textForLocale(locale, '交付', 'Delivery')
        : textForLocale(locale, '执行', 'Execution');
  const progressRailLabel = liveMode ? 'Plan → Dev → Review/Delivery' : 'Plan → Dispatch → Execution';
  const titleLines = wrapText(title, 18, 2);
  const judgmentLines = wrapText(judgment, 34, 2);
  const goalLines = wrapText(goal, 30, 2);
  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#09131D"/>
        <stop offset="0.56" stop-color="#0D1722"/>
        <stop offset="1" stop-color="#060B11"/>
      </linearGradient>
      <linearGradient id="card" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#162636"/>
        <stop offset="1" stop-color="#0B151F"/>
      </linearGradient>
      <linearGradient id="rail" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="#54E5A3"/>
        <stop offset="0.52" stop-color="#5BB7FF"/>
        <stop offset="1" stop-color="#33465B"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000000" flood-opacity="0.34"/>
      </filter>
      <style>
        text { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Songti SC", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
      </style>
    </defs>
    <rect width="1080" height="1080" fill="url(#bg)" />
    <g opacity="0.07" stroke="#7FA7C8" stroke-width="2" fill="none">
      <path d="M96 154c64-42 124-40 182 6"/>
      <path d="M796 126c82 38 148 32 198-18"/>
      <circle cx="908" cy="430" r="112"/>
      <path d="M54 1130c70-56 150-64 240-24"/>
    </g>
    <rect x="18" y="18" width="1044" height="1044" rx="34" fill="none" stroke="#253D51" stroke-width="2" opacity="0.7"/>

    <path d="M56 70 C74 40 104 40 122 70 S174 100 192 70 S244 40 262 70" fill="none" stroke="#58E7AE" stroke-width="10" stroke-linecap="round" />
    <text x="294" y="80" fill="#5CE6AA" font-size="27" font-weight="760">symphonyness</text>
    <text x="500" y="80" fill="#96A7B4" font-size="26" font-weight="520">Supervisor</text>

    <rect x="56" y="106" width="154" height="38" rx="11" fill="#172838" stroke="#30465A"/>
    <text x="78" y="132" fill="#AAB8C4" font-size="22" font-weight="620">${escapeSvg(compact(identifier, 12))}</text>
    <rect x="230" y="106" width="${statusWidth}" height="38" rx="11" fill="#312812" stroke="#72591F"/>
    <text x="252" y="132" fill="#FFD464" font-size="22" font-weight="680">${escapeSvg(compact(status, 15))}</text>
    <rect x="${252 + statusWidth}" y="106" width="${confidenceWidth}" height="38" rx="11" fill="#102F24" stroke="#1F6748"/>
    <text x="${276 + statusWidth}" y="132" fill="#76EAAA" font-size="22" font-weight="680">${escapeSvg(compact(confidence, 19))}</text>

    ${textLines({ x: 56, y: 204, lines: titleLines, size: 42, fill: '#F7FAFC', weight: 800, lineHeight: 50 })}

    <g transform="translate(56 258)">
      <rect x="0" y="0" width="968" height="66" rx="17" fill="#0D1B27" stroke="#263C4F"/>
      <circle cx="37" cy="33" r="22" fill="#EAF2F8"/>
      <path transform="translate(20 16)" fill="#13202B" d="M17 1C8.2 1 1 8.2 1 17c0 7 4.6 13 10.9 15.1.8.1 1.1-.3 1.1-.8v-2.7c-4.5 1-5.4-1.9-5.4-1.9-.7-1.8-1.7-2.2-1.7-2.2-1.4-.9.1-.9.1-.9 1.6.1 2.4 1.6 2.4 1.6 1.4 2.4 3.6 1.7 4.6 1.3.1-1 .5-1.7 1-2.2-3.6-.4-7.3-1.8-7.3-7.9 0-1.7.6-3.2 1.6-4.3-.2-.4-.7-2.1.2-4.4 0 0 1.3-.4 4.4 1.6A15 15 0 0 1 17 8.7c1.3 0 2.7.2 4 .5 3-2 4.4-1.6 4.4-1.6.9 2.3.3 4 .2 4.4 1 1.1 1.6 2.5 1.6 4.3 0 6.1-3.7 7.5-7.3 7.9.6.5 1.1 1.5 1.1 3v4.2c0 .4.3.9 1.1.8A16 16 0 0 0 33 17C33 8.2 25.8 1 17 1Z"/>
      <text x="80" y="28" fill="#8EA0AF" font-size="19" font-weight="560">Repository</text>
      <text x="80" y="54" fill="#F0F6FB" font-size="24" font-weight="720">${escapeSvg(compact(repo, 48))}</text>
      <text x="924" y="45" fill="#5F7384" font-size="34" font-weight="400">›</text>
    </g>

    <rect x="56" y="352" width="968" height="136" rx="21" fill="#0E1C28" stroke="#263D50"/>
    <text x="88" y="397" fill="#73E8A7" font-size="25" font-weight="760">${escapeSvg(textForLocale(locale, 'Supervisor 判断', 'Supervisor Judgment'))}</text>
    ${textLines({ x: 88, y: 440, lines: [complexityText], size: 23, fill: '#DDE8F1', weight: 540, lineHeight: 32 })}
    ${textLines({ x: 88, y: 471, lines: judgmentLines.slice(0, 1), size: 23, fill: '#DDE8F1', weight: 540, lineHeight: 32 })}
    <text x="900" y="397" text-anchor="end" fill="#8EA0AF" font-size="20" font-weight="560">${escapeSvg(textForLocale(locale, '风险', 'Risk'))}</text>
    <text x="900" y="432" text-anchor="end" fill="#FFD464" font-size="25" font-weight="760">${escapeSvg(riskSummary(risk, locale))}</text>

    <g transform="translate(56 520)">
      <rect x="0" y="0" width="470" height="176" rx="21" fill="#0C1822" stroke="#263D50"/>
      <text x="30" y="42" fill="#F0F6FB" font-size="24" font-weight="740">${escapeSvg(leftPanelTitle)}</text>
      ${bulletRows({ x: 34, y: 80, items: scopeItems, maxChars: 22, maxLines: 3, bulletFill: '#58E7A1', size: 20, rowHeight: 29 })}
    </g>

    <g transform="translate(554 520)">
      <rect x="0" y="0" width="470" height="176" rx="21" fill="#0C1822" stroke="#263D50"/>
      <text x="30" y="42" fill="#F0F6FB" font-size="24" font-weight="740">${escapeSvg(rightPanelTitle)}</text>
      ${bulletRows({ x: 34, y: 80, items: acceptanceItems, maxChars: 18, maxLines: 3, bulletFill: '#7CC7FF', size: 19, rowHeight: 28 })}
    </g>

    <g transform="translate(56 724)">
      <rect x="0" y="0" width="968" height="130" rx="19" fill="rgba(255, 209, 102, 0.08)" stroke="rgba(255, 209, 102, 0.22)"/>
      <text x="30" y="40" fill="#FFD464" font-size="23" font-weight="760">${escapeSvg(riskPanelTitle)}</text>
      ${bulletRows({ x: 34, y: 76, items: [...outOfScopeItems, ...riskItems].slice(0, 3), maxChars: 48, maxLines: 2, bulletFill: '#FFD464', textFill: '#FFE7B7', size: 20, rowHeight: 28 })}
    </g>

    <g transform="translate(56 866)">
      <rect x="0" y="0" width="968" height="188" rx="23" fill="rgba(13, 27, 39, 0.50)" stroke="rgba(64, 95, 122, 0.48)"/>
      <text x="30" y="42" fill="#EAF2FB" font-size="23" font-weight="760">${escapeSvg(textForLocale(locale, '阶段进度', 'Stage Progress'))}</text>
      <text x="938" y="42" text-anchor="end" fill="#74899B" font-size="18" font-weight="620">${escapeSvg(progressRailLabel)}</text>
      <line x1="126" y1="102" x2="842" y2="102" stroke="#263B4F" stroke-width="8" stroke-linecap="round"/>
      ${railFillEnd > 0 ? `<line x1="126" y1="102" x2="${Math.min(842, Math.round(126 + (railFillEnd / 824) * 716))}" y2="102" stroke="url(#rail)" stroke-width="8" stroke-linecap="round"/>` : ''}
      <g transform="translate(126 0)">
        <circle cx="0" cy="102" r="24" fill="${planTone.fill}" stroke="${planTone.stroke}" stroke-width="4"/>
        <g transform="translate(-28 74)">${phaseGlyph(progressValue.plan >= 100, progressValue.plan > 0 && progressValue.plan < 100)}</g>
        <text x="0" y="151" text-anchor="middle" fill="${planTone.text}" font-size="22" font-weight="650">${escapeSvg(textForLocale(locale, '计划', 'Plan'))}</text>
        <text x="0" y="176" text-anchor="middle" fill="${planTone.text}" font-size="18" font-weight="620">${progressValue.plan}%</text>
      </g>
      <g transform="translate(484 0)">
        <circle cx="0" cy="102" r="24" fill="${dispatchTone.fill}" stroke="${dispatchTone.stroke}" stroke-width="4"/>
        <g transform="translate(-28 74)">${phaseGlyph(progressValue.dispatch >= 100, dispatchActive && progressValue.dispatch < 100)}</g>
        <text x="0" y="151" text-anchor="middle" fill="${dispatchTone.text}" font-size="22" font-weight="650">${escapeSvg(middlePhaseLabel)}</text>
        <text x="0" y="176" text-anchor="middle" fill="${dispatchTone.text}" font-size="18" font-weight="620">${progressValue.dispatch}%</text>
      </g>
      <g transform="translate(842 0)">
        <circle cx="0" cy="102" r="24" fill="${executionTone.fill}" stroke="${executionTone.stroke}" stroke-width="4"/>
        <g transform="translate(-28 74)">${phaseGlyph(progressValue.execution >= 100, executionActive && progressValue.execution < 100)}</g>
        <text x="0" y="151" text-anchor="middle" fill="${executionTone.text}" font-size="22" font-weight="650">${escapeSvg(finalPhaseLabel)}</text>
        <text x="0" y="176" text-anchor="middle" fill="${executionTone.text}" font-size="18" font-weight="620">${progressValue.execution}%</text>
      </g>
    </g>
  </svg>`;
}

function milestoneScore(milestone: SupervisorMilestone): number {
  switch (milestone.kind) {
    case 'completed':
      return 100;
    case 'child_completed':
      return 82;
    case 'waiting_on_child':
    case 'retrying':
      return 68;
    case 'delivery_failed':
    case 'child_failed':
    case 'requires_user_decision':
      return 42;
    default:
      return 58;
  }
}

function riskDelta(session: SupervisorSessionRecord, issue: RuntimeIssueView | null, milestone: SupervisorMilestone): string {
  if (isInternalSupervisorTurnBudgetFailure(milestone)) {
    return 'Risk stable: supervisor is still collecting final evidence.';
  }
  return outcomeString(session, 'risk_delta')
    ?? issue?.riskDelta
    ?? issue?.risk_delta
    ?? (milestone.kind === 'completed' || milestone.kind === 'child_completed'
      ? 'Risk down: verified progress reduced open uncertainty.'
      : milestone.kind === 'delivery_failed' || milestone.kind === 'child_failed' || milestone.kind === 'requires_user_decision'
        ? 'Risk up: user judgment or recovery is needed.'
        : 'Risk stable: supervisor is watching the next checkpoint.');
}

function buildMilestoneSummarySvg(
  session: SupervisorSessionRecord,
  issue: RuntimeIssueView | null,
  milestone: SupervisorMilestone,
): string {
  const identifier = issue?.identifier || milestone.issue_identifier || session.root_issue_id || session.id;
  const title = issue?.title || session.plan_card?.title || 'Supervisor milestone';
  const round = roundLabel(session, issue);
  const score = milestoneScore(milestone);
  const risk = riskDelta(session, issue, milestone);
  const summary = milestone.summary || issue?.delivery_summary || issue?.next_recommended_action || 'Supervisor recorded a key runtime milestone.';
  const nextGoal = roundGoal(session, issue);
  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg width="900" height="1280" viewBox="0 0 900 1280" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#07111a"/>
        <stop offset="0.52" stop-color="#102336"/>
        <stop offset="1" stop-color="#07111a"/>
      </linearGradient>
      <linearGradient id="panel" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#172e42"/>
        <stop offset="1" stop-color="#0b1725"/>
      </linearGradient>
      <style>
        text { font-family: "Inter", "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
      </style>
    </defs>
    <rect width="900" height="1280" fill="url(#bg)" />
    <rect x="54" y="56" width="792" height="1168" rx="34" fill="url(#panel)" stroke="#2a435b" />
    <text x="92" y="130" fill="#58e5aa" font-size="25" font-weight="820">symphonyness · Milestone</text>
    <text x="92" y="206" fill="#f4f8ff" font-size="44" font-weight="850">${escapeSvg(compact(identifier, 18))}</text>
    ${textLines({ x: 92, y: 258, lines: wrapText(title, 28, 2), size: 28, fill: '#dbe7f3', weight: 620, lineHeight: 38 })}

    <rect x="92" y="364" width="716" height="180" rx="22" fill="#0c1b29" stroke="#25445d"/>
    <text x="128" y="426" fill="#9bd0ff" font-size="26" font-weight="780">${escapeSvg(round)}</text>
    <text x="128" y="486" fill="#f8fafc" font-size="62" font-weight="900">${score}</text>
    <text x="234" y="486" fill="#8fa3b8" font-size="24" font-weight="620">visual score</text>
    <text x="700" y="456" text-anchor="end" fill="${score >= 80 ? '#85efac' : score >= 60 ? '#ffd166' : '#ff9b9b'}" font-size="34" font-weight="820">${escapeSvg(milestone.kind.replace(/_/g, ' '))}</text>

    <rect x="92" y="594" width="716" height="188" rx="22" fill="#0e2131" stroke="#25445d"/>
    <text x="128" y="654" fill="#65efaa" font-size="29" font-weight="830">本轮结果</text>
    ${textLines({ x: 128, y: 702, lines: wrapText(summary, 34, 2), size: 25, fill: '#eef6ff', weight: 580, lineHeight: 36 })}

    <rect x="92" y="826" width="716" height="156" rx="22" fill="rgba(245, 158, 11, 0.12)" stroke="rgba(245, 158, 11, 0.28)"/>
    <text x="128" y="884" fill="#ffd166" font-size="29" font-weight="830">风险变化</text>
    ${textLines({ x: 128, y: 932, lines: wrapText(risk, 34, 2), size: 24, fill: '#ffe7b7', weight: 580, lineHeight: 34 })}

    <rect x="92" y="1024" width="716" height="148" rx="22" fill="rgba(96, 165, 250, 0.12)" stroke="rgba(96, 165, 250, 0.28)"/>
    <text x="128" y="1080" fill="#9bd0ff" font-size="29" font-weight="830">下一轮目标</text>
    ${textLines({ x: 128, y: 1126, lines: wrapText(nextGoal, 34, 2), size: 24, fill: '#eaf2fb', weight: 580, lineHeight: 34 })}
  </svg>`;
}

export function buildSupervisorMilestoneSummaryCard(
  session: SupervisorSessionRecord,
  issue: RuntimeIssueView | null,
  milestone: SupervisorMilestone,
  materialKey: string,
): SupervisorMilestoneSummaryCard {
  const svg = buildMilestoneSummarySvg(session, issue, milestone);
  const png = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: 900,
    },
  }).render().asPng();
  const identifier = issue?.identifier || milestone.issue_identifier || session.root_issue_id || session.id;
  const title = issue?.title || session.plan_card?.title || 'Supervisor milestone';
  const risk = riskDelta(session, issue, milestone);
  return {
    media_key: `milestone_summary|${materialKey}`,
    caption: `<b>${escapeSvg(identifier)} · ${escapeSvg(compact(title, 70))}</b>\n${escapeSvg(roundLabel(session, issue))} · ${escapeSvg(compact(milestone.summary || milestone.kind, 80))}\n${escapeSvg(compact(risk, 96))}`,
    photo: {
      bytes: png,
      filename: `${identifier}-milestone-summary.png`,
      content_type: 'image/png',
    },
  };
}

export function buildSupervisorSessionVisualCard(
  session: SupervisorSessionRecord,
  issue: RuntimeIssueView | null,
  materialKey: string,
): SupervisorSessionVisualCard | null {
  if (!session.plan_card) {
    return null;
  }
  const svg = buildSupervisorSessionVisualCardSvg(session, issue);
  const png = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: 1080,
    },
  }).render().asPng();
  const identifier = issue?.identifier || session.root_issue_id || 'Plan Card';
  const title = issue?.title || session.plan_card.title;
  const status = statusLabel(session, issue);
  const captionStatus = issue && (session.state === 'materialized' || session.state === 'executing')
    ? `${materializationPrefix(session)} · ${status}`
    : status;
  const repo = issue?.github_repo || session.plan_card.repo_ref || session.repo_ref || null;
  return {
    media_key: `visual|${materialKey}`,
    caption: `<b>${escapeSvg(identifier)} · ${escapeSvg(compact(title, 56))}</b>\n${escapeSvg(captionStatus)}${repo ? ` · ${escapeSvg(compact(repo, 34))}` : ''}`,
    photo: {
      bytes: png,
      filename: `${safeFilenamePart(identifier)}-supervisor-card.png`,
      content_type: 'image/png',
    },
  };
}
