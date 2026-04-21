import { describe, expect, test } from 'bun:test';
import {
  consumeTimelineEventForCli,
  createCliTimelineRenderState,
  flushCliTimelineState,
  formatTimelineEventForCli,
  shouldLogStructuredAgentEvent,
} from './timeline';
import type { AgentEvent } from '../types';

describe('CLI timeline formatting', () => {
  test('returns the user-facing message for timeline events', () => {
    const formatted = formatTimelineEventForCli({
      event: 'timeline',
      timestamp: new Date(),
      codex_app_server_pid: '123',
      payload: {
        level: 'info',
        category: 'tool',
        code: 'tool_completed',
        message: 'Bash completed',
        turn: 2,
        tool_name: 'Bash',
        detail: null,
      },
    } as AgentEvent);

    expect(formatted).toBe('Bash completed');
  });

  test('ignores non-timeline events', () => {
    const formatted = formatTimelineEventForCli({
      event: 'turn_completed',
      timestamp: new Date(),
      codex_app_server_pid: '123',
      payload: { foo: 'bar' },
    } as AgentEvent);

    expect(formatted).toBeNull();
  });

  test('suppresses structured duplicates for timeline-covered events', () => {
    expect(
      shouldLogStructuredAgentEvent({
        event: 'turn_completed',
        timestamp: new Date(),
        codex_app_server_pid: '123',
      } as AgentEvent)
    ).toBe(false);

    expect(
      shouldLogStructuredAgentEvent({
        event: 'unsupported_tool_call',
        timestamp: new Date(),
        codex_app_server_pid: '123',
      } as AgentEvent)
    ).toBe(true);
  });

  test('aggregates consecutive tool events with concise detail summaries', () => {
    const state = createCliTimelineRenderState();
    const messages = [
      {
        event: 'timeline',
        timestamp: new Date(),
        codex_app_server_pid: '123',
        payload: {
          level: 'info',
          category: 'tool',
          code: 'tool_started',
          message: 'Using Read',
          turn: 1,
          tool_name: 'Read',
          detail: { path: '/tmp/worktrees/INT-28/.symphony/HANDOVER.md' },
        },
      },
      {
        event: 'timeline',
        timestamp: new Date(),
        codex_app_server_pid: '123',
        payload: {
          level: 'info',
          category: 'tool',
          code: 'tool_started',
          message: 'Using Read',
          turn: 1,
          tool_name: 'Read',
          detail: { path: '/tmp/worktrees/INT-28/trump_news.py' },
        },
      },
      {
        event: 'timeline',
        timestamp: new Date(),
        codex_app_server_pid: '123',
        payload: {
          level: 'info',
          category: 'tool',
          code: 'tool_started',
          message: 'Using Read',
          turn: 1,
          tool_name: 'Read',
          detail: { path: '/tmp/worktrees/INT-28/test_trump_news.py' },
        },
      },
      {
        event: 'timeline',
        timestamp: new Date(),
        codex_app_server_pid: '123',
        payload: {
          level: 'info',
          category: 'turn',
          code: 'assistant_thinking',
          message: 'Claude is thinking',
          turn: 1,
          tool_name: null,
          detail: null,
        },
      },
    ] as AgentEvent[];

    const output = messages.flatMap((event) => consumeTimelineEventForCli(event, state));

    expect(output).toEqual([
      'Read ×3 · INT-28/.symphony/HANDOVER.md, worktrees/INT-28/trump_news.py, worktrees/INT-28/test_trump_news.py',
      'Claude is thinking',
    ]);
    expect(flushCliTimelineState(state)).toEqual([]);
  });

  test('formats single tool completion with richer context', () => {
    const state = createCliTimelineRenderState();
    const output = consumeTimelineEventForCli({
      event: 'timeline',
      timestamp: new Date(),
      codex_app_server_pid: '123',
      payload: {
        level: 'info',
        category: 'tool',
        code: 'tool_completed',
        message: 'Write completed',
        turn: 2,
        tool_name: 'Write',
        detail: { path: '.symphony/REVIEW_REPORT.md' },
      },
    } as AgentEvent, state);

    expect(output).toEqual([]);
    expect(flushCliTimelineState(state)).toEqual([
      'Write completed · .symphony/REVIEW_REPORT.md',
    ]);
  });
});
