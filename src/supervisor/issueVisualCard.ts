import { Resvg } from '@resvg/resvg-js';
import type { BotTransportPhoto } from '../bots/types';
import { runtimeIssueProgressValue } from '../runtime/issueProgress';
import type { RuntimeIssueView } from '../runtime/types';
import { inferRuntimeLocaleFromText, localizeKnownRuntimeText, type RuntimeLocale } from '../i18n/locale';
import { symHarixLogoDarkThemeDataUri, symHarixLogoLightThemeDataUri } from '../branding/symharixLogo';

export interface SupervisorIssueVisualCard {
  media_key: string;
  caption: string;
  photo: BotTransportPhoto;
}

export type SupervisorIssueVisualTheme = 'light' | 'dark';

export interface SupervisorIssueVisualCardOptions {
  theme?: SupervisorIssueVisualTheme;
}

function escapeXml(value: string): string {
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

function visualTextUnits(value: string): number {
  return Array.from(value).reduce((total, char) => {
    if (/\s/.test(char)) return total + 0.35;
    if (/[\x00-\x7F]/.test(char)) return total + 0.58;
    return total + 1;
  }, 0);
}

function compactVisualLine(value: string, maxUnits: number): string {
  let output = '';
  for (const char of Array.from(value)) {
    const next = `${output}${char}`;
    if (visualTextUnits(next) > Math.max(1, maxUnits - 1)) {
      break;
    }
    output = next;
  }
  return `${output.trim()}…`;
}

function wrapVisualText(value: string, maxUnits: number, maxLines: number): string[] {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }
  const flushLongToken = (token: string, target: string[]): string => {
    let rest = token;
    while (visualTextUnits(rest) > maxUnits && target.length < maxLines - 1) {
      let line = '';
      for (const char of Array.from(rest)) {
        const next = `${line}${char}`;
        if (visualTextUnits(next) > maxUnits && line) {
          break;
        }
        line = next;
      }
      target.push(line.trim());
      rest = rest.slice(line.length).trimStart();
    }
    return rest;
  };
  const lines: string[] = [];
  let current = '';
  const tokens = normalized.split(/(\s+)/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index]!;
    if (visualTextUnits(token) > maxUnits && !current.trim()) {
      token = flushLongToken(token, lines);
      if (!token) {
        continue;
      }
    }
    const next = `${current}${token}`;
    if (visualTextUnits(next) > maxUnits && current.trim()) {
      lines.push(current.trim());
      current = token.trimStart();
      if (lines.length === maxLines) {
        const remainder = tokens.slice(index + 1).join('');
        lines[maxLines - 1] = compactVisualLine(`${lines[maxLines - 1]}${remainder}`, maxUnits);
        return lines;
      }
    } else {
      current = next;
    }
  }
  if (current.trim() && lines.length < maxLines) {
    lines.push(current.trim());
  }
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
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
  const fill = params.fill ?? '#101820';
  const weight = params.weight ?? 600;
  const lineHeight = params.lineHeight ?? Math.round(params.size * 1.35);
  const opacity = params.opacity ?? 1;
  return params.lines.map((line, index) => (
    `<text x="${params.x}" y="${params.y + index * lineHeight}" fill="${fill}" opacity="${opacity}" font-size="${params.size}" font-weight="${weight}">${escapeXml(line)}</text>`
  )).join('');
}

function isDone(issue: RuntimeIssueView): boolean {
  return issue.delivery_state === 'completed' ||
    issue.orchestrator_state === 'completed' ||
    /^(done|completed|closed)$/i.test(issue.tracker_state);
}

function isCanceled(issue: RuntimeIssueView): boolean {
  return /cancelled|canceled/i.test(`${issue.tracker_state} ${issue.orchestrator_state ?? ''}`);
}

function isFailed(issue: RuntimeIssueView): boolean {
  return issue.delivery_state === 'delivery_failed' ||
    /failed|blocked|halted/i.test(issue.orchestrator_state ?? '');
}

