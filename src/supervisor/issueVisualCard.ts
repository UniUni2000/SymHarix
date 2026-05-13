import { Resvg } from '@resvg/resvg-js';
import type { BotTransportPhoto } from '../bots/types';
import { runtimeIssueProgressValue } from '../runtime/issueProgress';
import type { RuntimeIssueView } from '../runtime/types';
import { inferRuntimeLocaleFromText, localizeKnownRuntimeText, type RuntimeLocale } from '../i18n/locale';

export interface SupervisorIssueVisualCard {
  media_key: string;
  caption: string;
  photo: BotTransportPhoto;
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
  return textForLocale(locale, '执行中', 'Running');
}

function statusTone(issue: RuntimeIssueView): { pill: string; text: string; progress: string; debt: string } {
  if (isCanceled(issue)) {
    return { pill: '#3B3420', text: '#FFD45E', progress: '#6AB5FF', debt: '#E8C558' };
  }
  if (isDone(issue)) {
    return { pill: '#123B2B', text: '#69E6A3', progress: '#69E6A3', debt: '#69E6A3' };
  }
  if (isFailed(issue) || issue.active_decision_kind || issue.governance_status === 'blocked') {
    return { pill: '#3A271C', text: '#FFB36B', progress: '#FFB36B', debt: '#FFCC66' };
  }
  if (issue.phase === 'REVIEW' || /review/i.test(issue.tracker_state)) {
    return { pill: '#17304A', text: '#89CFFF', progress: '#89CFFF', debt: '#E8C558' };
  }
  return { pill: '#143B2B', text: '#70E4A2', progress: '#70E4A2', debt: '#E8C558' };
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
}): string {
  const titleLines = wrapText(params.title, 32, 2);
  const detailLines = titleLines.length > 1 ? [] : wrapText(params.detail, 42, 1);
  return `
    <g transform="translate(82 ${params.y})">
      <rect x="0" y="0" width="916" height="102" rx="20" fill="#111820" stroke="#223243" stroke-width="2"/>
      <rect x="0" y="0" width="7" height="102" rx="4" fill="${params.accent}"/>
      <text x="38" y="38" fill="#8FA1B3" font-size="21" font-weight="850" letter-spacing="2">${escapeXml(params.label)}</text>
      ${textLines({ x: 206, y: 39, lines: titleLines, size: 25, fill: '#EEF4FA', weight: 820, lineHeight: 31 })}
      ${detailLines.length > 0 ? textLines({ x: 206, y: 78, lines: detailLines, size: 19, fill: '#AEBCC8', weight: 640, lineHeight: 26 }) : ''}
    </g>
  `;
}

function chipSvg(chip: string, x: number, y: number, width: number, tone: 'green' | 'blue' | 'neutral'): string {
  const colors = tone === 'green'
    ? { fill: '#0D382A', stroke: '#1D6D4B', text: '#59E69B' }
    : tone === 'blue'
      ? { fill: '#102B44', stroke: '#2B5D85', text: '#6BB4FF' }
      : { fill: '#141C25', stroke: '#2A3949', text: '#B8C7D5' };
  return `
    <rect x="${x}" y="${y}" width="${width}" height="54" rx="16" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="2"/>
    <text x="${x + 24}" y="${y + 35}" fill="${colors.text}" font-size="22" font-weight="820">${escapeXml(compact(chip, Math.max(8, Math.floor(width / 15))))}</text>
  `;
}

