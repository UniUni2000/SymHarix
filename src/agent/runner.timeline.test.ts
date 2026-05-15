import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { PassThrough } from 'stream';
import { AgentRunner } from './runner';

type FakeWritable = PassThrough & {
  writes: string[];
};

function createFakeChildProcess() {
  const child = new EventEmitter() as unknown as ChildProcess & EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: FakeWritable;
    pid: number;
  };
  const stdin = new PassThrough() as FakeWritable;
  stdin.writes = [];
  const originalWrite = stdin.write.bind(stdin);
  stdin.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
    stdin.writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return originalWrite(chunk, encoding as BufferEncoding, cb);
  }) as typeof stdin.write;

  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = stdin;

  return child;
}

describe('AgentRunner timeline events', () => {
  test('passes supervisor MCP config, allowed tools, and system prompt through thread start', async () => {
    const runner = new AgentRunner({
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      approvalPolicy: 'on-request',
      threadSandbox: 'workspace-read',
      mcpConfig: JSON.stringify({
        mcpServers: {
          'supervisor-context': {
            command: 'bun',
            args: ['run', 'src/supervisor/contextMcpServer.ts'],
          },
          'supervisor-orchestrator': {
            command: 'bun',
            args: ['run', 'src/supervisor/orchestratorMcpServer.ts'],
          },
        },
      }),
      tools: ['Read', 'Grep', 'Glob', 'LS', 'TodoRead'],
      allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'mcp__supervisor-context__list_context_sources', 'mcp__supervisor-orchestrator__show_issue_card'],
      systemPrompt: 'You are the top-level Supervisor Claude Code runtime.',
      turnTimeoutMs: 5000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 5000,
      projectRoot: process.cwd(),
    });
    const child = createFakeChildProcess();

    const initialized = runner.initializeSession(child, process.cwd());

    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`));
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({
        id: 2,
        result: { thread: { id: 'thread-supervisor' } },
      })}\n`));
    });

    await initialized;
    const threadStart = child.stdin.writes
      .map((line) => JSON.parse(line))
      .find((message) => message.method === 'thread/start');
    const rawMcpConfig = threadStart.params.mcpConfig;

    expect(threadStart.params).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-read',
      mcpConfig: expect.any(String),
      tools: ['Read', 'Grep', 'Glob', 'LS', 'TodoRead'],
      allowedTools: ['Read', 'Grep', 'Glob', 'LS', 'mcp__supervisor-context__list_context_sources', 'mcp__supervisor-orchestrator__show_issue_card'],
      systemPrompt: 'You are the top-level Supervisor Claude Code runtime.',
    });
    const mcpConfig = JSON.parse(rawMcpConfig);
    expect(mcpConfig.mcpServers['supervisor-context']).toBeTruthy();
    expect(mcpConfig.mcpServers['supervisor-orchestrator']).toBeTruthy();
  });

  test('maps agent/timeline messages to timeline AgentEvent without breaking turn completion tokens', async () => {
    const runner = new AgentRunner({
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      turnTimeoutMs: 5000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 5000,
      projectRoot: process.cwd(),
    });
    const child = createFakeChildProcess();
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = [];

    const resultPromise = runner.runTurn(
      child,
      'thread-1',
      'hello',
      'INT-1: Example',
      process.cwd(),
      (event) => events.push({ event: event.event, payload: event.payload as Record<string, unknown> | undefined })
    );

    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            method: 'agent/timeline',
            params: {
              level: 'info',
              category: 'turn',
              code: 'turn_started',
              message: 'Turn 1 started',
              turn: 1,
              tool_name: null,
              detail: null,
            },
          })}\n`
        )
      );
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            method: 'turn/completed',
            result: {
              turn: {
                id: 'adapter-turn-1',
                api_calls: 1,
                tokens: { input: 10, output: 5, total: 15 },
              },
            },
          })}\n`
        )
      );
    });

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.tokens).toEqual({ input: 10, output: 5, total: 15 });
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe('timeline');
    expect(events[0]?.payload?.message).toBe('Turn 1 started');
    expect(events[1]?.event).toBe('turn_completed');
    expect(child.stdin.writes[0]).toContain('"method":"turn/start"');
  });

  test('preserves cached token fields from turn completion messages', async () => {
    const runner = new AgentRunner({
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      turnTimeoutMs: 5000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 5000,
      projectRoot: process.cwd(),
    });
    const child = createFakeChildProcess();
    const events: Array<{ event: string; usage?: unknown }> = [];

    const resultPromise = runner.runTurn(
      child,
      'thread-1',
      'hello',
      'INT-1: Example',
      process.cwd(),
      (event) => events.push({ event: event.event, usage: event.usage })
    );

    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            method: 'turn/completed',
            result: {
              turn: {
                id: 'adapter-turn-1',
                api_calls: 2,
                tokens: {
                  input: 650,
                  output: 50,
                  total: 700,
                  uncached_input: 100,
                  cache_creation_input: 150,
                  cache_read_input: 400,
                },
              },
            },
          })}\n`
        )
      );
    });

    const result = await resultPromise;

    expect(result.tokens).toEqual({
      input: 650,
      output: 50,
      total: 700,
      uncached_input: 100,
      cache_creation_input: 150,
      cache_read_input: 400,
    });
    expect(events.at(-1)?.usage).toEqual({
      input_tokens: 650,
      output_tokens: 50,
      total_tokens: 700,
      uncached_input_tokens: 100,
      cache_creation_input_tokens: 150,
      cache_read_input_tokens: 400,
    });
  });

  test('round-trips approval requests and passes timeline/transcript state to the runtime handler', async () => {
    const runner = new AgentRunner({
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      turnTimeoutMs: 5000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 5000,
      projectRoot: process.cwd(),
    });
    const child = createFakeChildProcess();
    const runtimeHandler = mock(async (request, state) => {
      expect(request.kind).toBe('approval');
      expect(request.summary.tool_name).toBe('Bash');
      expect(state.timeline).toHaveLength(1);
      expect(state.transcript).toEqual([
        {
          role: 'assistant',
          kind: 'message',
          text: 'I will inspect the repo.',
          turn: 1,
          tool_name: null,
        },
      ]);

      return {
        response: {
          behavior: 'allow',
          updatedInput: { command: 'pwd' },
          toolUseID: 'tool-1',
        },
      };
    });

    const resultPromise = runner.runTurn(
      child,
      'thread-1',
      'hello',
      'INT-2: Runtime request',
      process.cwd(),
      () => undefined,
      runtimeHandler,
    );

    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            method: 'agent/timeline',
            params: {
              level: 'info',
              category: 'turn',
              code: 'turn_started',
              message: 'Turn 1 started',
              turn: 1,
              tool_name: null,
              detail: null,
            },
          })}\n`,
        ),
      );
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            method: 'agent/transcript_delta',
            params: {
              role: 'assistant',
              kind: 'message',
              text: 'I will inspect the repo.',
              turn: 1,
              tool_name: null,
            },
          })}\n`,
        ),
      );
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            id: 7,
            method: 'approval/request',
            params: {
              request_id: 'runtime-1',
              turn: 1,
              request: {
                subtype: 'can_use_tool',
                tool_name: 'Bash',
                tool_use_id: 'tool-1',
                title: 'Use Bash',
                input: { command: 'pwd' },
              },
            },
          })}\n`,
        ),
      );

      setTimeout(() => {
        child.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({
              method: 'turn/completed',
              result: {
                turn: {
                  id: 'adapter-turn-1',
                  api_calls: 1,
                  tokens: { input: 12, output: 6, total: 18 },
                },
              },
            })}\n`,
          ),
        );
      }, 0);
    });

    const result = await resultPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtimeHandler).toHaveBeenCalledTimes(1);
    expect(result.transcript).toEqual([
      {
        role: 'assistant',
        kind: 'message',
        text: 'I will inspect the repo.',
        turn: 1,
        tool_name: null,
      },
    ]);
    expect(result.timeline).toHaveLength(1);
    expect(child.stdin.writes.some((line) => line.includes('"id":7') && line.includes('"behavior":"allow"'))).toBe(true);
  });

  test('round-trips elicitation requests back to the adapter process', async () => {
    const runner = new AgentRunner({
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      turnTimeoutMs: 5000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 5000,
      projectRoot: process.cwd(),
    });
    const child = createFakeChildProcess();

    const resultPromise = runner.runTurn(
      child,
      'thread-1',
      'hello',
      'INT-3: Elicitation request',
      process.cwd(),
      () => undefined,
      async () => ({
        response: {
          action: 'accept',
          content: { answer: 'confirmed' },
        },
      }),
    );

    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            id: 9,
            method: 'item/tool/requestUserInput',
            params: {
              request_id: 'elicitation-1',
              turn: 1,
              request: {
                subtype: 'elicitation',
                title: 'Need confirmation',
                message: 'Proceed?',
                requested_schema: {
                  type: 'object',
                  properties: { answer: { type: 'string' } },
                },
              },
            },
          })}\n`,
        ),
      );

      setTimeout(() => {
        child.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({
              method: 'turn/completed',
              result: {
                turn: {
                  id: 'adapter-turn-1',
                  api_calls: 1,
                  tokens: { input: 4, output: 2, total: 6 },
                },
              },
            })}\n`,
          ),
        );
      }, 0);
    });

    await resultPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(child.stdin.writes.some((line) => line.includes('"id":9') && line.includes('"action":"accept"'))).toBe(true);
  });
});
