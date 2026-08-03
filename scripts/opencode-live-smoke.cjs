#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const adapter = cp.spawn('node', [path.join(projectRoot, 'scripts', 'opencode-adapter.cjs')], {
  cwd: projectRoot,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let transcript = '';
let finished = false;
let stderr = '';
const timeout = setTimeout(() => {
  fail('live smoke test timed out');
}, Number(process.env.SYMHARIX_OPENCODE_SMOKE_TIMEOUT_MS) || 120_000);

function send(message) {
  adapter.stdin.write(`${JSON.stringify(message)}\n`);
}

function cleanup() {
  clearTimeout(timeout);
  adapter.stdin.end();
  if (!adapter.killed) adapter.kill('SIGTERM');
}

function fail(message) {
  if (finished) return;
  finished = true;
  cleanup();
  console.error(`OpenCode live smoke failed: ${message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
  process.exitCode = 1;
}

adapter.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

adapter.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      send({
        id: 2,
        method: 'thread/start',
        params: {
          cwd: projectRoot,
          sandbox: 'workspace-read',
          systemPrompt: 'This is a runtime health check. Do not use tools or change files.',
        },
      });
      continue;
    }
    if (message.id === 2) {
      send({
        id: 3,
        method: 'turn/start',
        params: {
          title: 'SymHarix OpenCode smoke test',
          input: [{
            type: 'text',
            text: 'Reply with exactly SYMHARIX_SMOKE_OK and no other text. Do not call tools.',
          }],
          sandboxPolicy: { type: 'read-only' },
        },
      });
      continue;
    }
    if (message.method === 'agent/transcript_delta' && message.params?.role === 'assistant') {
      transcript += message.params.text || '';
      continue;
    }
    if (message.method === 'turn/failed') {
      fail(message.result?.error || 'turn failed');
      continue;
    }
    if (message.method === 'turn/completed') {
      if (transcript.trim() !== 'SYMHARIX_SMOKE_OK') {
        fail(`unexpected model response: ${JSON.stringify(transcript.trim())}`);
        continue;
      }
      if (finished) continue;
      finished = true;
      cleanup();
      console.log('OpenCode live smoke passed: read-only adapter, model call, transcript, and completion event.');
    }
  }
});

adapter.on('error', (error) => fail(error.message));
adapter.on('exit', (code, signal) => {
  if (!finished) fail(`adapter exited before completion (code=${code}, signal=${signal})`);
});

send({ id: 1, method: 'initialize', params: { capabilities: {} } });
