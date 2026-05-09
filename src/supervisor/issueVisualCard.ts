import { Resvg } from '@resvg/resvg-js';
import type { BotTransportPhoto } from '../bots/types';
import type { RuntimeIssueView } from '../runtime/types';

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

function statusLabel(issue: RuntimeIssueView): string {
  if (isCanceled(issue)) return '已取消';
  if (isDone(issue)) return '已完成';
  if (isFailed(issue)) return '需要处理';
  if (issue.active_decision_kind || issue.governance_status === 'blocked') return '需要决策';
  if (issue.phase === 'REVIEW' || /review/i.test(issue.tracker_state)) return 'Review 中';
  return '执行中';
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
    issue.github_repo ?? null,
    issue.branch_name ?? null,
    issue.active_pr_number ? `PR #${issue.active_pr_number}` : null,
    issue.github_issue_number ? `GH #${issue.github_issue_number}` : null,
  ].filter((item): item is string => Boolean(item));
}

function latestSignal(issue: RuntimeIssueView): string {
  const milestone = issue.milestones?.at(-1)?.summary;
  return compact(
    issue.delivery_summary ||
      issue.next_recommended_action ||
      milestone ||
      issue.supervisor_plan_summary ||
      'Supervisor has the issue tracked in the runtime control plane.',
    92,
  );
}

function progressValue(issue: RuntimeIssueView): number {
  if (isDone(issue) || isCanceled(issue)) return 100;
  if (isFailed(issue)) return 76;
  if (issue.phase === 'REVIEW' || /review/i.test(issue.tracker_state)) return 72;
  if (issue.phase === 'DEV') return 66;
  return 42;
}

