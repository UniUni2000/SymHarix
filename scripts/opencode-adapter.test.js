const { describe, expect, test } = require('bun:test');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  buildOpenCodeArgs,
  buildOpenCodeInlineConfig,
  configuredModel,
  convertMcpConfig,
  createEventState,
  normalizeOpenCodeUsage,
  openCodeToolName,
  startAdapter,
  translateOpenCodeEvent,
} = require('./opencode-adapter.cjs');

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function collectJson(stream) {
  let buffer = '';
  const messages = [];
  const waiters = [];
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      messages.push(JSON.parse(line));
    }
    for (let index = 0; index < waiters.length; ) {
      const waiter = waiters[index];
      const match = messages.findIndex(waiter.predicate);
      if (match < 0) {
        index += 1;
        continue;
      }
      const [message] = messages.splice(match, 1);
      waiters.splice(index, 1);
      waiter.resolve(message);
    }
  });
  return {
    waitFor(predicate) {
      const match = messages.findIndex(predicate);
      if (match >= 0) return Promise.resolve(messages.splice(match, 1)[0]);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

describe('opencode-adapter configuration', () => {
  test('builds a first-turn and resumed OpenCode command without a shell', () => {
    const first = buildOpenCodeArgs({
      agent: 'symharix',
      cwd: '/repo with spaces',
      model: 'deepseek/deepseek-chat',
      variant: 'high',
      title: 'INT-1: test',
      prompt: 'implement safely',
    });
    expect(first).toEqual([
      'run',
      '--pure',
      '--format',
      'json',
      '--agent',
      'symharix',
      '--dir',
      '/repo with spaces',
      '--model',
      'deepseek/deepseek-chat',
      '--variant',
      'high',
      '--title',
      'INT-1: test',
      '--',
      'implement safely',
    ]);

    const resumed = buildOpenCodeArgs({
      agent: 'symharix',
      cwd: '/repo',
      sessionID: 'ses_123',
      title: 'ignored',
      prompt: 'continue',
    });
    expect(resumed).toContain('ses_123');
    expect(resumed).not.toContain('--title');
  });

  test('creates a writable dev policy with external delivery commands denied', () => {
    const config = buildOpenCodeInlineConfig({
      env: {
        SYMHARIX_OPENCODE_MODEL: 'openai/gpt-5.1-codex',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { inherited: { options: { apiKey: 'kept' } } } }),
      },
      role: 'dev',
    });
    const agent = config.agent.symharix;
    expect(agent.permission.edit).toBe('allow');
    expect(agent.permission.bash['*']).toBe('allow');
    expect(agent.permission.bash['git push*']).toBe('deny');
    expect(agent.permission.external_directory).toBe('deny');
    expect(agent.maxOutputTokens).toBe(16_000);
    expect(agent.steps).toBe(12);
    expect(config.provider.inherited.options.apiKey).toBe('kept');
  });

  test('creates a read-only plan/review policy and opt-in web access', () => {
    const config = buildOpenCodeInlineConfig({
      env: {},
      role: 'plan',
      allowExternalResearch: true,
    });
    const permission = config.agent.symharix.permission;
    expect(permission.edit).toBe('deny');
    expect(permission.bash['*']).toBe('deny');
    expect(permission.bash['git diff*']).toBe('allow');
    expect(permission.bash['bun test*']).toBeUndefined();
    expect(permission.webfetch).toBe('allow');
    expect(permission.websearch).toBe('allow');
  });

  test('limits review writes to the canonical review artifact', () => {
    const config = buildOpenCodeInlineConfig({
      env: {},
      role: 'review',
    });
    const permission = config.agent.symharix.permission;
    expect(permission.edit['*']).toBe('deny');
    expect(permission.edit['.symphony/REVIEW_REPORT.md']).toBe('allow');
    expect(permission.bash['git diff*']).toBe('allow');
    expect(permission.bash['bun run test*']).toBe('allow');
    expect(permission.bash['python* -m pytest*']).toBe('allow');
    expect(permission.bash['git push*']).toBeUndefined();
  });

  test('translates Claude-shaped MCP config to native OpenCode config', () => {
    const converted = convertMcpConfig(JSON.stringify({
      mcpServers: {
        local: {
          command: 'bun',
          args: ['run', 'server.ts'],
          env: { TOKEN: 'secret' },
        },
        remote: {
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer token' },
        },
      },
    }));
    expect(converted.local).toEqual({
      type: 'local',
      command: ['bun', 'run', 'server.ts'],
      enabled: true,
      environment: { TOKEN: 'secret' },
    });
    expect(converted.remote.type).toBe('remote');
    expect(openCodeToolName('mcp__supervisor-context__get_runtime_overview')).toBe(
      'supervisor-context_get_runtime_overview',
    );
  });

  test('configures an arbitrary OpenAI-compatible provider without embedding its key', () => {
    const config = buildOpenCodeInlineConfig({
      env: {
        SYMHARIX_OPENCODE_MODEL: 'symharix-compatible/qwen-coder',
        SYMHARIX_OPENCODE_PROVIDER: 'symharix-compatible',
        SYMHARIX_OPENCODE_BASE_URL: 'https://models.example.test/v1',
        SYMHARIX_OPENCODE_API_KEY: 'do-not-copy-me',
      },
    });
    expect(config.provider['symharix-compatible']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      models: { 'qwen-coder': { name: 'qwen-coder' } },
      options: {
        baseURL: 'https://models.example.test/v1',
        apiKey: '{env:SYMHARIX_OPENCODE_API_KEY}',
      },
    });
    expect(JSON.stringify(config)).not.toContain('do-not-copy-me');
  });

  test('migrates the legacy Anthropic model name without changing local secrets', () => {
    expect(configuredModel({ ANTHROPIC_MODEL: 'claude-sonnet-4-5' })).toBe(
      'anthropic/claude-sonnet-4-5',
    );
  });

  test('allows separate Plan, Dev, and Review model routing', () => {
    const env = {
      SYMHARIX_OPENCODE_MODEL: 'deepseek/deepseek-chat',
      SYMHARIX_OPENCODE_PLAN_MODEL: 'openai/gpt-5.1-mini',
      SYMHARIX_OPENCODE_REVIEW_MODEL: 'anthropic/claude-sonnet-4-5',
    };
    expect(configuredModel(env, 'plan')).toBe('openai/gpt-5.1-mini');
    expect(configuredModel(env, 'dev')).toBe('deepseek/deepseek-chat');
    expect(configuredModel(env, 'review')).toBe('anthropic/claude-sonnet-4-5');
  });

  test('passes the configured single-turn output ceiling to OpenCode', () => {
    const config = buildOpenCodeInlineConfig({
      env: {
        SYMHARIX_MAX_TURN_OUTPUT_TOKENS: '4096',
        SYMHARIX_MAX_TURN_STEPS: '5',
      },
      role: 'dev',
    });
    expect(config.agent.symharix.maxOutputTokens).toBe(4096);
    expect(config.agent.symharix.steps).toBe(5);
  });
});