function isEnglishLocale(locale: RuntimeLocale | null | undefined): boolean {
  return locale === 'en';
}

function issueLocale(issue: RuntimeIssueView): RuntimeLocale {
  return issue.supervisor_locale ?? inferRuntimeLocaleFromText([
    issue.title,
    issue.supervisor_plan_summary,
    issue.delivery_summary,
    issue.next_recommended_action,
  ].filter(Boolean).join('\n'));
}

function textForLocale(locale: RuntimeLocale | null | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

function localizedKnown(value: string, locale: RuntimeLocale | null | undefined): string {
  return isEnglishLocale(locale) ? localizeKnownRuntimeText(value, locale) : value;
}

function statusLabel(issue: RuntimeIssueView, locale: RuntimeLocale | null | undefined = issueLocale(issue)): string {
  if (isCanceled(issue)) return textForLocale(locale, '已取消', 'Cancelled');
  if (isDone(issue)) return textForLocale(locale, '已完成', 'Completed');
  if (isFailed(issue)) return textForLocale(locale, '需要处理', 'Needs recovery');
  if (issue.active_decision_kind || issue.governance_status === 'blocked') return textForLocale(locale, '需要决策', 'Needs decision');
  if (issue.phase === 'REVIEW' || /review/i.test(issue.tracker_state)) return textForLocale(locale, 'Review 中', 'In review');
  if (issue.phase === 'DEV' || issue.session || issue.orchestrator_state === 'dev_running') return textForLocale(locale, 'Dev 中', 'Dev running');
  return textForLocale(locale, '准备中', 'Preparing');
}

function statusTone(issue: RuntimeIssueView): { pill: string; text: string; progress: string; debt: string } {
  if (isCanceled(issue)) {
    return { pill: '#3B3420', text: '#B78618', progress: '#1F78FF', debt: '#B78618' };
  }
  if (isDone(issue)) {
    return { pill: '#123B2B', text: '#16955A', progress: '#16955A', debt: '#16955A' };
  }
  if (isFailed(issue) || issue.active_decision_kind || issue.governance_status === 'blocked') {
    return { pill: '#3A271C', text: '#D98518', progress: '#D98518', debt: '#D98518' };
  }
  if (issue.phase === 'REVIEW' || /review/i.test(issue.tracker_state)) {
    return { pill: '#17304A', text: '#1F78FF', progress: '#1F78FF', debt: '#D98518' };
  }
  return { pill: '#143B2B', text: '#16955A', progress: '#16955A', debt: '#D98518' };
}

function detailChips(issue: RuntimeIssueView): string[] {
  return [
    issue.active_pr_number ? `PR #${issue.active_pr_number}` : null,
    issue.branch_name ?? null,
    issue.github_repo ?? null,
    issue.github_issue_number ? `GH #${issue.github_issue_number}` : null,
  ].filter((item): item is string => Boolean(item));
}

function fileDisplayName(path: string | null | undefined): string {
  const normalized = (path ?? '').split(/[\\/]/).filter(Boolean);
  return normalized.at(-1) ?? path ?? '';
}

function shortTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });
}

function latestSignal(issue: RuntimeIssueView): string {
  const locale = issueLocale(issue);
  const latestFile = issue.session?.recent_files
    ?.filter((file) => file.operation !== 'read')
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')))
    .at(0);
  if (latestFile) {
    const time = shortTime(latestFile.timestamp);
    const file = fileDisplayName(latestFile.path);
    return compact(
      textForLocale(
        locale,
        `${time ? `${time} · ` : ''}改了 ${file}`,
        `${time ? `${time} · ` : ''}Edited ${file}`,
      ),
      92,
    );
  }
  const milestone = issue.milestones?.at(-1)?.summary;
  return compact(
    localizedKnown(issue.delivery_summary ||
      issue.next_recommended_action ||
      milestone ||
      issue.supervisor_plan_summary ||
      textForLocale(locale, 'Supervisor 已在 runtime 控制面跟踪这张单。', 'Supervisor has the issue tracked in the runtime control plane.'), locale),
    92,
  );
}

