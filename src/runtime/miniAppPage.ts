import type {
  RuntimeFileActivity,
  RuntimeIssueView,
  RuntimeMilestoneView,
  RuntimeToolActivity,
} from './types';
import { localizeKnownRuntimeText, type RuntimeLocale } from '../i18n/locale';
import {
  isRuntimeIssueCompleted,
  isRuntimeIssueRetryableFailure,
  runtimeIssueBaseProgress,
} from './issueProgress';

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
  additions?: number | null;
  deletions?: number | null;
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
  locale?: RuntimeLocale | null,
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
      return compactPlainText(localizeKnownRuntimeText(message, locale), maxLength);
    }
  }
  return compactPlainText(localizeKnownRuntimeText(raw || fallback, locale), maxLength);
}

function compactText(value: string | null | undefined, maxLength = 520): string {
  return normalizeRuntimeMiniAppSummary(value, '', maxLength);
}

function isRetryableRuntimeMiniAppFailure(issue: RuntimeIssueView): boolean {
  return isRuntimeIssueRetryableFailure(issue);
}

export function isRuntimeMiniAppIssueCompleted(issue: RuntimeIssueView): boolean {
  return isRuntimeIssueCompleted(issue);
}

function runtimeMiniAppStateLabel(issue: RuntimeIssueView): string {
  const englishOutput = issue.supervisor_locale === 'en';
  if (isRuntimeMiniAppIssueCompleted(issue)) {
    return englishOutput ? 'Completed' : '已完成';
  }
  if (issue.delivery_state === 'proof_satisfied') {
    return englishOutput ? 'Proof satisfied' : '证据满足';
  }
  if (isRetryableRuntimeMiniAppFailure(issue)) {
    return englishOutput ? 'Needs recovery' : '需要恢复';
  }
  if (issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming' || issue.active_decision_kind) {
    return englishOutput ? 'Needs decision' : '待确认';
  }
  if (issue.governance_thread_state === 'waiting_on_child') {
    return englishOutput ? 'Waiting on child' : '等待子任务';
  }
  if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
    return englishOutput ? 'Review running' : 'Review 进行中';
  }
  if (issue.session || issue.orchestrator_state === 'dev_running') {
    return englishOutput ? 'Running' : '运行中';
  }
  if (issue.orchestrator_state === 'retry_scheduled') {
    return englishOutput ? 'Retry scheduled' : '等待重试';
  }
  if (issue.orchestrator_state === 'failed') {
    return englishOutput ? 'Blocked' : '已阻塞';
  }
  if (issue.orchestrator_state === 'discovering' || issue.orchestrator_state === 'mapping' || issue.orchestrator_state === 'workspace_ready') {
    return englishOutput ? 'Preparing' : '准备中';
  }
  if (issue.orchestrator_state === 'cancelled') {
    return englishOutput ? 'Cancelled' : '已取消';
  }
  return compactPlainText(issue.tracker_state || issue.orchestrator_state || (englishOutput ? 'Waiting' : '等待中'), 36);
}

