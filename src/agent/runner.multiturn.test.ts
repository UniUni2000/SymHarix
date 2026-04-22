import { describe, expect, test } from 'bun:test';
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

  child.pid = 22222;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = stdin;

  return child;
}

describe('AgentRunner multi-turn cleanup', () => {
  test('does not duplicate timeline events across sequential turns on the same child process', async () => {
    const runner = new AgentRunner({
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      turnTimeoutMs: 5000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 5000,
      projectRoot: process.cwd(),
    });
    const child = createFakeChildProcess();

    const firstEvents: string[] = [];
    const firstTurn = runner.runTurn(
      child,
      'thread-1',
      'first',
      'INT-26: Example',
      process.cwd(),
      (event) => firstEvents.push(event.event)
    );
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({
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
      })}\n`));
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({
        method: 'turn/completed',
        result: {
          turn: {
            id: 'adapter-turn-1',
            api_calls: 1,
            tokens: { input: 1, output: 1, total: 2 },
          },
        },
      })}\n`));
    });
    await firstTurn;

    const secondEvents: string[] = [];
    const secondTurn = runner.runTurn(
      child,
      'thread-1',
      'second',
      'INT-26: Example',
      process.cwd(),
      (event) => secondEvents.push(event.event)
    );
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({
        method: 'agent/timeline',
        params: {
          level: 'info',
          category: 'turn',
          code: 'turn_started',
          message: 'Turn 2 started',
          turn: 2,
          tool_name: null,
          detail: null,
        },
      })}\n`));
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({
        method: 'turn/completed',
        result: {
          turn: {
            id: 'adapter-turn-2',
            api_calls: 1,
            tokens: { input: 2, output: 1, total: 3 },
          },
        },
      })}\n`));
    });
    const secondResult = await secondTurn;

    expect(firstEvents).toEqual(['timeline', 'turn_completed']);
    expect(secondEvents).toEqual(['timeline', 'turn_completed']);
    expect(secondResult.tokens).toEqual({ input: 2, output: 1, total: 3 });
  });
});
