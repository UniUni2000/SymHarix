import type { AgentEvent, AgentTimelinePayload } from '../types';

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isTimelinePayload(payload: AgentEvent['payload']): payload is AgentTimelinePayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  return (
    isString((payload as AgentTimelinePayload).level) &&
    isString((payload as AgentTimelinePayload).category) &&
    isString((payload as AgentTimelinePayload).code) &&
    isString((payload as AgentTimelinePayload).message)
  );
}

interface ToolAggregationState {
  code: 'tool_started' | 'tool_completed' | 'tool_failed';
  level: AgentTimelinePayload['level'];
  toolName: string;
  turn: number | null;
  count: number;
  summaries: string[];
}

export interface CliTimelineRenderState {
  pendingTool: ToolAggregationState | null;
}

function getTimelinePayload(event: AgentEvent): AgentTimelinePayload | null {
  if (event.event !== 'timeline' || !isTimelinePayload(event.payload)) {
    return null;
  }

  return event.payload;
}

function truncate(value: string, maxLength = 120): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function compactPathLikeValue(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized.includes('/')) {
    return value;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 3) {
    return normalized;
  }

  return segments.slice(-3).join('/');
}

function normalizeSummary(summary: string): string {
  const compact = compactPathLikeValue(summary.replace(/\s+/g, ' ').trim());
  return truncate(compact, 120);
}

function extractToolSummary(payload: AgentTimelinePayload): string | null {
  const detail = payload.detail;
  if (!detail || typeof detail !== 'object') {
    return null;
  }

  if (typeof detail.summary === 'string' && detail.summary.trim()) {
    return normalizeSummary(detail.summary);
  }

  if (typeof detail.path === 'string' && detail.path.trim()) {
    return normalizeSummary(detail.path);
  }

  if (typeof detail.command_preview === 'string' && detail.command_preview.trim()) {
    return truncate(detail.command_preview.replace(/\s+/g, ' ').trim(), 120);
  }

  if (typeof detail.url === 'string' && detail.url.trim()) {
    return truncate(detail.url.trim(), 120);
  }

  if (typeof detail.pattern === 'string' && detail.pattern.trim()) {
    return truncate(detail.pattern.replace(/\s+/g, ' ').trim(), 120);
  }

  return null;
}

function formatToolAggregation(state: ToolAggregationState): string {
  const base =
    state.code === 'tool_started'
      ? state.toolName
      : `${state.toolName} ${state.code === 'tool_completed' ? 'completed' : 'failed'}`;
  const countSuffix = state.count > 1 ? ` ×${state.count}` : '';
  const uniqueSummaries = Array.from(new Set(state.summaries.filter(Boolean)));

  if (uniqueSummaries.length === 0) {
    return `${base}${countSuffix}`;
  }

  const visible = uniqueSummaries.slice(0, 3);
  const remaining = uniqueSummaries.length - visible.length;
  const detail = visible.join(', ');
  const suffix = remaining > 0 ? `${detail}, +${remaining} more` : detail;
  return `${base}${countSuffix} · ${truncate(suffix, 140)}`;
}

function isToolAggregationCandidate(
  payload: AgentTimelinePayload,
): payload is AgentTimelinePayload & { tool_name: string } {
  return (
    payload.category === 'tool' &&
    (payload.code === 'tool_started' ||
      payload.code === 'tool_completed' ||
      payload.code === 'tool_failed') &&
    typeof payload.tool_name === 'string' &&
    payload.tool_name.length > 0
  );
}

export function createCliTimelineRenderState(): CliTimelineRenderState {
  return {
    pendingTool: null,
  };
}

export function flushCliTimelineState(
  state: CliTimelineRenderState,
): string[] {
  if (!state.pendingTool) {
    return [];
  }

  const message = formatToolAggregation(state.pendingTool);
  state.pendingTool = null;
  return [message];
}

export function consumeTimelineEventForCli(
  event: AgentEvent,
  state: CliTimelineRenderState,
): string[] {
  const payload = getTimelinePayload(event);
  if (!payload) {
    return [];
  }

  if (!isToolAggregationCandidate(payload)) {
    return [...flushCliTimelineState(state), payload.message];
  }

  const summary = extractToolSummary(payload);
  if (
    state.pendingTool &&
    state.pendingTool.code === payload.code &&
    state.pendingTool.toolName === payload.tool_name &&
    state.pendingTool.turn === payload.turn &&
    state.pendingTool.level === payload.level
  ) {
    state.pendingTool.count += 1;
    if (summary) {
      state.pendingTool.summaries.push(summary);
    }
    return [];
  }

  const messages = flushCliTimelineState(state);
  state.pendingTool = {
    code: payload.code,
    level: payload.level,
    toolName: payload.tool_name,
    turn: payload.turn,
    count: 1,
    summaries: summary ? [summary] : [],
  };
  return messages;
}

export function formatTimelineEventForCli(event: AgentEvent): string | null {
  const payload = getTimelinePayload(event);
  if (!payload) {
    return null;
  }

  return payload.message;
}

export function shouldLogStructuredAgentEvent(event: AgentEvent): boolean {
  return !['session_started', 'turn_completed', 'turn_failed', 'turn_cancelled', 'timeline'].includes(event.event);
}