export function buildSupervisorIssueVisualCardSvg(issue: RuntimeIssueView): string {
  const tone = statusTone(issue);
  const titleLines = wrapText(issue.title, 31, 2);
  const chips = detailChips(issue);
  const progress = progressValue(issue);
  const progressWidth = Math.round(760 * progress / 100);
  const signalLines = wrapText(latestSignal(issue), 38, 2);
  const scopeLines = [
    issue.phase === 'REVIEW' ? 'Review 当前交付状态与证据' : '分析仓库当前状态与缺失内容',
    issue.actions.can_retry ? '识别失败原因并准备重试' : '识别最紧急问题与下一步',
    '保持 GitHub / Linear / runtime 状态一致',
  ];
  const acceptanceLines = [
    issue.github_issue_number ? `GitHub #${issue.github_issue_number} 状态可追踪` : 'Issue 已被 runtime 跟踪',
    issue.active_pr_number ? `PR #${issue.active_pr_number} 与单据一致` : '交付状态清晰可解释',
    '用户能从 Telegram 打开运行视图',
  ];
  const chipSvg = chips.slice(0, 2).map((chip, index) => {
    const widths = [520, 310];
    const x = 88 + [0, 546][index];
    return `
      <rect x="${x}" y="286" width="${widths[index]}" height="66" rx="18" fill="#0C2230" stroke="#203D4D" stroke-width="2"/>
      <text x="${x + 62}" y="314" fill="#7693A4" font-size="16" font-weight="700">${index === 0 ? 'Repository' : 'Branch'}</text>
      <text x="${x + 62}" y="337" fill="#DDEBF3" font-size="21" font-weight="760">${escapeXml(compact(chip, index === 0 ? 32 : 20))}</text>
      <circle cx="${x + 32}" cy="319" r="18" fill="#E9F5FA"/>
      <text x="${x + 32}" y="326" text-anchor="middle" fill="#071622" font-size="20" font-weight="900">${index === 0 ? 'G' : 'B'}</text>
    `;
  }).join('');
  const listItems = (items: string[], x: number, y: number, color: string): string => items.map((item, index) => `
    <circle cx="${x}" cy="${y + index * 39}" r="6" fill="${color}"/>
    <text x="${x + 22}" y="${y + index * 39 + 8}" fill="#D7E8F0" font-size="22" font-weight="650">${escapeXml(compact(item, 30))}</text>
  `).join('');

  return `
<svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cardBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#071622"/>
      <stop offset="0.56" stop-color="#09202E"/>
      <stop offset="1" stop-color="#0B1824"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1080" fill="#06131D"/>
  <rect x="36" y="36" width="1008" height="1008" rx="30" fill="url(#cardBg)" stroke="#183247" stroke-width="3"/>
  <path d="M60 102 C95 40 145 160 202 96 S286 92 326 116" fill="none" stroke="#64F0B6" stroke-width="12" stroke-linecap="round"/>
  <text x="360" y="102" fill="#62E6AD" font-size="24" font-weight="800">symphonyness</text>
  <text x="548" y="102" fill="#88A2B2" font-size="24" font-weight="700">Supervisor</text>
  <path d="M792 78 C854 118 930 112 1002 70" fill="none" stroke="#102B3B" stroke-width="2"/>

  <rect x="88" y="142" width="158" height="38" rx="12" fill="#132B3B" stroke="#24495C"/>
  <text x="112" y="168" fill="#A6C2D1" font-size="18" font-weight="800">${escapeXml(issue.identifier)}</text>
  <rect x="262" y="142" width="232" height="38" rx="12" fill="${tone.pill}" stroke="#51472C"/>
  <text x="286" y="168" fill="${tone.text}" font-size="18" font-weight="800">${escapeXml(`${issue.complexity ?? 'L2'} · ${statusLabel(issue)}`)}</text>
  <rect x="512" y="142" width="258" height="38" rx="12" fill="#103B2B" stroke="#1D6B48"/>
  <text x="536" y="168" fill="#80E6AD" font-size="18" font-weight="800">High Confidence</text>

  ${textLines({
    x: 88,
    y: 238,
    lines: titleLines,
    size: 38,
    fill: '#F3FAFD',
    weight: 850,
    lineHeight: 48,
  })}

  ${chipSvg}

  <rect x="88" y="382" width="904" height="128" rx="22" fill="#0C2432" stroke="#214455" stroke-width="2"/>
  <text x="122" y="424" fill="#63E7A8" font-size="24" font-weight="850">Supervisor 判断</text>
  <text x="870" y="424" text-anchor="end" fill="${tone.text}" font-size="22" font-weight="850">${escapeXml(statusLabel(issue))}</text>
  ${textLines({
    x: 122,
    y: 462,
    lines: signalLines,
    size: 22,
    fill: '#CBE0EA',
    weight: 650,
    lineHeight: 32,
  })}

  <rect x="88" y="540" width="424" height="180" rx="20" fill="#0B2230" stroke="#1F4253" stroke-width="2"/>
  <text x="122" y="586" fill="#FFFFFF" font-size="22" font-weight="850">本次范围</text>
  ${listItems(scopeLines, 124, 626, '#66F0B4')}

  <rect x="548" y="540" width="444" height="180" rx="20" fill="#0B2230" stroke="#1F4253" stroke-width="2"/>
  <text x="582" y="586" fill="#FFFFFF" font-size="22" font-weight="850">验收标准</text>
  ${listItems(acceptanceLines, 584, 626, '#8CCAFF')}

  <rect x="88" y="750" width="904" height="110" rx="20" fill="#24261E" stroke="#615332" stroke-width="2"/>
  <text x="122" y="794" fill="${tone.debt}" font-size="23" font-weight="850">交付阻塞</text>
  <circle cx="126" cy="828" r="6" fill="${tone.debt}"/>
  <text x="148" y="836" fill="#E7DDB7" font-size="21" font-weight="650">${escapeXml(compact(issue.next_recommended_action || '继续等待最终交付动作完成。', 48))}</text>

  <text x="88" y="912" fill="#E8F4FA" font-size="24" font-weight="850">阶段进度</text>
  <text x="884" y="912" text-anchor="end" fill="#8AA4B3" font-size="18" font-weight="700">Plan · Dispatch · Execution</text>
  <rect x="156" y="954" width="760" height="10" rx="5" fill="#1E4358"/>
  <rect x="156" y="954" width="${progressWidth}" height="10" rx="5" fill="${tone.progress}"/>
  <circle cx="156" cy="958" r="24" fill="#68E7A7"/>
  <text x="156" y="1004" text-anchor="middle" fill="#84E9B5" font-size="18" font-weight="800">计划</text>
  <text x="156" y="1028" text-anchor="middle" fill="#84E9B5" font-size="17" font-weight="800">100%</text>
  <circle cx="536" cy="958" r="24" fill="${progress >= 66 ? '#68E7A7' : '#16384B'}" stroke="#4AA9DF" stroke-width="4"/>
  <text x="536" y="1004" text-anchor="middle" fill="${progress >= 66 ? '#84E9B5' : '#88A2B2'}" font-size="18" font-weight="800">调度</text>
  <text x="536" y="1028" text-anchor="middle" fill="${progress >= 66 ? '#84E9B5' : '#88A2B2'}" font-size="17" font-weight="800">${progress >= 66 ? '100%' : '进行中'}</text>
  <circle cx="916" cy="958" r="24" fill="${progress >= 100 ? '#68E7A7' : '#102D40'}" stroke="#4AA9DF" stroke-width="5"/>
  <text x="916" y="1004" text-anchor="middle" fill="${progress >= 100 ? '#84E9B5' : '#8CCAFF'}" font-size="18" font-weight="800">交付</text>
  <text x="916" y="1028" text-anchor="middle" fill="${progress >= 100 ? '#84E9B5' : '#8CCAFF'}" font-size="17" font-weight="800">${progress >= 100 ? '100%' : '处理中'}</text>
</svg>`;
}

export function buildSupervisorIssueVisualCard(issue: RuntimeIssueView): SupervisorIssueVisualCard {
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
  const repo = issue.github_repo ? ` · ${escapeXml(compact(issue.github_repo, 34))}` : '';
  return {
    media_key: `issue-card|${issue.identifier}|${stateKey}`,
    caption: `<b>${escapeXml(issue.identifier)} · ${escapeXml(compact(issue.title, 56))}</b>\n${escapeXml(statusLabel(issue))}${repo}`,
    photo: {
      bytes: png,
      filename: `${safeFilenamePart(issue.identifier)}-issue-card.png`,
      content_type: 'image/png',
    },
  };
}