function nowSignal(issue: RuntimeIssueView): string {
  const locale = issueLocale(issue);
  if (isDone(issue)) {
    return textForLocale(locale, 'Issue 已完成，最终交付已闭环。', 'Issue completed; delivery is closed.');
  }
  if (isCanceled(issue)) {
    return textForLocale(locale, 'Issue 已取消，当前不会继续执行。', 'Issue cancelled; no further work is running.');
  }
  if (isFailed(issue) || issue.actions.can_retry) {
    return textForLocale(locale, '当前需要恢复处理，可从 Telegram 触发重试。', 'Recovery is needed; retry can be triggered from Telegram.');
  }
  if (issue.phase === 'REVIEW' || /review/i.test(issue.tracker_state)) {
    return issue.active_pr_number
      ? textForLocale(locale, `Review 进行中，正在看 PR #${issue.active_pr_number}。`, `Review running on PR #${issue.active_pr_number}.`)
      : textForLocale(locale, 'Review 进行中，等待审查结果。', 'Review running; waiting for review result.');
  }
  if (issue.session || issue.orchestrator_state === 'dev_running') {
    return textForLocale(locale, 'Dev 正在执行，最近改动会同步到这里。', 'Dev is running; recent changes appear here.');
  }
  return textForLocale(locale, 'Supervisor 正在跟踪这张单。', 'Supervisor is tracking this issue.');
}

function nextSignal(issue: RuntimeIssueView): string {
  const locale = issueLocale(issue);
  if (isDone(issue)) {
    return issue.active_pr_number
      ? textForLocale(locale, `PR #${issue.active_pr_number} 已就绪，可打开 Mini App 回看日志。`, `PR #${issue.active_pr_number} is ready; open Mini App for logs.`)
      : textForLocale(locale, '可以打开 Mini App 查看完整交付日志。', 'Open Mini App to review the full delivery log.');
  }
  if (issue.actions.can_retry) {
    return textForLocale(locale, '下一步建议重试，并保留原始证据链。', 'Next: retry while preserving the evidence trail.');
  }
  return compact(
    localizedKnown(issue.next_recommended_action || textForLocale(locale, '等待下一条 review / delivery 信号。', 'Wait for the next review or delivery signal.'), locale),
    112,
  );
}

function progressValue(issue: RuntimeIssueView): number {
  return runtimeIssueProgressValue(issue);
}

function evidenceSignal(issue: RuntimeIssueView, locale: RuntimeLocale): string {
  const summary = issue.evidence_summary;
  if (summary && Number(summary.total_requirements) > 0) {
    return textForLocale(locale, `证据 ${summary.satisfied}/${summary.total_requirements}`, `Evidence ${summary.satisfied}/${summary.total_requirements}`);
  }
  if (issue.active_pr_number) {
    return `PR #${issue.active_pr_number}`;
  }
  return textForLocale(locale, 'Runtime live', 'Runtime live');
}

function signalRowSvg(params: {
  y: number;
  label: string;
  title: string;
  detail: string;
  accent: string;
  surface?: string;
  border?: string;
  theme?: SupervisorIssueVisualTheme;
}): string {
  const titleLines = wrapVisualText(params.title, 28, 2);
  const detailLines = titleLines.length > 1 ? [] : wrapVisualText(params.detail, 36, 1);
  const surface = params.surface ?? '#F8FBFE';
  const border = params.border ?? '#D9E4EF';
  const theme = params.theme ?? 'light';
  const labelFill = theme === 'dark' ? '#8FA1B3' : '#7B8EA4';
  const titleFill = theme === 'dark' ? '#EEF4FA' : '#1A2638';
  const detailFill = theme === 'dark' ? '#AEBCC8' : '#73869A';
  return `
    <g transform="translate(82 ${params.y})">
      <rect x="0" y="0" width="916" height="102" rx="20" fill="${surface}" stroke="${border}" stroke-width="2"/>
      <rect x="0" y="0" width="7" height="102" rx="4" fill="${params.accent}"/>
      <text x="38" y="38" fill="${labelFill}" font-size="21" font-weight="850" letter-spacing="2">${escapeXml(params.label)}</text>
      ${textLines({ x: 206, y: 39, lines: titleLines, size: 25, fill: titleFill, weight: 820, lineHeight: 31 })}
      ${detailLines.length > 0 ? textLines({ x: 206, y: 78, lines: detailLines, size: 19, fill: detailFill, weight: 640, lineHeight: 26 }) : ''}
    </g>
  `;
}