export function runtimeMiniAppProgressLabel(issue: RuntimeIssueView, progress: number): string {
  const englishOutput = issue.supervisor_locale === 'en';
  if (isRuntimeMiniAppIssueCompleted(issue)) {
    return `${englishOutput ? 'Done' : '完成'} ${progress}%`;
  }
  if (issue.delivery_state === 'proof_satisfied') {
    return `${englishOutput ? 'Proof' : '证据'} ${progress}%`;
  }
  if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
    return `${englishOutput ? 'Review' : '审查'} ${progress}%`;
  }
  if (issue.session || issue.orchestrator_state === 'dev_running') {
    return `${englishOutput ? 'Build' : '构建'} ${progress}%`;
  }
  if (issue.governance_thread_state === 'waiting_on_child') {
    return `${englishOutput ? 'Dispatch' : '调度'} ${progress}%`;
  }
  return `${englishOutput ? 'Plan' : '计划'} ${progress}%`;
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
      summary: normalizeRuntimeMiniAppSummary(milestone.summary, milestone.key, 180, issue.supervisor_locale),
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

  const englishOutput = issue.supervisor_locale === 'en';
  const items: RuntimeMilestoneView[] = [
    milestone(
      issue,
      'plan_ready',
      compactText(issue.supervisor_plan_summary || issue.title, 160) || (englishOutput
        ? 'Plan is ready and waiting for the execution signal.'
        : '计划已形成，等待执行信号。'),
      issue.created_at,
    ),
  ];

  if (issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming') {
    items.push(milestone(
      issue,
      'needs_decision',
      compactText(issue.next_recommended_action || issue.governance_summary, 180) || (englishOutput
        ? 'User confirmation is needed for the next step.'
        : '当前需要用户确认下一步。'),
    ));
  } else {
    items.push(milestone(
      issue,
      'dispatch_ready',
      issue.session || issue.orchestrator_state
        ? (englishOutput ? 'Entered the runtime lane and waiting for the latest execution signal.' : '已进入运行通道，等待最近执行信号刷新。')
        : (englishOutput ? 'Ready to enter the runtime lane.' : '已准备进入运行通道。'),
    ));
  }

  if (isRuntimeMiniAppIssueCompleted(issue)) {
    items.push(milestone(
      issue,
      'delivery_completed',
      compactText(issue.delivery_summary, 180) || (englishOutput
        ? 'Issue is complete and final delivery is closed.'
        : 'Issue 已完成，最终交付已闭环。'),
    ));
  } else if (issue.delivery_state === 'proof_satisfied') {
    items.push(milestone(
      issue,
      'proof_satisfied',
      compactText(issue.delivery_summary, 180) || (englishOutput
        ? 'Proof is satisfied and final delivery is pending.'
        : '证据已满足，正在等待最终交付。'),
    ));
  } else if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
    items.push(milestone(
      issue,
      'review_running',
      compactText(issue.session?.last_message || issue.next_recommended_action, 180) || (englishOutput
        ? 'Review is checking delivery quality.'
        : 'Review 正在检查交付质量。'),
      issue.session?.last_event_at || issue.updated_at,
    ));
  } else if (issue.session || issue.orchestrator_state === 'dev_running') {
    items.push(milestone(
      issue,
      'dev_running',
      compactText(issue.session?.last_message || issue.next_recommended_action, 180) || (englishOutput
        ? 'The dev agent is advancing the current round.'
        : 'Dev agent 正在推进当前轮次。'),
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
  const englishOutput = issue.supervisor_locale === 'en';
  if (isRuntimeMiniAppIssueCompleted(issue)) {
    const completedAt = issue.updated_at || issue.created_at;
    const summary = normalizeRuntimeMiniAppSummary(issue.delivery_summary, '', 180, issue.supervisor_locale);
    return [{
      kind: 'summary',
      label: 'Closed',
      summary: summary || (englishOutput
        ? 'Issue is complete and final delivery is closed.'
        : 'Issue 已完成，最终交付已闭环。'),
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
  const englishOutput = issue.supervisor_locale === 'en';
  const deliverySummary = normalizeRuntimeMiniAppSummary(issue.delivery_summary, '', 4000, issue.supervisor_locale);
  const reviewApproved = issue.milestones?.some((milestone) => milestone.kind === 'review_completed') ?? false;
  if (completed) {
    return {
      mode: 'completed',
      progress: 100,
      stateLabel: 'Completed',
      stateTone: 'green',
      liveBadgeLabel: 'Final',
      timelineTitle: englishOutput ? 'Delivery Summary' : '交付总结',
      judgmentSummary: deliverySummary || (englishOutput
        ? 'Plan thread is complete and final delivery is closed.'
        : '计划线程已完成，最终交付已闭环。'),
      nextRecommendation: issue.active_pr_number
        ? (englishOutput
          ? `Completed. PR #${issue.active_pr_number} is ready. You can view the PR or start the next request in Telegram.`
          : `已完成，PR #${issue.active_pr_number} 已就绪。可以查看 PR，或回到 Telegram 发起下一条需求。`)
        : (englishOutput
          ? 'Completed. You can return to Telegram to start the next request.'
          : '已完成。可以回到 Telegram 发起下一条需求。'),
      roundGoal: englishOutput
        ? `Plan "${issue.title}" is complete. No more dev-agent instructions are needed.`
        : `当前计划「${issue.title}」已经完成，不再向 dev agent 追加指令。`,
      riskDelta: compactText(issue.riskDelta || issue.risk_delta, 180) || 'stable',
      planStatus: englishOutput ? 'Done' : '完成',
      dispatchStatus: englishOutput ? 'Done' : '完成',
      devStatus: englishOutput ? 'Done' : '完成',
      reviewStatus: englishOutput ? 'Done' : '完成',
      reviewDeliveryStatus: reviewApproved ? 'approved' : (englishOutput ? 'Done' : '完成'),
      emptyChildQueueLabel: englishOutput
        ? 'Single-issue execution is complete. No child tasks were split out.'
        : '单 issue 已完成，没有拆分子任务。',
      activityFeed: buildRuntimeMiniAppActivityFeed(issue),
      visibleMilestones: buildRuntimeMiniAppMilestones(issue),
      diffFiles: buildRuntimeMiniAppDiffFiles(issue),
    };
  }

  const progress = runtimeIssueBaseProgress(issue);
  const reviewActive = issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running';
  return {
    mode: 'live',
    progress: retryableFailure ? Math.max(progress, 82) : progress,
    stateLabel: runtimeMiniAppStateLabel(issue),
    stateTone: issue.delivery_state === 'proof_satisfied'
      ? 'green'
      : retryableFailure
        ? 'yellow'
        : 'blue',
    liveBadgeLabel: retryableFailure ? 'Action' : 'Live',
    timelineTitle: englishOutput ? 'Live Event Stream' : '实时事件流',
    judgmentSummary: normalizeRuntimeMiniAppSummary(
      issue.supervisor_plan_summary || issue.governance_summary || issue.delivery_summary,
      '',
      4000,
      issue.supervisor_locale,
    ) || (englishOutput
      ? 'The system is advancing the highest-confidence next step and keeping child work ordered.'
      : '当前只推进最有把握的下一步，保持 child 队列有序。'),
    nextRecommendation: retryableFailure
      ? (englishOutput
        ? 'Delivery recovery is blocked, but this can usually be retried: clean workflow artifacts and re-enter delivery.'
        : '交付恢复卡住了，但这类问题可以一键重试：先清理工作流产物，再重新进入交付。')
      : normalizeRuntimeMiniAppSummary(issue.next_recommended_action || issue.governance_expected_handoff, '', 4000, issue.supervisor_locale) || (englishOutput
        ? 'Waiting for the supervisor to write the next action.'
        : '等待 supervisor 写入下一步动作。'),
    roundGoal: normalizeRuntimeMiniAppSummary(issue.roundGoal || issue.round?.goal || issue.next_recommended_action, '', 4000, issue.supervisor_locale) || (englishOutput
      ? 'Waiting for the next runtime signal.'
      : '等待下一步运行时信号。'),
    riskDelta: normalizeRuntimeMiniAppSummary(issue.riskDelta || issue.risk_delta, '', 4000, issue.supervisor_locale) || 'stable',
    planStatus: englishOutput ? 'Done' : '完成',
    dispatchStatus: progress >= 30 ? (englishOutput ? 'Done' : '完成') : (englishOutput ? 'Waiting' : '等待'),
    devStatus: reviewActive ? (englishOutput ? 'Done' : '完成') : (englishOutput ? 'Running' : '运行中'),
    reviewStatus: reviewActive ? (englishOutput ? 'Running' : '运行中') : (englishOutput ? 'Waiting' : '等待中'),
    reviewDeliveryStatus: reviewActive ? 'running' : 'waiting for review',
    emptyChildQueueLabel: englishOutput
      ? 'Single-issue execution. No child tasks are needed.'
      : '这是单 issue 执行，没有必要拆分子任务。',
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
    <meta name="color-scheme" content="dark light" />
    <title>symphonyness issue cockpit · ${escapedIssueId}</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      :root {
        --miniapp-width: 390px;
        --bottom-nav-height: 56px;
        --glass-radius: 12px;
        --bg: #0b0f14;
        --panel: rgba(17, 23, 31, 0.84);
        --panel-strong: rgba(13, 18, 25, 0.98);
        --panel-gradient-start: rgba(17, 23, 31, 0.88);
        --panel-gradient-end: rgba(11, 16, 23, 0.86);
        --header-gradient: linear-gradient(180deg, rgba(11, 15, 20, 0.98) 0%, rgba(11, 15, 20, 0.9) 76%, rgba(11, 15, 20, 0) 100%);
        --body-bg:
          linear-gradient(180deg, rgba(20, 28, 38, 0.72) 0%, rgba(12, 17, 24, 0.9) 44%, rgba(8, 12, 18, 0.98) 100%),
          #0b0f14;
        --ring-core: #0d1117;
        --line: rgba(148, 163, 184, 0.16);
        --line-strong: rgba(148, 163, 184, 0.24);
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
      html[data-theme="light"] {
        color-scheme: light;
        --bg: #f6f8fb;
        --panel: rgba(255, 255, 255, 0.92);
        --panel-strong: rgba(255, 255, 255, 0.98);
        --panel-gradient-start: rgba(255, 255, 255, 0.96);
        --panel-gradient-end: rgba(246, 249, 253, 0.94);
        --header-gradient: linear-gradient(180deg, rgba(246, 248, 251, 0.98) 0%, rgba(246, 248, 251, 0.92) 72%, rgba(246, 248, 251, 0) 100%);
        --body-bg: linear-gradient(180deg, #ffffff 0%, #eef3f8 100%);
        --ring-core: #ffffff;
        --line: rgba(40, 58, 79, 0.14);
        --line-strong: rgba(40, 58, 79, 0.24);
        --ink: #142033;
        --muted: #64748b;
        --soft: #334155;
        --green: #12874f;
        --green-soft: rgba(18, 135, 79, 0.1);
        --blue: #1769c2;
        --blue-soft: rgba(23, 105, 194, 0.1);
        --yellow: #9a6500;
        --yellow-soft: rgba(180, 116, 0, 0.12);
        --red: #bd3333;
        --red-soft: rgba(189, 51, 51, 0.12);
      }

      * { box-sizing: border-box; }
      html { min-height: 100%; background: var(--bg); }
      body {
        margin: 0;
        min-height: 100svh;
        color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Segoe UI", sans-serif;
        background: var(--body-bg);
      }

      button { font: inherit; border: 0; }
      .shell {
        width: min(100%, var(--miniapp-width));
        max-width: var(--miniapp-width);
        min-height: 100svh;
        margin: 0 auto;
        padding: calc(12px + env(safe-area-inset-top)) 23px calc(86px + env(safe-area-inset-bottom));
        padding-bottom: calc(86px + env(safe-area-inset-bottom));
        overflow-x: hidden;
      }
      .fixed-header {
        position: sticky;
        top: 0;
        z-index: 20;
        margin: -2px -2px 12px;
        padding: 8px 2px 8px;
        background: var(--header-gradient);
        backdrop-filter: blur(18px);
      }
      .preference-controls {
        position: absolute;
        top: 40px;
        right: 7px;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-bottom: 0;
      }
      .segmented-control {
        position: relative;
        display: inline-grid;
        place-items: center;
        width: 32px;
        min-width: 32px;
        height: 32px;
        min-height: 32px;
        padding: 0;
        overflow: hidden;
        border: 1px solid rgba(42, 59, 76, 0.85);
        border-radius: 9px;
        background: rgba(21, 29, 40, 0.82);
        box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.12);
      }
      .segmented-control::before {
        content: none;
      }
      .segmented-option {
        grid-area: 1 / 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        min-height: 0;
        padding: 0;
        border-radius: 9px;
        color: #d9e4f2;
        background: transparent;
        cursor: pointer;
        font-size: 12px;
        font-weight: 780;
        line-height: 1;
        transition: color 180ms ease;
      }
      .segmented-option[aria-pressed="false"] {
        pointer-events: none;
        opacity: 0;
      }
      .segmented-option[aria-pressed="true"] {
        color: #d9e4f2;
      }
      .theme-icon {
        font-size: 16px;
        line-height: 1;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 22px;
        align-items: start;
        padding: 36px 8px 12px;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        cursor: pointer;
      }
      .hero:focus-visible {
        outline: 2px solid rgba(107, 180, 255, 0.42);
        outline-offset: 2px;
      }
      .hero-main {
        min-width: 0;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 34px;
        margin-bottom: 18px;
        color: var(--ink);
        font-weight: 760;
        font-size: 15px;
      }
      .wave {
        width: 36px;
        height: 24px;
      }
      .issue-eyebrow {
        margin: 0 0 4px;
        color: #2f94ff;
        font-size: 12px;
        line-height: 16px;
        font-weight: 720;
      }
      .issue-title {
        margin: 0 0 10px;
        padding-right: 6px;
        font-size: clamp(22px, 5.9vw, 24px);
        line-height: 1.16;
        font-weight: 820;
        letter-spacing: 0;
        overflow-wrap: anywhere;
      }
      .hero.collapsed .issue-title {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 4;
      }
      .hero-details {
        display: grid;
        gap: 0;
        margin-top: 12px;
      }
      .hero.collapsed .hero-details {
        display: grid;
      }
      .repo-line {
        display: none;
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
      .hero .repo-line {
        display: none;
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
        min-height: 24px;
        align-items: center;
        gap: 6px;
        max-width: 100%;
        padding: 5px 10px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.045);
        color: var(--soft);
        font-size: 10.5px;
        font-weight: 650;
        line-height: 1.2;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .chip.green { color: var(--green); background: var(--green-soft); border-color: rgba(86, 227, 159, 0.2); }
      .chip.blue { color: var(--blue); background: var(--blue-soft); border-color: rgba(107, 180, 255, 0.22); }
      .chip.yellow { color: var(--yellow); background: var(--yellow-soft); border-color: rgba(255, 209, 102, 0.22); }
      .progress-rail {
        display: flex;
        align-items: center;
        justify-content: flex-start;
      }
      .progress-summary {
        width: 100%;
        max-width: none;
        display: block;
        margin-left: 0;
        padding-top: 0;
      }
      .progress-kicker {
        display: none;
        color: var(--muted);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      .progress-value {
        display: block;
        margin: 0 0 18px;
        font-size: 34px;
        line-height: 0.95;
        font-weight: 620;
        letter-spacing: -0.06em;
      }
      .progress-copy {
        display: none;
        margin: 0 0 3px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 720;
      }
      .progress-track {
        grid-column: 1 / -1;
        width: 100%;
        height: 4px;
        margin-top: 0;
        border-radius: 999px;
        background: color-mix(in srgb, var(--line-strong) 72%, transparent);
        overflow: visible;
      }
      .progress-fill {
        width: 0%;
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #56e39f 0%, #6bb4ff 100%);
        transition: background 220ms ease;
      }
      .progress-steps {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0;
        margin-top: 9px;
      }
      .progress-step {
        position: relative;
        min-width: 0;
        padding-top: 17px;
        color: #aab6c4;
        font-size: 10px;
        line-height: 13px;
        text-align: center;
      }
      .progress-step::before {
        content: "";
        position: absolute;
        top: -20px;
        left: 50%;
        width: 16px;
        height: 16px;
        border: 2px solid rgba(78, 93, 111, 0.8);
        border-radius: 50%;
        background: var(--bg);
        transform: translateX(-50%);
      }
      .progress-step.done::before,
      .progress-step.active::before {
        border-color: #2f94ff;
        background: #2f94ff;
        box-shadow: 0 0 0 4px rgba(47, 148, 255, 0.12);
      }
      .progress-step.done::after {
        content: "";
        position: absolute;
        top: -20px;
        left: 50%;
        width: 16px;
        height: 16px;
        background: url("data:image/svg+xml,%3Csvg%20width%3D%2716%27%20height%3D%2716%27%20viewBox%3D%270%200%2016%2016%27%20fill%3D%27none%27%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%3E%3Cpath%20d%3D%27M4.2%208.1L6.8%2010.7L11.9%205.3%27%20stroke%3D%27white%27%20stroke-width%3D%272.1%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27/%3E%3C/svg%3E") center / 13px 13px no-repeat;
        transform: translateX(-50%);
      }
      .progress-step.active {
        color: #2490ff;
        font-weight: 750;
      }
      .judgment {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
        margin: 0;
      }
      .tabbar {
        position: fixed;
        left: 50%;
        bottom: calc(8px + env(safe-area-inset-bottom));
        z-index: 30;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        width: min(calc(100vw - 34px), calc(var(--miniapp-width) - 34px));
        min-height: var(--bottom-nav-height);
        gap: 6px;
        margin-top: 0;
        padding: 6px 12px;
        border: 1px solid var(--line);
        border-radius: 28px;
        background: rgba(5, 13, 22, 0.86);
        box-shadow: 0 18px 46px rgba(0, 0, 0, 0.32);
        backdrop-filter: blur(22px);
        transform: translateX(-50%);
      }
      .tab-button {
        display: grid;
        place-items: center;
        gap: 3px;
        min-height: 44px;
        padding: 6px 5px 5px;
        border: 1px solid transparent;
        border-radius: 22px;
        color: var(--muted);
        background: transparent;
        cursor: pointer;
        font-size: 11px;
        font-weight: 780;
        line-height: 1.1;
        letter-spacing: 0;
      }
      .tab-button.active {
        color: var(--ink);
        background: linear-gradient(180deg, rgba(38, 120, 255, 0.42), rgba(28, 98, 218, 0.28));
        border-color: rgba(107, 180, 255, 0.3);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 10px 22px rgba(26, 99, 220, 0.22);
      }
      html[data-theme="light"] .tabbar {
        background: rgba(255, 255, 255, 0.9);
        border-color: rgba(40, 58, 79, 0.16);
        box-shadow: 0 16px 42px rgba(18, 31, 51, 0.16);
      }
      html[data-theme="light"] .tab-button {
        color: #64748b;
      }
      html[data-theme="light"] .tab-button.active {
        color: #ffffff;
        background: linear-gradient(180deg, #2f8cff, #1769e8);
        border-color: rgba(23, 105, 194, 0.26);
        box-shadow: 0 10px 22px rgba(23, 105, 194, 0.22);
      }
      .tab-icon {
        width: 16px;
        height: 16px;
        color: currentColor;
      }
      .tab-label {
        display: block;
        max-width: 100%;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .tab-panel {
        display: none;
        animation: tabIn 160ms ease-out;
      }
      .tab-panel.active {
        display: block;
      }
      .tab-stack {
        display: grid;
        gap: 14px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: var(--glass-radius);
        background: linear-gradient(145deg, var(--panel-gradient-start), var(--panel-gradient-end));
        box-shadow: none;
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
      .signal-panel {
        display: grid;
        gap: 12px;
        padding: 14px 12px;
      }
      .signal-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .signal-pill {
        display: inline-flex;
        min-height: 28px;
        align-items: center;
        padding: 0 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        font-size: 12px;
        font-weight: 780;
      }
      .signal-pill.green {
        color: var(--green);
        background: var(--green-soft);
        border-color: rgba(86, 227, 159, 0.24);
      }
      .signal-pill.blue {
        color: var(--blue);
        background: var(--blue-soft);
        border-color: rgba(107, 180, 255, 0.24);
      }
      .signal-pill.yellow {
        color: var(--yellow);
        background: var(--yellow-soft);
        border-color: rgba(255, 209, 102, 0.24);
      }
      .signal-list {
        display: grid;
        gap: 10px;
      }
      .signal-row {
        display: grid;
        grid-template-columns: 74px minmax(0, 1fr);
        gap: 14px;
        align-items: start;
        padding: 13px 14px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.04);
      }
      .signal-row strong {
        display: block;
        color: var(--ink);
        font-size: 15px;
        line-height: 1.26;
        font-weight: 790;
      }
      .signal-row span {
        display: block;
        margin-top: 5px;
        color: var(--soft);
        font-size: 13px;
        line-height: 1.48;
      }
      .signal-key {
        color: var(--muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .signal-row.green {
        background: color-mix(in srgb, var(--green-soft) 82%, transparent);
        border-color: rgba(86, 227, 159, 0.22);
      }
      .signal-row.blue {
        background: color-mix(in srgb, var(--blue-soft) 82%, transparent);
        border-color: rgba(107, 180, 255, 0.2);
      }
      .signal-row.yellow {
        background: color-mix(in srgb, var(--yellow-soft) 82%, transparent);
        border-color: rgba(255, 209, 102, 0.2);
      }
      .signal-acceptance {
        padding-top: 14px;
        border-top: 1px solid var(--line);
      }
      .signal-acceptance strong {
        display: block;
        color: var(--ink);
        font-size: 15px;
        line-height: 1.24;
        font-weight: 790;
      }
      .signal-acceptance span {
        display: block;
        margin-top: 5px;
        color: var(--soft);
        font-size: 13px;
        line-height: 1.46;
      }
      .signal-acceptance-track {
        height: 10px;
        margin-top: 12px;
        border-radius: 999px;
        background:
          linear-gradient(90deg, #56e39f 0%, #56e39f var(--accept-a, 0%), #6bb4ff var(--accept-a, 0%), #6bb4ff var(--accept-b, 0%), color-mix(in srgb, var(--line-strong) 72%, transparent) var(--accept-b, 0%), color-mix(in srgb, var(--line-strong) 72%, transparent) 100%);
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
      .side-stack {
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
      .diff-open-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 7px;
        padding: 4px 9px;
        border: 1px solid rgba(107, 180, 255, 0.24);
        border-radius: 8px;
        color: var(--blue);
        background: rgba(107, 180, 255, 0.08);
        cursor: pointer;
        font-size: 12px;
        font-weight: 760;
        line-height: 1.1;
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
      .diff-stat-summary {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 52px;
        padding: 5px 10px;
        border: 1px solid rgba(156, 179, 204, 0.18);
        border-radius: 10px;
        background: rgba(107, 180, 255, 0.08);
        text-align: center;
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 12px;
        font-weight: 820;
      }
      .diff-stat-summary[hidden] {
        display: none;
      }
      .diff-stat-token.add {
        color: var(--green);
      }
      .diff-stat-token.del {
        color: var(--red);
      }
      .diff-row-stats {
        display: inline-flex;
        vertical-align: middle;
        margin-right: 4px;
      }
      .diff-row-separator {
        color: var(--muted);
      }
      html[data-theme="dark"] .diff-stat-summary {
        border-color: rgba(134, 161, 191, 0.18);
        background: rgba(255, 255, 255, 0.06);
      }
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
        margin-top: 0;
      }
      .history-panel[hidden] {
        display: none;
      }
      .text-button {
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
      #diff-drawer-close-button {
        position: absolute;
        top: 32px;
        right: 17px;
        width: 32px;
        height: 32px;
        min-height: 32px;
        padding: 0;
        overflow: hidden;
        border-radius: 50%;
        color: transparent;
        background: rgba(15, 23, 42, 0.08);
        border-color: rgba(15, 23, 42, 0.1);
      }
      #diff-drawer-close-button::after {
        content: "×";
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        color: #1f2937;
        font-size: 22px;
        line-height: 1;
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
      .diff-drawer-backdrop {
        position: fixed;
        inset: 0;
        z-index: 40;
        background: rgba(15, 23, 42, 0.22);
        backdrop-filter: blur(5px);
      }
      .diff-drawer-backdrop[hidden] {
        display: none;
      }
      .diff-drawer {
        position: fixed;
        top: auto;
        left: 50%;
        right: auto;
        bottom: 0;
        z-index: 41;
        width: min(100vw, var(--miniapp-width));
        height: min(660px, calc(100svh - 184px));
        padding: 40px 17px calc(88px + env(safe-area-inset-bottom));
        border: 1px solid rgba(203, 213, 225, 0.9);
        border-bottom: 0;
        border-radius: 28px 28px 0 0;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 -18px 46px rgba(15, 23, 42, 0.16);
        overflow: hidden;
        transform: translateX(-50%);
      }
      .diff-drawer::before {
        content: "";
        position: absolute;
        top: 14px;
        left: 50%;
        width: 58px;
        height: 4px;
        border-radius: 3px;
        background: rgba(15, 23, 42, 0.24);
        transform: translateX(-50%);
      }
      .diff-drawer[hidden] {
        display: none;
      }
      .diff-drawer-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .diff-drawer-kicker {
        margin: 0;
        color: var(--muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      .diff-drawer-header strong {
        display: block;
        margin-top: 7px;
        color: var(--ink);
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 20px;
        font-weight: 850;
        line-height: 1.45;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .diff-drawer-header span {
        display: block;
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.48;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .diff-drawer-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
      }
      .diff-drawer-note {
        display: block;
        margin-top: 12px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .diff-drawer-note[hidden] {
        display: none;
      }
      .diff-drawer-body {
        margin-top: 14px;
        height: calc(100% - 190px);
        padding: 12px 12px 14px;
        border: 1px solid rgba(203, 213, 225, 0.78);
        border-radius: 10px;
        background: rgba(248, 251, 255, 0.96);
        overflow: auto;
      }
      .diff-drawer-code {
        margin: 0;
        white-space: pre-wrap;
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 10.5px;
        line-height: 1.65;
        color: #172033;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .diff-drawer-line {
        display: block;
      }
      .diff-drawer-line.add {
        color: #147a47;
      }
      .diff-drawer-line.context {
        color: #27364a;
      }
      .diff-drawer-line.del {
        color: #b4234f;
      }
      .diff-drawer-line.hunk {
        margin: 8px 0 6px;
        color: #64748b;
        font-size: 10px;
        font-weight: 780;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .diff-drawer-line.meta {
        color: #64748b;
      }
      html[data-theme="dark"] .diff-drawer-backdrop {
        background: rgba(0, 0, 0, 0.5);
      }
      html[data-theme="dark"] .diff-drawer {
        border-color: rgba(134, 161, 191, 0.22);
        background: rgba(7, 17, 29, 0.98);
        box-shadow: 0 -18px 46px rgba(0, 0, 0, 0.34);
      }
      html[data-theme="dark"] .diff-drawer::before {
        background: rgba(255, 255, 255, 0.56);
      }
      html[data-theme="dark"] .diff-drawer-body {
        border-color: rgba(134, 161, 191, 0.14);
        background: rgba(6, 13, 23, 0.86);
      }
      html[data-theme="dark"] #diff-drawer-close-button {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(255, 255, 255, 0.08);
      }
      html[data-theme="dark"] #diff-drawer-close-button::after {
        color: #d9e6f3;
      }
      html[data-theme="dark"] .diff-drawer-header strong {
        color: #f4f8ff;
      }
      html[data-theme="dark"] .diff-drawer-code {
        color: #dbe6f5;
      }
      html[data-theme="dark"] .diff-drawer-line.add {
        color: #56e39f;
      }
      html[data-theme="dark"] .diff-drawer-line.context {
        color: #dbe6f5;
      }
      html[data-theme="dark"] .diff-drawer-line.del {
        color: #ff9bac;
      }
      @media (max-width: 720px) {
        .diff-drawer {
          width: min(100%, var(--miniapp-width));
          max-width: 100%;
          border-right: 0;
          border-bottom: 0;
          border-left: 0;
        }
        .diff-drawer-body {
          height: calc(100% - 190px);
        }
      }
      .actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin: 0;
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
      .actions .success { color: #d7ffea; background: var(--green-soft); border-color: rgba(86, 227, 159, 0.24); }
      .actions .disabled { color: var(--muted); pointer-events: none; opacity: 0.62; }
      html[data-theme="light"] .actions .danger { color: #c23f66; background: rgba(252, 231, 236, 0.92); border-color: rgba(247, 186, 198, 0.84); }
      html[data-theme="light"] .actions .primary { color: #225ca8; background: rgba(231, 240, 255, 0.96); border-color: rgba(191, 216, 255, 0.84); }
      html[data-theme="light"] .actions .success { color: #17844e; background: rgba(232, 247, 239, 0.96); border-color: rgba(183, 235, 203, 0.84); }
      .loading {
        min-height: 180px;
        display: grid;
        place-items: center;
        color: var(--muted);
      }
      @media (min-width: 720px) {
        .shell { padding-left: 12px; padding-right: 12px; }
        .hero { grid-template-columns: minmax(0, 1fr); padding: 15px 14px 14px; }
        .progress-summary { max-width: none; margin-left: 0; }
        .progress-value { font-size: 34px; }
        .progress-track { width: 100%; }
        .judgment { grid-template-columns: minmax(0, 1fr); }
        .layout { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
        .layout > .panel:first-child { min-height: 0; }
        .issue-title { font-size: 28px; }
        .actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @keyframes tabIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
    </style>
  </head>
  <body>
    <main class="shell" data-issue-id="${escapedIssueId}" data-issue-api="${issueApi}" data-timeline-api="${timelineApi}" data-history-api="${historyApi}">
      <header class="fixed-header">
        <div class="preference-controls" aria-label="Display preferences">
          <div id="theme-toggle" class="segmented-control" data-value="dark" role="group" aria-label="切换日间夜间模式">
            <button class="segmented-option" type="button" data-theme-choice="light" aria-label="日间模式" aria-pressed="false"><span class="theme-icon" aria-hidden="true">☀</span></button>
            <button class="segmented-option" type="button" data-theme-choice="dark" aria-label="夜间模式" aria-pressed="true"><span class="theme-icon" aria-hidden="true">☾</span></button>
          </div>
          <div id="language-toggle" class="segmented-control" data-value="zh" role="group" aria-label="切换中英文">
            <button class="segmented-option" type="button" data-lang-choice="zh" aria-pressed="true">中</button>
            <button class="segmented-option" type="button" data-lang-choice="en" aria-pressed="false">EN</button>
          </div>
        </div>
        <section id="hero" class="hero collapsed" role="button" tabindex="0" aria-expanded="false">
          <div class="hero-main">
            <div class="brand">
              <svg class="wave" viewBox="0 0 70 42" aria-hidden="true">
                <path d="M4 23 C12 5 26 8 27 24 C29 42 47 39 50 19 C53 2 63 9 66 21" fill="none" stroke="#2c93ff" stroke-width="6" stroke-linecap="round"/>
              </svg>
              <span>symphonyness</span>
            </div>
            <p id="issue-eyebrow" class="issue-eyebrow">${escapedIssueId}</p>
            <h1 id="issue-title" class="issue-title">${escapedIssueId}</h1>
            <div id="hero-details" class="hero-details">
              <div id="repo-line" class="repo-line">
                <svg class="github-mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0.2a8 8 0 0 0-2.53 15.59c0.4 0.07 0.55-0.17 0.55-0.38v-1.49c-2.24 0.49-2.71-0.95-2.71-0.95-0.36-0.92-0.88-1.16-0.88-1.16-0.72-0.49 0.05-0.48 0.05-0.48 0.8 0.06 1.22 0.82 1.22 0.82 0.71 1.21 1.86 0.86 2.31 0.66 0.07-0.52 0.28-0.86 0.5-1.06-1.79-0.2-3.67-0.89-3.67-3.98 0-0.88 0.31-1.6 0.82-2.16-0.08-0.2-0.36-1.02 0.08-2.13 0 0 0.67-0.21 2.2 0.82A7.62 7.62 0 0 1 8 4.03c0.68 0 1.36 0.09 2 0.27 1.52-1.03 2.19-0.82 2.19-0.82 0.44 1.11 0.16 1.93 0.08 2.13 0.51 0.56 0.82 1.28 0.82 2.16 0 3.1-1.89 3.77-3.69 3.97 0.29 0.25 0.55 0.74 0.55 1.5v2.22c0 0.21 0.15 0.46 0.56 0.38A8 8 0 0 0 8 0.2Z"/></svg>
                <span>loading</span>
                <span class="repo-name">loading</span>
              </div>
              <div id="status-line" class="status-line">
                <span class="chip green">Loading</span>
              </div>
            </div>
          </div>
          <div class="progress-rail">
            <div class="progress-summary">
              <span class="progress-kicker">PROGRESS</span>
              <strong id="progress-value" class="progress-value">0%</strong>
              <span id="progress-copy" class="progress-copy" data-i18n="overallProgress">整体进度</span>
              <div class="progress-track">
                <div id="progress-fill" class="progress-fill"></div>
              </div>
              <div id="progress-steps" class="progress-steps" aria-hidden="true">
                <span class="progress-step done">Plan</span>
                <span class="progress-step done">Dev</span>
                <span class="progress-step active">Review</span>
                <span class="progress-step">Delivery</span>
              </div>
            </div>
          </div>
        </section>

      </header>

      <div class="tabbar" role="tablist" aria-label="Issue views">
        <button class="tab-button active" type="button" role="tab" aria-selected="true" data-tab="overview">
          <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4h6M9 12h6M9 16h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <span class="tab-label">Issue</span>
        </button>
        <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab="changes">
          <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h8M8 12h8M8 17h5M5 5v14M19 5v14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <span class="tab-label">Changes</span>
        </button>
        <button class="tab-button" type="button" role="tab" aria-selected="false" data-tab="delivery">
          <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7M6 20h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="tab-label">Delivery</span>
        </button>
      </div>

      <section id="tab-overview" class="tab-panel active" role="tabpanel">
        <div class="tab-stack">
          <section class="panel pad signal-panel">
            <h2 class="panel-title"><span data-i18n="overviewSignal">Overview Signal</span> <span id="signal-state-badge" class="chip green">Running</span></h2>
            <div id="signal-pills" class="signal-pills"></div>
            <div id="overview-signal" class="signal-list"></div>
            <div class="signal-acceptance">
              <strong id="signal-acceptance-title">Acceptance: 0/0</strong>
              <span id="signal-acceptance-copy">Waiting for runtime signal.</span>
              <div id="signal-acceptance-track" class="signal-acceptance-track" style="--accept-a:0%;--accept-b:0%"></div>
            </div>
          </section>

          <section class="judgment">
            <article class="panel pad">
            <h2 class="panel-title" data-i18n="currentJudgment">当前判断</h2>
              <p id="judgment-copy" class="panel-copy">正在读取当前 issue 状态。</p>
            </article>
            <article class="panel pad">
            <h2 class="panel-title" data-i18n="nextRecommendation">下一步推荐</h2>
              <p id="next-copy" class="panel-copy">等待运行时信号。</p>
            </article>
          </section>

          <section class="panel pad">
            <h2 class="panel-title"><span data-i18n="roundGoalTitle">当前轮次目标</span> <span id="complexity-chip" class="chip blue">L?</span></h2>
            <p id="round-goal" class="panel-copy">等待 supervisor round 信号。</p>
            <p id="risk-delta" class="panel-copy" style="margin-top:8px">risk_delta · loading</p>
          </section>

          <section id="stage-row" class="panel stage-row" aria-label="阶段进度"></section>
          <section class="panel pad">
            <h2 class="panel-title"><span id="timeline-title">实时事件流</span> <span id="live-badge" class="chip green">Live</span></h2>
            <div id="timeline-list" class="timeline"><div class="loading">Loading timeline...</div></div>
          </section>

          <section class="side-stack">
            <section class="panel pad">
              <h2 class="panel-title"><span data-i18n="agentProgress">Agent 进度</span> <span class="chip green" data-i18n="latestThree">最近 3 条</span></h2>
              <div id="agent-list"></div>
            </section>
            <section class="panel pad">
              <h2 class="panel-title"><span data-i18n="milestones">关键节点</span> <span class="chip yellow">milestones</span></h2>
              <div id="milestone-list"></div>
            </section>
          </section>
        </div>
      </section>

      <section id="tab-changes" class="tab-panel" role="tabpanel">
        <div class="layout">
          <section class="panel pad">
            <h2 class="panel-title"><span data-i18n="fileActivity">文件活动</span> <span class="chip blue" data-i18n="recent">最近</span></h2>
            <div id="file-list"></div>
          </section>

          <section class="panel pad">
            <h2 class="panel-title"><span data-i18n="codeChanges">代码改动</span> <span class="chip green">diff</span></h2>
            <div id="diff-list"></div>
          </section>
        </div>
      </section>

      <section id="tab-delivery" class="tab-panel" role="tabpanel">
        <div class="tab-stack">
          <section class="panel pad">
            <h2 class="panel-title" data-i18n="deliveryClosure">交付闭环</h2>
            <div id="delivery-list"></div>
          </section>

          <section class="panel pad">
            <h2 class="panel-title"><span data-i18n="acceptanceCriteria">验收标准</span> <span class="chip green">checks</span></h2>
            <div id="acceptance-list"></div>
          </section>

          <section class="panel pad">
            <h2 class="panel-title" data-i18n="deliverySummaryTitle">交付总结</h2>
            <p id="delivery-summary" class="panel-copy">等待交付记录。</p>
          </section>

          <section class="panel pad">
            <h2 class="panel-title"><span data-i18n="childQueue">子任务队列</span> <span id="root-label" class="chip">Root: ${escapedIssueId}</span></h2>
            <div id="child-list"></div>
          </section>

          <section id="history-panel" class="panel pad history-panel" hidden>
            <h2 class="panel-title"><span data-i18n="fullLog">完整日志</span> <button id="history-close-button" class="text-button" type="button" data-i18n="collapse">收起</button></h2>
            <p id="history-digest" class="panel-copy">等待历史记录。</p>
            <div id="history-entry-list"></div>
          </section>

          <div class="actions">
            <button id="pause-button" class="danger" type="button" data-runtime-action="pause">暂停执行</button>
            <button id="request-button" class="primary" type="button" data-runtime-action="request">补充要求</button>
            <a id="pr-link" class="primary" href="#" target="_blank" rel="noreferrer">查看 PR</a>
            <button id="back-button" type="button" data-runtime-action="back">回 Telegram</button>
          </div>
        </div>
      </section>

      <div id="diff-drawer-backdrop" class="diff-drawer-backdrop" hidden></div>
      <aside id="diff-drawer" class="diff-drawer" hidden aria-hidden="true" aria-labelledby="diff-drawer-title">
        <div class="diff-drawer-header">
          <div>
            <p class="diff-drawer-kicker" data-i18n="codeChanges">代码改动</p>
            <strong id="diff-drawer-title">src/runtime/miniAppPage.ts</strong>
            <span id="diff-drawer-reason">等待更详细的改动摘要。</span>
          </div>
          <button id="diff-drawer-close-button" class="text-button" type="button" data-i18n="collapse">收起</button>
        </div>
        <div class="diff-drawer-meta">
          <b id="diff-drawer-stat" class="diff-stat-summary"><span class="diff-stat-token add">+0</span><span class="diff-stat-token del">-0</span></b>
          <span id="diff-drawer-badge" class="chip blue">M</span>
        </div>
        <span id="diff-drawer-note" class="diff-drawer-note" hidden>以下只展示片段。</span>
        <div class="diff-drawer-body">
          <code id="diff-drawer-detail" class="diff-drawer-code">No diff detail yet.</code>
        </div>
      </aside>
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

        const storedLang = window.localStorage.getItem('symphony.miniapp.lang.' + issueId);
        const state = {
          issue: null,
          timeline: [],
          history: null,
          stream: null,
          activeTab: 'overview',
          heroExpanded: false,
          renderedDiffFiles: [],
          theme: window.localStorage.getItem('symphony.miniapp.theme') || 'dark',
          lang: storedLang || null,
          langInitialized: storedLang === 'en' || storedLang === 'zh'
        };
        const el = {
          hero: document.getElementById('hero'),
          heroDetails: document.getElementById('hero-details'),
          themeToggle: document.getElementById('theme-toggle'),
          languageToggle: document.getElementById('language-toggle'),
          issueEyebrow: document.getElementById('issue-eyebrow'),
          issueTitle: document.getElementById('issue-title'),
          repoLine: document.getElementById('repo-line'),
          statusLine: document.getElementById('status-line'),
          progressValue: document.getElementById('progress-value'),
          progressCopy: document.getElementById('progress-copy'),
          progressFill: document.getElementById('progress-fill'),
          progressSteps: document.getElementById('progress-steps'),
          signalStateBadge: document.getElementById('signal-state-badge'),
          signalPills: document.getElementById('signal-pills'),
          overviewSignal: document.getElementById('overview-signal'),
          signalAcceptanceTitle: document.getElementById('signal-acceptance-title'),
          signalAcceptanceCopy: document.getElementById('signal-acceptance-copy'),
          signalAcceptanceTrack: document.getElementById('signal-acceptance-track'),
          judgmentCopy: document.getElementById('judgment-copy'),
          nextCopy: document.getElementById('next-copy'),
          stageRow: document.getElementById('stage-row'),
          timelineTitle: document.getElementById('timeline-title'),
          timelineList: document.getElementById('timeline-list'),
          liveBadge: document.getElementById('live-badge'),
          fileList: document.getElementById('file-list'),
          diffList: document.getElementById('diff-list'),
          deliveryList: document.getElementById('delivery-list'),
          acceptanceList: document.getElementById('acceptance-list'),
          deliverySummary: document.getElementById('delivery-summary'),
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
          diffDrawerBackdrop: document.getElementById('diff-drawer-backdrop'),
          diffDrawer: document.getElementById('diff-drawer'),
          diffDrawerTitle: document.getElementById('diff-drawer-title'),
          diffDrawerReason: document.getElementById('diff-drawer-reason'),
          diffDrawerStat: document.getElementById('diff-drawer-stat'),
          diffDrawerBadge: document.getElementById('diff-drawer-badge'),
          diffDrawerNote: document.getElementById('diff-drawer-note'),
          diffDrawerDetail: document.getElementById('diff-drawer-detail'),
          diffDrawerCloseButton: document.getElementById('diff-drawer-close-button'),
          prLink: document.getElementById('pr-link'),
          pauseButton: document.getElementById('pause-button'),
          requestButton: document.getElementById('request-button'),
          backButton: document.getElementById('back-button')
        };
        const tabButtons = Array.from(document.querySelectorAll('[data-tab]'));
        const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));
        const messages = {
          zh: {
            themeDark: '夜间',
            themeLight: '日间',
            langLabel: '中文',
            overallProgress: '整体进度',
            overviewSignal: '状态概览',
            currentJudgment: '当前判断',
            nextRecommendation: '下一步推荐',
            roundGoalTitle: '当前轮次目标',
            agentProgress: 'Agent 进度',
            latestThree: '最近 3 条',
            milestones: '关键节点',
            fileActivity: '文件活动',
            recent: '最近',
            codeChanges: '代码改动',
            acceptanceCriteria: '验收标准',
            deliveryClosure: '交付闭环',
            deliverySummaryTitle: '交付总结',
            childQueue: '子任务队列',
            fullLog: '完整日志',
            collapse: '收起',
            expand: '展开',
            repository: '仓库',
            phase: '阶段',
            rootIssue: 'Root issue',
            childRunning: 'Child running',
            deliveryDone: 'Delivery done',
            supervisorDone: 'Supervisor done',
            overallReady: '已完成',
            waiting: '等待',
            running: '运行中',
            waitingEvents: '等待事件流。',
            noFileActivity: '暂无文件活动。',
            noCodeChanges: '还没有可展示的代码改动。',
            noAgentProgress: '暂无 agent 最近进度。',
            noMilestones: '暂无关键节点总结。',
            diffDetails: '完整 diff',
            diffSummary: '改动摘要',
            reason: '原因',
            noDiffDetail: '暂无更详细的 diff 摘要。',
            diffExcerptNote: '这里展示的是运行时历史里的改动片段，+ / - 数字来自整份文件的改动统计。',
            diffSummaryOnlyNote: '这里还没有完整 patch，只拿到了这份文件的改动摘要，+ / - 数字来自整份文件的改动统计。',
            restore: '恢复',
            restorable: '可一键恢复',
            noRestore: '无需恢复',
            viewPr: '查看 PR',
            prPending: 'PR 待生成',
            acceptanceProgress: '验收进度',
            status: '状态',
            completed: '已完成',
            validating: '持续验证中',
            missingRequirement: '未满足验收项',
            noChildQueue: '这是单 issue 执行，没有必要拆分子任务。',
            noHistory: '这条 issue 暂时还没有可回放的完整日志。',
            noCheckpoints: '暂无历史检查点。',
            fullLogButton: '完整日志',
            newRequest: '新需求',
            backTelegram: '回 Telegram',
            retryDelivery: '修复交付并重试',
            addRequirement: '补充要求',
            pause: '暂停执行',
            retrying: '正在重试…',
            retryFailed: '恢复动作提交失败。',
            pauseHint: '暂停执行会回到 Telegram 原生按钮确认。',
            requestHint: '补充要求会回到 Telegram 对话继续输入。',
            closedSummary: 'Issue 已完成，最终交付已闭环。',
            planReady: '计划已形成，等待执行信号。',
            needsDecision: '当前需要用户确认下一步。',
            dispatchActive: '已进入运行通道，等待最近执行信号刷新。',
            dispatchReady: '已准备进入运行通道。',
            proofSatisfied: '证据已满足，正在等待最终交付。',
            reviewRunning: 'Review 正在检查交付质量。',
            devRunning: 'Dev agent 正在推进当前轮次。',
            readingIssue: '正在读取当前 issue 状态。',
            waitingSignal: '等待运行时信号。',
            waitingRound: '等待 supervisor round 信号。',
            waitingDelivery: '等待交付记录。',
            toolRunning: '正在运行',
            toolDone: '完成',
            toolActivity: '活动',
            readingFile: '读取文件',
            writingFile: '写入文件',
            editingFile: '编辑文件',
            checkGit: '检查 Git 状态',
            runTests: '运行测试',
            listFiles: '检查文件列表',
            viewPrStatus: '查看 PR 状态',
            updateTests: '补充或更新回归测试。',
            updateUi: '调整界面展示逻辑与排版。',
            updateDocs: '更新文档说明。',
            updatePackage: '更新依赖或脚本配置。',
            updateRuntime: '更新运行证据与交付状态。',
            updateFile: '更新 {name}。',
            addFile: '新增 {name}。',
            deleteFile: '删除 {name}。',
            writeFile: '写入 {name}',
            readFile: '读取 {name}',
            editFile: '编辑 {name}',
            completedIssueNoMoreInstructions: '当前计划「{title}」已经完成，不再向 dev agent 追加指令。',
            doneWithPr: '已完成，PR #{pr} 已就绪。可以查看 PR，或回到 Telegram 发起下一条需求。',
            doneNoPr: '已完成。可以回到 Telegram 发起下一条需求。',
            liveJudgmentFallback: '当前只推进最有把握的下一步，保持 child 队列有序。',
            retryRecommendation: '交付恢复卡住了，但这类问题可以一键重试：先清理工作流产物，再重新进入交付。',
            waitingSupervisorAction: '等待 supervisor 写入下一步动作。',
            waitingRuntimeSignal: '等待下一步运行时信号。',
            nowLabel: 'Now',
            latestLabel: 'Latest',
            nextLabel: 'Next',
            runningShort: '运行中',
            acceptanceSummary: '验收：{passed}/{total}'
          },
          en: {
            themeDark: 'Dark',
            themeLight: 'Light',
            langLabel: 'EN',
            overallProgress: 'Overall',
            overviewSignal: 'Overview Signal',
            currentJudgment: 'Current Judgment',
            nextRecommendation: 'Next Recommendation',
            roundGoalTitle: 'Round Goal',
            agentProgress: 'Agent Progress',
            latestThree: 'Latest 3',
            milestones: 'Milestones',
            fileActivity: 'File Activity',
            recent: 'Recent',
            codeChanges: 'Code Changes',
            acceptanceCriteria: 'Acceptance Criteria',
            deliveryClosure: 'Delivery',
            deliverySummaryTitle: 'Delivery Summary',
            childQueue: 'Child Queue',
            fullLog: 'Full Log',
            collapse: 'Collapse',
            expand: 'Expand',
            repository: 'Repository',
            phase: 'Phase',
            rootIssue: 'Root issue',
            childRunning: 'Child running',
            deliveryDone: 'Delivery done',
            supervisorDone: 'Supervisor done',
            overallReady: 'Done',
            waiting: 'Waiting',
            running: 'Running',
            waitingEvents: 'Waiting for events.',
            noFileActivity: 'No file activity yet.',
            noCodeChanges: 'No code changes to show yet.',
            noAgentProgress: 'No recent agent progress yet.',
            noMilestones: 'No milestone summary yet.',
            diffDetails: 'Full diff',
            diffSummary: 'Summary',
            reason: 'Reason',
            noDiffDetail: 'No deeper diff detail is available yet.',
            diffExcerptNote: 'This panel shows an excerpt from runtime history. The + / - totals come from the full file diff stats.',
            diffSummaryOnlyNote: 'A full patch is not available here yet. The + / - totals come from the full file diff stats.',
            restore: 'Recovery',
            restorable: 'One-click recovery available',
            noRestore: 'No recovery needed',
            viewPr: 'View PR',
            prPending: 'PR pending',
            acceptanceProgress: 'Acceptance progress',
            status: 'Status',
            completed: 'Completed',
            validating: 'Validating',
            missingRequirement: 'Unsatisfied requirement',
            noChildQueue: 'Single-issue execution. No child tasks are needed.',
            noHistory: 'This issue has no replayable full log yet.',
            noCheckpoints: 'No history checkpoints yet.',
            fullLogButton: 'Full Log',
            newRequest: 'New Request',
            backTelegram: 'Back to Telegram',
            retryDelivery: 'Fix delivery and retry',
            addRequirement: 'Add Requirement',
            pause: 'Pause',
            retrying: 'Retrying...',
            retryFailed: 'Recovery action failed.',
            pauseHint: 'Pause will return to the native Telegram confirmation flow.',
            requestHint: 'Continue in the Telegram chat to add requirements.',
            closedSummary: 'Issue is complete and delivery is closed.',
            planReady: 'Plan is ready and waiting for an execution signal.',
            needsDecision: 'A decision is needed before the run can continue.',
            dispatchActive: 'The run is active and waiting for the next execution signal.',
            dispatchReady: 'Ready to enter the execution channel.',
            proofSatisfied: 'Evidence is satisfied and final delivery is pending.',
            reviewRunning: 'Review is checking delivery quality.',
            devRunning: 'The dev agent is advancing this round.',
            readingIssue: 'Loading the current issue state.',
            waitingSignal: 'Waiting for runtime signal.',
            waitingRound: 'Waiting for supervisor round signal.',
            waitingDelivery: 'Waiting for delivery record.',
            toolRunning: 'is running',
            toolDone: 'completed',
            toolActivity: 'activity',
            readingFile: 'Reading file',
            writingFile: 'Writing file',
            editingFile: 'Editing file',
            checkGit: 'Checking Git status',
            runTests: 'Running tests',
            listFiles: 'Checking file list',
            viewPrStatus: 'Checking PR status',
            updateTests: 'Adds or updates regression tests.',
            updateUi: 'Updates interface logic and layout.',
            updateDocs: 'Updates documentation.',
            updatePackage: 'Updates dependencies or script configuration.',
            updateRuntime: 'Updates runtime evidence and delivery state.',
            updateFile: 'Updates {name}.',
            addFile: 'Adds {name}.',
            deleteFile: 'Deletes {name}.',
            writeFile: 'Write {name}',
            readFile: 'Read {name}',
            editFile: 'Edit {name}',
            completedIssueNoMoreInstructions: 'The plan "{title}" is complete. No more dev-agent instructions will be added.',
            doneWithPr: 'Completed. PR #{pr} is ready. You can view the PR or start the next request in Telegram.',
            doneNoPr: 'Completed. You can start the next request in Telegram.',
            liveJudgmentFallback: 'The system is advancing the highest-confidence next step and keeping child work ordered.',
            retryRecommendation: 'Delivery recovery is blocked, but this can be retried: clean workflow artifacts and re-enter delivery.',
            waitingSupervisorAction: 'Waiting for the supervisor to write the next action.',
            waitingRuntimeSignal: 'Waiting for the next runtime signal.',
            nowLabel: 'Now',
            latestLabel: 'Latest',
            nextLabel: 'Next',
            runningShort: 'Running',
            acceptanceSummary: 'Acceptance: {passed}/{total}'
          }
        };
        function t(key, vars) {
          const table = messages[state.lang] || messages.zh;
          const fallback = messages.zh[key] || key;
          return String(table[key] || fallback).replace(/\\{(\\w+)\\}/g, (_, name) => {
            return vars && vars[name] != null ? String(vars[name]) : '';
          });
        }
        function isEnglish() {
          return state.lang === 'en';
        }
        function applyPreferences() {
          const theme = state.theme === 'light' ? 'light' : 'dark';
          const lang = state.lang === 'en' ? 'en' : 'zh';
          state.theme = theme;
          state.lang = lang;
          document.documentElement.setAttribute('data-theme', theme);
          document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
          document.querySelectorAll('[data-i18n]').forEach((node) => {
            node.textContent = t(node.getAttribute('data-i18n'));
          });
          el.themeToggle.dataset.value = theme;
          el.languageToggle.dataset.value = lang;
          el.themeToggle.querySelectorAll('[data-theme-choice]').forEach((button) => {
            button.setAttribute('aria-pressed', button.getAttribute('data-theme-choice') === theme ? 'true' : 'false');
          });
          el.languageToggle.querySelectorAll('[data-lang-choice]').forEach((button) => {
            button.setAttribute('aria-pressed', button.getAttribute('data-lang-choice') === lang ? 'true' : 'false');
          });
          el.historyCloseButton.textContent = t('collapse');
          window.localStorage.setItem('symphony.miniapp.theme', theme);
          if (state.langInitialized) {
            window.localStorage.setItem('symphony.miniapp.lang.' + issueId, lang);
          }
        }
        function applyIssueDefaultLanguage(issue) {
          if (state.langInitialized) return;
          state.lang = issue && issue.supervisor_locale === 'en' ? 'en' : 'zh';
          state.langInitialized = true;
        }

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
          return '<span class="expandable-copy" data-full-text="' + escapeHtml(full) + '" data-preview-text="' + escapeHtml(preview) + '"><span class="expandable-text">' + escapeHtml(preview) + '</span><button class="expand-button" type="button">' + escapeHtml(t('expand')) + '</button></span>';
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
          button.textContent = expanded ? t('expand') : t('collapse');
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
              if (code === 'tool_started' || /^using\\s+/i.test(message)) return isEnglish() ? toolName + ' ' + t('toolRunning') : toolName + ' ' + t('toolRunning');
              if (code === 'tool_completed') return isEnglish() ? toolName + ' ' + t('toolDone') : toolName + ' ' + t('toolDone');
              return toolName + ' ' + (code ? code.replace(/^tool_/, '') : t('toolActivity'));
            }
            if (message) {
              return localizeKnownRuntimeText(message).replace(/\\s+/g, ' ').trim().slice(0, limit);
            }
          }
          return localizeKnownRuntimeText(raw || fallback || '').replace(/\\s+/g, ' ').trim();
        }
        function localizeKnownRuntimeText(value) {
          const text = String(value || '').replace(/\\s+/g, ' ').trim();
          if (!text || !isEnglish()) return text;
          const smokeDone = text.match(/^(\\S+)\\s+烟雾测试已成功完成。\\s+([\\w./-]+)\\s+中添加了一个字符，并通过了编译验证。\\s+PR #(\\d+) 已审查批准，无进一步行动。$/);
          if (smokeDone) {
            return smokeDone[1] + ' smoke test completed successfully. One character was added to ' + smokeDone[2] + ', compile verification passed, and PR #' + smokeDone[3] + ' was approved. No further action is needed.';
          }
          function localizeSnippet(snippet) {
            return String(snippet || '')
              .replace(/（/g, '(')
              .replace(/）/g, ')')
              .replace(/；/g, '; ')
              .replace(/，/g, ', ')
              .replace(/。\\s*$/g, '')
              .replace(/追加一个\\s*character/g, 'appends one character')
              .replace(/添加了一个\\s*character/g, 'adds one character')
              .replace(/追加一个字符/g, 'appends one character')
              .replace(/添加了一个字符/g, 'adds one character')
              .replace(/\\x60([^\\x60]+)\\x60\\s*验证/g, '\\x60$1\\x60 verifies')
              .replace(/([A-Za-z0-9_.-]+)\\s*验证/g, '$1 verifies')
              .replace(/验证/g, 'verify')
              .replace(/批准即创建/g, 'create after approval')
              .replace(/\\s+/g, ' ')
              .trim();
          }
          const continuePlan = text.match(/^继续推进计划「(.+)」。\\s*完成标准：(.+?)。\\s*(?:当前只推进子单\\s+([^，。]+)，(.+?)。\\s*)?(?:历史提醒：(.+)。)?$/);
          if (continuePlan) {
            return [
              'Continue advancing plan "' + continuePlan[1] + '".',
              'Acceptance: ' + localizeSnippet(continuePlan[2]) + '.',
              continuePlan[3] ? 'Only advance child issue ' + continuePlan[3] + '; ' + localizeSnippet(continuePlan[4]) + '.' : null,
              continuePlan[5] ? 'History reminders: ' + localizeSnippet(continuePlan[5]) + '.' : null
            ].filter(Boolean).join(' ');
          }
          return text
            .replace(/^当前计划「(.+)」已经完成，不再向 dev agent 追加指令。$/, 'Plan "$1" is complete. No more dev-agent instructions are needed.')
            .replace(/^计划「(.+)」正在推进。$/, 'Plan "$1" is in progress.')
            .replace(/^继续推进计划「(.+)」。$/, 'Continue advancing plan "$1".')
            .replace(/^完成标准：(.+)。?$/, function (_match, body) { return 'Acceptance: ' + localizeSnippet(body) + '.'; })
            .replace(/^证据已满足，正在等待最终交付动作完成。$/, 'Proof is satisfied and final delivery is pending.')
            .replace(/^证据已满足，正在等待最终交付。$/, 'Proof is satisfied and final delivery is pending.')
            .replace(/^Issue 已完成，最终交付已闭环。$/, 'Issue is complete and final delivery is closed.')
            .replace(/^计划线程已完成，最终交付已闭环。$/, 'Plan thread is complete and final delivery is closed.')
            .replace(/^Review 正在检查交付质量。$/, 'Review is checking delivery quality.')
            .replace(/^Dev agent 正在推进当前轮次。$/, 'The dev agent is advancing the current round.')
            .replace(/^等待 supervisor 写入下一步动作。$/, 'Waiting for the supervisor to write the next action.')
            .replace(/^等待下一步运行时信号。$/, 'Waiting for the next runtime signal.')
            .replace(/^当前只推进最有把握的下一步，保持 child 队列有序。$/, 'The system is advancing the highest-confidence next step and keeping child work ordered.')
            .replace(/## Review Summary \\*\\*变更审查\\*\\*/g, '## Review Summary **Change assessed**')
            .replace(/\\*\\*验证结果\\*\\*：/g, '**Verification result**: ')
            .replace(/\\*\\*变更审查\\*\\*：/g, '**Change assessed**: ')
            .replace(/未尾追加一个/g, 'appended one')
            .replace(/追加一个\\s*character/g, 'appends one character')
            .replace(/添加了一个\\s*character/g, 'adds one character')
            .replace(/追加一个字符/g, 'appends one character')
            .replace(/添加了一个字符/g, 'adds one character')
            .replace(/\\x60([^\\x60]+)\\x60\\s*验证/g, '\\x60$1\\x60 verifies')
            .replace(/批准即创建/g, 'create after approval')
            .replace(/；/g, '; ')
            .replace(/字符/g, 'character')
            .replace(/无进一步行动/g, 'no further action');
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
        function runtimeStateLabel(issue) {
          if (!issue) return t('waiting');
          if (isCompletedIssue(issue)) return t('completed');
          if (issue.delivery_state === 'proof_satisfied') return isEnglish() ? 'Proof satisfied' : '证据满足';
          if (isRetryableDeliveryFailure(issue)) return isEnglish() ? 'Needs recovery' : '需要恢复';
          if (issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming' || issue.active_decision_kind) {
            return isEnglish() ? 'Needs decision' : '待确认';
          }
          if (issue.governance_thread_state === 'waiting_on_child') {
            return isEnglish() ? 'Waiting on child' : '等待子任务';
          }
          if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
            return isEnglish() ? 'Review running' : 'Review 进行中';
          }
          if (issue.session || issue.orchestrator_state === 'dev_running') {
            return t('runningShort');
          }
          if (issue.orchestrator_state === 'retry_scheduled') {
            return isEnglish() ? 'Retry scheduled' : '等待重试';
          }
          if (issue.orchestrator_state === 'failed') {
            return isEnglish() ? 'Blocked' : '已阻塞';
          }
          if (issue.orchestrator_state === 'discovering' || issue.orchestrator_state === 'mapping' || issue.orchestrator_state === 'workspace_ready') {
            return isEnglish() ? 'Preparing' : '准备中';
          }
          if (issue.orchestrator_state === 'cancelled') {
            return isEnglish() ? 'Cancelled' : '已取消';
          }
          return compactText(issue.tracker_state || issue.orchestrator_state || t('waiting'), 36);
        }
        function runtimeProgressLabel(issue, progress) {
          if (!issue) return String(progress || 0) + '%';
          if (isCompletedIssue(issue)) return (isEnglish() ? 'Done' : '完成') + ' ' + String(progress) + '%';
          if (issue.delivery_state === 'proof_satisfied') return (isEnglish() ? 'Proof' : '证据') + ' ' + String(progress) + '%';
          if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') return (isEnglish() ? 'Review' : '审查') + ' ' + String(progress) + '%';
          if (issue.session || issue.orchestrator_state === 'dev_running') return (isEnglish() ? 'Build' : '构建') + ' ' + String(progress) + '%';
          if (issue.governance_thread_state === 'waiting_on_child') return (isEnglish() ? 'Dispatch' : '调度') + ' ' + String(progress) + '%';
          return (isEnglish() ? 'Plan' : '计划') + ' ' + String(progress) + '%';
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
            milestone(issue, 'plan_ready', compactText(issue.supervisor_plan_summary || issue.title, 160) || t('planReady'), issue.created_at)
          ];
          if (issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming') {
            items.push(milestone(issue, 'needs_decision', compactText(issue.next_recommended_action || issue.governance_summary, 180) || t('needsDecision')));
          } else {
            items.push(milestone(issue, 'dispatch_ready', issue.session || issue.orchestrator_state ? t('dispatchActive') : t('dispatchReady')));
          }
          if (isCompletedIssue(issue)) {
            items.push(milestone(issue, 'delivery_completed', compactText(issue.delivery_summary, 180) || t('closedSummary')));
          } else if (issue.delivery_state === 'proof_satisfied') {
            items.push(milestone(issue, 'proof_satisfied', compactText(issue.delivery_summary, 180) || t('proofSatisfied')));
          } else if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
            items.push(milestone(issue, 'review_running', compactText((issue.session && issue.session.last_message) || issue.next_recommended_action, 180) || t('reviewRunning'), issue.session && issue.session.last_event_at || issue.updated_at));
          } else if (issue.session || issue.orchestrator_state === 'dev_running') {
            items.push(milestone(issue, 'dev_running', compactText((issue.session && issue.session.last_message) || issue.next_recommended_action, 180) || t('devRunning'), issue.session && issue.session.last_event_at || issue.updated_at));
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
          if (operation === 'read') return isEnglish() ? 'Read' : '读取';
          if (operation === 'write') return isEnglish() ? 'Write' : '写入';
          if (operation === 'edit') return isEnglish() ? 'Edit' : '编辑';
          return t('fileActivity');
        }
        function summarizeDiffPath(path, fallback) {
          const displayPath = readablePath(path);
          const name = fileDisplayName(displayPath);
          const lower = displayPath.toLowerCase();
          if (/\\.test\\.|\\.spec\\.|__tests__|test\\//.test(lower)) return t('updateTests');
          if (/miniapp|page|style|css|tsx?$|jsx?$/.test(lower)) return t('updateUi');
          if (/readme|docs?|\\.md$/.test(lower)) return t('updateDocs');
          if (/package|bun\\.lock|lockfile/.test(lower)) return t('updatePackage');
          if (/\\.symphony|state|evidence|handover/.test(lower)) return t('updateRuntime');
          if (fallback) return compactText(fallback, 90);
          return t('updateFile', { name });
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
        function historyFileDiffs(history) {
          return history && Array.isArray(history.file_diffs) ? history.file_diffs : [];
        }
        function historyFileDiffForPath(history, path) {
          if (!path) return null;
          return historyFileDiffs(history).find((item) => readablePath(item.path) === readablePath(path)) || null;
        }
        function parseChangeLine(line) {
          const trimmed = String(line || '').replace(/^[-*]\\s+/, '').trim();
          if (!trimmed) return null;
          function parseDiffStats(value) {
            const match = String(value || '').match(/\\+(\\d+)\\s*-\\s*(\\d+)/);
            if (!match) return { additions: null, deletions: null };
            return {
              additions: Number(match[1] || 0),
              deletions: Number(match[2] || 0)
            };
          }
          function isLikelyDiffPath(value) {
            const candidate = readablePath(value).replace(/^['"]|['"]$/g, '').trim();
            if (!candidate || /\\s/.test(candidate)) return false;
            return /\\.[a-z0-9][a-z0-9._-]*$/i.test(candidate)
              || /^(README|CHANGELOG|LICENSE)(?:\\.|$)/i.test(candidate)
              || /^(src|test|tests|docs|scripts|packages|app|lib|public|config)\\//.test(candidate);
          }
          let match = trimmed.match(/^\\|?\\s*\`?([^\`|]+?)\`?\\s*\\|\\s*([^|]+?)(?:\\|\\s*([^|]+?))?(?:\\||$)/);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            const action = String(match[2] || '').toLowerCase();
            const deleted = /delete|remove|删除|移除/.test(action);
            const added = /add|create|新增|创建/.test(action);
            const stats = parseDiffStats(match[3] || trimmed);
            return {
              path,
              badge: deleted ? 'D' : added ? 'A' : 'M',
              summary: summarizeDiffPath(path, deleted ? t('deleteFile', { name: fileDisplayName(path) }) : added ? t('addFile', { name: fileDisplayName(path) }) : t('updateFile', { name: fileDisplayName(path) })),
              detail: compactText(trimmed.replace(/\\|/g, ' '), 260),
              additions: stats.additions,
              deletions: stats.deletions,
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
              summary: t('deleteFile', { name: fileDisplayName(path) }),
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
              summary: t('addFile', { name: fileDisplayName(path) }),
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
              summary: summarizeDiffPath(path, t('updateFile', { name: fileDisplayName(path) })),
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
              summary: summarizeDiffPath(path, t('updateFile', { name: fileDisplayName(path) })),
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
          historyFileDiffs(history).forEach((item) => {
            if (!item || !item.path) return;
            byPath.set(readablePath(item.path), {
              path: readablePath(item.path),
              badge: item.deletions != null && item.additions === 0 ? 'D' : item.additions != null && item.deletions === 0 ? 'A' : 'M',
              summary: summarizeDiffPath(readablePath(item.path), t('updateFile', { name: fileDisplayName(readablePath(item.path)) })),
              detail: compactText(item.patch || '', 260),
              additions: item.additions,
              deletions: item.deletions,
              timestamp: null,
              tone: item.deletions != null && item.additions === 0 ? 'red' : item.additions != null && item.deletions === 0 ? 'green' : 'blue'
            });
          });
          changeTextSourcesFromHistory(history).forEach((source) => {
            splitHistoryChangeLines(source).forEach((line) => {
              const item = parseChangeLine(line);
              if (!item || !item.path) return;
              byPath.set(item.path, Object.assign({}, byPath.get(item.path), item));
            });
          });
          return Array.from(byPath.values()).slice(0, 12);
        }
        function extractDiffStatsFromHistory(history) {
          const byPath = new Map();
          changeTextSourcesFromHistory(history).forEach((source) => {
            splitHistoryChangeLines(source).forEach((line) => {
              const trimmed = String(line || '').replace(/^[-*]\\s+/, '').trim();
              const match = trimmed.match(/^\\|?\\s*\`?([^\`|]+?)\`?\\s*\\|\\s*[^|]+?\\|\\s*([^|]+?)(?:\\||$)/);
              if (!match || !match[1]) return;
              const path = readablePath(match[1]);
              const statsMatch = String(match[2] || '').match(/\\+(\\d+)\\s*-\\s*(\\d+)/);
              if (!path || !statsMatch) return;
              byPath.set(path, {
                additions: Number(statsMatch[1] || 0),
                deletions: Number(statsMatch[2] || 0)
              });
            });
          });
          return byPath;
        }
        function diffStatsForPath(history, path) {
          if (!path) return null;
          const fromWorkspace = historyFileDiffForPath(history, path);
          if (fromWorkspace && (fromWorkspace.additions != null || fromWorkspace.deletions != null)) {
            return {
              additions: fromWorkspace.additions,
              deletions: fromWorkspace.deletions
            };
          }
          const direct = extractDiffStatsFromHistory(history).get(path);
          if (direct) return direct;
          const escapedPath = String(path).replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
          const pattern = new RegExp('(?:^|\\\\n)\\\\|?\\\\s*' + escapedPath + '\\\\s*\\\\|\\\\s*[^|]+?\\\\|\\\\s*\\\\+(\\\\d+)\\\\s*-\\\\s*(\\\\d+)', 'i');
          for (const source of changeTextSourcesFromHistory(history)) {
            const match = String(source || '').match(pattern);
            if (match) {
              return {
                additions: Number(match[1] || 0),
                deletions: Number(match[2] || 0)
              };
            }
          }
          return null;
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
              summary: humanFileOperation(file.operation) + (file.status === 'started' ? (isEnglish() ? 'ing' : '中') : (isEnglish() ? ' done' : '完成')) + ' · ' + summarizeDiffPath(normalized, overview),
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
            return normalizeRuntimeSummary(value, (label || 'Bash') + ' ' + t('toolRunning'), 72);
          }
          const command = stripShellNoise(value);
          const lower = command.toLowerCase();
          const pathMatch = command.match(/(?:cat|sed|awk|tail|head|less|open|code)\\s+(?:-[^\\s]+\\s+)*["']?([^"'\\s<>|;&]+)["']?/i) || command.match(/>\\s*["']?([^"'\\s<>|;&]+)["']?/);
          const path = pathMatch && pathMatch[1] ? fileDisplayName(pathMatch[1]) : '';
          if (/gh\\s+pr\\s+view/i.test(command)) {
            const pr = command.match(/gh\\s+pr\\s+view\\s+(\\d+)/i);
            return pr && pr[1] ? (isEnglish() ? 'View PR #' + pr[1] : '查看 PR #' + pr[1]) : t('viewPrStatus');
          }
          if (/git\\s+status|git\\s+log/i.test(command)) return t('checkGit');
          if (/bun\\s+test|npm\\s+test|pnpm\\s+test|pytest|vitest|jest/i.test(command)) return t('runTests');
          if (/\\brm\\s+-rf\\b|\\bdelete\\b|删除/.test(lower)) return compactText(command.replace(/\\s*&&\\s*/g, '，然后 '), 72);
          if (/^cat\\s*>|>\\s*["']?[^"'\\s]+/.test(command)) return path ? t('writeFile', { name: path }) : t('writingFile');
          if (/^(cat|sed|awk|tail|head|less)\\b/.test(command)) return path ? t('readFile', { name: path }) : t('readingFile');
          if (/^(ls|find|tree)\\b/.test(command)) return t('listFiles');
          if (!command || /^using\\s+/i.test(command)) return (label || 'Bash') + ' ' + t('toolRunning');
          return compactText(command.replace(/\\/Users\\/[^\\s"']+/g, (match) => fileDisplayName(match)), 72);
        }
        function summarizeToolActivity(tool, label) {
          if (label === 'Bash') return summarizeShellCommand(tool.message || tool.summary || '', label);
          const path = fileDisplayName(tool.path);
          if (label === 'Read') return path ? t('readFile', { name: path }) : compactText(tool.summary || tool.message || t('readingFile'), 72);
          if (label === 'Edit') return path ? t('editFile', { name: path }) : compactText(tool.summary || tool.message || t('editingFile'), 72);
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
              summary: compactText(issue.delivery_summary, 180) || t('closedSummary'),
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
              timelineTitle: t('deliverySummaryTitle'),
              judgmentSummary: deliverySummary || t('closedSummary'),
              nextRecommendation: issue.active_pr_number
                ? t('doneWithPr', { pr: issue.active_pr_number })
                : t('doneNoPr'),
              roundGoal: t('completedIssueNoMoreInstructions', { title: issue.title || issue.identifier || 'issue' }),
              riskDelta: normalizeRuntimeSummary(issue.riskDelta || issue.risk_delta, '', 4000) || 'stable',
              planStatus: t('completed'),
              dispatchStatus: t('completed'),
              devStatus: t('completed'),
              reviewStatus: t('completed'),
              reviewDeliveryStatus: reviewApproved ? 'approved' : t('completed'),
              emptyChildQueueLabel: t('noChildQueue'),
              activityFeed: buildActivityFeed(issue),
              visibleMilestones: buildMilestones(issue),
              diffFiles: buildDiffFiles(issue)
            };
          }
          const progress = getIssueProgress(issue);
          const reviewActive = issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running';
          return {
            mode: 'live',
            progress: retryableFailure ? Math.max(progress, 82) : progress,
            stateLabel: runtimeStateLabel(issue),
            stateTone: issue.delivery_state === 'proof_satisfied'
              ? 'green'
              : retryableFailure
                ? 'yellow'
                : 'blue',
            liveBadgeLabel: retryableFailure ? 'Action' : 'Live',
            timelineTitle: isEnglish() ? 'Live Event Stream' : '实时事件流',
            judgmentSummary: normalizeRuntimeSummary(
              issue.supervisor_plan_summary || issue.governance_summary || issue.delivery_summary,
              '',
              4000
            ) || t('liveJudgmentFallback'),
            nextRecommendation: retryableFailure
              ? t('retryRecommendation')
              : normalizeRuntimeSummary(issue.next_recommended_action || issue.governance_expected_handoff, '', 4000) || t('waitingSupervisorAction'),
            roundGoal: normalizeRuntimeSummary(issue.roundGoal || (issue.round && issue.round.goal) || issue.next_recommended_action, '', 4000) || t('waitingRuntimeSignal'),
            riskDelta: normalizeRuntimeSummary(issue.riskDelta || issue.risk_delta, '', 4000) || 'stable',
            planStatus: t('completed'),
            dispatchStatus: progress >= 30 ? t('completed') : t('waiting'),
            devStatus: reviewActive ? t('completed') : t('running'),
            reviewStatus: reviewActive ? t('running') : t('waiting'),
            reviewDeliveryStatus: reviewActive ? 'running' : 'waiting for review',
            emptyChildQueueLabel: t('noChildQueue'),
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
        function signalPill(label, tone) {
          return '<span class="signal-pill ' + escapeHtml(tone || '') + '">' + escapeHtml(label) + '</span>';
        }
        function signalRow(label, title, copy, tone) {
          return '<div class="signal-row ' + escapeHtml(tone || '') + '"><b class="signal-key">' + escapeHtml(label) + '</b><div><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(copy) + '</span></div></div>';
        }
        function setHeroExpanded(expanded) {
          state.heroExpanded = !!expanded;
          el.hero.classList.toggle('collapsed', !state.heroExpanded);
          el.hero.classList.toggle('expanded', state.heroExpanded);
          el.hero.setAttribute('aria-expanded', state.heroExpanded ? 'true' : 'false');
        }
        function progressRailGradient(issue) {
          if (isCompletedIssue(issue)) {
            return 'linear-gradient(90deg, #56e39f 0%, #1ea967 100%)';
          }
          if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
            return 'linear-gradient(90deg, #56e39f 0%, #6bb4ff 60%, #6e6bff 100%)';
          }
          if (issue.session || issue.orchestrator_state === 'dev_running') {
            return 'linear-gradient(90deg, #56e39f 0%, #6bb4ff 100%)';
          }
          return 'linear-gradient(90deg, #56e39f 0%, #56e39f 100%)';
        }
        function latestChangedFile(issue, diffFiles) {
          const files = issue && issue.session && Array.isArray(issue.session.recent_files) ? issue.session.recent_files.slice() : [];
          const candidate = files
            .filter((item) => item && item.operation !== 'read')
            .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')))[0];
          if (candidate) {
            return {
              path: readablePath(candidate.path),
              timestamp: candidate.timestamp || null,
            };
          }
          const diffFile = Array.isArray(diffFiles) ? diffFiles[0] : null;
          return diffFile ? { path: diffFile.path, timestamp: diffFile.timestamp || null } : null;
        }
        function renderOverviewSignal(issue) {
          const presentation = getPresentation(issue);
          const diffFiles = presentation.diffFiles || [];
          const latestFile = latestChangedFile(issue, diffFiles);
          const latestFeed = (presentation.activityFeed || [])[0] || null;
          const evidence = issue.evidence_summary || null;
          const missing = Array.isArray(issue.missing_requirements) ? issue.missing_requirements : [];
          const total = evidence ? Number(evidence.total_requirements || 0) : Math.max(missing.length, diffFiles.length ? 1 : 0);
          const satisfied = evidence ? Number(evidence.satisfied || 0) : Math.max(0, total - missing.length);
          const changedLabel = diffFiles.length
            ? '+' + String(diffFiles.length) + ' files'
            : t('noCodeChanges');
          const latestTitle = latestFile
            ? (isEnglish()
                ? [(latestFile.timestamp ? shortTime(latestFile.timestamp) : ''), 'edited ' + fileDisplayName(latestFile.path)].filter(Boolean).join(' · ')
                : [(latestFile.timestamp ? shortTime(latestFile.timestamp) : ''), '改了 ' + fileDisplayName(latestFile.path)].filter(Boolean).join(' · '))
            : (latestFeed ? latestFeed.summary : t('waitingSignal'));
          const latestCopy = latestFile
            ? (isEnglish()
                ? 'This round includes real code changes, not just analysis.'
                : '这轮有真实代码改动，不是停留在分析。')
            : (latestFeed ? latestFeed.detail || latestFeed.status || t('waitingSignal') : t('waitingSignal'));
          const nowTitle = compactText(
            presentation.mode === 'completed'
              ? t('closedSummary')
              : ((issue.session && issue.session.last_message)
                || (issue.phase === 'REVIEW' ? t('reviewRunning') : t('devRunning'))),
            120,
          ) || presentation.stateLabel;
          const nextTitle = compactText(presentation.nextRecommendation, 120) || t('waitingSupervisorAction');
          const nextCopy = isCompletedIssue(issue)
            ? t('doneNoPr')
            : (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running')
              ? (isEnglish() ? 'Review is the next visible step.' : '下一步会先产出 review 结果。')
              : (isEnglish() ? 'The next visible signal will come from review or delivery.' : '接下来会先等 review 或 delivery 信号。');
          const pillTone = presentation.mode === 'completed'
            ? 'green'
            : presentation.stateTone === 'yellow'
              ? 'yellow'
              : 'green';
          el.signalStateBadge.className = 'chip ' + escapeHtml(pillTone);
          el.signalStateBadge.textContent = presentation.mode === 'completed' ? t('completed') : t('runningShort');
          el.signalPills.innerHTML = [
            signalPill(presentation.mode === 'completed' ? t('completed') : t('runningShort'), pillTone),
            signalPill(runtimeProgressLabel(issue, presentation.progress), presentation.mode === 'completed' ? 'green' : (issue.phase === 'REVIEW' ? 'blue' : 'yellow')),
            diffFiles.length ? signalPill(changedLabel, 'blue') : '',
          ].filter(Boolean).join('');
          el.overviewSignal.innerHTML = [
          signalRow(
            t('nowLabel'),
            nowTitle,
            presentation.mode === 'completed'
              ? (isEnglish() ? 'Delivery has closed cleanly.' : '交付已经闭环，可以放心回看。')
              : (isEnglish() ? 'The task is actively moving forward.' : '任务正在推进，关键状态保持可见。'),
            pillTone,
          ),
            signalRow(t('latestLabel'), latestTitle, latestCopy, 'blue'),
            signalRow(t('nextLabel'), nextTitle, nextCopy, presentation.mode === 'completed' ? 'green' : 'yellow'),
          ].join('');
          el.signalAcceptanceTitle.textContent = t('acceptanceSummary', { passed: satisfied, total: total || 0 });
          el.signalAcceptanceCopy.textContent = presentation.mode === 'completed'
            ? t('closedSummary')
            : (missing.length
                ? (isEnglish() ? 'Review summary or delivery evidence is still pending.' : '目前还差 review summary 或 delivery evidence。')
                : t('validating'));
          const firstStop = total > 0 ? Math.round(Math.max(0, Math.min(100, (satisfied / total) * 100))) : 0;
          const secondStop = total > 0 ? Math.round(Math.max(firstStop, Math.min(100, ((satisfied + 1) / total) * 100))) : firstStop;
          el.signalAcceptanceTrack.style.setProperty('--accept-a', firstStop + '%');
          el.signalAcceptanceTrack.style.setProperty('--accept-b', secondStop + '%');
        }
        function setActiveTab(tab) {
          state.activeTab = tab || 'overview';
          tabButtons.forEach((button) => {
            const active = button.getAttribute('data-tab') === state.activeTab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
          });
          tabPanels.forEach((panel) => {
            panel.classList.toggle('active', panel.id === 'tab-' + state.activeTab);
          });
          if (state.activeTab !== 'changes') {
            closeDiffDrawer();
          }
        }
        function renderHero(issue) {
          const presentation = getPresentation(issue);
          const identifier = issue.identifier || issueId;
          const rawTitle = issue.title || 'Issue';
          let displayTitle = String(rawTitle);
          if (displayTitle.indexOf(identifier) === 0) {
            displayTitle = displayTitle.slice(identifier.length).replace(/^\\s*[·:-]?\\s*/, '') || String(rawTitle);
          }
          document.body.classList.toggle('is-completed', presentation.mode === 'completed');
          setHeroExpanded(state.heroExpanded);
          el.issueEyebrow.textContent = identifier;
          el.issueTitle.textContent = displayTitle;
          el.repoLine.innerHTML = githubMark() + '<span>' + escapeHtml(t('repository')) + '</span><span class="repo-name">' + escapeHtml(issue.github_repo || 'repo pending') + '</span>';
          const child = issue.governance_current_child || (Array.isArray(issue.governance_child_queue) ? issue.governance_child_queue.find((item) => item.queue_state === 'current') : null);
          el.statusLine.innerHTML = [
            chip(presentation.stateLabel, presentation.stateTone),
            chip(issue.active_pr_number ? 'PR #' + issue.active_pr_number : t('prPending'), 'blue'),
            chip(issue.branch_name || (child && child.issue_identifier) || t('rootIssue'), 'blue')
          ].join('');
          const progress = presentation.progress;
          el.progressValue.textContent = progress + '%';
          el.progressFill.style.width = Math.max(0, Math.min(100, progress)) + '%';
          el.progressFill.style.background = progressRailGradient(issue);
          if (el.progressSteps) {
            const completed = isCompletedIssue(issue);
            const reviewActive = issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running';
            const steps = Array.from(el.progressSteps.querySelectorAll('.progress-step'));
            const states = completed
              ? ['done', 'done', 'done', 'done']
              : reviewActive
                ? ['done', 'done', 'active', '']
                : (issue.session || issue.orchestrator_state === 'dev_running')
                  ? ['done', 'active', '', '']
                  : ['active', '', '', ''];
            steps.forEach((step, index) => {
              step.className = 'progress-step ' + states[index];
            });
          }
          renderExpandableText(el.judgmentCopy, presentation.judgmentSummary, '', 180);
          renderExpandableText(el.nextCopy, presentation.nextRecommendation, '', 180);
          el.rootLabel.textContent = 'Root: ' + (issue.governance_root_issue_identifier || identifier);
        }
        function renderRound(issue) {
          const presentation = getPresentation(issue);
          const round = issue.round || { index: 1, total: 1, goal: t('waitingRuntimeSignal') };
          el.complexityChip.textContent = (issue.complexity || 'L?') + ' · Round ' + round.index + '/' + round.total;
          renderExpandableText(el.roundGoal, presentation.roundGoal, t('waitingRound'), 180);
          renderExpandableText(el.riskDelta, 'riskDelta · ' + presentation.riskDelta, 'riskDelta · stable', 160);
        }
        function renderStages(issue) {
          const presentation = getPresentation(issue);
          const progress = presentation.progress;
          const completed = isCompletedIssue(issue);
          const reviewActive = issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running';
          const stages = [
            ['Plan', 100, '#56e39f', presentation.planStatus],
            ['Dispatch', progress >= 30 ? 100 : 0, '#56e39f', presentation.dispatchStatus],
            ['Dev', reviewActive || completed ? 100 : Math.min(100, Math.max(0, progress)), reviewActive || completed ? '#56e39f' : '#6bb4ff', presentation.devStatus],
            ['Review', completed ? 100 : reviewActive ? Math.min(100, progress) : 0, completed ? '#56e39f' : reviewActive ? '#6bb4ff' : '#c9d5e1', presentation.reviewStatus]
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
            el.timelineList.innerHTML = '<div class="loading">' + escapeHtml(t('waitingEvents')) + '</div>';
            return;
          }
          el.timelineList.innerHTML = items.map((item) => (
            '<article class="event"><time class="event-time">' + escapeHtml(shortTime(item.timestamp)) + '</time><span class="event-node"></span><div><h3>' + escapeHtml(item.category === 'tool' ? summarizeToolActivity({ tool_name: item.tool_name || 'Tool', status: item.code === 'tool_started' ? 'started' : 'completed', message: item.message || '', summary: null, path: item.detail && item.detail.path || null, timestamp: item.timestamp || '' }, titleCaseToolName(item.tool_name || 'Tool')) : compactText(item.message || item.code || 'runtime event', 90)) + '</h3><p>' + escapeHtml([item.tool_name, item.category, item.level].filter(Boolean).join(' · ')) + '</p></div><span class="mini-badge">✓</span></article>'
          )).join('');
        }
        function renderFiles(issue) {
          const files = issue.session && Array.isArray(issue.session.recent_files) ? issue.session.recent_files.slice(0, 5) : [];
          if (!files.length) {
            el.fileList.innerHTML = '<p class="panel-copy">' + escapeHtml(t('noFileActivity')) + '</p>';
            return;
          }
          el.fileList.innerHTML = files.map((file) => (
            '<div class="file-row"><div><strong>' + escapeHtml(fileDisplayName(file.path)) + '</strong><span>' + escapeHtml(humanFileOperation(file.operation)) + ' · ' + escapeHtml(shortTime(file.timestamp)) + '</span></div><b class="mini-badge ' + escapeHtml(feedToneFromStatus(file.status)) + '">' + escapeHtml((file.operation || 'M').slice(0, 1).toUpperCase()) + '</b></div>'
          )).join('');
        }
        function formatDiffHunkHeader(line) {
          const match = String(line || '').match(/^@@\\s+-(\\d+)(?:,(\\d+))?\\s+\\+(\\d+)(?:,(\\d+))?\\s+@@/);
          if (!match) return compactText(String(line || '').trim(), 72);
          function lineRange(startValue, countValue) {
            const start = Number(startValue || 0);
            const count = Number(countValue || 1);
            if (!start || count <= 1) return String(start);
            return String(start) + '-' + String(start + count - 1);
          }
          return (isEnglish() ? 'Hunk ' : '片段 ')
            + lineRange(match[1], match[2])
            + ' -> '
            + lineRange(match[3], match[4]);
        }
        function renderDiffDrawerDetail(detail, mode) {
          const raw = String(detail || t('noDiffDetail'));
          if (mode === 'summary') {
            return raw
              .split(/\\n+/)
              .map((line) => String(line || '').replace(/^\\s*#+\\s*/, '').trim())
              .filter(Boolean)
              .map((line) => '<span class="diff-drawer-line meta">' + escapeHtml(line) + '</span>')
              .join('');
          }
          return raw.split(/\\n/).map((line) => {
            if (/^diff --git /.test(line) || /^index /.test(line) || /^--- /.test(line) || /^\\+\\+\\+ /.test(line)) {
              return '';
            }
            if (/^@@ /.test(line)) {
              return '<span class="diff-drawer-line hunk">' + escapeHtml(formatDiffHunkHeader(line)) + '</span>';
            }
            if (/^\\\\ No newline at end of file$/.test(line)) {
              return '<span class="diff-drawer-line meta">' + escapeHtml(isEnglish() ? 'No newline at end of file' : '文件结尾没有换行') + '</span>';
            }
            const tone = /^\\+/.test(line)
              ? ' add'
              : /^-/.test(line)
                ? ' del'
                : /^[|]/.test(line)
                  ? ' meta'
                  : ' context';
            return '<span class="diff-drawer-line' + tone + '">' + escapeHtml(line || ' ') + '</span>';
          }).filter(Boolean).join('');
        }
        function diffLineCounts(detail) {
          return String(detail || '').split(/\\n/).reduce((acc, line) => {
            if (/^\\+(?!\\+\\+)/.test(line)) acc.additions += 1;
            if (/^-(?!--)/.test(line)) acc.deletions += 1;
            return acc;
          }, { additions: 0, deletions: 0 });
        }
        function renderDiffStatMarkup(stats) {
          if (!stats || (stats.additions == null && stats.deletions == null)) {
            return '';
          }
          const additions = Number(stats.additions || 0);
          const deletions = Number(stats.deletions || 0);
          return '<span class="diff-stat-token add">+' + String(additions) + '</span><span class="diff-stat-token del">-' + String(deletions) + '</span>';
        }
        function pathHeaderLine(line) {
          const match = String(line || '').match(/^\\s*\`?([^\`|]+?)\`?\\s*\\|\\s*(?:[^|]+?)(?:\\|\\s*[^|]+)?(?:\\||$)/);
          return match ? readablePath(match[1]) : '';
        }
        function extractDiffDetailForPath(history, path) {
          if (!path) return null;
          for (const source of changeTextSourcesFromHistory(history)) {
            const lines = String(source || '').split(/\\n/).map((line) => line.replace(/\\s+$/g, ''));
            const divider = lines.findIndex((line) => !String(line).trim());
            const statLines = divider >= 0 ? lines.slice(0, divider) : lines.slice();
            const hunkLines = divider >= 0 ? lines.slice(divider + 1).filter((line) => String(line).trim()) : [];
            const statIndex = statLines.findIndex((line) => pathHeaderLine(line) === path);
            if (statIndex >= 0) {
              const statLine = statLines[statIndex].trim();
              if (statIndex === 0 && hunkLines.some((line) => /^[+-]/.test(line))) {
                return [statLine, ''].concat(hunkLines.slice(0, 18)).join('\\n');
              }
              return statLine;
            }
            const matchingLine = lines.find((line) => String(line).indexOf(path) >= 0);
            if (matchingLine) return matchingLine.trim();
          }
          return null;
        }
        function diffDetailForFile(file, stats) {
          const path = readablePath(file && file.path || '');
          const workspaceDiff = historyFileDiffForPath(state.history, path);
          if (workspaceDiff && typeof workspaceDiff.patch === 'string' && workspaceDiff.patch.trim()) {
            return {
              text: workspaceDiff.patch.trim(),
              mode: 'full',
              isExcerpt: false,
              noteKey: 'diffExcerptNote'
            };
          }
          const candidates = [];
          [file && file.detail, file && file.summary].forEach((value) => {
            if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
          });
          const extracted = extractDiffDetailForPath(state.history, path);
          if (extracted) candidates.push(extracted);
          const best = candidates.sort((left, right) => right.length - left.length)[0];
          const text = best || t('noDiffDetail');
          const counts = diffLineCounts(text);
          const additions = stats && stats.additions != null ? Number(stats.additions || 0) : null;
          const deletions = stats && stats.deletions != null ? Number(stats.deletions || 0) : null;
          const hasAnyShownLines = counts.additions > 0 || counts.deletions > 0;
          const isExcerpt = additions != null && deletions != null
            ? counts.additions < additions || counts.deletions < deletions
            : !hasAnyShownLines;
          const noteKey = hasAnyShownLines ? 'diffExcerptNote' : 'diffSummaryOnlyNote';
          return {
            text,
            mode: hasAnyShownLines ? 'excerpt' : 'summary',
            isExcerpt,
            noteKey
          };
        }
        function closeDiffDrawer() {
          el.diffDrawer.hidden = true;
          el.diffDrawer.setAttribute('aria-hidden', 'true');
          el.diffDrawerBackdrop.hidden = true;
        }
        function openDiffDrawer(index) {
          const file = state.renderedDiffFiles[index];
          if (!file) return;
          el.diffDrawerTitle.textContent = file.path || 'diff';
          el.diffDrawerReason.textContent = file.summary || t('noDiffDetail');
          el.diffDrawerStat.hidden = !file.statsMarkup;
          el.diffDrawerStat.innerHTML = file.statsMarkup || '';
          el.diffDrawerStat.className = 'diff-stat-summary';
          el.diffDrawerBadge.className = 'chip ' + (file.tone || 'blue');
          el.diffDrawerBadge.textContent = file.badge || 'M';
          el.diffDrawerNote.hidden = !file.drawerIsExcerpt;
          el.diffDrawerNote.textContent = file.drawerIsExcerpt ? t(file.drawerNoteKey || 'diffExcerptNote') : '';
          el.diffDrawerDetail.innerHTML = renderDiffDrawerDetail(file.drawerDetail, file.drawerMode);
          el.diffDrawer.hidden = false;
          el.diffDrawer.setAttribute('aria-hidden', 'false');
          el.diffDrawerBackdrop.hidden = false;
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
          state.renderedDiffFiles = [];
          if (!uniqueFiles.length) {
            closeDiffDrawer();
            el.diffList.innerHTML = '<p class="panel-copy">' + escapeHtml(t('noCodeChanges')) + '</p>';
            return;
          }
          function diffStatLabel(file) {
            const stats = (file.additions != null || file.deletions != null) ? file : diffStatsForPath(state.history, file.path);
            if (stats && (stats.additions != null || stats.deletions != null)) {
              return '+' + String(stats.additions || 0) + ' -' + String(stats.deletions || 0);
            }
            return '';
          }
          state.renderedDiffFiles = uniqueFiles.map((file) => {
            const stats = (file.additions != null || file.deletions != null) ? file : diffStatsForPath(state.history, file.path);
            const statsLabel = diffStatLabel(file);
            const statsMarkup = renderDiffStatMarkup(stats);
            const detail = diffDetailForFile(file, stats);
            return Object.assign({}, file, {
              statsLabel,
              statsMarkup,
              drawerDetail: detail.text,
              drawerMode: detail.mode,
              drawerIsExcerpt: detail.isExcerpt,
              drawerNoteKey: detail.noteKey
            });
          });
          el.diffList.innerHTML = state.renderedDiffFiles.map((file, index) => (
            '<div class="diff-row"><div><strong>' + escapeHtml(file.path) + '</strong><span>' + (file.statsMarkup ? ('<span class="diff-row-stats"><span class="diff-stat-summary">' + file.statsMarkup + '</span></span><span class="diff-row-separator"> · </span>') : '') + escapeHtml(t('reason')) + ': ' + expandableCopy(file.summary || 'modified', 'modified', 130) + '</span><button class="diff-open-button" type="button" data-diff-open="' + String(index) + '">' + escapeHtml(file.drawerMode === 'full' ? t('diffDetails') : t('diffSummary')) + '</button></div><b class="diff-stat ' + escapeHtml(file.tone || '') + '">' + escapeHtml(file.badge) + '</b></div>'
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
            el.agentList.innerHTML = '<p class="panel-copy">' + escapeHtml(t('noAgentProgress')) + '</p>';
            return;
          }
          el.agentList.innerHTML = items.slice(0, 6).map((item) => (
            '<div class="agent-row"><div><strong>' + escapeHtml(item.agent + ' · ' + (item.status || 'running')) + '</strong><span>' + expandableCopy(findExpandedHistoryText(item.summary), 'progress', 180) + '</span></div><b class="mini-badge">' + escapeHtml(item.agent.slice(0, 1)) + '</b></div>'
          )).join('');
        }
        function renderMilestones(issue) {
          const milestones = getPresentation(issue).visibleMilestones;
          if (!milestones.length) {
            el.milestoneList.innerHTML = '<p class="panel-copy">' + escapeHtml(t('noMilestones')) + '</p>';
            return;
          }
          el.milestoneList.innerHTML = milestones.map((item) => (
            '<div class="milestone-row"><div><strong>' + escapeHtml(item.kind || 'milestone') + '</strong><span>' + expandableCopy(item.summary || item.key, 'recorded', 180) + '</span></div><span>' + escapeHtml(shortTime(item.timestamp)) + '</span></div>'
          )).join('');
        }
        function renderDelivery(issue) {
          const presentation = getPresentation(issue);
          const completed = isCompletedIssue(issue);
          const rows = completed
            ? [
                [isEnglish() ? 'Review approved' : 'Review 已批准', presentation.reviewDeliveryStatus],
                [isEnglish() ? 'CI passed' : 'CI 已通过', issue.evidence_summary ? String(issue.evidence_summary.satisfied) + '/' + String(issue.evidence_summary.total_requirements) : 'checks'],
                [isEnglish() ? 'Merged to main' : '已合并到 main', issue.active_pr_number ? 'PR #' + issue.active_pr_number : 'done']
              ]
            : [
                ['PR', issue.active_pr_number ? '#' + issue.active_pr_number : 'pending'],
                ['Review', presentation.reviewDeliveryStatus],
                ['Linear', issue.tracker_state || 'In Progress'],
                [t('restore'), isRetryableDeliveryFailure(issue) ? t('restorable') : t('noRestore')]
              ];
          el.deliveryList.innerHTML = rows.map(([label, value]) => (
            '<div class="delivery-row"><div><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(value) + '</span></div>' + chip(completed ? '✓' : '›', completed ? 'green' : '') + '</div>'
          )).join('');
          renderExpandableText(el.deliverySummary, issue.delivery_summary || presentation.judgmentSummary, t('waitingDelivery'), 220);
          if (issue.github_repo && issue.active_pr_number) {
            el.prLink.href = 'https://github.com/' + issue.github_repo + '/pull/' + issue.active_pr_number;
            el.prLink.classList.remove('disabled');
            el.prLink.textContent = t('viewPr');
          } else {
            el.prLink.href = '#';
            el.prLink.classList.add('disabled');
            el.prLink.textContent = t('prPending');
          }
        }
        function renderAcceptance(issue) {
          const missing = Array.isArray(issue.missing_requirements) ? issue.missing_requirements : [];
          const evidence = issue.evidence_summary || null;
          const satisfied = evidence ? String(evidence.satisfied) + '/' + String(evidence.total_requirements) : '0/0';
          const rows = missing.length
            ? missing.map((item) => [item.label || item.id || t('missingRequirement'), item.status || 'missing'])
            : [[t('acceptanceProgress'), satisfied], [t('status'), isCompletedIssue(issue) ? t('completed') : t('validating')]];
          el.acceptanceList.innerHTML = rows.map(([label, value]) => (
            '<div class="delivery-row"><div><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(value) + '</span></div>' + chip(String(value).toLowerCase().includes('missing') ? '待补' : '✓', String(value).toLowerCase().includes('missing') ? 'yellow' : 'green') + '</div>'
          )).join('');
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
          renderExpandableText(el.historyDigest, digest.detail || digest.history_blurb, t('noHistory'), 220);
          if (!entries.length) {
            el.historyEntryList.innerHTML = '<p class="panel-copy" style="margin-top:12px">' + escapeHtml(t('noCheckpoints')) + '</p>';
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
            setRuntimeAction(el.pauseButton, 'history', t('completed'), 'success');
            setRuntimeAction(el.requestButton, 'request', t('addRequirement'), 'primary');
            setRuntimeAction(el.backButton, 'back', t('backTelegram'), '');
            return;
          }
          if (isRetryableDeliveryFailure(issue)) {
            setRuntimeAction(el.pauseButton, 'retry', t('retryDelivery'), 'primary');
            setRuntimeAction(el.requestButton, 'request', t('addRequirement'), 'primary');
            setRuntimeAction(el.backButton, 'back', t('backTelegram'), '');
            return;
          }
          setRuntimeAction(el.pauseButton, 'pause', t('pause'), 'danger');
          setRuntimeAction(el.requestButton, 'request', t('addRequirement'), 'primary');
          setRuntimeAction(el.backButton, 'back', t('backTelegram'), '');
        }
        function render() {
          if (!state.issue) return;
          applyPreferences();
          renderHero(state.issue);
          renderOverviewSignal(state.issue);
          renderRound(state.issue);
          renderStages(state.issue);
          renderTimeline();
          renderFiles(state.issue);
          renderDiff(state.issue);
          renderAgents(state.issue);
          renderMilestones(state.issue);
          renderDelivery(state.issue);
          renderAcceptance(state.issue);
          renderChildren(state.issue);
          renderActions(state.issue);
          setActiveTab(state.activeTab);
        }
        async function load() {
          const [issue, timeline, history] = await Promise.all([
            fetchJson(urls.issue),
            fetchJson(urls.timeline),
            fetchJson(urls.history)
          ]);
          state.issue = issue;
          applyIssueDefaultLanguage(issue);
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
          renderExpandableText(el.nextCopy, result.message, isEnglish() ? 'Recovery action submitted.' : '恢复动作已提交。', 180);
          await load();
        }
        document.addEventListener('click', (event) => {
          const button = event.target && event.target.closest ? event.target.closest('button') : null;
          if (!button) return;
          if (button.classList.contains('expand-button')) {
            toggleExpandedText(button);
            return;
          }
          if (button.classList.contains('diff-open-button')) {
            openDiffDrawer(Number(button.getAttribute('data-diff-open') || '-1'));
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
              button.textContent = t('retrying');
              if (tg && tg.HapticFeedback) {
                tg.HapticFeedback.impactOccurred('medium');
              }
              postRuntimeIssueAction('retry').catch((error) => {
                button.disabled = false;
                button.textContent = t('retryDelivery');
                if (tg) {
                  tg.showAlert(error.message || t('retryFailed'));
                } else {
                  el.nextCopy.textContent = error.message || t('retryFailed');
                }
              });
            }
            if (action === 'pause' && tg) {
              tg.HapticFeedback && tg.HapticFeedback.impactOccurred('medium');
              tg.showAlert(t('pauseHint'));
            }
            if (action === 'request' && tg) {
              tg.showAlert(t('requestHint'));
            }
          });
        });
        tabButtons.forEach((button) => {
          button.addEventListener('click', () => {
            setActiveTab(button.getAttribute('data-tab'));
          });
        });
        el.hero.addEventListener('click', () => {
          setHeroExpanded(!state.heroExpanded);
        });
        el.hero.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setHeroExpanded(!state.heroExpanded);
          }
        });
        el.themeToggle.addEventListener('click', (event) => {
          event.preventDefault();
          state.theme = state.theme === 'light' ? 'dark' : 'light';
          applyPreferences();
        });
        el.languageToggle.addEventListener('click', (event) => {
          event.preventDefault();
          state.lang = state.lang === 'en' ? 'zh' : 'en';
          applyPreferences();
          render();
        });
        el.historyCloseButton.addEventListener('click', () => {
          el.historyPanel.hidden = true;
        });
        el.diffDrawerCloseButton.addEventListener('click', () => {
          closeDiffDrawer();
        });
        el.diffDrawerBackdrop.addEventListener('click', () => {
          closeDiffDrawer();
        });
        applyPreferences();
        load().then(openStream).catch((error) => {
          el.timelineList.innerHTML = '<div class="loading">' + escapeHtml(error.message || 'Load failed') + '</div>';
        });
      })();
    </script>
  </body>
</html>`;
}
