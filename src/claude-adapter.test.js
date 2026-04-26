const { describe, expect, test } = require('bun:test');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  buildToolResultTimelineEvents,
  collectTimelineEventsFromClaudeMessage,
  createTimelineState,
  formatTurnCompletedMessage,
  startAdapter,
} = require('../scripts/claude-adapter.cjs');

function createFakeClaudeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.kill = () => true;
  return child;
}

function createJsonCollector(stream) {
  let buffer = '';
  const messages = [];
  const waiters = [];

  function flushWaiters() {
    for (let index = 0; index < waiters.length; ) {
      const waiter = waiters[index];
      const matchIndex = messages.findIndex(waiter.predicate);
      if (matchIndex === -1) {
        index += 1;
        continue;
      }

      const [message] = messages.splice(matchIndex, 1);
      waiters.splice(index, 1);
      waiter.resolve(message);
    }
  }

  stream.on('data', (chunk) => {
    buffer += chunk.toString();

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        messages.push(JSON.parse(line));
        flushWaiters();
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });

  return {
    waitFor(predicate) {
      const matchIndex = messages.findIndex(predicate);
      if (matchIndex !== -1) {
        const [message] = messages.splice(matchIndex, 1);
        return Promise.resolve(message);
      }

      return new Promise((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
  };
}

describe('claude-adapter timeline helpers', () => {
  test('collapses repeated assistant activity into one thinking event per turn', () => {
    const state = createTimelineState();
    const messages = [
      { type: 'user' },
      { type: 'assistant' },
      { type: 'assistant' },
      { type: 'text_delta', text: 'hello' },
    ];

    const events = messages.flatMap((message) =>
      collectTimelineEventsFromClaudeMessage(message, { turn: 3, timelineState: state }).events
    );

    expect(events.map((event) => event.params.code)).toEqual(['assistant_thinking']);
  });

  test('emits tool started for tool_use messages', () => {
    const state = createTimelineState();
    const message = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }],
      },
    };

    const events = collectTimelineEventsFromClaudeMessage(message, { turn: 4, timelineState: state }).events;

    expect(events.map((event) => event.params.code)).toEqual(['assistant_thinking', 'tool_started']);
    expect(events[1].params.message).toBe('Using Bash');
  });

  test('emits rate limit retry timeline events', () => {
    const state = createTimelineState();
    const message = { type: 'system', subtype: 'api_retry', attempt: 2, retry_delay_ms: 2500 };

    const events = collectTimelineEventsFromClaudeMessage(message, { turn: 1, timelineState: state }).events;

    expect(events).toHaveLength(1);
    expect(events[0].params.code).toBe('rate_limit_retry');
    expect(events[0].params.message).toBe('Rate limit hit · retrying in 3s');
  });

  test('builds tool completed events for successful tool results', () => {
    const events = buildToolResultTimelineEvents({
      toolName: 'Bash',
      failed: false,
      resultText: 'ok',
      turn: 2,
      toolInput: {},
    });

    expect(events).toHaveLength(1);
    expect(events[0].params.code).toBe('tool_completed');
    expect(events[0].params.message).toBe('Bash completed');
  });

  test('builds todo updated events for TodoWrite results', () => {
    const events = buildToolResultTimelineEvents({
      toolName: 'TodoWrite',
      failed: false,
      resultText: 'updated',
      turn: 2,
      toolInput: { todos: [{ content: 'a' }, { content: 'b' }] },
    });

    expect(events).toHaveLength(1);
    expect(events[0].params.code).toBe('todo_updated');
    expect(events[0].params.message).toBe('Updated todo list (2 items)');
  });

  test('formats turn completion summaries for user-facing logs', () => {
    const message = formatTurnCompletedMessage(3, { input: 1200, output: 400, total: 1600 });
    expect(message).toBe('Turn 3 completed · in 1.2k / out 400');
  });

  test('does not complete a turn on assistant thinking or tool_use messages before the final result', async () => {
    const originalSpawn = childProcess.spawn;
    const originalExit = process.exit;
    const fakeClaude = createFakeClaudeProcess();
    const adapterIn = new PassThrough();
    const adapterOut = new PassThrough();
    const adapterErr = new PassThrough();
    const adapterCollector = createJsonCollector(adapterOut);
    let runtime;
    let emittedTurnCompleted = false;

    childProcess.spawn = () => fakeClaude;
    process.exit = () => {};

    try {
      runtime = startAdapter({
        env: { ...process.env, SYMPHONY_ADAPTER_DEBUG: '0' },
        stdin: adapterIn,
        stdout: adapterOut,
        stderr: adapterErr,
      });

      adapterOut.on('data', (chunk) => {
        const text = chunk.toString();
        if (text.includes('"method":"turn/completed"')) {
          emittedTurnCompleted = true;
        }
      });

      adapterIn.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`);
      await adapterCollector.waitFor((message) => message.id === 1);

      adapterIn.write(`${JSON.stringify({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } })}\n`);
      await adapterCollector.waitFor((message) => message.id === 2);

      adapterIn.write(`${JSON.stringify({
        id: 3,
        method: 'turn/start',
        params: {
          input: [{ type: 'text', text: 'Use TodoWrite then finish.' }],
        },
      })}\n`);
      await adapterCollector.waitFor((message) => message.id === 3);

      fakeClaude.stdout.write(`${JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'planning' }],
          usage: { input_tokens: 110, output_tokens: 0 },
        },
      })}\n`);

      fakeClaude.stdout.write(`${JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'TodoWrite', input: { todos: [] } }],
          usage: { input_tokens: 110, output_tokens: 0 },
        },
      })}\n`);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(emittedTurnCompleted).toBe(false);

      fakeClaude.stdout.write(`${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
        },
      })}\n`);
      fakeClaude.stdout.write(`${JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'DONE' }],
          usage: { input_tokens: 2298, output_tokens: 0 },
        },
      })}\n`);
      fakeClaude.stdout.write(`${JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 2,
        usage: { input_tokens: 2408, output_tokens: 91 },
      })}\n`);

      const turnCompleted = await adapterCollector.waitFor(
        (message) => message.method === 'turn/completed',
      );
      expect(turnCompleted.result.turn.api_calls).toBe(2);
      expect(turnCompleted.result.turn.tokens).toEqual({
        input: 2408,
        output: 91,
        total: 2499,
      });
    } finally {
      runtime?.rl.close();
      childProcess.spawn = originalSpawn;
      process.exit = originalExit;
    }
  });

  test('forwards can_use_tool control requests to the runner and returns control responses to Claude', async () => {
    const originalSpawn = childProcess.spawn;
    const originalExit = process.exit;
    const fakeClaude = createFakeClaudeProcess();
    const adapterIn = new PassThrough();
    const adapterOut = new PassThrough();
    const adapterErr = new PassThrough();
    const adapterCollector = createJsonCollector(adapterOut);
    const claudeCollector = createJsonCollector(fakeClaude.stdin);
    let runtime;

    childProcess.spawn = () => fakeClaude;
    process.exit = () => {};

    try {
      runtime = startAdapter({
        env: { ...process.env, SYMPHONY_ADAPTER_DEBUG: '0' },
        stdin: adapterIn,
        stdout: adapterOut,
        stderr: adapterErr,
      });

      adapterIn.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`);
      await adapterCollector.waitFor((message) => message.id === 1);

      adapterIn.write(`${JSON.stringify({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } })}\n`);
      await adapterCollector.waitFor((message) => message.id === 2);

      adapterIn.write(`${JSON.stringify({
        id: 3,
        method: 'turn/start',
        params: {
          input: [{ type: 'text', text: 'hello' }],
        },
      })}\n`);
      await adapterCollector.waitFor((message) => message.id === 3);
      await claudeCollector.waitFor((message) => message.type === 'user');

      fakeClaude.stdout.write(`${JSON.stringify({
        type: 'control_request',
        request_id: 'cc-request-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'tool-1',
          title: 'Use Bash',
          input: { command: 'pwd' },
        },
      })}\n`);

      const approvalRequest = await adapterCollector.waitFor(
        (message) => message.method === 'approval/request',
      );
      expect(approvalRequest.params.request.tool_name).toBe('Bash');

      adapterIn.write(`${JSON.stringify({
        id: approvalRequest.id,
        result: {
          behavior: 'allow',
          updatedInput: { command: 'pwd' },
          toolUseID: 'tool-1',
        },
      })}\n`);

      const controlResponse = await claudeCollector.waitFor(
        (message) => message.type === 'control_response',
      );
      expect(controlResponse.response.subtype).toBe('success');
      expect(controlResponse.response.request_id).toBe('cc-request-1');
      expect(controlResponse.response.response.behavior).toBe('allow');

      fakeClaude.stdout.write(`${JSON.stringify({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 2, output_tokens: 1 },
      })}\n`);
      await adapterCollector.waitFor((message) => message.method === 'turn/completed');
    } finally {
      runtime?.rl.close();
      childProcess.spawn = originalSpawn;
      process.exit = originalExit;
    }
  });

  test('forwards elicitation requests to the runner and sends accepted content back to Claude', async () => {
    const originalSpawn = childProcess.spawn;
    const originalExit = process.exit;
    const fakeClaude = createFakeClaudeProcess();
    const adapterIn = new PassThrough();
    const adapterOut = new PassThrough();
    const adapterErr = new PassThrough();
    const adapterCollector = createJsonCollector(adapterOut);
    const claudeCollector = createJsonCollector(fakeClaude.stdin);
    let runtime;

    childProcess.spawn = () => fakeClaude;
    process.exit = () => {};

    try {
      runtime = startAdapter({
        env: { ...process.env, SYMPHONY_ADAPTER_DEBUG: '0' },
        stdin: adapterIn,
        stdout: adapterOut,
        stderr: adapterErr,
      });

      adapterIn.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`);
      await adapterCollector.waitFor((message) => message.id === 1);

      adapterIn.write(`${JSON.stringify({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } })}\n`);
      await adapterCollector.waitFor((message) => message.id === 2);

      adapterIn.write(`${JSON.stringify({
        id: 3,
        method: 'turn/start',
        params: {
          input: [{ type: 'text', text: 'hello' }],
        },
      })}\n`);
      await adapterCollector.waitFor((message) => message.id === 3);
      await claudeCollector.waitFor((message) => message.type === 'user');

      fakeClaude.stdout.write(`${JSON.stringify({
        type: 'control_request',
        request_id: 'cc-request-2',
        request: {
          subtype: 'elicitation',
          title: 'Need input',
          message: 'Please confirm.',
          requested_schema: {
            type: 'object',
            properties: {
              answer: { type: 'string' },
            },
          },
        },
      })}\n`);

      const elicitationRequest = await adapterCollector.waitFor(
        (message) => message.method === 'item/tool/requestUserInput',
      );
      expect(elicitationRequest.params.request.title).toBe('Need input');

      adapterIn.write(`${JSON.stringify({
        id: elicitationRequest.id,
        result: {
          action: 'accept',
          content: { answer: 'confirmed' },
        },
      })}\n`);

      const controlResponse = await claudeCollector.waitFor(
        (message) => message.type === 'control_response',
      );
      expect(controlResponse.response.subtype).toBe('success');
      expect(controlResponse.response.request_id).toBe('cc-request-2');
      expect(controlResponse.response.response.action).toBe('accept');
      expect(controlResponse.response.response.content).toEqual({ answer: 'confirmed' });

      fakeClaude.stdout.write(`${JSON.stringify({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
      })}\n`);
      await adapterCollector.waitFor((message) => message.method === 'turn/completed');
    } finally {
      runtime?.rl.close();
      childProcess.spawn = originalSpawn;
      process.exit = originalExit;
    }
  });

  test('surfaces Claude startup stderr when the child exits before the first turn begins', async () => {
    const originalSpawn = childProcess.spawn;
    const originalExit = process.exit;
    const fakeClaude = createFakeClaudeProcess();
    const adapterIn = new PassThrough();
    const adapterOut = new PassThrough();
    const adapterErr = new PassThrough();
    const adapterCollector = createJsonCollector(adapterOut);
    let runtime;

    childProcess.spawn = () => fakeClaude;
    process.exit = () => {};

    try {
      runtime = startAdapter({
        env: { ...process.env, SYMPHONY_ADAPTER_DEBUG: '0' },
        stdin: adapterIn,
        stdout: adapterOut,
        stderr: adapterErr,
      });

      adapterIn.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`);
      await adapterCollector.waitFor((message) => message.id === 1);

      adapterIn.write(`${JSON.stringify({ id: 2, method: 'thread/start', params: { cwd: process.cwd() } })}\n`);
      await adapterCollector.waitFor((message) => message.id === 2);

      fakeClaude.stderr.write(`Cannot find module 'lodash-es/sumBy.js'\n`);
      fakeClaude.stdin.end();
      fakeClaude.stdin.destroy();
      fakeClaude.emit('exit', 1, null);

      adapterIn.write(`${JSON.stringify({
        id: 3,
        method: 'turn/start',
        params: {
          input: [{ type: 'text', text: 'say hi' }],
        },
      })}\n`);

      const failed = await adapterCollector.waitFor(
        (message) => message.method === 'turn/failed',
      );
      expect(failed.result.error).toContain(`Cannot find module 'lodash-es/sumBy.js'`);
    } finally {
      runtime?.rl.close();
      childProcess.spawn = originalSpawn;
      process.exit = originalExit;
    }
  });
});