type ChipTone = 'green' | 'blue' | 'yellow' | 'neutral';

function chipColors(tone: ChipTone, theme: SupervisorIssueVisualTheme = 'light'): { fill: string; stroke: string; text: string } {
  if (theme === 'dark') {
    if (tone === 'green') {
      return { fill: '#0D382A', stroke: '#1D6D4B', text: '#59E69B' };
    }
    if (tone === 'blue') {
      return { fill: '#102B44', stroke: '#2B5D85', text: '#6BB4FF' };
    }
    if (tone === 'yellow') {
      return { fill: '#332B16', stroke: '#6F5C25', text: '#FFD166' };
    }
    return { fill: '#141C25', stroke: '#2A3949', text: '#B8C7D5' };
  }
  if (tone === 'green') {
    return { fill: '#E8F7EF', stroke: '#B7EBCB', text: '#16844E' };
  }
  if (tone === 'blue') {
    return { fill: '#E7F0FF', stroke: '#BFD8FF', text: '#225CA8' };
  }
  if (tone === 'yellow') {
    return { fill: '#FFF5E1', stroke: '#F2D79A', text: '#9A6500' };
  }
  return { fill: '#F2F6FA', stroke: '#D4DFEA', text: '#51667D' };
}

function statusChipTone(issue: RuntimeIssueView): ChipTone {
  if (isDone(issue)) return 'green';
  if (isFailed(issue) || issue.actions.can_retry || issue.active_decision_kind || issue.governance_status === 'blocked') return 'yellow';
  if (issue.phase === 'REVIEW' || /review/i.test(issue.tracker_state)) return 'blue';
  if (issue.phase === 'DEV' || issue.session || issue.orchestrator_state === 'dev_running') return 'green';
  return 'neutral';
}

function chipSvg(chip: string, x: number, y: number, width: number, tone: ChipTone, theme: SupervisorIssueVisualTheme = 'light'): string {
  const colors = chipColors(tone, theme);
  return `
    <rect x="${x}" y="${y}" width="${width}" height="54" rx="16" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="2"/>
    <text x="${x + 24}" y="${y + 35}" fill="${colors.text}" font-size="22" font-weight="820">${escapeXml(compact(chip, Math.max(8, Math.floor(width / 15))))}</text>
  `;
}

function statusChipSvg(chip: string, x: number, y: number, width: number, tone: ChipTone, theme: SupervisorIssueVisualTheme = 'light'): string {
  const colors = theme === 'dark'
    ? tone === 'green'
      ? { fill: '#0C3F2C', stroke: '#2EBA74', text: '#72F0AA', dot: '#56E39F' }
      : tone === 'blue'
        ? { fill: '#102F4D', stroke: '#2F94FF', text: '#9BD5FF', dot: '#2F94FF' }
        : tone === 'yellow'
          ? { fill: '#3A2D14', stroke: '#F3B53F', text: '#FFD166', dot: '#FFD166' }
          : { fill: '#141C25', stroke: '#3A4B5C', text: '#D0DCE7', dot: '#94A3B8' }
    : tone === 'green'
      ? { fill: '#E8F7EF', stroke: '#2EBA74', text: '#16844E', dot: '#2EBA74' }
      : tone === 'blue'
        ? { fill: '#E7F0FF', stroke: '#2F94FF', text: '#225CA8', dot: '#2F94FF' }
        : tone === 'yellow'
          ? { fill: '#FFF5E1', stroke: '#F3B53F', text: '#9A6500', dot: '#F3B53F' }
          : { fill: '#F2F6FA', stroke: '#B7C7D8', text: '#51667D', dot: '#94A3B8' };
  return `
    <rect x="${x}" y="${y - 2}" width="${width}" height="58" rx="18" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="3"/>
    <circle cx="${x + 30}" cy="${y + 27}" r="7" fill="${colors.dot}"/>
    <text x="${x + 52}" y="${y + 35}" fill="${colors.text}" font-size="23" font-weight="880">${escapeXml(compact(chip, Math.max(8, Math.floor((width - 32) / 14))))}</text>
  `;
}