function stepSvg(params: {
  x: number;
  y: number;
  label: string;
  state: 'done' | 'active' | 'idle';
}): string {
  const done = params.state === 'done';
  const active = params.state === 'active';
  const fill = done || active ? '#2F94FF' : '#0D1117';
  const stroke = done || active ? '#2F94FF' : '#475569';
  const text = done ? '#75E8AA' : active ? '#6BB4FF' : '#94A3B8';
  const glyph = done
    ? '<path d="M-8 0L-2 6L10 -7" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'
    : active
      ? '<circle cx="0" cy="0" r="6" fill="#FFFFFF"/>'
      : '';
  return `
    <g transform="translate(${params.x} ${params.y})">
      <circle cx="0" cy="0" r="26" fill="${fill}" stroke="${stroke}" stroke-width="5"/>
      <circle cx="0" cy="0" r="36" fill="none" stroke="${done || active ? '#2F94FF' : '#334155'}" stroke-width="7" opacity="${done || active ? '0.16' : '0.35'}"/>
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

export function buildSupervisorIssueVisualCardSvg(issue: RuntimeIssueView): string {
  const locale = issueLocale(issue);
  const tone = statusTone(issue);
  const titleLines = wrapVisualText(issue.title, 18.5, 2);
  const titleIsMultiline = titleLines.length > 1;
  const titleFontSize = titleIsMultiline ? 40 : 48;
  const titleLineHeight = titleIsMultiline ? 48 : 58;
  const titleY = titleIsMultiline ? 276 : 290;
  const titleBottom = titleY + Math.max(0, titleLines.length - 1) * titleLineHeight + Math.round(titleFontSize * 0.56);
  const chipY = Math.max(392, titleBottom + 46);
  const progressTextY = chipY + 128;
  const progressRailY = chipY + 162;
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
  const chipRow = [
    chipSvg(status, 82, chipY, 196, isDone(issue) ? 'green' : issue.phase === 'REVIEW' ? 'blue' : 'neutral'),
    chips[0] ? chipSvg(chips[0], 300, chipY, 180, 'blue') : '',
    chips[1] ? chipSvg(chips[1], 502, chipY, 252, 'blue') : '',
    chipSvg(evidence, 776, chipY, 222, isDone(issue) ? 'green' : 'neutral'),
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
      <stop offset="0" stop-color="#141C26"/>
      <stop offset="0.48" stop-color="#0B1016"/>
      <stop offset="1" stop-color="#080C11"/>
    </linearGradient>
    <linearGradient id="liveRail" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#56E39F"/>
      <stop offset="0.62" stop-color="#2F94FF"/>
      <stop offset="1" stop-color="#1EA967"/>
    </linearGradient>
    <style>
      text { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: 0; }
    </style>
  </defs>
  <rect width="1080" height="1080" fill="#071018"/>
  <rect x="34" y="34" width="1012" height="1012" rx="42" fill="url(#cardBg)" stroke="#263647" stroke-width="3"/>
  <path d="M74 126 C92 88 126 90 144 126 S196 164 216 126 S268 88 288 126" fill="none" stroke="#2F94FF" stroke-width="13" stroke-linecap="round"/>
  <text x="326" y="135" fill="#F6FAFD" font-size="34" font-weight="840">symphonyness</text>
  <rect x="800" y="91" width="198" height="62" rx="18" fill="#111820" stroke="#2C3D50" stroke-width="2"/>
  <text x="899" y="132" text-anchor="middle" fill="#6BB4FF" font-size="22" font-weight="820">${escapeXml(textForLocale(locale, '打开 Mini App', 'Open Mini App'))}</text>

  <text x="82" y="226" fill="#2F94FF" font-size="34" font-weight="850">${escapeXml(issue.identifier)}</text>
  ${textLines({
    x: 82,
    y: titleY,
    lines: titleLines,
    size: titleFontSize,
    fill: '#F4F8FB',
    weight: 880,
    lineHeight: titleLineHeight,
  })}

  ${chipRow}

  <text x="82" y="${progressTextY}" fill="${tone.text}" font-size="${progressFontSize}" font-weight="850">${progress}%</text>
  <text x="${progressLabelX}" y="${progressLabelY}" fill="#9BAABC" font-size="25" font-weight="780">${escapeXml(textForLocale(locale, '实时进度', 'Live progress'))}</text>
  <rect x="106" y="${progressRailY}" width="856" height="10" rx="5" fill="#26313D"/>
  <rect x="106" y="${progressRailY}" width="${progressWidth}" height="10" rx="5" fill="url(#liveRail)"/>
  ${stepSvg({ x: 106, y: progressStepY, label: labels[0]!, state: states[0]! })}
  ${stepSvg({ x: 392, y: progressStepY, label: labels[1]!, state: states[1]! })}
  ${stepSvg({ x: 678, y: progressStepY, label: labels[2]!, state: states[2]! })}
  ${stepSvg({ x: 962, y: progressStepY, label: labels[3]!, state: states[3]! })}

  <text x="82" y="670" fill="#E8F0F7" font-size="31" font-weight="860">${escapeXml(textForLocale(locale, '状态概览', 'Status Overview'))}</text>
  <text x="998" y="670" text-anchor="end" fill="#8393A3" font-size="21" font-weight="720">${escapeXml(textForLocale(locale, 'Telegram 预览', 'Telegram Preview'))}</text>
  ${signalRowSvg({
    y: 704,
    label: textForLocale(locale, 'NOW', 'NOW'),
    title: now,
    detail: status,
    accent: isDone(issue) ? '#56E39F' : issue.phase === 'REVIEW' ? '#2F94FF' : '#FFD166',
  })}
  ${signalRowSvg({
    y: 820,
    label: textForLocale(locale, 'LATEST', 'LATEST'),
    title: latest,
    detail: issue.github_repo || textForLocale(locale, 'Runtime 控制面', 'Runtime control plane'),
    accent: '#2F94FF',
  })}
  ${signalRowSvg({
    y: 936,
    label: textForLocale(locale, 'NEXT', 'NEXT'),
    title: next,
    detail: textForLocale(locale, '打开 Mini App 可查看完整日志和 diff。', 'Open Mini App for full logs and diff.'),
    accent: isFailed(issue) || issue.actions.can_retry ? '#FFD166' : '#56E39F',
  })}
</svg>`;
}

export function buildSupervisorIssueVisualCard(issue: RuntimeIssueView): SupervisorIssueVisualCard {
  const locale = issueLocale(issue);
  const svg = buildSupervisorIssueVisualCardSvg(issue);
  const png = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: 1080,
    },
  }).render().asPng();
  const stateKey = [
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
      filename: `${safeFilenamePart(issue.identifier)}-issue-card.png`,
      content_type: 'image/png',
    },
  };
}