describe('opencode-adapter event contract', () => {
  test('normalizes cached and reasoning tokens', () => {
    expect(normalizeOpenCodeUsage({
      input: 100,
      output: 20,
      reasoning: 5,
      total: 125,
      cache: { read: 300, write: 50 },
    })).toEqual({
      input: 450,
      output: 25,
      total: 475,
      uncached_input: 100,
      cache_creation_input: 50,
      cache_read_input: 300,
    });
  });

  test('translates text, tools, usage, and error events', () => {
    const state = createEventState();
    const text = translateOpenCodeEvent({
      type: 'text',
      sessionID: 'ses_1',
      part: { type: 'text', text: 'done' },
    }, 1, state);
    const tool = translateOpenCodeEvent({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'pwd' }, output: '/repo' },
      },
    }, 1, state);
    translateOpenCodeEvent({
      type: 'step_finish',
      sessionID: 'ses_1',
      part: {
        type: 'step-finish',
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }, 1, state);

    expect(state.sessionID).toBe('ses_1');
    expect(text[0].method).toBe('agent/transcript_delta');
    expect(tool.map((message) => message.params?.code).filter(Boolean)).toEqual(['tool_started', 'tool_completed']);
    expect(state.usage).toMatchObject({ input: 10, output: 5, total: 15 });
    expect(state.apiCalls).toBe(1);
  });

  test('runs two turns and resumes the real OpenCode session', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output = collectJson(stdout);
    const spawns = [];
    const children = [];
    startAdapter({
      stdin,
      stdout,
      stderr,
      binary: '/fake/opencode',
      env: { SYMHARIX_OPENCODE_MODEL: 'deepseek/deepseek-chat' },
      spawn: (binary, args, options) => {
        const child = fakeProcess();
        spawns.push({ binary, args, options });
        children.push(child);
        return child;
      },
    });

    stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`);
    await output.waitFor((message) => message.id === 1);
    stdin.write(`${JSON.stringify({
      id: 2,
      method: 'thread/start',
      params: { cwd: '/repo', sandbox: 'workspace-write' },
    })}\n`);
    await output.waitFor((message) => message.id === 2);
    stdin.write(`${JSON.stringify({
      id: 3,
      method: 'turn/start',
      params: { title: 'first', input: [{ type: 'text', text: 'first prompt' }] },
    })}\n`);
    await output.waitFor((message) => message.id === 3);
    children[0].stdout.write(`${JSON.stringify({
      type: 'text',
      sessionID: 'ses_real',
      part: { type: 'text', text: 'first answer' },
    })}\n`);
    children[0].stdout.write(`${JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_real',
      part: {
        type: 'step-finish',
        tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })}\n`);
    children[0].emit('exit', 0, null);
    const firstDone = await output.waitFor((message) => message.method === 'turn/completed');
    expect(firstDone.result.turn.tokens.total).toBe(5);

    stdin.write(`${JSON.stringify({
      id: 4,
      method: 'turn/start',
      params: { title: 'second', input: [{ type: 'text', text: 'second prompt' }] },
    })}\n`);
    await output.waitFor((message) => message.id === 4);
    expect(spawns[1].args).toContain('--session');
    expect(spawns[1].args).toContain('ses_real');
    expect(spawns[1].options.env.OPENCODE_CONFIG_CONTENT).not.toContain('undefined');
    expect(spawns[1].options.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX).toBe('16000');
    children[1].emit('exit', 0, null);
    await output.waitFor((message) => message.method === 'turn/completed');
    stdin.end();
  });

  test('terminates a turn at the aggregate token ceiling and reports consumed usage', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const output = collectJson(stdout);
    const child = fakeProcess();
    let killSignal = null;
    child.kill = (signal) => {
      killSignal = signal;
      return true;
    };
    startAdapter({
      stdin,
      stdout,
      stderr,
      binary: '/fake/opencode',
      env: { SYMHARIX_TURN_RESERVE_TOKENS: '10' },
      spawn: () => child,
    });
    stdin.write(`${JSON.stringify({
      id: 1,
      method: 'thread/start',
      params: { cwd: '/repo', sandbox: 'workspace-write' },
    })}\n`);
    await output.waitFor((message) => message.id === 1);
    stdin.write(`${JSON.stringify({
      id: 2,
      method: 'turn/start',
      params: { input: [{ type: 'text', text: 'work' }] },
    })}\n`);
    await output.waitFor((message) => message.id === 2);
    child.stdout.write(`${JSON.stringify({
      type: 'step_finish',
      sessionID: 'ses_budget',
      part: {
        type: 'step-finish',
        tokens: { input: 8, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })}\n`);
    expect(killSignal).toBe('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    const failed = await output.waitFor((message) => message.method === 'turn/failed');
    expect(failed.result.error).toContain('turn token ceiling reached');
    expect(failed.result.turn.tokens.total).toBe(12);
    stdin.end();
  });
});