function stepSvg(params: {
  x: number;
  y: number;
  label: string;
  state: 'done' | 'active' | 'idle';
  theme?: SupervisorIssueVisualTheme;
}): string {
  const done = params.state === 'done';
  const active = params.state === 'active';
  const theme = params.theme ?? 'light';
  const fill = done || active ? '#2F94FF' : theme === 'dark' ? '#0D1117' : '#FFFFFF';
  const stroke = done || active ? '#2F94FF' : theme === 'dark' ? '#475569' : '#97ABC0';
  const text = theme === 'dark'
    ? done ? '#75E8AA' : active ? '#6BB4FF' : '#94A3B8'
    : done ? '#11824E' : active ? '#225CA8' : '#6D8096';
  const haloStroke = done || active ? '#2F94FF' : theme === 'dark' ? '#334155' : '#C7D5E3';
  const haloOpacity = done || active ? '0.16' : theme === 'dark' ? '0.35' : '0.6';
  const glyph = done
    ? '<path d="M-8 0L-2 6L10 -7" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
    : active
      ? '<circle cx="0" cy="0" r="6" fill="#FFFFFF"/>'
      : '';
  return `
    <g transform="translate(${params.x} ${params.y})">
      <circle cx="0" cy="0" r="26" fill="${fill}" stroke="${stroke}" stroke-width="5"/>
      <circle cx="0" cy="0" r="36" fill="none" stroke="${haloStroke}" stroke-width="7" opacity="${haloOpacity}"/>
      ${glyph}
      <text x="0" y="66" text-anchor="middle" fill="${text}" font-size="22" font-weight="${done || active ? '820' : '700'}">${escapeXml(params.label)}</text>
    </g>
  `;
}

function stepStates(issue: RuntimeIssueView): Array<'done' | 'active' | 'idle'> {
  if (isDone(issue) || isCanceled(issue)) {
    return ['done', 'done', 'done', 'done'];
  }
  if (issue.phase === 'REVIEW' || /review/i.test(issue.tracker_state)) {
    return ['done', 'done', 'active', 'idle'];
  }
  if (issue.session || issue.orchestrator_state === 'dev_running' || issue.phase === 'DEV') {
    return ['done', 'active', 'idle', 'idle'];
  }
  return ['active', 'idle', 'idle', 'idle'];
}

