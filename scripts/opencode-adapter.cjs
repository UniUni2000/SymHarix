#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const path = require('path');
const readline = require('readline');
const { checkRuntime, readLock } = require('./opencode-runtime.cjs');

const DEFAULT_AGENT = 'symharix';
const DEFAULT_MAX_TURN_OUTPUT_TOKENS = 16_000;
const DEFAULT_MAX_TURN_STEPS = 12;
const DEFAULT_MAX_TURN_TOKENS = 200_000;
const DEFAULT_SYSTEM_PROMPT = [
  'You are the SymHarix coding runtime.',
  'Work only inside the provided repository workspace.',
  'Do not push, merge, create pull requests, or change external tracker state.',
  'The SymHarix state machine owns commits, pull requests, review decisions, merges, and tracker transitions.',
  'Use tools to inspect, implement, and verify the requested work, then report concrete evidence.',
].join('\n');

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function resolveMaxOutputTokens(env = process.env) {
  return Math.trunc(
    number(env.SYMHARIX_MAX_TURN_OUTPUT_TOKENS || env.SYMPHONY_MAX_TURN_OUTPUT_TOKENS)
    || DEFAULT_MAX_TURN_OUTPUT_TOKENS,
  );
}

function resolveMaxTurnSteps(env = process.env) {
  return Math.trunc(
    number(env.SYMHARIX_MAX_TURN_STEPS || env.SYMPHONY_MAX_TURN_STEPS)
    || DEFAULT_MAX_TURN_STEPS,
  );
}

function resolveMaxTurnTokens(env = process.env) {
  return Math.trunc(
    number(env.SYMHARIX_TURN_RESERVE_TOKENS || env.SYMPHONY_TURN_RESERVE_TOKENS)
    || DEFAULT_MAX_TURN_TOKENS,
  );
}

function makeUsage() {
  return {
    input: 0,
    output: 0,
    total: 0,
    uncached_input: 0,
    cache_creation_input: 0,
    cache_read_input: 0,
  };
}

function addUsage(left, right) {
  const usage = {
    input: number(left.input) + number(right.input),
    output: number(left.output) + number(right.output),
    total: number(left.total) + number(right.total),
    uncached_input: number(left.uncached_input) + number(right.uncached_input),
    cache_creation_input: number(left.cache_creation_input) + number(right.cache_creation_input),
    cache_read_input: number(left.cache_read_input) + number(right.cache_read_input),
  };
  usage.total = Math.max(usage.total, usage.input + usage.output);
  return usage;
}

function normalizeOpenCodeUsage(tokens) {
  const uncachedInput = number(tokens?.input);
  const cacheRead = number(tokens?.cache?.read);
  const cacheWrite = number(tokens?.cache?.write);
  const input = uncachedInput + cacheRead + cacheWrite;
  const output = number(tokens?.output) + number(tokens?.reasoning);
  const total = Math.max(number(tokens?.total), input + output);
  return {
    input,
    output,
    total,
    ...(cacheRead > 0 || cacheWrite > 0 ? { uncached_input: uncachedInput } : {}),
    ...(cacheWrite > 0 ? { cache_creation_input: cacheWrite } : {}),
    ...(cacheRead > 0 ? { cache_read_input: cacheRead } : {}),
  };
}

function deepMerge(left, right) {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return right;
  if (!right || typeof right !== 'object' || Array.isArray(right)) return right;
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    result[key] = (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    )
      ? deepMerge(result[key], value)
      : value;
  }
  return result;
}

