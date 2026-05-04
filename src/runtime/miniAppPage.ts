import type {
  RuntimeFileActivity,
  RuntimeIssueView,
  RuntimeMilestoneView,
  RuntimeToolActivity,
} from './types';

export interface RuntimeMiniAppActivityFeedItem {
  kind: 'tool' | 'file' | 'summary';
  label: string;
  summary: string;
  detail: string;
  timestamp: string | null;
  tone: 'green' | 'blue' | 'yellow' | 'red' | 'neutral';
  status: string;
}

export interface RuntimeMiniAppDiffFileItem {
  path: string;
  badge: 'M' | 'A' | 'D' | 'R';
  summary: string;
  detail?: string | null;
  timestamp: string | null;
  tone: 'green' | 'blue' | 'yellow' | 'red' | 'neutral';
}

export interface RuntimeMiniAppIssuePresentation {
  mode: 'live' | 'completed';
  progress: number;
  stateLabel: string;
  stateTone: 'green' | 'blue' | 'yellow';
  liveBadgeLabel: string;
  timelineTitle: string;
  judgmentSummary: string;
  nextRecommendation: string;
  roundGoal: string;
  riskDelta: string;
  planStatus: string;
  dispatchStatus: string;
  devStatus: string;
  reviewStatus: string;
  reviewDeliveryStatus: string;
  emptyChildQueueLabel: string;
  activityFeed: RuntimeMiniAppActivityFeedItem[];
  visibleMilestones: RuntimeMilestoneView[];
  diffFiles: RuntimeMiniAppDiffFileItem[];
}