export function buildSupervisorIssueVisualCardSvg(issue: RuntimeIssueView, theme: SupervisorIssueVisualTheme = 'light'): string {
  const locale = issueLocale(issue);
  const tone = statusTone(issue);
  const titleLines = wrapVisualText(issue.title, 18.5, 2);
  const titleIsMultiline = titleLines.length > 1;
  const titleFontSize = titleIsMultiline ? 40 : 48;
  const titleLineHeight = titleIsMultiline ? 48 : 58;
  const titleY = titleIsMultiline ? 252 : 266;
  const titleBottom = titleY + Math.max(0, titleLines.length - 1) * titleLineHeight + Math.round(titleFontSize * 0.56);
  const chipY = Math.max(330, titleBottom + 18);
  const progressTextY = chipY + 128;
  const progressRailY = chipY + 184;
  const progressStepY = progressRailY + 5;
  const chips = detailChips(issue);
  const progress = progressValue(issue);
  const progressFontSize = progress >= 100 ? 58 : 68;
  const progressLabelX = progress >= 100 ? 252 : 246;
  const progressLabelY = progressTextY - Math.round(progressFontSize * 0.16);
  const progressWidth = Math.round(856 * progress / 100);
  const states = stepStates(issue);
  const latest = latestSignal(issue);
  const now = nowSignal(issue);
  const next = nextSignal(issue);
  const evidence = evidenceSignal(issue, locale);
  const status = statusLabel(issue, locale);
  const isDark = theme === 'dark';
  const chipRow = [
    statusChipSvg(status, 82, chipY, 196, statusChipTone(issue), theme),
    chips[0] ? chipSvg(chips[0], 300, chipY, 180, 'blue', theme) : '',
    chips[1] ? chipSvg(chips[1], 502, chipY, 252, 'blue', theme) : '',
    chipSvg(evidence, 776, chipY, 222, isDone(issue) ? 'green' : 'neutral', theme),
  ].join('');
  const labels = [
    textForLocale(locale, 'Plan', 'Plan'),
    textForLocale(locale, 'Dev', 'Dev'),
    textForLocale(locale, 'Review', 'Review'),
    textForLocale(locale, 'Delivery', 'Delivery'),
  ];

  return `
<svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${isDark ? '#141C26' : '#FFFFFF'}"/>
      <stop offset="0.52" stop-color="${isDark ? '#0B1016' : '#F6FAFD'}"/>
      <stop offset="1" stop-color="${isDark ? '#080C11' : '#EDF3F8'}"/>
    </linearGradient>
    <linearGradient id="liveRail" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${isDark ? '#56E39F' : '#1DB56F'}"/>
      <stop offset="0.62" stop-color="#2F94FF"/>
      <stop offset="1" stop-color="${isDark ? '#1EA967' : '#138856'}"/>
    </linearGradient>
    <style>
      text { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
    </style>
  </defs>
  <rect width="1080" height="1080" fill="${isDark ? '#071018' : '#EEF3F8'}"/>
  <rect x="34" y="34" width="1012" height="1012" rx="42" fill="url(#cardBg)" stroke="${isDark ? '#263647' : '#D5E0EA'}" stroke-width="3"/>
  <image x="74" y="72" width="64" height="64" href="${isDark ? symHarixLogoDarkThemeDataUri : symHarixLogoLightThemeDataUri}" preserveAspectRatio="xMidYMid meet"/>
  <text x="166" y="116" fill="${isDark ? '#F6FAFD' : '#182337'}" font-size="34" font-weight="780">SymHarix</text>

  <text x="82" y="194" fill="${isDark ? '#2F94FF' : '#2C73D5'}" font-size="34" font-weight="850">${escapeXml(issue.identifier)}</text>
  ${textLines({
    x: 82,
    y: titleY,
    lines: titleLines,
    size: titleFontSize,
    fill: isDark ? '#F4F8FB' : '#172233',
    weight: 860,
    lineHeight: titleLineHeight,
  })}

  ${chipRow}

  <text x="82" y="${progressTextY}" fill="${tone.text}" font-size="${progressFontSize}" font-weight="850">${progress}%</text>
  <text x="${progressLabelX}" y="${progressLabelY}" fill="${isDark ? '#9BAABC' : '#7D8EA4'}" font-size="25" font-weight="780">${escapeXml(textForLocale(locale, '实时进度', 'Live progress'))}</text>
  <rect x="106" y="${progressRailY}" width="856" height="10" rx="5" fill="${isDark ? '#26313D' : '#D7E1EB'}"/>
  <rect x="106" y="${progressRailY}" width="${progressWidth}" height="10" rx="5" fill="url(#liveRail)"/>
  ${stepSvg({ x: 106, y: progressStepY, label: labels[0]!, state: states[0]!, theme })}
  ${stepSvg({ x: 392, y: progressStepY, label: labels[1]!, state: states[1]!, theme })}
  ${stepSvg({ x: 678, y: progressStepY, label: labels[2]!, state: states[2]!, theme })}
  ${stepSvg({ x: 962, y: progressStepY, label: labels[3]!, state: states[3]!, theme })}

  <text x="82" y="670" fill="${isDark ? '#E8F0F7' : '#18263A'}" font-size="31" font-weight="860">${escapeXml(textForLocale(locale, '状态概览', 'Status Overview'))}</text>
  <text x="998" y="670" text-anchor="end" fill="${isDark ? '#8393A3' : '#8A9AAF'}" font-size="21" font-weight="720">${escapeXml(textForLocale(locale, 'Telegram 预览', 'Telegram Preview'))}</text>
  ${signalRowSvg({
    y: 704,
    label: textForLocale(locale, 'NOW', 'NOW'),
    title: now,
    detail: status,
    accent: isDone(issue) ? '#56E39F' : issue.phase === 'REVIEW' ? '#2F94FF' : '#FFD166',
    surface: isDark ? '#111820' : isDone(issue) ? '#F0FAF4' : issue.phase === 'REVIEW' ? '#EEF4FF' : '#FFF8E9',
    border: isDark ? '#223243' : isDone(issue) ? '#C8EFD8' : issue.phase === 'REVIEW' ? '#D3E2FF' : '#F1DFB1',
    theme,
  })}
  ${signalRowSvg({
    y: 820,
    label: textForLocale(locale, 'LATEST', 'LATEST'),
    title: latest,
    detail: issue.github_repo || textForLocale(locale, 'Runtime 控制面', 'Runtime control plane'),
    accent: '#2F94FF',
    surface: isDark ? '#111820' : '#EEF4FF',
    border: isDark ? '#223243' : '#D3E2FF',
    theme,
  })}
  ${signalRowSvg({
    y: 936,
    label: textForLocale(locale, 'NEXT', 'NEXT'),
    title: next,
    detail: textForLocale(locale, '打开 Mini App 可查看完整日志和 diff。', 'Open Mini App for full logs and diff.'),
    accent: isFailed(issue) || issue.actions.can_retry ? '#FFD166' : '#56E39F',
    surface: isDark ? '#111820' : isFailed(issue) || issue.actions.can_retry ? '#FFF8E9' : '#F0FAF4',
    border: isDark ? '#223243' : isFailed(issue) || issue.actions.can_retry ? '#F1DFB1' : '#C8EFD8',
    theme,
  })}
</svg>`;
}