function parseJsonObject(value, label) {
  if (!value || !String(value).trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function convertMcpConfig(value) {
  const parsed = parseJsonObject(value, 'mcpConfig');
  const servers = parsed.mcpServers || parsed.mcp || {};
  const converted = {};
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue;
    if (typeof server.url === 'string') {
      converted[name] = {
        type: 'remote',
        url: server.url,
        enabled: server.enabled !== false,
        ...(server.headers && typeof server.headers === 'object' ? { headers: server.headers } : {}),
      };
      continue;
    }
    if (typeof server.command !== 'string' || !server.command.trim()) continue;
    converted[name] = {
      type: 'local',
      command: [server.command, ...(Array.isArray(server.args) ? server.args.map(String) : [])],
      enabled: server.enabled !== false,
      ...(typeof server.cwd === 'string' ? { cwd: server.cwd } : {}),
      ...(server.env && typeof server.env === 'object' ? { environment: server.env } : {}),
    };
  }
  return converted;
}

function openCodeToolName(name) {
  const match = String(name).match(/^mcp__([^_]+(?:-[^_]+)*)__([^]+)$/);
  return match ? `${match[1]}_${match[2]}` : String(name).toLowerCase();
}

function safeBashPermissions(role) {
  if (role === 'dev') {
    return {
      '*': 'allow',
      'git push*': 'deny',
      'git commit*': 'deny',
      'git merge*': 'deny',
      'git rebase*': 'deny',
      'git reset*': 'deny',
      'gh *': 'deny',
      'curl *': 'deny',
      'wget *': 'deny',
      'rm -rf *': 'deny',
    };
  }
  const readOnlyCommands = {
    '*': 'deny',
    'pwd': 'allow',
    'git status*': 'allow',
    'git diff*': 'allow',
    'git log*': 'allow',
    'git show*': 'allow',
    'git branch --show-current': 'allow',
    'rg *': 'allow',
    'find *': 'allow',
    'ls*': 'allow',
  };
  if (role === 'review') {
    return {
      ...readOnlyCommands,
      'bun test*': 'allow',
      'bun run test*': 'allow',
      'npm test*': 'allow',
      'pytest *': 'allow',
      'python* -m pytest*': 'allow',
      '.venv/bin/python* -m pytest*': 'allow',
    };
  }
  return readOnlyCommands;
}

function providerOverride(env, model) {
  const providerID = String(env.SYMHARIX_OPENCODE_PROVIDER || env.SYMPHONY_OPENCODE_PROVIDER || model || '')
    .split('/')[0]
    .trim();
  const baseURL = (
    env.SYMHARIX_OPENCODE_BASE_URL ||
    env.SYMPHONY_OPENCODE_BASE_URL ||
    (providerID === 'anthropic' ? env.ANTHROPIC_BASE_URL : '') ||
    (providerID === 'openai' ? env.OPENAI_BASE_URL : '')
  );
  if (!providerID || !baseURL) return {};

  const modelID = String(model || '').split('/').slice(1).join('/');
  const custom = providerID === 'symharix-compatible' || Boolean(
    env.SYMHARIX_OPENCODE_PROVIDER_NPM || env.SYMPHONY_OPENCODE_PROVIDER_NPM,
  );
  return {
    [providerID]: {
      ...(custom ? {
        npm: env.SYMHARIX_OPENCODE_PROVIDER_NPM || env.SYMPHONY_OPENCODE_PROVIDER_NPM || '@ai-sdk/openai-compatible',
        name: env.SYMHARIX_OPENCODE_PROVIDER_NAME || env.SYMPHONY_OPENCODE_PROVIDER_NAME || 'SymHarix compatible provider',
        ...(modelID ? { models: { [modelID]: { name: modelID } } } : {}),
      } : {}),
      options: {
        baseURL,
        ...(custom ? { apiKey: '{env:SYMHARIX_OPENCODE_API_KEY}' } : {}),
      },
    },
  };
}

function configuredModel(env, role) {
  const roleKey = role ? `SYMHARIX_OPENCODE_${String(role).toUpperCase()}_MODEL` : '';
  const legacyRoleKey = role ? `SYMPHONY_OPENCODE_${String(role).toUpperCase()}_MODEL` : '';
  const current = (roleKey ? env[roleKey] : '') ||
    (legacyRoleKey ? env[legacyRoleKey] : '') ||
    env.SYMHARIX_OPENCODE_MODEL ||
    env.SYMPHONY_OPENCODE_MODEL;
  if (current) return current;
  const legacy = String(env.ANTHROPIC_MODEL || '').trim();
  if (!legacy) return '';
  return legacy.startsWith('anthropic/') ? legacy : `anthropic/${legacy}`;
}

function buildOpenCodeInlineConfig(options = {}) {
  const env = options.env || process.env;
  const base = parseJsonObject(env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT');
  const role = options.role || (options.readOnly === true ? 'plan' : 'dev');
  const readOnly = role === 'plan';
  const review = role === 'review';
  const external = options.allowExternalResearch === true;
  const permission = {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    skill: 'allow',
    todowrite: role === 'dev' ? 'allow' : 'deny',
    edit: readOnly
      ? 'deny'
      : review
        ? {
            '*': 'deny',
            '.symphony/REVIEW_REPORT.md': 'allow',
            '**/.symphony/REVIEW_REPORT.md': 'allow',
          }
        : 'allow',
    bash: safeBashPermissions(role),
    task: 'deny',
    external_directory: 'deny',
    question: 'deny',
    webfetch: external ? 'allow' : 'deny',
    websearch: external ? 'allow' : 'deny',
  };

  for (const tool of options.allowedTools || []) {
    const converted = openCodeToolName(tool);
    if (converted.startsWith('mcp__')) continue;
    permission[converted] = 'allow';
  }

  const model = options.model || configuredModel(env, role);
  const maxOutputTokens = resolveMaxOutputTokens(env);
  const maxTurnSteps = resolveMaxTurnSteps(env);
  const agentName = env.SYMHARIX_OPENCODE_AGENT || env.SYMPHONY_OPENCODE_AGENT || DEFAULT_AGENT;
  const override = {
    $schema: 'https://opencode.ai/config.json',
    share: 'disabled',
    autoupdate: false,
    agent: {
      [agentName]: {
        description:
          role === 'plan'
            ? 'SymHarix read-only planning runtime'
            : role === 'review'
              ? 'SymHarix independent code review runtime'
              : 'SymHarix repository development runtime',
        mode: 'primary',
        prompt: [
          DEFAULT_SYSTEM_PROMPT,
          role === 'plan'
            ? 'Role: PLAN. Analyze and propose; never modify the repository.'
            : role === 'review'
              ? 'Role: REVIEW. Independently inspect and test the implementation. Do not change product code; only .symphony/REVIEW_REPORT.md may be written.'
              : 'Role: DEV. Implement and verify local product changes; leave delivery to the state machine.',
          options.systemPrompt || '',
        ].filter(Boolean).join('\n\n'),
        maxOutputTokens,
        steps: maxTurnSteps,
        permission,
      },
    },
    ...(options.mcpConfig ? { mcp: convertMcpConfig(options.mcpConfig) } : {}),
    ...(model ? { provider: providerOverride(env, model) } : {}),
  };
  return deepMerge(base, override);
}

function buildOpenCodeArgs(options = {}) {
  const args = ['run', '--pure', '--format', 'json', '--agent', options.agent || DEFAULT_AGENT, '--dir', options.cwd];
  if (options.sessionID) args.push('--session', options.sessionID);
  if (options.model) args.push('--model', options.model);
  if (options.variant) args.push('--variant', options.variant);
  if (options.title && !options.sessionID) args.push('--title', options.title);
  args.push('--', options.prompt);
  return args;
}

function timeline(code, message, turn, options = {}) {
  return {
    method: 'agent/timeline',
    params: {
      level: options.level || 'info',
      category: options.category || 'turn',
      code,
      message,
      turn,
      tool_name: options.toolName || null,
      detail: options.detail || null,
    },
  };
}

function errorText(error) {
  if (!error) return 'Unknown OpenCode error';
  if (typeof error === 'string') return error;
  if (typeof error.data?.message === 'string') return error.data.message;
  if (typeof error.message === 'string') return error.message;
  if (typeof error.name === 'string') return error.name;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function createEventState() {
  return {
    sessionID: null,
    usage: makeUsage(),
    apiCalls: 0,
    error: null,
  };
}

function translateOpenCodeEvent(event, turn, state) {
  const messages = [];
  if (typeof event?.sessionID === 'string' && event.sessionID) state.sessionID = event.sessionID;
  const part = event?.part;

  if (event?.type === 'step_start') {
    messages.push(timeline('assistant_thinking', 'OpenCode is working', turn, { category: 'assistant' }));
  } else if (event?.type === 'reasoning' && typeof part?.text === 'string' && part.text.trim()) {
    messages.push(timeline('assistant_thinking', 'OpenCode reasoning completed', turn, { category: 'assistant' }));
  } else if (event?.type === 'text' && typeof part?.text === 'string' && part.text.trim()) {
    messages.push({
      method: 'agent/transcript_delta',
      params: {
        role: 'assistant',
        kind: 'message',
        text: part.text,
        turn,
        tool_name: null,
      },
    });
  } else if (event?.type === 'tool_use' && part?.type === 'tool') {
    const failed = part.state?.status === 'error';
    const toolName = String(part.tool || 'tool');
    messages.push(timeline('tool_started', `Using ${toolName}`, turn, {
      category: 'tool',
      toolName,
      detail: { input: part.state?.input || null },
    }));
    messages.push(timeline(failed ? 'tool_failed' : 'tool_completed', `${toolName} ${failed ? 'failed' : 'completed'}`, turn, {
      level: failed ? 'error' : 'info',
      category: 'tool',
      toolName,
      detail: failed ? { error: part.state?.error || 'unknown' } : null,
    }));
    const output = failed ? part.state?.error : part.state?.output;
    if (typeof output === 'string' && output.trim()) {
      messages.push({
        method: 'agent/transcript_delta',
        params: {
          role: 'user',
          kind: 'tool_result',
          text: output,
          turn,
          tool_name: toolName,
        },
      });
    }
  } else if (event?.type === 'step_finish' && part?.tokens) {
    state.usage = addUsage(state.usage, normalizeOpenCodeUsage(part.tokens));
    state.apiCalls += 1;
  } else if (event?.type === 'error') {
    state.error = errorText(event.error);
    messages.push(timeline('turn_failed', state.error, turn, { level: 'error' }));
  }

  return messages;
}

function startAdapter(options = {}) {
  const input = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const env = options.env || process.env;
  const spawn = options.spawn || cp.spawn;
  const debug = env.SYMHARIX_ADAPTER_DEBUG === '1' || env.SYMPHONY_ADAPTER_DEBUG === '1';
  const runtime = {
    cwd: process.cwd(),
    readOnly: false,
    role: 'dev',
    systemPrompt: '',
    mcpConfig: null,
    allowedTools: [],
    child: null,
    turn: 0,
    sessionID: null,
    activeRequestID: null,
    activeState: null,
    stderrBuffer: '',
  };
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const send = (message) => stdout.write(`${JSON.stringify(message)}\n`);
  const log = (message) => {
    if (debug) stderr.write(`[opencode-adapter] ${message}\n`);
  };
  const finish = (success, message) => {
    if (runtime.activeRequestID === null || !runtime.activeState) return;
    const turn = runtime.turn;
    const state = runtime.activeState;
    if (success) {
      send(timeline('turn_completed', `Turn ${turn} completed`, turn, {
        detail: {
          input_tokens: state.usage.input,
          output_tokens: state.usage.output,
          total_tokens: state.usage.total,
        },
      }));
      send({
        method: 'turn/completed',
        result: {
          turn: {
            id: `opencode-turn-${turn}`,
            api_calls: Math.max(state.apiCalls, 1),
            tokens: state.usage,
          },
        },
      });
    } else {
      const detail = message || state.error || runtime.stderrBuffer.trim() || 'OpenCode turn failed';
      send(timeline('turn_failed', detail, turn, { level: 'error' }));
      send({
        method: 'turn/failed',
        result: {
          error: detail,
          turn: {
            api_calls: state.apiCalls,
            tokens: state.usage,
          },
        },
      });
    }
    runtime.activeRequestID = null;
    runtime.activeState = null;
    runtime.child = null;
    runtime.stderrBuffer = '';
  };

  function launchTurn(message) {
    runtime.turn += 1;
    runtime.activeRequestID = message.id ?? `turn-${runtime.turn}`;
    runtime.activeState = createEventState();
    const prompt = message.params?.input?.[0]?.text ?? message.params?.text ?? '';
    const sandbox = message.params?.sandboxPolicy || {};
    const allowExternalResearch = sandbox.allowExternalResearch === true || sandbox.allowExternalWebTools === true;
    const agent = env.SYMHARIX_OPENCODE_AGENT || env.SYMPHONY_OPENCODE_AGENT || DEFAULT_AGENT;
    const model = configuredModel(env, runtime.role) || undefined;
    const variant = env.SYMHARIX_OPENCODE_VARIANT || env.SYMPHONY_OPENCODE_VARIANT || undefined;
    const inlineConfig = buildOpenCodeInlineConfig({
      env,
      readOnly: runtime.readOnly,
      role: runtime.role,
      model,
      allowExternalResearch,
      allowedTools: runtime.allowedTools,
      systemPrompt: runtime.systemPrompt,
      mcpConfig: runtime.mcpConfig,
    });
    const binary = options.binary || checkRuntime({
      explicitBinary: env.SYMHARIX_OPENCODE_BIN || env.SYMPHONY_OPENCODE_BIN,
    }).binary;
    const args = buildOpenCodeArgs({
      agent,
      cwd: runtime.cwd,
      model,
      variant,
      sessionID: runtime.sessionID,
      title: message.params?.title || `SymHarix turn ${runtime.turn}`,
      prompt,
    });

    send({ id: message.id, result: { turn: { id: `opencode-turn-${runtime.turn}` } } });
    send(timeline('turn_started', `Turn ${runtime.turn} started`, runtime.turn));
    log(`Spawning ${binary} ${args.slice(0, -1).join(' ')}`);

    const child = spawn(binary, args, {
      cwd: runtime.cwd,
      env: {
        ...env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(resolveMaxOutputTokens(env)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runtime.child = child;
    let outputBuffer = '';
    child.stdout.on('data', (chunk) => {
      outputBuffer += chunk.toString();
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          for (const translated of translateOpenCodeEvent(event, runtime.turn, runtime.activeState)) {
            send(translated);
          }
          if (runtime.activeState?.sessionID) runtime.sessionID = runtime.activeState.sessionID;
          if (
            runtime.activeState
            && runtime.activeState.usage.total >= resolveMaxTurnTokens(env)
            && !runtime.activeState.error
          ) {
            const usage = runtime.activeState.usage;
            runtime.activeState.error =
              `OpenCode turn token ceiling reached (total=${usage.total} >= limit=${resolveMaxTurnTokens(env)}; `
              + `uncached_input=${usage.uncached_input}, cache_read=${usage.cache_read_input}, output=${usage.output}).`;
            child.kill('SIGTERM');
          }
        } catch (error) {
          log(`Ignoring non-JSON OpenCode output: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      runtime.stderrBuffer += chunk.toString();
      log(chunk.toString().trim());
    });
    child.on('error', (error) => finish(false, error instanceof Error ? error.message : String(error)));
    child.on('exit', (code, signal) => {
      if (signal) {
        finish(false, runtime.activeState?.error || `OpenCode was terminated by ${signal}`);
        return;
      }
      finish(code === 0 && !runtime.activeState?.error, runtime.activeState?.error || undefined);
    });
  }

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        send({ id: message.id, result: { adapter: 'symharix-opencode', version: readLock().version } });
        return;
      }
      if (message.method === 'thread/start') {
        runtime.cwd = message.params?.cwd || process.cwd();
        const sandbox = String(message.params?.sandbox || '').toLowerCase();
        runtime.readOnly = sandbox === 'workspace-read' || sandbox === 'read-only';
        runtime.role = ['plan', 'dev', 'review'].includes(message.params?.role)
          ? message.params.role
          : runtime.readOnly
            ? 'plan'
            : 'dev';
        runtime.systemPrompt = message.params?.systemPrompt || '';
        runtime.mcpConfig = message.params?.mcpConfig || null;
        runtime.allowedTools = Array.isArray(message.params?.allowedTools) ? message.params.allowedTools : [];
        send(timeline('session_started', 'OpenCode session started', null, {
          category: 'session',
          detail: { cwd: runtime.cwd, read_only: runtime.readOnly },
        }));
        send({ id: message.id, result: { thread: { id: `opencode-adapter-${process.pid}` } } });
        return;
      }
      if (message.method === 'turn/start') {
        if (runtime.child) {
          send({ method: 'turn/failed', result: { error: 'OpenCode turn already in progress' } });
          return;
        }
        launchTurn(message);
      }
    } catch (error) {
      log(`Input parsing error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  rl.on('close', () => {
    if (runtime.child) runtime.child.kill('SIGTERM');
  });

  return { runtime, close: () => rl.close() };
}

module.exports = {
  addUsage,
  buildOpenCodeArgs,
  buildOpenCodeInlineConfig,
  configuredModel,
  convertMcpConfig,
  createEventState,
  deepMerge,
  normalizeOpenCodeUsage,
  openCodeToolName,
  providerOverride,
  resolveMaxOutputTokens,
  resolveMaxTurnSteps,
  resolveMaxTurnTokens,
  safeBashPermissions,
  startAdapter,
  translateOpenCodeEvent,
};

if (require.main === module) {
  startAdapter();
}