function compactPlainText(value: string | null | undefined, maxLength = 520): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function parseRuntimeJsonSummary(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!/^[{[]/.test(trimmed)) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function normalizeRuntimeMiniAppSummary(
  value: string | null | undefined,
  fallback = '',
  maxLength = 520,
): string {
  const raw = String(value || '').trim();
  const parsed = parseRuntimeJsonSummary(raw);
  if (parsed) {
    const toolName = typeof parsed.tool_name === 'string' ? titleCaseToolName(parsed.tool_name) : null;
    const code = typeof parsed.code === 'string' ? parsed.code : '';
    const message = typeof parsed.message === 'string' ? parsed.message : '';
    if (toolName) {
      if (code === 'tool_started' || /^using\s+/i.test(message)) {
        return `${toolName} 正在运行`;
      }
      if (code === 'tool_completed') {
        return `${toolName} 完成`;
      }
      return `${toolName} ${code ? code.replace(/^tool_/, '') : '活动'}`;
    }
    if (message) {
      return compactPlainText(message, maxLength);
    }
  }
  return compactPlainText(raw || fallback, maxLength);
}

function compactText(value: string | null | undefined, maxLength = 520): string {
  return normalizeRuntimeMiniAppSummary(value, '', maxLength);
}

function isRetryableRuntimeMiniAppFailure(issue: RuntimeIssueView): boolean {
  return Boolean(
    issue.actions?.can_retry &&
    (issue.delivery_state === 'delivery_failed' || issue.delivery_code || issue.orchestrator_state === 'failed'),
  );
}

export function isRuntimeMiniAppIssueCompleted(issue: RuntimeIssueView): boolean {
  return issue.delivery_state === 'completed' ||
    issue.orchestrator_state === 'completed' ||
    /^(done|completed)$/i.test(issue.tracker_state || '') ||
    issue.supervisor_session_state === 'completed';
}

function isInternalRuntimeMiniAppMilestone(milestone: RuntimeMilestoneView): boolean {
  if (milestone.kind !== 'delivery_failed') {
    return false;
  }
  return /supervisor_turn_budget_exhausted|turn_budget_exhausted/i.test([
    milestone.key,
    milestone.summary,
  ].join('\n'));
}

export function visibleRuntimeMiniAppMilestones(issue: RuntimeIssueView): RuntimeMilestoneView[] {
  return (issue.milestones ?? [])
    .filter((milestone) => !isInternalRuntimeMiniAppMilestone(milestone))
    .map((milestone) => ({
      ...milestone,
      summary: normalizeRuntimeMiniAppSummary(milestone.summary, milestone.key, 180),
    }))
    .slice(0, 5);
}

function milestone(
  issue: RuntimeIssueView,
  kind: string,
  summary: string,
  timestamp: string | null = issue.updated_at || issue.created_at,
): RuntimeMilestoneView {
  return {
    kind,
    key: `miniapp:${issue.issue_id}:${kind}:${timestamp ?? ''}`,
    summary,
    timestamp,
  };
}

export function buildRuntimeMiniAppMilestones(issue: RuntimeIssueView): RuntimeMilestoneView[] {
  const visible = visibleRuntimeMiniAppMilestones(issue);
  if (visible.length > 0) {
    return visible;
  }

  const items: RuntimeMilestoneView[] = [
    milestone(
      issue,
      'plan_ready',
      compactText(issue.supervisor_plan_summary || issue.title, 160) || '计划已形成，等待执行信号。',
      issue.created_at,
    ),
  ];

  if (issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming') {
    items.push(milestone(
      issue,
      'needs_decision',
      compactText(issue.next_recommended_action || issue.governance_summary, 180) || '当前需要用户确认下一步。',
    ));
  } else {
    items.push(milestone(
      issue,
      'dispatch_ready',
      issue.session || issue.orchestrator_state
        ? '已进入运行通道，等待最近执行信号刷新。'
        : '已准备进入运行通道。',
    ));
  }

  if (isRuntimeMiniAppIssueCompleted(issue)) {
    items.push(milestone(
      issue,
      'delivery_completed',
      compactText(issue.delivery_summary, 180) || 'Issue 已完成，最终交付已闭环。',
    ));
  } else if (issue.delivery_state === 'proof_satisfied') {
    items.push(milestone(
      issue,
      'proof_satisfied',
      compactText(issue.delivery_summary, 180) || '证据已满足，正在等待最终交付。',
    ));
  } else if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
    items.push(milestone(
      issue,
      'review_running',
      compactText(issue.session?.last_message || issue.next_recommended_action, 180) || 'Review 正在检查交付质量。',
      issue.session?.last_event_at || issue.updated_at,
    ));
  } else if (issue.session || issue.orchestrator_state === 'dev_running') {
    items.push(milestone(
      issue,
      'dev_running',
      compactText(issue.session?.last_message || issue.next_recommended_action, 180) || 'Dev agent 正在推进当前轮次。',
      issue.session?.last_event_at || issue.updated_at,
    ));
  }

  return items.slice(0, 5);
}

function diffBadgeForFile(file: RuntimeFileActivity): RuntimeMiniAppDiffFileItem['badge'] {
  if (file.operation === 'write') {
    return 'A';
  }
  return 'M';
}

function stripShellNoise(value: string): string {
  return value
    .replace(/\s+2>\s*\/dev\/null/g, '')
    .replace(/\s+1>\s*\/dev\/null/g, '')
    .replace(/\s+>\s*\/dev\/null/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortWorkspacePath(path: string | null | undefined): string {
  const normalized = String(path || '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
  if (!normalized) {
    return '';
  }
  const worktreeMatch = normalized.match(/\/worktrees\/[^/\s"']+\/(.+)$/);
  if (worktreeMatch?.[1]) {
    return worktreeMatch[1];
  }
  const workspaceMatch = normalized.match(/\/workspaces\/[^/\s"']+\/(.+)$/);
  if (workspaceMatch?.[1]) {
    return workspaceMatch[1];
  }
  const projectMatch = normalized.match(/\/symharix\/(.+)$/);
  if (projectMatch?.[1]) {
    return projectMatch[1];
  }
  if (!normalized.startsWith('/')) {
    return normalized;
  }
  return basename(normalized);
}

function readablePath(path: string | null | undefined): string {
  return shortWorkspacePath(path) || basename(path) || 'workspace';
}

function fileDisplayName(path: string | null | undefined): string {
  return basename(shortWorkspacePath(path) || path) || 'workspace';
}

function parentFolder(path: string | null | undefined): string {
  const shortened = shortWorkspacePath(path);
  const parts = shortened.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return '';
  }
  return parts.slice(0, -1).join('/');
}

function humanFileOperation(operation: RuntimeFileActivity['operation'] | string | null | undefined): string {
  if (operation === 'read') return '读取';
  if (operation === 'write') return '写入';
  if (operation === 'edit') return '编辑';
  return '文件活动';
}

function summarizeDiffPath(path: string, fallback: string): string {
  const displayPath = readablePath(path);
  const name = fileDisplayName(displayPath);
  const lower = displayPath.toLowerCase();
  if (/\.test\.|\.spec\.|__tests__|test\//.test(lower)) {
    return '补充或更新回归测试。';
  }
  if (/miniapp|page|style|css|tsx?$|jsx?$/.test(lower)) {
    return '调整界面展示逻辑与排版。';
  }
  if (/readme|docs?|\.md$/.test(lower)) {
    return '更新文档说明。';
  }
  if (/package|bun\.lock|lockfile/.test(lower)) {
    return '更新依赖或脚本配置。';
  }
  if (/\.symphony|state|evidence|handover/.test(lower)) {
    return '更新运行证据与交付状态。';
  }
  if (fallback) {
    return compactText(fallback, 90);
  }
  return `更新 ${name}。`;
}

export function buildRuntimeMiniAppDiffFiles(issue: RuntimeIssueView): RuntimeMiniAppDiffFileItem[] {
  const byPath = new Map<string, RuntimeMiniAppDiffFileItem>();
  const overview = compactText(issue.change_pack_summary?.overview, 90);

  for (const path of issue.change_pack_summary?.files ?? []) {
    const normalized = readablePath(path);
    if (!normalized) {
      continue;
    }
    byPath.set(normalized, {
      path: normalized,
      badge: 'M',
      summary: summarizeDiffPath(normalized, overview),
      detail: overview || null,
      timestamp: null,
      tone: 'blue',
    });
  }

  for (const file of issue.session?.recent_files ?? []) {
    if (file.operation === 'read') {
      continue;
    }
    const normalized = readablePath(file.path);
    if (!normalized) {
      continue;
    }
    byPath.set(normalized, {
      path: normalized,
      badge: diffBadgeForFile(file),
      summary: `${humanFileOperation(file.operation)}${file.status === 'started' ? '中' : '完成'} · ${summarizeDiffPath(normalized, overview)}`,
      detail: overview || null,
      timestamp: file.timestamp,
      tone: feedToneFromStatus(file.status),
    });
  }

  return [...byPath.values()]
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')))
    .slice(0, 8);
}

function titleCaseToolName(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (/bash|shell|terminal|exec/.test(lower)) {
    return 'Bash';
  }
  if (/read|open|cat/.test(lower)) {
    return 'Read';
  }
  if (/edit|patch|apply|write/.test(lower)) {
    return 'Edit';
  }
  if (/test|pytest|bun|vitest|jest/.test(lower)) {
    return 'Test';
  }
  if (/git|github|pr/.test(lower)) {
    return 'Git';
  }
  if (/review/.test(lower)) {
    return 'Review';
  }
  const compact = toolName.replace(/[_-]+/g, ' ').trim();
  return compact ? compact.slice(0, 1).toUpperCase() + compact.slice(1) : 'Tool';
}

function basename(path: string | null | undefined): string {
  const normalized = String(path || '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.split('/').filter(Boolean).at(-1) || normalized;
}

function summarizeShellCommand(value: string, label = 'Bash'): string {
  if (/^\s*[{[]/.test(value)) {
    return normalizeRuntimeMiniAppSummary(value, `${label} 运行中`, 72);
  }
  const command = stripShellNoise(value);
  const lower = command.toLowerCase();
  const pathCandidate = command.match(/(?:cat|sed|awk|tail|head|less|open|code)\s+(?:-[^\s]+\s+)*["']?([^"'\s<>|;&]+)["']?/i)?.[1]
    || command.match(/>\s*["']?([^"'\s<>|;&]+)["']?/)?.[1];
  const path = pathCandidate ? fileDisplayName(pathCandidate) : '';
  if (/gh\s+pr\s+view/i.test(command)) {
    const pr = command.match(/gh\s+pr\s+view\s+(\d+)/i)?.[1];
    return pr ? `查看 PR #${pr}` : '查看 PR 状态';
  }
  if (/git\s+status|git\s+log/i.test(command)) {
    return '检查 Git 状态';
  }
  if (/bun\s+test|npm\s+test|pnpm\s+test|pytest|vitest|jest/i.test(command)) {
    return '运行测试';
  }
  if (/\brm\s+-rf\b|\bdelete\b|删除/.test(lower)) {
    return compactText(command.replace(/\s*&&\s*/g, '，然后 '), 72);
  }
  if (/^cat\s*>|>\s*["']?[^"'\s]+/.test(command)) {
    return path ? `写入 ${path}` : '写入文件';
  }
  if (/^(cat|sed|awk|tail|head|less)\b/.test(command)) {
    return path ? `读取 ${path}` : '读取文件';
  }
  if (/^(ls|find|tree)\b/.test(command)) {
    return '检查文件列表';
  }
  if (!command || /^using\s+/i.test(command)) {
    return `${label} 运行中`;
  }
  return compactText(command.replace(/\/Users\/[^\s"']+/g, (match) => fileDisplayName(match)), 72);
}

function summarizeToolActivity(tool: RuntimeToolActivity, label: string): string {
  if (label === 'Bash') {
    return summarizeShellCommand(tool.message || tool.summary || '', label);
  }
  const path = fileDisplayName(tool.path);
  if (label === 'Read') {
    return path ? `读取 ${path}` : compactText(tool.summary || tool.message || '读取文件', 72);
  }
  if (label === 'Edit') {
    return path ? `编辑 ${path}` : compactText(tool.summary || tool.message || '编辑文件', 72);
  }
  return compactText(tool.summary || tool.message || `${label} running`, 72);
}

function feedToneFromStatus(status: string | null | undefined): RuntimeMiniAppActivityFeedItem['tone'] {
  if (status === 'failed') {
    return 'red';
  }
  if (status === 'started') {
    return 'blue';
  }
  if (status === 'completed') {
    return 'green';
  }
  return 'neutral';
}

function feedItemFromTool(tool: RuntimeToolActivity): RuntimeMiniAppActivityFeedItem {
  const label = titleCaseToolName(tool.tool_name);
  const detailPath = readablePath(tool.path);
  const detail = detailPath || (tool.status === 'started' ? `${label} running` : `${label} completed`);
  const summary = summarizeToolActivity(tool, label);
  return {
    kind: 'tool',
    label,
    summary,
    detail,
    timestamp: tool.timestamp,
    tone: feedToneFromStatus(tool.status),
    status: tool.status,
  };
}

function feedItemFromFile(file: RuntimeFileActivity): RuntimeMiniAppActivityFeedItem {
  const label = file.operation === 'read'
    ? 'Read'
    : file.operation === 'write'
      ? 'Write'
      : file.operation === 'edit'
        ? 'Edit'
        : 'File';
  const fileName = basename(file.path) || 'workspace';
  const displayName = fileDisplayName(file.path) || fileName;
  const folder = parentFolder(file.path);
  return {
    kind: 'file',
    label,
    summary: `${humanFileOperation(file.operation)} ${displayName}`,
    detail: [humanFileOperation(file.operation), folder].filter(Boolean).join(' · '),
    timestamp: file.timestamp,
    tone: feedToneFromStatus(file.status),
    status: file.status,
  };
}

function activityDedupeKey(item: RuntimeMiniAppActivityFeedItem): string {
  return [
    item.kind,
    item.label,
    compactText(item.summary.toLowerCase(), 80),
  ].join('|');
}

export function buildRuntimeMiniAppActivityFeed(issue: RuntimeIssueView): RuntimeMiniAppActivityFeedItem[] {
  if (isRuntimeMiniAppIssueCompleted(issue)) {
    const completedAt = issue.updated_at || issue.created_at;
    const summary = compactText(issue.delivery_summary, 180);
    return [{
      kind: 'summary',
      label: 'Closed',
      summary: summary || 'Issue 已完成，最终交付已闭环。',
      detail: issue.active_pr_number ? `PR #${issue.active_pr_number}` : issue.github_repo || issue.identifier,
      timestamp: completedAt,
      tone: 'green',
      status: 'completed',
    }];
  }

  const tools = issue.session?.recent_tools ?? [];
  const files = issue.session?.recent_files ?? [];
  const sorted = [
    ...tools.map(feedItemFromTool),
    ...files.map(feedItemFromFile),
  ]
    .sort((left, right) => {
      const leftStarted = left.status === 'started' ? 1 : 0;
      const rightStarted = right.status === 'started' ? 1 : 0;
      if (leftStarted !== rightStarted) {
        return rightStarted - leftStarted;
      }
      return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
    });
  const seen = new Set<string>();
  const compacted: RuntimeMiniAppActivityFeedItem[] = [];
  for (const item of sorted) {
    const key = activityDedupeKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    compacted.push(item);
  }
  return compacted.slice(0, 6);
}

export function buildRuntimeMiniAppIssuePresentation(issue: RuntimeIssueView): RuntimeMiniAppIssuePresentation {
  const completed = isRuntimeMiniAppIssueCompleted(issue);
  const retryableFailure = isRetryableRuntimeMiniAppFailure(issue);
  const deliverySummary = normalizeRuntimeMiniAppSummary(issue.delivery_summary, '', 4000);
  const reviewApproved = issue.milestones?.some((milestone) => milestone.kind === 'review_completed') ?? false;
  if (completed) {
    return {
      mode: 'completed',
      progress: 100,
      stateLabel: 'Completed',
      stateTone: 'green',
      liveBadgeLabel: 'Final',
      timelineTitle: '交付总结',
      judgmentSummary: deliverySummary || '计划线程已完成，最终交付已闭环。',
      nextRecommendation: issue.active_pr_number
        ? `已完成，PR #${issue.active_pr_number} 已就绪。可以查看 PR，或回到 Telegram 发起下一条需求。`
        : '已完成。可以回到 Telegram 发起下一条需求。',
      roundGoal: `当前计划「${issue.title}」已经完成，不再向 dev agent 追加指令。`,
      riskDelta: compactText(issue.riskDelta || issue.risk_delta, 180) || 'stable',
      planStatus: '完成',
      dispatchStatus: '完成',
      devStatus: '完成',
      reviewStatus: '完成',
      reviewDeliveryStatus: reviewApproved ? 'approved' : '完成',
      emptyChildQueueLabel: '单 issue 已完成，没有拆分子任务。',
      activityFeed: buildRuntimeMiniAppActivityFeed(issue),
      visibleMilestones: buildRuntimeMiniAppMilestones(issue),
      diffFiles: buildRuntimeMiniAppDiffFiles(issue),
    };
  }

  const progress = issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running'
    ? 72
    : issue.session || issue.orchestrator_state === 'dev_running'
      ? 42
      : issue.governance_thread_state === 'waiting_on_child'
        ? 34
        : 18;
  return {
    mode: 'live',
    progress: retryableFailure ? Math.max(progress, 82) : progress,
    stateLabel: issue.delivery_state === 'proof_satisfied'
      ? 'Proof satisfied'
      : retryableFailure
        ? 'Needs recovery'
        : issue.orchestrator_state || issue.tracker_state || 'Running',
    stateTone: issue.delivery_state === 'proof_satisfied'
      ? 'green'
      : retryableFailure
        ? 'yellow'
        : 'blue',
    liveBadgeLabel: retryableFailure ? 'Action' : 'Live',
    timelineTitle: '实时事件流',
    judgmentSummary: normalizeRuntimeMiniAppSummary(
      issue.supervisor_plan_summary || issue.governance_summary || issue.delivery_summary,
      '',
      4000,
    ) || '当前只推进最有把握的下一步，保持 child 队列有序。',
    nextRecommendation: retryableFailure
      ? '交付恢复卡住了，但这类问题可以一键重试：先清理工作流产物，再重新进入交付。'
      : normalizeRuntimeMiniAppSummary(issue.next_recommended_action || issue.governance_expected_handoff, '', 4000) || '等待 supervisor 写入下一步动作。',
    roundGoal: normalizeRuntimeMiniAppSummary(issue.roundGoal || issue.round?.goal || issue.next_recommended_action, '', 4000) || '等待下一步运行时信号。',
    riskDelta: normalizeRuntimeMiniAppSummary(issue.riskDelta || issue.risk_delta, '', 4000) || 'stable',
    planStatus: '完成',
    dispatchStatus: progress >= 30 ? '完成' : '等待',
    devStatus: progress >= 100 ? '完成' : '运行中',
    reviewStatus: progress >= 78 ? '运行中' : '等待中',
    reviewDeliveryStatus: issue.phase === 'REVIEW' ? 'running' : 'waiting for review',
    emptyChildQueueLabel: '这是单 issue 执行，没有必要拆分子任务。',
    activityFeed: buildRuntimeMiniAppActivityFeed(issue),
    visibleMilestones: buildRuntimeMiniAppMilestones(issue),
    diffFiles: buildRuntimeMiniAppDiffFiles(issue),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderRuntimeMiniAppPage(issueId: string): string {
  const encodedIssueId = encodeURIComponent(issueId);
  const escapedIssueId = escapeHtml(issueId);
  const issueApi = `/api/v1/runtime/issues/${encodedIssueId}`;
  const timelineApi = `/api/v1/runtime/issues/${encodedIssueId}/timeline`;
  const historyApi = `/api/v1/runtime/issues/${encodedIssueId}/history`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <title>symphonyness issue cockpit · ${escapedIssueId}</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      :root {
        --bg: #061018;
        --panel: rgba(12, 22, 34, 0.9);
        --panel-strong: rgba(15, 29, 43, 0.98);
        --line: rgba(156, 179, 204, 0.18);
        --line-strong: rgba(156, 179, 204, 0.28);
        --ink: #f3f7fb;
        --muted: #94a7ba;
        --soft: #c9d5e1;
        --green: #56e39f;
        --green-soft: rgba(86, 227, 159, 0.14);
        --blue: #6bb4ff;
        --blue-soft: rgba(107, 180, 255, 0.15);
        --yellow: #ffd166;
        --yellow-soft: rgba(255, 209, 102, 0.14);
        --red: #ff7b7b;
        --red-soft: rgba(255, 123, 123, 0.15);
      }

      * { box-sizing: border-box; }
      html { min-height: 100%; background: var(--bg); }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 82% 8%, rgba(86, 227, 159, 0.16), transparent 24%),
          radial-gradient(circle at 8% 18%, rgba(107, 180, 255, 0.16), transparent 28%),
          linear-gradient(180deg, #08131d 0%, #040b12 100%);
      }

      button { font: inherit; border: 0; }
      .shell {
        width: min(100%, 1080px);
        min-height: 100vh;
        margin: 0 auto;
        padding: calc(14px + env(safe-area-inset-top)) 12px calc(18px + env(safe-area-inset-bottom));
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 10;
        display: grid;
        grid-template-columns: 74px minmax(0, 1fr) 42px;
        align-items: center;
        gap: 10px;
        margin: -2px -2px 12px;
        padding: 10px 2px 12px;
        background: linear-gradient(180deg, rgba(6, 16, 24, 0.96), rgba(6, 16, 24, 0.72));
        backdrop-filter: blur(18px);
      }
      .topbar button {
        min-height: 38px;
        color: var(--blue);
        background: transparent;
        text-align: left;
        cursor: pointer;
      }
      .app-title {
        min-width: 0;
        text-align: center;
      }
      .app-title strong {
        display: block;
        overflow: hidden;
        color: var(--ink);
        font-size: 18px;
        line-height: 1.15;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .app-title span {
        color: var(--muted);
        font-size: 12px;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 112px;
        gap: 12px;
        align-items: center;
        padding: 16px 10px 15px;
      }
      .hero > div:first-child {
        min-width: 0;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
        color: var(--ink);
        font-weight: 760;
        font-size: 18px;
      }
      .wave {
        width: 42px;
        height: 30px;
      }
      .issue-title {
        margin: 0 0 10px;
        font-size: clamp(23px, 5.8vw, 34px);
        line-height: 1.12;
        font-weight: 820;
        letter-spacing: 0;
        overflow-wrap: anywhere;
      }
      .repo-line,
      .status-line {
        display: flex;
        min-width: 0;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        color: var(--soft);
        font-size: 14px;
      }
      .github-mark {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        color: var(--ink);
      }
      .repo-name {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-weight: 720;
      }
      .chip {
        display: inline-flex;
        min-height: 30px;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border: 1px solid var(--line);
        border-radius: 9px;
        background: rgba(255, 255, 255, 0.045);
        color: var(--soft);
        font-weight: 620;
      }
      .chip.green { color: var(--green); background: var(--green-soft); border-color: rgba(86, 227, 159, 0.2); }
      .chip.blue { color: var(--blue); background: var(--blue-soft); border-color: rgba(107, 180, 255, 0.22); }
      .chip.yellow { color: var(--yellow); background: var(--yellow-soft); border-color: rgba(255, 209, 102, 0.22); }
      .ring {
        position: relative;
        width: 108px;
        aspect-ratio: 1;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: conic-gradient(var(--green) var(--progress), var(--blue) calc(var(--progress) + 22deg), rgba(255,255,255,0.08) 0);
      }
      .ring::before {
        content: "";
        position: absolute;
        inset: 10px;
        border-radius: 50%;
        background: #071018;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
      }
      .ring-content {
        position: relative;
        text-align: center;
      }
      .ring-content strong {
        display: block;
        font-size: 28px;
        line-height: 1;
      }
      .ring-content span {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 620;
      }
      .judgment {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
        margin: 4px 0 14px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: 12px;
        background: linear-gradient(145deg, rgba(17, 31, 45, 0.92), rgba(8, 17, 27, 0.92));
        box-shadow: 0 18px 46px rgba(0, 0, 0, 0.24);
      }
      .panel.pad { padding: 15px; }
      .panel-title {
        margin: 0 0 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        color: var(--ink);
        font-size: 16px;
        line-height: 1.25;
        font-weight: 780;
      }
      .panel-copy {
        margin: 0;
        color: var(--soft);
        font-size: 14px;
        line-height: 1.55;
      }
      .stage-row {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0;
        overflow: hidden;
      }
      .stage {
        min-width: 0;
        padding: 14px 10px 16px;
        border-right: 1px solid var(--line);
      }
      .stage:last-child { border-right: 0; }
      .stage strong {
        display: block;
        color: var(--ink);
        font-size: 13px;
        line-height: 1.2;
      }
      .stage span {
        display: block;
        margin-top: 5px;
        color: var(--muted);
        font-size: 12px;
      }
      .stage-meter {
        position: relative;
        height: 3px;
        margin-top: 15px;
        border-radius: 999px;
        background: rgba(255,255,255,0.12);
      }
      .stage-meter i {
        display: block;
        width: var(--value);
        height: 100%;
        border-radius: inherit;
        background: var(--tone);
      }
      .layout {
        display: grid;
        gap: 14px;
      }
      .timeline {
        position: relative;
        display: grid;
        gap: 14px;
        margin-top: 8px;
      }
      .timeline::before {
        content: "";
        position: absolute;
        top: 18px;
        bottom: 10px;
        left: 78px;
        width: 2px;
        border-radius: 999px;
        background: linear-gradient(180deg, rgba(86, 227, 159, 0.45), rgba(107, 180, 255, 0.22), transparent);
      }
      .event {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-columns: 62px 22px minmax(0, 1fr) minmax(42px, max-content);
        gap: 8px;
        align-items: start;
      }
      .event-time {
        color: var(--soft);
        font-size: 12px;
        font-weight: 760;
      }
      .event-node {
        display: block;
        margin-top: 3px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--green);
        box-shadow: 0 0 0 6px rgba(86, 227, 159, 0.12);
      }
      .event-node.blue { background: var(--blue); box-shadow: 0 0 0 6px rgba(107, 180, 255, 0.12); }
      .event-node.yellow { background: var(--yellow); box-shadow: 0 0 0 6px rgba(255, 209, 102, 0.12); }
      .event-node.red { background: var(--red); box-shadow: 0 0 0 6px rgba(255, 123, 123, 0.12); }
      .event-node.neutral { background: var(--muted); box-shadow: 0 0 0 6px rgba(148, 167, 186, 0.11); }
      .event h3 {
        margin: 0;
        min-width: 0;
        font-size: 14px;
        line-height: 1.3;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .event p {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .event > div { min-width: 0; }
      .file-row,
      .agent-row,
      .milestone-row,
      .diff-row,
      .delivery-row,
      .child-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        padding: 10px 0;
        border-top: 1px solid rgba(156, 179, 204, 0.12);
      }
      .file-row > div,
      .agent-row > div,
      .milestone-row > div,
      .diff-row > div,
      .delivery-row > div,
      .child-row > div {
        min-width: 0;
      }
      .file-row:first-of-type,
      .agent-row:first-of-type,
      .milestone-row:first-of-type,
      .diff-row:first-of-type,
      .delivery-row:first-of-type,
      .child-row:first-of-type {
        border-top: 0;
      }
      .file-row strong,
      .agent-row strong,
      .milestone-row strong,
      .diff-row strong,
      .delivery-row strong,
      .child-row strong {
        display: block;
        overflow: hidden;
        font-size: 13px;
        line-height: 1.35;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .file-row span,
      .agent-row span,
      .milestone-row span,
      .diff-row span,
      .delivery-row span,
      .child-row span {
        display: block;
        margin-top: 3px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.42;
      }
      .agent-row span,
      .milestone-row span {
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .diff-row {
        align-items: start;
      }
      .diff-row strong {
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        color: var(--ink);
      }
      .diff-row span {
        line-height: 1.45;
      }
      .expandable-copy {
        display: block;
        min-width: 0;
      }
      .expandable-text {
        display: block;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .expand-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 7px;
        padding: 4px 9px;
        border: 1px solid rgba(107, 180, 255, 0.26);
        border-radius: 8px;
        color: var(--blue);
        background: rgba(107, 180, 255, 0.11);
        cursor: pointer;
        font-size: 12px;
        font-weight: 760;
        line-height: 1.1;
      }
      .diff-detail {
        display: block;
        margin-top: 7px;
        padding-left: 10px;
        border-left: 2px solid rgba(107, 180, 255, 0.22);
        color: var(--soft);
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 11px;
        line-height: 1.48;
        overflow-wrap: anywhere;
        word-break: break-word;
        white-space: normal;
      }
      .diff-stat {
        min-width: 34px;
        padding: 5px 8px;
        border-radius: 8px;
        color: var(--green);
        background: rgba(86, 227, 159, 0.12);
        text-align: center;
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 12px;
        font-weight: 820;
      }
      .diff-stat.blue { color: var(--blue); background: var(--blue-soft); }
      .diff-stat.yellow { color: var(--yellow); background: var(--yellow-soft); }
      .diff-stat.red { color: #ffd1d1; background: var(--red-soft); }
      .mini-badge {
        min-width: 34px;
        max-width: 72px;
        padding: 5px 8px;
        border-radius: 8px;
        color: var(--green);
        background: var(--green-soft);
        text-align: center;
        font-size: 12px;
        font-weight: 760;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mini-badge.blue { color: var(--blue); background: var(--blue-soft); }
      .mini-badge.yellow { color: var(--yellow); background: var(--yellow-soft); }
      .mini-badge.red { color: #ffd1d1; background: var(--red-soft); }
      .mini-badge.neutral { color: var(--soft); background: rgba(255,255,255,0.07); }
      .event .mini-badge { justify-self: end; }
      .history-panel {
        margin-top: 14px;
      }
      .history-panel[hidden] {
        display: none;
      }
      .panel-title .text-button {
        min-height: 30px;
        padding: 4px 9px;
        border: 1px solid var(--line);
        border-radius: 8px;
        color: var(--blue);
        background: rgba(107, 180, 255, 0.1);
        cursor: pointer;
        font-size: 12px;
        font-weight: 720;
      }
      .history-entry {
        display: grid;
        grid-template-columns: 76px minmax(0, 1fr) minmax(42px, max-content);
        gap: 10px;
        align-items: start;
        padding: 12px 0;
        border-top: 1px solid rgba(156, 179, 204, 0.12);
      }
      .history-entry:first-of-type {
        border-top: 0;
      }
      .history-entry time {
        color: var(--muted);
        font-size: 12px;
        font-weight: 760;
      }
      .history-entry strong {
        display: block;
        color: var(--ink);
        font-size: 13px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .history-entry span {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin: 14px 0 0;
        padding: 0 0 env(safe-area-inset-bottom);
      }
      .actions button,
      .actions a {
        display: inline-flex;
        min-height: 50px;
        align-items: center;
        justify-content: center;
        padding: 10px 8px;
        border: 1px solid var(--line);
        border-radius: 10px;
        color: var(--soft);
        background: rgba(255, 255, 255, 0.055);
        text-decoration: none;
        font-size: 13px;
        font-weight: 760;
        line-height: 1.18;
        white-space: nowrap;
      }
      .actions .danger { color: #ffd1d1; background: var(--red-soft); border-color: rgba(255, 123, 123, 0.24); }
      .actions .primary { color: #c7efff; background: var(--blue-soft); border-color: rgba(107, 180, 255, 0.24); }
      .actions .disabled { color: var(--muted); pointer-events: none; opacity: 0.62; }
      .loading {
        min-height: 180px;
        display: grid;
        place-items: center;
        color: var(--muted);
      }
      @media (min-width: 720px) {
        .shell { padding-left: 22px; padding-right: 22px; }
        .hero { grid-template-columns: minmax(0, 1fr) 176px; padding: 26px 20px 20px; }
        .ring { width: 160px; }
        .ring-content strong { font-size: 42px; }
        .judgment { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .layout { grid-template-columns: minmax(0, 1.5fr) minmax(320px, 0.88fr); align-items: stretch; }
        .layout > .panel:first-child { min-height: 430px; }
        .issue-title { font-size: 36px; }
        .actions { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <main class="shell" data-issue-id="${escapedIssueId}" data-issue-api="${issueApi}" data-timeline-api="${timelineApi}" data-history-api="${historyApi}">
      <nav class="topbar" aria-label="Telegram Mini App controls">
        <button id="close-button" type="button">Close</button>
        <div class="app-title">
          <strong>symphonyness</strong>
          <span>issue cockpit</span>
        </div>
        <button id="menu-button" type="button" aria-label="More">•••</button>
      </nav>

      <section id="hero" class="hero panel">
        <div>
          <div class="brand">
            <svg class="wave" viewBox="0 0 70 42" aria-hidden="true">
              <path d="M4 23 C12 5 26 8 27 24 C29 42 47 39 50 19 C53 2 63 9 66 21" fill="none" stroke="#56e39f" stroke-width="6" stroke-linecap="round"/>
            </svg>
            <span>symphonyness</span>
          </div>
          <h1 id="issue-title" class="issue-title">${escapedIssueId}</h1>
          <div id="repo-line" class="repo-line">
            <svg class="github-mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0.2a8 8 0 0 0-2.53 15.59c0.4 0.07 0.55-0.17 0.55-0.38v-1.49c-2.24 0.49-2.71-0.95-2.71-0.95-0.36-0.92-0.88-1.16-0.88-1.16-0.72-0.49 0.05-0.48 0.05-0.48 0.8 0.06 1.22 0.82 1.22 0.82 0.71 1.21 1.86 0.86 2.31 0.66 0.07-0.52 0.28-0.86 0.5-1.06-1.79-0.2-3.67-0.89-3.67-3.98 0-0.88 0.31-1.6 0.82-2.16-0.08-0.2-0.36-1.02 0.08-2.13 0 0 0.67-0.21 2.2 0.82A7.62 7.62 0 0 1 8 4.03c0.68 0 1.36 0.09 2 0.27 1.52-1.03 2.19-0.82 2.19-0.82 0.44 1.11 0.16 1.93 0.08 2.13 0.51 0.56 0.82 1.28 0.82 2.16 0 3.1-1.89 3.77-3.69 3.97 0.29 0.25 0.55 0.74 0.55 1.5v2.22c0 0.21 0.15 0.46 0.56 0.38A8 8 0 0 0 8 0.2Z"/></svg>
            <span class="repo-name">loading</span>
          </div>
          <div id="status-line" class="status-line">
            <span class="chip green">Loading</span>
          </div>
        </div>
        <div id="progress-ring" class="ring" style="--progress: 0deg">
          <div class="ring-content">
            <strong id="progress-value">0%</strong>
            <span>整体进度</span>
          </div>
        </div>
      </section>

      <section class="judgment">
        <article class="panel pad">
          <h2 class="panel-title">全览 / Supervisor 判断</h2>
          <p id="judgment-copy" class="panel-copy">正在读取当前 issue 状态。</p>
        </article>
        <article class="panel pad">
          <h2 class="panel-title">下一步推荐</h2>
          <p id="next-copy" class="panel-copy">等待运行时信号。</p>
        </article>
      </section>

      <section class="panel pad" style="margin-bottom:14px">
        <h2 class="panel-title">当前轮次目标 <span id="complexity-chip" class="chip blue">L?</span></h2>
        <p id="round-goal" class="panel-copy">等待 supervisor round 信号。</p>
        <p id="risk-delta" class="panel-copy" style="margin-top:8px">risk_delta · loading</p>
      </section>

      <section id="stage-row" class="panel stage-row" aria-label="阶段进度"></section>

      <div class="layout">
        <section class="panel pad">
          <h2 class="panel-title"><span id="timeline-title">实时事件流</span> <span id="live-badge" class="chip green">Live</span></h2>
          <div id="timeline-list" class="timeline"><div class="loading">Loading timeline...</div></div>
        </section>

        <aside class="side-stack">
          <section class="panel pad">
            <h2 class="panel-title">文件活动 <span class="chip blue">最近</span></h2>
            <div id="file-list"></div>
          </section>

          <section class="panel pad" style="margin-top:14px">
            <h2 class="panel-title">代码改动 <span class="chip green">diff</span></h2>
            <div id="diff-list"></div>
          </section>

          <section class="panel pad" style="margin-top:14px">
            <h2 class="panel-title">Agent 进度 <span class="chip green">最近 3 条</span></h2>
            <div id="agent-list"></div>
          </section>

          <section class="panel pad" style="margin-top:14px">
            <h2 class="panel-title">关键节点 <span class="chip yellow">milestones</span></h2>
            <div id="milestone-list"></div>
          </section>

          <section class="panel pad" style="margin-top:14px">
            <h2 class="panel-title">PR / Delivery</h2>
            <div id="delivery-list"></div>
          </section>
        </aside>
      </div>

      <section class="panel pad" style="margin-top:14px">
        <h2 class="panel-title">子任务队列 <span id="root-label" class="chip">Root: ${escapedIssueId}</span></h2>
        <div id="child-list"></div>
      </section>

      <section id="history-panel" class="panel pad history-panel" hidden>
        <h2 class="panel-title">完整日志 <button id="history-close-button" class="text-button" type="button">收起</button></h2>
        <p id="history-digest" class="panel-copy">等待历史记录。</p>
        <div id="history-entry-list"></div>
      </section>

      <div class="actions">
        <button id="pause-button" class="danger" type="button" data-runtime-action="pause">暂停执行</button>
        <button id="request-button" class="primary" type="button" data-runtime-action="request">补充要求</button>
        <a id="pr-link" class="primary" href="#" target="_blank" rel="noreferrer">查看 PR</a>
        <button id="back-button" type="button" data-runtime-action="back">回 Telegram</button>
      </div>
    </main>

    <script>
      (function () {
        const issueId = ${JSON.stringify(issueId)};
        const urls = {
          issue: ${JSON.stringify(issueApi)},
          timeline: ${JSON.stringify(timelineApi)},
          history: ${JSON.stringify(historyApi)},
          stream: '/api/v1/runtime/stream'
        };
        const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
        if (tg) {
          tg.ready();
          tg.expand();
          document.documentElement.style.setProperty('--tg-bg', tg.themeParams && tg.themeParams.bg_color || '#061018');
        }

        const state = { issue: null, timeline: [], history: null, stream: null };
        const el = {
          issueTitle: document.getElementById('issue-title'),
          repoLine: document.getElementById('repo-line'),
          statusLine: document.getElementById('status-line'),
          progressRing: document.getElementById('progress-ring'),
          progressValue: document.getElementById('progress-value'),
          judgmentCopy: document.getElementById('judgment-copy'),
          nextCopy: document.getElementById('next-copy'),
          stageRow: document.getElementById('stage-row'),
          timelineTitle: document.getElementById('timeline-title'),
          timelineList: document.getElementById('timeline-list'),
          liveBadge: document.getElementById('live-badge'),
          fileList: document.getElementById('file-list'),
          diffList: document.getElementById('diff-list'),
          deliveryList: document.getElementById('delivery-list'),
          childList: document.getElementById('child-list'),
          rootLabel: document.getElementById('root-label'),
          complexityChip: document.getElementById('complexity-chip'),
          roundGoal: document.getElementById('round-goal'),
          riskDelta: document.getElementById('risk-delta'),
          agentList: document.getElementById('agent-list'),
          milestoneList: document.getElementById('milestone-list'),
          historyPanel: document.getElementById('history-panel'),
          historyDigest: document.getElementById('history-digest'),
          historyEntryList: document.getElementById('history-entry-list'),
          historyCloseButton: document.getElementById('history-close-button'),
          prLink: document.getElementById('pr-link'),
          pauseButton: document.getElementById('pause-button'),
          requestButton: document.getElementById('request-button'),
          backButton: document.getElementById('back-button'),
          closeButton: document.getElementById('close-button')
        };

        function escapeHtml(value) {
          return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }
        function compactText(value, maxLength) {
          const normalized = normalizeRuntimeSummary(value, '', maxLength);
          const limit = maxLength || 520;
          if (!normalized) return '';
          return normalized.length <= limit ? normalized : normalized.slice(0, limit - 1).trim() + '…';
        }
        function expandableCopy(value, fallback, previewLength) {
          const limit = previewLength || 180;
          const full = normalizeRuntimeSummary(value, fallback || '', 4000);
          const preview = compactText(full, limit);
          if (!full) return '';
          if (full === preview || full.length <= limit) {
            return '<span class="expandable-copy"><span class="expandable-text">' + escapeHtml(full) + '</span></span>';
          }
          return '<span class="expandable-copy" data-full-text="' + escapeHtml(full) + '" data-preview-text="' + escapeHtml(preview) + '"><span class="expandable-text">' + escapeHtml(preview) + '</span><button class="expand-button" type="button">展开</button></span>';
        }
        function renderExpandableText(target, value, fallback, previewLength) {
          target.innerHTML = expandableCopy(value, fallback, previewLength);
        }
        function toggleExpandedText(button) {
          const root = button.closest('.expandable-copy');
          if (!root) return;
          const text = root.querySelector('.expandable-text');
          if (!text) return;
          const expanded = root.getAttribute('data-expanded') === 'true';
          text.textContent = expanded ? root.getAttribute('data-preview-text') || '' : root.getAttribute('data-full-text') || '';
          root.setAttribute('data-expanded', expanded ? 'false' : 'true');
          button.textContent = expanded ? '展开' : '收起';
        }
        function parseRuntimeJsonSummary(value) {
          const raw = String(value || '').trim();
          if (!/^[{[]/.test(raw)) return null;
          try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
          } catch {
            return null;
          }
        }
        function normalizeRuntimeSummary(value, fallback, maxLength) {
          const raw = String(value || '').trim();
          const parsed = parseRuntimeJsonSummary(raw);
          const limit = maxLength || 520;
          if (parsed) {
            const toolName = typeof parsed.tool_name === 'string' ? titleCaseToolName(parsed.tool_name) : null;
            const code = typeof parsed.code === 'string' ? parsed.code : '';
            const message = typeof parsed.message === 'string' ? parsed.message : '';
            if (toolName) {
              if (code === 'tool_started' || /^using\\s+/i.test(message)) return toolName + ' 正在运行';
              if (code === 'tool_completed') return toolName + ' 完成';
              return toolName + ' ' + (code ? code.replace(/^tool_/, '') : '活动');
            }
            if (message) {
              return message.replace(/\\s+/g, ' ').trim().slice(0, limit);
            }
          }
          return String(raw || fallback || '').replace(/\\s+/g, ' ').trim();
        }
        function shortTime(iso) {
          const date = new Date(iso || Date.now());
          if (Number.isNaN(date.getTime())) return '--:--:--';
          return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        }
        async function fetchJson(url) {
          const response = await fetch(url);
          const payload = await response.json();
          if (!response.ok || !payload.success) {
            throw new Error(payload.error || 'Request failed');
          }
          return payload.data;
        }
        function isCompletedIssue(issue) {
          if (!issue) return false;
          return issue.delivery_state === 'completed'
            || issue.orchestrator_state === 'completed'
            || /^(done|completed)$/i.test(issue.tracker_state || '')
            || issue.supervisor_session_state === 'completed';
        }
        function isRetryableDeliveryFailure(issue) {
          return Boolean(issue && issue.actions && issue.actions.can_retry && (
            issue.delivery_state === 'delivery_failed' ||
            issue.delivery_code ||
            issue.orchestrator_state === 'failed'
          ));
        }
        function isInternalMilestone(item) {
          if (!item || item.kind !== 'delivery_failed') return false;
          return /supervisor_turn_budget_exhausted|turn_budget_exhausted/i.test([
            item.key,
            item.summary,
            item.delivery_code,
            item.deliveryCode
          ].filter(Boolean).join('\\n'));
        }
        function visibleMilestones(issue) {
          return Array.isArray(issue && issue.milestones)
            ? issue.milestones.filter((item) => !isInternalMilestone(item)).map((item) => Object.assign({}, item, {
                summary: normalizeRuntimeSummary(item.summary, item.key, 180)
              })).slice(0, 5)
            : [];
        }
        function milestone(issue, kind, summary, timestamp) {
          const stamp = timestamp || issue.updated_at || issue.created_at || null;
          return {
            kind,
            key: 'miniapp:' + issue.issue_id + ':' + kind + ':' + (stamp || ''),
            summary,
            timestamp: stamp
          };
        }
        function buildMilestones(issue) {
          const visible = visibleMilestones(issue);
          if (visible.length) return visible;
          const items = [
            milestone(issue, 'plan_ready', compactText(issue.supervisor_plan_summary || issue.title, 160) || '计划已形成，等待执行信号。', issue.created_at)
          ];
          if (issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming') {
            items.push(milestone(issue, 'needs_decision', compactText(issue.next_recommended_action || issue.governance_summary, 180) || '当前需要用户确认下一步。'));
          } else {
            items.push(milestone(issue, 'dispatch_ready', issue.session || issue.orchestrator_state ? '已进入运行通道，等待最近执行信号刷新。' : '已准备进入运行通道。'));
          }
          if (isCompletedIssue(issue)) {
            items.push(milestone(issue, 'delivery_completed', compactText(issue.delivery_summary, 180) || 'Issue 已完成，最终交付已闭环。'));
          } else if (issue.delivery_state === 'proof_satisfied') {
            items.push(milestone(issue, 'proof_satisfied', compactText(issue.delivery_summary, 180) || '证据已满足，正在等待最终交付。'));
          } else if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
            items.push(milestone(issue, 'review_running', compactText((issue.session && issue.session.last_message) || issue.next_recommended_action, 180) || 'Review 正在检查交付质量。', issue.session && issue.session.last_event_at || issue.updated_at));
          } else if (issue.session || issue.orchestrator_state === 'dev_running') {
            items.push(milestone(issue, 'dev_running', compactText((issue.session && issue.session.last_message) || issue.next_recommended_action, 180) || 'Dev agent 正在推进当前轮次。', issue.session && issue.session.last_event_at || issue.updated_at));
          }
          return items.slice(0, 5);
        }
        function stripShellNoise(value) {
          return String(value || '')
            .replace(/\\s+2>\\s*\\/dev\\/null/g, '')
            .replace(/\\s+1>\\s*\\/dev\\/null/g, '')
            .replace(/\\s+>\\s*\\/dev\\/null/g, '')
            .replace(/\\s+/g, ' ')
            .trim();
        }
        function basename(path) {
          const normalized = String(path || '').trim();
          if (!normalized) return '';
          const parts = normalized.split('/').filter(Boolean);
          return parts[parts.length - 1] || normalized;
        }
        function shortWorkspacePath(path) {
          const normalized = String(path || '').replace(/^['"]|['"]$/g, '').trim();
          if (!normalized) return '';
          const worktreeMatch = normalized.match(/\\/worktrees\\/[^/\\s"']+\\/(.+)$/);
          if (worktreeMatch && worktreeMatch[1]) return worktreeMatch[1];
          const workspaceMatch = normalized.match(/\\/workspaces\\/[^/\\s"']+\\/(.+)$/);
          if (workspaceMatch && workspaceMatch[1]) return workspaceMatch[1];
          const projectMatch = normalized.match(/\\/symharix\\/(.+)$/);
          if (projectMatch && projectMatch[1]) return projectMatch[1];
          if (!normalized.startsWith('/')) return normalized;
          return basename(normalized);
        }
        function readablePath(path) {
          return shortWorkspacePath(path) || basename(path) || 'workspace';
        }
        function fileDisplayName(path) {
          return basename(shortWorkspacePath(path) || path) || 'workspace';
        }
        function parentFolder(path) {
          const parts = shortWorkspacePath(path).split('/').filter(Boolean);
          return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
        }
        function humanFileOperation(operation) {
          if (operation === 'read') return '读取';
          if (operation === 'write') return '写入';
          if (operation === 'edit') return '编辑';
          return '文件活动';
        }
        function summarizeDiffPath(path, fallback) {
          const displayPath = readablePath(path);
          const name = fileDisplayName(displayPath);
          const lower = displayPath.toLowerCase();
          if (/\\.test\\.|\\.spec\\.|__tests__|test\\//.test(lower)) return '补充或更新回归测试。';
          if (/miniapp|page|style|css|tsx?$|jsx?$/.test(lower)) return '调整界面展示逻辑与排版。';
          if (/readme|docs?|\\.md$/.test(lower)) return '更新文档说明。';
          if (/package|bun\\.lock|lockfile/.test(lower)) return '更新依赖或脚本配置。';
          if (/\\.symphony|state|evidence|handover/.test(lower)) return '更新运行证据与交付状态。';
          if (fallback) return compactText(fallback, 90);
          return '更新 ' + name + '。';
        }
        function changeTextSourcesFromHistory(history) {
          const entries = history && Array.isArray(history.entries) ? history.entries : [];
          const sources = [];
          entries.forEach((entry) => {
            [
              entry.summary,
              entry.body,
              entry.detail && entry.detail.payload && entry.detail.payload.body,
              entry.detail && entry.detail.requested_changes_md,
              entry.detail && entry.detail.summary
            ].forEach((value) => {
              if (typeof value === 'string' && value.trim()) sources.push(value);
            });
          });
          return sources;
        }
        function parseChangeLine(line) {
          const trimmed = String(line || '').replace(/^[-*]\\s+/, '').trim();
          if (!trimmed) return null;
          function isLikelyDiffPath(value) {
            const candidate = readablePath(value).replace(/^['"]|['"]$/g, '').trim();
            if (!candidate || /\\s/.test(candidate)) return false;
            return /\\.[a-z0-9][a-z0-9._-]*$/i.test(candidate)
              || /^(README|CHANGELOG|LICENSE)(?:\\.|$)/i.test(candidate)
              || /^(src|test|tests|docs|scripts|packages|app|lib|public|config)\\//.test(candidate);
          }
          let match = trimmed.match(/^\\|\\s*\`?([^\`|]+?)\`?\\s*\\|\\s*([^|]+?)\\s*\\|/);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            const action = String(match[2] || '').toLowerCase();
            const deleted = /delete|remove|删除|移除/.test(action);
            const added = /add|create|新增|创建/.test(action);
            return {
              path,
              badge: deleted ? 'D' : added ? 'A' : 'M',
              summary: summarizeDiffPath(path, deleted ? '删除文件。' : added ? '新增文件。' : '更新文件。'),
              detail: compactText(trimmed.replace(/\\|/g, ' '), 260),
              timestamp: null,
              tone: deleted ? 'red' : added ? 'green' : 'blue'
            };
          }
          match = trimmed.match(/(?:删除|移除|remove(?:d)?|delete(?:d)?)\\s+\`?([^\`\\n]+?)\`?(?:\\s|$)/i);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            return {
              path,
              badge: 'D',
              summary: '删除 ' + fileDisplayName(path) + '。',
              detail: compactText(trimmed, 260),
              timestamp: null,
              tone: 'red'
            };
          }
          match = trimmed.match(/(?:新增|创建|添加|add(?:ed)?|create(?:d)?)\\s+\`?([^\`\\n]+?)\`?(?:\\s|$)/i);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            return {
              path,
              badge: 'A',
              summary: '新增 ' + fileDisplayName(path) + '。',
              detail: compactText(trimmed, 260),
              timestamp: null,
              tone: 'green'
            };
          }
          match = trimmed.match(/(?:更新|修改|编辑|清空|modify|update(?:d)?|edit(?:ed)?)\\s+\`?([^\`\\n]+?)\`?(?:\\s|$)/i);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            return {
              path,
              badge: 'M',
              summary: summarizeDiffPath(path, '更新文件。'),
              detail: compactText(trimmed, 260),
              timestamp: null,
              tone: 'blue'
            };
          }
          match = trimmed.match(/\`([^\`]+\\.[a-z0-9][a-z0-9._-]*)\`/i);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            return {
              path,
              badge: 'M',
              summary: summarizeDiffPath(path, '更新文件。'),
              detail: compactText(trimmed, 260),
              timestamp: null,
              tone: 'blue'
            };
          }
          return null;
        }
        function splitHistoryChangeLines(source) {
          return String(source || '')
            .replace(/\\s+-\\s+(?=(?:删除|移除|新增|创建|添加|更新|修改|编辑|清空|remove|delete|add|create|modify|update|edit)\\b)/ig, '\\n- ')
            .replace(/\\s+(?=\\|\\s*(?:\`?[\\w./-]+\`?)\\s*\\|\\s*(?:deleted|removed|删除|移除|modified|updated|added|created|新增|创建))/ig, '\\n')
            .split(/\\n+/);
        }
        function extractDiffFilesFromHistory(history) {
          const byPath = new Map();
          changeTextSourcesFromHistory(history).forEach((source) => {
            splitHistoryChangeLines(source).forEach((line) => {
              const item = parseChangeLine(line);
              if (!item || !item.path) return;
              byPath.set(item.path, Object.assign({}, byPath.get(item.path), item));
            });
          });
          return Array.from(byPath.values()).slice(0, 12);
        }
        function buildDiffFiles(issue) {
          const byPath = new Map();
          const overview = compactText(issue.change_pack_summary && issue.change_pack_summary.overview, 90);
          const files = issue.change_pack_summary && Array.isArray(issue.change_pack_summary.files) ? issue.change_pack_summary.files : [];
          files.forEach((path) => {
            const normalized = readablePath(path);
            if (!normalized) return;
            byPath.set(normalized, {
              path: normalized,
              badge: 'M',
              summary: summarizeDiffPath(normalized, overview),
              detail: overview || null,
              timestamp: issue.updated_at || null,
              tone: 'blue'
            });
          });
          const recent = issue.session && Array.isArray(issue.session.recent_files) ? issue.session.recent_files : [];
          recent.forEach((file) => {
            if (file.operation === 'read') return;
            const normalized = readablePath(file.path);
            if (!normalized) return;
            byPath.set(normalized, {
              path: normalized,
              badge: file.operation === 'write' ? 'A' : 'M',
              summary: humanFileOperation(file.operation) + (file.status === 'started' ? '中' : '完成') + ' · ' + summarizeDiffPath(normalized, overview),
              detail: overview || null,
              timestamp: file.timestamp || null,
              tone: feedToneFromStatus(file.status)
            });
          });
          return Array.from(byPath.values())
            .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')))
            .slice(0, 8);
        }
        function titleCaseToolName(toolName) {
          const lower = String(toolName || '').toLowerCase();
          if (/bash|shell|terminal|exec/.test(lower)) return 'Bash';
          if (/read|open|cat/.test(lower)) return 'Read';
          if (/edit|patch|apply|write/.test(lower)) return 'Edit';
          if (/test|pytest|bun|vitest|jest/.test(lower)) return 'Test';
          if (/git|github|pr/.test(lower)) return 'Git';
          if (/review/.test(lower)) return 'Review';
          const compact = String(toolName || '').replace(/[_-]+/g, ' ').trim();
          return compact ? compact.slice(0, 1).toUpperCase() + compact.slice(1) : 'Tool';
        }
        function summarizeShellCommand(value, label) {
          if (/^\\s*[{[]/.test(String(value || ''))) {
            return normalizeRuntimeSummary(value, (label || 'Bash') + ' 运行中', 72);
          }
          const command = stripShellNoise(value);
          const lower = command.toLowerCase();
          const pathMatch = command.match(/(?:cat|sed|awk|tail|head|less|open|code)\\s+(?:-[^\\s]+\\s+)*["']?([^"'\\s<>|;&]+)["']?/i) || command.match(/>\\s*["']?([^"'\\s<>|;&]+)["']?/);
          const path = pathMatch && pathMatch[1] ? fileDisplayName(pathMatch[1]) : '';
          if (/gh\\s+pr\\s+view/i.test(command)) {
            const pr = command.match(/gh\\s+pr\\s+view\\s+(\\d+)/i);
            return pr && pr[1] ? '查看 PR #' + pr[1] : '查看 PR 状态';
          }
          if (/git\\s+status|git\\s+log/i.test(command)) return '检查 Git 状态';
          if (/bun\\s+test|npm\\s+test|pnpm\\s+test|pytest|vitest|jest/i.test(command)) return '运行测试';
          if (/\\brm\\s+-rf\\b|\\bdelete\\b|删除/.test(lower)) return compactText(command.replace(/\\s*&&\\s*/g, '，然后 '), 72);
          if (/^cat\\s*>|>\\s*["']?[^"'\\s]+/.test(command)) return path ? '写入 ' + path : '写入文件';
          if (/^(cat|sed|awk|tail|head|less)\\b/.test(command)) return path ? '读取 ' + path : '读取文件';
          if (/^(ls|find|tree)\\b/.test(command)) return '检查文件列表';
          if (!command || /^using\\s+/i.test(command)) return (label || 'Bash') + ' 运行中';
          return compactText(command.replace(/\\/Users\\/[^\\s"']+/g, (match) => fileDisplayName(match)), 72);
        }
        function summarizeToolActivity(tool, label) {
          if (label === 'Bash') return summarizeShellCommand(tool.message || tool.summary || '', label);
          const path = fileDisplayName(tool.path);
          if (label === 'Read') return path ? '读取 ' + path : compactText(tool.summary || tool.message || '读取文件', 72);
          if (label === 'Edit') return path ? '编辑 ' + path : compactText(tool.summary || tool.message || '编辑文件', 72);
          return compactText(tool.summary || tool.message || label + ' running', 72);
        }
        function feedToneFromStatus(status) {
          if (status === 'failed') return 'red';
          if (status === 'started') return 'blue';
          if (status === 'completed') return 'green';
          return 'neutral';
        }
        function feedItemFromTool(tool) {
          const label = titleCaseToolName(tool.tool_name);
          const detailPath = readablePath(tool.path);
          return {
            kind: 'tool',
            label,
            summary: summarizeToolActivity(tool, label),
            detail: detailPath || (tool.status === 'started' ? label + ' running' : label + ' completed'),
            timestamp: tool.timestamp || null,
            tone: feedToneFromStatus(tool.status),
            status: tool.status || 'completed'
          };
        }
        function feedItemFromFile(file) {
          const label = file.operation === 'read'
            ? 'Read'
            : file.operation === 'write'
              ? 'Write'
              : file.operation === 'edit'
                ? 'Edit'
                : 'File';
          const name = fileDisplayName(file.path);
          const folder = parentFolder(file.path);
          return {
            kind: 'file',
            label,
            summary: humanFileOperation(file.operation) + ' ' + name,
            detail: [humanFileOperation(file.operation), folder].filter(Boolean).join(' · '),
            timestamp: file.timestamp || null,
            tone: feedToneFromStatus(file.status),
            status: file.status || 'completed'
          };
        }
        function activityDedupeKey(item) {
          return [item.kind, item.label, compactText(String(item.summary || '').toLowerCase(), 80)].join('|');
        }
        function buildActivityFeed(issue) {
          if (isCompletedIssue(issue)) {
            return [{
              kind: 'summary',
              label: 'Closed',
              summary: compactText(issue.delivery_summary, 180) || 'Issue 已完成，最终交付已闭环。',
              detail: issue.active_pr_number ? 'PR #' + issue.active_pr_number : issue.github_repo || issue.identifier || issueId,
              timestamp: issue.updated_at || issue.created_at || null,
              tone: 'green',
              status: 'completed'
            }];
          }
          const tools = issue.session && Array.isArray(issue.session.recent_tools) ? issue.session.recent_tools : [];
          const files = issue.session && Array.isArray(issue.session.recent_files) ? issue.session.recent_files : [];
          const sorted = tools.map(feedItemFromTool).concat(files.map(feedItemFromFile))
            .sort((left, right) => {
              const leftStarted = left.status === 'started' ? 1 : 0;
              const rightStarted = right.status === 'started' ? 1 : 0;
              if (leftStarted !== rightStarted) return rightStarted - leftStarted;
              return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
            });
          const seen = new Set();
          const compacted = [];
          sorted.forEach((item) => {
            const key = activityDedupeKey(item);
            if (seen.has(key)) return;
            seen.add(key);
            compacted.push(item);
          });
          return compacted.slice(0, 6);
        }
        function getIssueProgress(issue) {
          if (!issue) return 0;
          if (isCompletedIssue(issue)) return 100;
          if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') return 72;
          if (issue.session || issue.orchestrator_state === 'dev_running') return 42;
          if (issue.governance_thread_state === 'waiting_on_child') return 34;
          return 18;
        }
        function getPresentation(issue) {
          const completed = isCompletedIssue(issue);
          const retryableFailure = isRetryableDeliveryFailure(issue);
          const deliverySummary = normalizeRuntimeSummary(issue.delivery_summary, '', 4000);
          const reviewApproved = Array.isArray(issue.milestones)
            ? issue.milestones.some((item) => item.kind === 'review_completed')
            : false;
          if (completed) {
            return {
              mode: 'completed',
              progress: 100,
              stateLabel: 'Completed',
              stateTone: 'green',
              liveBadgeLabel: 'Final',
              timelineTitle: '交付总结',
              judgmentSummary: deliverySummary || '计划线程已完成，最终交付已闭环。',
              nextRecommendation: issue.active_pr_number
                ? '已完成，PR #' + issue.active_pr_number + ' 已就绪。可以查看 PR，或回到 Telegram 发起下一条需求。'
                : '已完成。可以回到 Telegram 发起下一条需求。',
              roundGoal: '当前计划「' + (issue.title || issue.identifier || 'issue') + '」已经完成，不再向 dev agent 追加指令。',
              riskDelta: normalizeRuntimeSummary(issue.riskDelta || issue.risk_delta, '', 4000) || 'stable',
              planStatus: '完成',
              dispatchStatus: '完成',
              devStatus: '完成',
              reviewStatus: '完成',
              reviewDeliveryStatus: reviewApproved ? 'approved' : '完成',
              emptyChildQueueLabel: '单 issue 已完成，没有拆分子任务。',
              activityFeed: buildActivityFeed(issue),
              visibleMilestones: buildMilestones(issue),
              diffFiles: buildDiffFiles(issue)
            };
          }
          const progress = getIssueProgress(issue);
          return {
            mode: 'live',
            progress: retryableFailure ? Math.max(progress, 82) : progress,
            stateLabel: issue.delivery_state === 'proof_satisfied'
              ? 'Proof satisfied'
              : retryableFailure
                ? 'Needs recovery'
                : issue.orchestrator_state || issue.tracker_state || 'Running',
            stateTone: issue.delivery_state === 'proof_satisfied'
              ? 'green'
              : retryableFailure
                ? 'yellow'
                : 'blue',
            liveBadgeLabel: retryableFailure ? 'Action' : 'Live',
            timelineTitle: '实时事件流',
            judgmentSummary: normalizeRuntimeSummary(
              issue.supervisor_plan_summary || issue.governance_summary || issue.delivery_summary,
              '',
              4000
            ) || '当前只推进最有把握的下一步，保持 child 队列有序。',
            nextRecommendation: retryableFailure
              ? '交付恢复卡住了，但这类问题可以一键重试：先清理工作流产物，再重新进入交付。'
              : normalizeRuntimeSummary(issue.next_recommended_action || issue.governance_expected_handoff, '', 4000) || '等待 supervisor 写入下一步动作。',
            roundGoal: normalizeRuntimeSummary(issue.roundGoal || (issue.round && issue.round.goal) || issue.next_recommended_action, '', 4000) || '等待下一步运行时信号。',
            riskDelta: normalizeRuntimeSummary(issue.riskDelta || issue.risk_delta, '', 4000) || 'stable',
            planStatus: '完成',
            dispatchStatus: progress >= 30 ? '完成' : '等待',
            devStatus: progress >= 100 ? '完成' : '运行中',
            reviewStatus: progress >= 78 ? '运行中' : '等待中',
            reviewDeliveryStatus: issue.phase === 'REVIEW' ? 'running' : 'waiting for review',
            emptyChildQueueLabel: '这是单 issue 执行，没有必要拆分子任务。',
            activityFeed: buildActivityFeed(issue),
            visibleMilestones: buildMilestones(issue),
            diffFiles: buildDiffFiles(issue)
          };
        }
        function githubMark() {
          return '<svg class="github-mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0.2a8 8 0 0 0-2.53 15.59c0.4 0.07 0.55-0.17 0.55-0.38v-1.49c-2.24 0.49-2.71-0.95-2.71-0.95-0.36-0.92-0.88-1.16-0.88-1.16-0.72-0.49 0.05-0.48 0.05-0.48 0.8 0.06 1.22 0.82 1.22 0.82 0.71 1.21 1.86 0.86 2.31 0.66 0.07-0.52 0.28-0.86 0.5-1.06-1.79-0.2-3.67-0.89-3.67-3.98 0-0.88 0.31-1.6 0.82-2.16-0.08-0.2-0.36-1.02 0.08-2.13 0 0 0.67-0.21 2.2 0.82A7.62 7.62 0 0 1 8 4.03c0.68 0 1.36 0.09 2 0.27 1.52-1.03 2.19-0.82 2.19-0.82 0.44 1.11 0.16 1.93 0.08 2.13 0.51 0.56 0.82 1.28 0.82 2.16 0 3.1-1.89 3.77-3.69 3.97 0.29 0.25 0.55 0.74 0.55 1.5v2.22c0 0.21 0.15 0.46 0.56 0.38A8 8 0 0 0 8 0.2Z"/></svg>';
        }
        function chip(label, tone) {
          return '<span class="chip ' + escapeHtml(tone || '') + '">' + escapeHtml(label) + '</span>';
        }
        function renderHero(issue) {
          const presentation = getPresentation(issue);
          const identifier = issue.identifier || issueId;
          const rawTitle = issue.title || 'Issue';
          const displayTitle = String(rawTitle).startsWith(identifier)
            ? rawTitle
            : identifier + ' · ' + rawTitle;
          document.body.classList.toggle('is-completed', presentation.mode === 'completed');
          el.issueTitle.textContent = displayTitle;
          el.repoLine.innerHTML = githubMark() + '<span>仓库</span><span class="repo-name">' + escapeHtml(issue.github_repo || 'repo pending') + '</span>';
          const child = issue.governance_current_child || (Array.isArray(issue.governance_child_queue) ? issue.governance_child_queue.find((item) => item.queue_state === 'current') : null);
          el.statusLine.innerHTML = [
            chip(presentation.stateLabel, presentation.stateTone),
            chip(issue.complexity || 'L?', 'blue'),
            chip(issue.round ? 'Round ' + issue.round.index + '/' + issue.round.total : 'Round ?', 'green'),
            chip(isCompletedIssue(issue) ? 'Delivery done' : child ? 'Child running' : 'Root issue', 'yellow'),
            chip(isCompletedIssue(issue) ? 'Supervisor done' : issue.session ? 'Claude Running' : 'Supervisor', 'blue')
          ].join('');
          const progress = presentation.progress;
          el.progressValue.textContent = progress + '%';
          el.progressRing.style.setProperty('--progress', Math.round(progress * 3.6) + 'deg');
          renderExpandableText(el.judgmentCopy, presentation.judgmentSummary, '', 180);
          renderExpandableText(el.nextCopy, presentation.nextRecommendation, '', 180);
          el.rootLabel.textContent = 'Root: ' + (issue.governance_root_issue_identifier || identifier);
        }
        function renderRound(issue) {
          const presentation = getPresentation(issue);
          const round = issue.round || { index: 1, total: 1, goal: '等待下一步运行时信号。' };
          el.complexityChip.textContent = (issue.complexity || 'L?') + ' · Round ' + round.index + '/' + round.total;
          renderExpandableText(el.roundGoal, presentation.roundGoal, '等待 supervisor round 信号。', 180);
          renderExpandableText(el.riskDelta, 'riskDelta · ' + presentation.riskDelta, 'riskDelta · stable', 160);
        }
        function renderStages(issue) {
          const presentation = getPresentation(issue);
          const progress = presentation.progress;
          const completed = isCompletedIssue(issue);
          const stages = [
            ['Plan', 100, '#56e39f', presentation.planStatus],
            ['Dispatch', progress >= 30 ? 100 : 0, '#56e39f', presentation.dispatchStatus],
            ['Dev', Math.min(100, Math.max(0, progress)), completed ? '#56e39f' : '#6bb4ff', presentation.devStatus],
            ['Review', completed ? 100 : progress >= 78 ? Math.min(100, progress) : 0, completed ? '#56e39f' : '#c9d5e1', presentation.reviewStatus]
          ];
          el.stageRow.innerHTML = stages.map(([label, value, tone, status]) => (
            '<div class="stage"><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(status) + '</span><div class="stage-meter"><i style="--value:' + value + '%;--tone:' + tone + '"></i></div></div>'
          )).join('');
        }
        function renderTimeline() {
          const presentation = getPresentation(state.issue);
          el.timelineTitle.textContent = presentation.timelineTitle;
          el.liveBadge.textContent = presentation.liveBadgeLabel;
          el.liveBadge.className = 'chip ' + (presentation.mode === 'completed' ? 'green' : 'green');
          const feed = presentation.activityFeed || [];
          if (feed.length) {
            el.timelineList.innerHTML = feed.map((item) => (
              '<article class="event"><time class="event-time">' + escapeHtml(shortTime(item.timestamp)) + '</time><span class="event-node ' + escapeHtml(item.tone) + '"></span><div><h3>' + escapeHtml(item.summary || item.label) + '</h3><p>' + escapeHtml(item.detail || item.status || '') + '</p></div><span class="mini-badge ' + escapeHtml(item.tone) + '">' + escapeHtml(item.label) + '</span></article>'
            )).join('');
            return;
          }
          const items = state.timeline.slice(0, 7);
          if (!items.length) {
            el.timelineList.innerHTML = '<div class="loading">等待事件流。</div>';
            return;
          }
          el.timelineList.innerHTML = items.map((item) => (
            '<article class="event"><time class="event-time">' + escapeHtml(shortTime(item.timestamp)) + '</time><span class="event-node"></span><div><h3>' + escapeHtml(item.category === 'tool' ? summarizeToolActivity({ tool_name: item.tool_name || 'Tool', status: item.code === 'tool_started' ? 'started' : 'completed', message: item.message || '', summary: null, path: item.detail && item.detail.path || null, timestamp: item.timestamp || '' }, titleCaseToolName(item.tool_name || 'Tool')) : compactText(item.message || item.code || 'runtime event', 90)) + '</h3><p>' + escapeHtml([item.tool_name, item.category, item.level].filter(Boolean).join(' · ')) + '</p></div><span class="mini-badge">✓</span></article>'
          )).join('');
        }
        function renderFiles(issue) {
          const files = issue.session && Array.isArray(issue.session.recent_files) ? issue.session.recent_files.slice(0, 5) : [];
          if (!files.length) {
            el.fileList.innerHTML = '<p class="panel-copy">暂无文件活动。</p>';
            return;
          }
          el.fileList.innerHTML = files.map((file) => (
            '<div class="file-row"><div><strong>' + escapeHtml(fileDisplayName(file.path)) + '</strong><span>' + escapeHtml(humanFileOperation(file.operation)) + ' · ' + escapeHtml(shortTime(file.timestamp)) + '</span></div><b class="mini-badge ' + escapeHtml(feedToneFromStatus(file.status)) + '">' + escapeHtml((file.operation || 'M').slice(0, 1).toUpperCase()) + '</b></div>'
          )).join('');
        }
        function renderDiff(issue) {
          const files = extractDiffFilesFromHistory(state.history).concat(getPresentation(issue).diffFiles || []);
          const seen = new Set();
          const uniqueFiles = files.filter((file) => {
            const key = file.path || file.summary || '';
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 12);
          if (!uniqueFiles.length) {
            el.diffList.innerHTML = '<p class="panel-copy">还没有可展示的代码改动。</p>';
            return;
          }
          el.diffList.innerHTML = uniqueFiles.map((file) => (
            '<div class="diff-row"><div><strong>' + escapeHtml(file.path) + '</strong><span>' + expandableCopy(file.summary || 'modified', 'modified', 130) + '</span>' + (file.detail ? '<small class="diff-detail">' + expandableCopy(file.detail, '', 120) + '</small>' : '') + '</div><b class="diff-stat ' + escapeHtml(file.tone || '') + '">' + escapeHtml(file.badge) + '</b></div>'
          )).join('');
        }
        function findExpandedHistoryText(summary) {
          const raw = String(summary || '');
          const prefix = raw.replace(/(?:\\.\\.\\.|…)$/, '').replace(/\\s+/g, ' ').slice(0, 80);
          if (!prefix || !state.history || !Array.isArray(state.history.entries)) return raw;
          for (const entry of state.history.entries) {
            const candidates = [
              entry.detail && entry.detail.payload && entry.detail.payload.body,
              entry.body,
              entry.summary
            ].filter((value) => typeof value === 'string' && value.length > raw.length);
            const found = candidates.find((value) => String(value).replace(/\\s+/g, ' ').indexOf(prefix) >= 0);
            if (found) return found;
          }
          return raw;
        }
        function renderAgents(issue) {
          const progress = issue.agentRecentProgress || issue.agent_recent_progress || { dev: [], review: [] };
          const items = []
            .concat((progress.dev || []).slice(0, 3).map((item) => Object.assign({ agent: 'Dev' }, item)))
            .concat((progress.review || []).slice(0, 3).map((item) => Object.assign({ agent: 'Review' }, item)));
          if (!items.length) {
            el.agentList.innerHTML = '<p class="panel-copy">暂无 agent 最近进度。</p>';
            return;
          }
          el.agentList.innerHTML = items.slice(0, 6).map((item) => (
            '<div class="agent-row"><div><strong>' + escapeHtml(item.agent + ' · ' + (item.status || 'running')) + '</strong><span>' + expandableCopy(findExpandedHistoryText(item.summary), 'progress', 180) + '</span></div><b class="mini-badge">' + escapeHtml(item.agent.slice(0, 1)) + '</b></div>'
          )).join('');
        }
        function renderMilestones(issue) {
          const milestones = getPresentation(issue).visibleMilestones;
          if (!milestones.length) {
            el.milestoneList.innerHTML = '<p class="panel-copy">暂无关键节点总结。</p>';
            return;
          }
          el.milestoneList.innerHTML = milestones.map((item) => (
            '<div class="milestone-row"><div><strong>' + escapeHtml(item.kind || 'milestone') + '</strong><span>' + expandableCopy(item.summary || item.key, 'recorded', 180) + '</span></div><span>' + escapeHtml(shortTime(item.timestamp)) + '</span></div>'
          )).join('');
        }
        function renderDelivery(issue) {
          const presentation = getPresentation(issue);
          const rows = [
            ['PR', issue.active_pr_number ? '#' + issue.active_pr_number : 'pending'],
            ['Review', presentation.reviewDeliveryStatus],
            ['Linear', isCompletedIssue(issue) ? 'Done' : issue.tracker_state || 'In Progress']
          ];
          el.deliveryList.innerHTML = rows.map(([label, value]) => (
            '<div class="delivery-row"><div><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(value) + '</span></div><span>›</span></div>'
          )).join('');
          if (issue.github_repo && issue.active_pr_number) {
            el.prLink.href = 'https://github.com/' + issue.github_repo + '/pull/' + issue.active_pr_number;
            el.prLink.classList.remove('disabled');
            el.prLink.textContent = '查看 PR';
          } else {
            el.prLink.href = '#';
            el.prLink.classList.add('disabled');
            el.prLink.textContent = 'PR 待生成';
          }
        }
        function renderChildren(issue) {
          const presentation = getPresentation(issue);
          const queue = Array.isArray(issue.governance_child_queue) ? issue.governance_child_queue.slice(0, 4) : [];
          if (!queue.length) {
            el.childList.innerHTML = '<p class="panel-copy">' + escapeHtml(presentation.emptyChildQueueLabel) + '</p>';
            return;
          }
          el.childList.innerHTML = queue.map((child, index) => (
            '<div class="child-row"><div><strong>Child ' + String(index + 1) + ' · ' + escapeHtml(child.issue_identifier || 'pending') + '</strong><span>' + escapeHtml(child.title || child.governance_summary || 'queued') + '</span></div>' + chip(child.queue_state || 'queued', child.queue_state === 'current' ? 'blue' : '') + '</div>'
          )).join('');
        }
        function renderHistoryPanel() {
          const view = state.history || {};
          const digest = view.digest || {};
          const entries = Array.isArray(view.entries) ? view.entries.slice(0, 20) : [];
          el.historyPanel.hidden = false;
          renderExpandableText(el.historyDigest, digest.detail || digest.history_blurb, '这条 issue 暂时还没有可回放的完整日志。', 220);
          if (!entries.length) {
            el.historyEntryList.innerHTML = '<p class="panel-copy" style="margin-top:12px">暂无历史检查点。</p>';
          } else {
            el.historyEntryList.innerHTML = entries.map((entry) => (
              '<article class="history-entry"><time>' + escapeHtml(shortTime(entry.timestamp)) + '</time><div><strong>' + escapeHtml(entry.title || entry.source || 'checkpoint') + '</strong><span>' + expandableCopy(entry.summary, 'checkpoint', 220) + '</span></div><b class="mini-badge blue">' + escapeHtml(entry.source || 'log') + '</b></article>'
            )).join('');
          }
          el.historyPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        function setRuntimeAction(button, action, label, className) {
          button.setAttribute('data-runtime-action', action);
          button.textContent = label;
          button.className = className || '';
          button.disabled = false;
        }
        function renderActions(issue) {
          const presentation = getPresentation(issue);
          if (presentation.mode === 'completed') {
            setRuntimeAction(el.pauseButton, 'history', '完整日志', 'primary');
            setRuntimeAction(el.requestButton, 'request', '新需求', 'primary');
            setRuntimeAction(el.backButton, 'back', '回 Telegram', '');
            return;
          }
          if (isRetryableDeliveryFailure(issue)) {
            setRuntimeAction(el.pauseButton, 'retry', '修复交付并重试', 'primary');
            setRuntimeAction(el.requestButton, 'request', '补充要求', 'primary');
            setRuntimeAction(el.backButton, 'back', '回 Telegram', '');
            return;
          }
          setRuntimeAction(el.pauseButton, 'pause', '暂停执行', 'danger');
          setRuntimeAction(el.requestButton, 'request', '补充要求', 'primary');
          setRuntimeAction(el.backButton, 'back', '回 Telegram', '');
        }
        function render() {
          if (!state.issue) return;
          renderHero(state.issue);
          renderRound(state.issue);
          renderStages(state.issue);
          renderTimeline();
          renderFiles(state.issue);
          renderDiff(state.issue);
          renderAgents(state.issue);
          renderMilestones(state.issue);
          renderDelivery(state.issue);
          renderChildren(state.issue);
          renderActions(state.issue);
        }
        async function load() {
          const [issue, timeline, history] = await Promise.all([
            fetchJson(urls.issue),
            fetchJson(urls.timeline),
            fetchJson(urls.history)
          ]);
          state.issue = issue;
          state.timeline = Array.isArray(timeline) ? timeline : [];
          state.history = history;
          render();
        }
        function openStream() {
          try {
            state.stream = new EventSource(urls.stream);
            state.stream.addEventListener('issue', (event) => {
              const issue = JSON.parse(event.data);
              if (issue && (issue.issue_id === state.issue.issue_id || issue.identifier === state.issue.identifier)) {
                state.issue = issue;
                render();
              }
            });
            state.stream.addEventListener('timeline', (event) => {
              const item = JSON.parse(event.data);
              if (item && state.issue && item.issue_id === state.issue.issue_id) {
                state.timeline = [item].concat(state.timeline).slice(0, 20);
                renderTimeline();
              }
            });
          } catch {
          }
        }
        async function postRuntimeIssueAction(action) {
          if (!state.issue) return;
          const targetId = state.issue.issue_id || state.issue.identifier || issueId;
          const result = await fetchJson('/api/v1/runtime/issues/' + encodeURIComponent(targetId) + '/' + action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          renderExpandableText(el.nextCopy, result.message, '恢复动作已提交。', 180);
          await load();
        }
        document.addEventListener('click', (event) => {
          const button = event.target && event.target.closest ? event.target.closest('button') : null;
          if (!button) return;
          if (button.classList.contains('expand-button')) {
            toggleExpandedText(button);
          }
        });
        document.querySelectorAll('[data-runtime-action]').forEach((button) => {
          button.addEventListener('click', () => {
            const action = button.getAttribute('data-runtime-action');
            if (action === 'back' && tg) {
              tg.close();
            }
            if (action === 'history') {
              renderHistoryPanel();
            }
            if (action === 'retry') {
              button.disabled = true;
              button.textContent = '正在重试…';
              if (tg && tg.HapticFeedback) {
                tg.HapticFeedback.impactOccurred('medium');
              }
              postRuntimeIssueAction('retry').catch((error) => {
                button.disabled = false;
                button.textContent = '修复交付并重试';
                if (tg) {
                  tg.showAlert(error.message || '恢复动作提交失败。');
                } else {
                  el.nextCopy.textContent = error.message || '恢复动作提交失败。';
                }
              });
            }
            if (action === 'pause' && tg) {
              tg.HapticFeedback && tg.HapticFeedback.impactOccurred('medium');
              tg.showAlert('暂停执行会回到 Telegram 原生按钮确认。');
            }
            if (action === 'request' && tg) {
              tg.showAlert('补充要求会回到 Telegram 对话继续输入。');
            }
          });
        });
        el.closeButton.addEventListener('click', () => {
          if (tg) tg.close();
          else history.back();
        });
        el.historyCloseButton.addEventListener('click', () => {
          el.historyPanel.hidden = true;
        });
        load().then(openStream).catch((error) => {
          el.timelineList.innerHTML = '<div class="loading">' + escapeHtml(error.message || 'Load failed') + '</div>';
        });
      })();
    </script>
  </body>
</html>`;
}