export function buildSupervisorIssueVisualCard(issue: RuntimeIssueView, options: SupervisorIssueVisualCardOptions = {}): SupervisorIssueVisualCard {
  const locale = issueLocale(issue);
  const theme = options.theme ?? 'light';
  const svg = buildSupervisorIssueVisualCardSvg(issue, theme);
  const png = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: 1080,
    },
  }).render().asPng();
  const stateKey = [
    theme,
    issue.updated_at,
    issue.phase,
    issue.tracker_state,
    issue.orchestrator_state,
    issue.delivery_state,
    issue.active_pr_number,
  ].filter(Boolean).join('|');
  const repo = issue.github_repo ? ` · ${compact(issue.github_repo, 34)}` : '';
  const status = `${statusLabel(issue, locale)} · ${progressValue(issue)}%${repo}`;
  const latest = `${textForLocale(locale, '最新', 'Latest')}: ${compact(latestSignal(issue), 70)}`;
  const next = `${textForLocale(locale, '下一步', 'Next')}: ${compact(nextSignal(issue), 70)}`;
  return {
    media_key: `issue-card|${issue.identifier}|${stateKey}`,
    caption: `<b>${escapeXml(issue.identifier)} · ${escapeXml(compact(issue.title, 56))}</b>\n${escapeXml(status)}\n${escapeXml(latest)}\n${escapeXml(next)}`,
    photo: {
      bytes: png,
      filename: theme === 'dark'
        ? `${safeFilenamePart(issue.identifier)}-issue-card-dark.png`
        : `${safeFilenamePart(issue.identifier)}-issue-card.png`,
      content_type: 'image/png',
    },
  };
}
