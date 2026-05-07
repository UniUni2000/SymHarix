#!/usr/bin/env node

/**
 * claude-adapter.js
 * Bridges Symphony's JSON-RPC protocol to a native Claude Code stream-json session.
 */

const cp = require('child_process');
const readline = require('readline');
const path = require('path');

const ADAPTER_TIMELINE_METHOD = 'agent/timeline';
const ADAPTER_TRANSCRIPT_METHOD = 'agent/transcript_delta';

const TOOL_NAME_TODO = new Set(['TodoWrite', 'todo_write']);
const TOOL_NAME_BASH = new Set(['Bash', 'bash']);
const TOOL_NAME_READ = new Set(['Read', 'read']);
const TOOL_NAME_WRITE = new Set(['Write', 'write']);
const TOOL_NAME_EDIT = new Set(['Edit', 'edit']);
const TOOL_NAME_GLOB = new Set(['Glob', 'glob']);
const TOOL_NAME_GREP = new Set(['Grep', 'grep', 'GrepTool']);
const TOOL_NAME_WEB_FETCH = new Set(['WebFetch', 'web_fetch', 'WebFetchTool']);
const TOOL_NAME_WEB_SEARCH = new Set(['WebSearch', 'web_search', 'WebSearchTool']);
const READ_ONLY_BLOCKED_TOOLS = new Set(['Bash', 'Write', 'Edit']);
const READ_ONLY_EXTERNAL_TOOLS = new Set(['WebFetch', 'WebSearch']);

function isAdapterDebugEnabled(env = process.env) {
  return env.SYMPHONY_ADAPTER_DEBUG === '1';
}

function formatCompactNumber(value) {
  const numeric = Number(value) || 0;
  if (Math.abs(numeric) < 1000) {
    return String(numeric);
  }

  const units = ['k', 'm', 'b'];
  let current = numeric;
  let unitIndex = -1;
  while (Math.abs(current) >= 1000 && unitIndex < units.length - 1) {
    current /= 1000;
    unitIndex += 1;
  }

  const rounded =
    Math.abs(current) >= 10 ? current.toFixed(0) : current.toFixed(1);
  return `${rounded.replace(/\.0$/, '')}${units[unitIndex]}`;
}

function formatTurnCompletedMessage(turn, tokens) {
  const input = tokens && typeof tokens.input === 'number' ? tokens.input : 0;
  const output =
    tokens && typeof tokens.output === 'number' ? tokens.output : 0;
  if (input > 0 || output > 0) {
    return `Turn ${turn} completed · in ${formatCompactNumber(input)} / out ${formatCompactNumber(output)}`;
  }
  return `Turn ${turn} completed`;
}

function normalizeToolName(toolName) {
  if (TOOL_NAME_BASH.has(toolName)) return 'Bash';
  if (TOOL_NAME_READ.has(toolName)) return 'Read';
  if (TOOL_NAME_WRITE.has(toolName)) return 'Write';
  if (TOOL_NAME_EDIT.has(toolName)) return 'Edit';
  if (TOOL_NAME_GLOB.has(toolName)) return 'Glob';
  if (TOOL_NAME_GREP.has(toolName)) return 'Grep';
  if (TOOL_NAME_WEB_FETCH.has(toolName)) return 'WebFetch';
  if (TOOL_NAME_WEB_SEARCH.has(toolName)) return 'WebSearch';
  if (TOOL_NAME_TODO.has(toolName)) return 'TodoWrite';
  return toolName || 'Tool';
}

function truncatePreview(value, maxLength = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function firstNonEmptyString(input, keys) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function buildToolSummary(toolName, toolInput) {
  const normalizedToolName = normalizeToolName(toolName);

  if (normalizedToolName === 'Bash') {
    return truncatePreview(firstNonEmptyString(toolInput, ['command', 'cmd']) || '', 140) || null;
  }

  if (normalizedToolName === 'Read' || normalizedToolName === 'Write' || normalizedToolName === 'Edit') {
    return firstNonEmptyString(toolInput, ['file_path', 'path', 'target_file']);
  }

  if (normalizedToolName === 'Glob') {
    const pattern = firstNonEmptyString(toolInput, ['pattern']);
    const searchPath = firstNonEmptyString(toolInput, ['path']);
    if (pattern && searchPath) {
      return `${pattern} in ${searchPath}`;
    }
    return pattern || searchPath;
  }

  if (normalizedToolName === 'Grep') {
    const pattern = firstNonEmptyString(toolInput, ['pattern', 'query']);
    const searchPath = firstNonEmptyString(toolInput, ['path']);
    if (pattern && searchPath) {
      return `${pattern} in ${searchPath}`;
    }
    return pattern || searchPath;
  }

  if (normalizedToolName === 'WebFetch') {
    return firstNonEmptyString(toolInput, ['url']);
  }

  if (normalizedToolName === 'WebSearch') {
    return truncatePreview(
      firstNonEmptyString(toolInput, ['query', 'search_term', 'term']) || '',
      140,
    ) || null;
  }

  if (normalizedToolName === 'TodoWrite') {
    const todos = Array.isArray(toolInput && toolInput.todos) ? toolInput.todos : [];
    const labels = todos
      .map((todo) => {
        if (!todo || typeof todo !== 'object') {
          return null;
        }
        if (typeof todo.content === 'string' && todo.content.trim()) {
          return truncatePreview(todo.content, 60);
        }
        if (typeof todo.activeForm === 'string' && todo.activeForm.trim()) {
          return truncatePreview(todo.activeForm, 60);
        }
        return null;
      })
      .filter(Boolean);
    if (labels.length > 0) {
      return labels.slice(0, 2).join(', ');
    }
  }

  return null;
}

function buildToolDetail(toolName, toolInput, resultText) {
  const normalizedToolName = normalizeToolName(toolName);
  const detail = {
    output_length: typeof resultText === 'string' ? resultText.length : 0,
  };
  const summary = buildToolSummary(normalizedToolName, toolInput);

  if (summary) {
    detail.summary = summary;
  }

  const path = firstNonEmptyString(toolInput, ['file_path', 'path', 'target_file']);
  if (path && (normalizedToolName === 'Read' || normalizedToolName === 'Write' || normalizedToolName === 'Edit')) {
    detail.path = path;
  }

  const commandPreview = firstNonEmptyString(toolInput, ['command', 'cmd']);
  if (commandPreview && normalizedToolName === 'Bash') {
    detail.command_preview = truncatePreview(commandPreview, 140);
  }

  const pattern = firstNonEmptyString(toolInput, ['pattern', 'query']);
  if (pattern && (normalizedToolName === 'Glob' || normalizedToolName === 'Grep' || normalizedToolName === 'WebSearch')) {
    detail.pattern = truncatePreview(pattern, 100);
  }

  const url = firstNonEmptyString(toolInput, ['url']);
  if (url && normalizedToolName === 'WebFetch') {
    detail.url = url;
  }

  return detail;
}

function buildTimelineEvent({
  level = 'info',
  category,
  code,
  message,
  turn = null,
  toolName = null,
  detail = null,
}) {
  return {
    method: ADAPTER_TIMELINE_METHOD,
    params: {
      level,
      category,
      code,
      message,
      turn,
      tool_name: toolName,
      detail,
    },
  };
}

function createTimelineState() {
  return {
    assistantThinkingTurn: null,
  };
}

function extractToolUses(ccMsg) {
  const content =
    ccMsg && ccMsg.message && Array.isArray(ccMsg.message.content)
      ? ccMsg.message.content
      : [];
  return content.filter((contentItem) => contentItem && contentItem.type === 'tool_use');
}

function extractToolResultBlocks(ccMsg) {
  const content =
    ccMsg && ccMsg.message && Array.isArray(ccMsg.message.content)
      ? ccMsg.message.content
      : [];
  return content.filter(
    (contentItem) => contentItem && contentItem.type === 'tool_result',
  );
}

function extractContentText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => extractContentText(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (!content || typeof content !== 'object') {
    return '';
  }

  if (content.type === 'text' && typeof content.text === 'string') {
    return content.text;
  }

  if ('content' in content) {
    return extractContentText(content.content);
  }

  return '';
}

function collectTranscriptEventsFromClaudeMessage(ccMsg, context) {
  const events = [];
  const turn = typeof context.turn === 'number' ? context.turn : null;

  if (ccMsg.type === 'assistant') {
    const text = extractContentText(ccMsg.message && ccMsg.message.content);
    if (text) {
      events.push({
        method: ADAPTER_TRANSCRIPT_METHOD,
        params: {
          role: 'assistant',
          kind: 'message',
          text,
          turn,
          tool_name: null,
        },
      });
    }
  }

  if (ccMsg.type === 'user') {
    for (const block of extractToolResultBlocks(ccMsg)) {
      const toolName = context.pendingToolUses.get(block.tool_use_id)?.toolName || null;
      const text = extractContentText(block.content);
      if (text) {
        events.push({
          method: ADAPTER_TRANSCRIPT_METHOD,
          params: {
            role: 'user',
            kind: 'tool_result',
            text,
            turn,
            tool_name: toolName ? normalizeToolName(toolName) : null,
          },
        });
      }
    }
  }

  return events;
}

function collectTimelineEventsFromClaudeMessage(ccMsg, context) {
  const timelineState = context.timelineState || createTimelineState();
  const turn = typeof context.turn === 'number' ? context.turn : null;
  const events = [];
  const toolUses = extractToolUses(ccMsg);
  const hasAssistantActivity = Boolean(
    ccMsg.type === 'assistant' || ccMsg.type === 'text_delta' || toolUses.length > 0,
  );

  if (
    turn !== null &&
    hasAssistantActivity &&
    timelineState.assistantThinkingTurn !== turn
  ) {
    timelineState.assistantThinkingTurn = turn;
    events.push(
      buildTimelineEvent({
        category: 'turn',
        code: 'assistant_thinking',
        message: 'Claude is thinking',
        turn,
      }),
    );
  }

  if (ccMsg.type === 'system' && ccMsg.subtype === 'api_retry') {
    const retryDelayMs = Math.round(Number(ccMsg.retry_delay_ms) || 0);
    const seconds =
      retryDelayMs > 0 ? Math.max(1, Math.round(retryDelayMs / 1000)) : 0;
    events.push(
      buildTimelineEvent({
        level: 'warn',
        category: 'rate_limit',
        code: 'rate_limit_retry',
        message:
          seconds > 0
            ? `Rate limit hit · retrying in ${seconds}s`
            : 'Rate limit hit · retrying',
        turn,
        detail: {
          attempt: Number(ccMsg.attempt) || 0,
          retry_delay_ms: retryDelayMs,
        },
      }),
    );
  }

  for (const toolUse of toolUses) {
    const toolName = normalizeToolName(toolUse.name);
    events.push(
      buildTimelineEvent({
        category: 'tool',
        code: 'tool_started',
        message: `Using ${toolName}`,
        turn,
        toolName,
        detail: {
          tool_call_id: toolUse.id || null,
          ...buildToolDetail(toolName, toolUse.input || {}, ''),
        },
      }),
    );
  }

  return {
    events,
    timelineState,
  };
}

function buildToolResultTimelineEvents({
  toolName,
  failed,
  resultText,
  turn,
  toolInput,
}) {
  const normalizedToolName = normalizeToolName(toolName);
  const detail = buildToolDetail(toolName, toolInput, resultText);

  if (TOOL_NAME_TODO.has(toolName)) {
    const todos = Array.isArray(toolInput && toolInput.todos) ? toolInput.todos : [];
    return [
      buildTimelineEvent({
        category: 'todo',
        code: 'todo_updated',
        message: `Updated todo list (${todos.length} item${todos.length === 1 ? '' : 's'})`,
        turn,
        toolName: normalizedToolName,
        detail: {
          todo_count: todos.length,
          ...(detail.summary ? { summary: detail.summary } : {}),
        },
      }),
    ];
  }

  if (failed) {
    return [
      buildTimelineEvent({
        level: 'error',
        category: 'tool',
        code: 'tool_failed',
        message: `${normalizedToolName} failed`,
        turn,
        toolName: normalizedToolName,
        detail,
      }),
    ];
  }

  return [
    buildTimelineEvent({
      category: 'tool',
      code: 'tool_completed',
      message: `${normalizedToolName} completed`,
      turn,
      toolName: normalizedToolName,
      detail,
    }),
  ];
}

function createAdapterRuntime() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  return {
    rl,
    childProcess: null,
    childCwd: process.cwd(),
    apiCallCount: 0,
    turnCounter: 0,
    lastOrchTurnCompleted: -1,
    pendingOrchTurn: null,
    processingOrchTurns: new Set(),
    seenTurnRequestIds: new Set(),
    childStdoutBuffer: '',
    childStderrBuffer: '',
    lastChildErrorMessage: null,
    timelineState: createTimelineState(),
    pendingToolUses: new Map(),
    nextRuntimeRequestId: 1,
    pendingControlRequests: new Map(),
    readOnlyMode: false,
    allowExternalWebTools: false,
  };
}

function startAdapter({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const runtime = createAdapterRuntime();
  const debugEnabled = isAdapterDebugEnabled(env);

  if (
    stdin !== process.stdin ||
    stdout !== process.stdout ||
    stderr !== process.stderr
  ) {
    runtime.rl.close();
    runtime.rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: false,
    });
  }

  function sendToOrchestrator(payload) {
    stdout.write(`${JSON.stringify(payload)}\n`);
  }

  function emitDebugLog(message) {
    if (!debugEnabled) {
      return;
    }
    stderr.write(`[adapter] ${message}\n`);
  }

  function emitTimelineEvent(event) {
    sendToOrchestrator(event);
  }

  function emitTranscriptEvent(event) {
    sendToOrchestrator(event);
  }

  function emitTurnStartedTimeline(turn) {
    emitTimelineEvent(
      buildTimelineEvent({
        category: 'turn',
        code: 'turn_started',
        message: `Turn ${turn} started`,
        turn,
      }),
    );
  }

  function emitTurnFailedTimeline(turn, message) {
    emitTimelineEvent(
      buildTimelineEvent({
        level: 'error',
        category: 'turn',
        code: 'turn_failed',
        message:
          turn !== null
            ? `Turn ${turn} failed${message ? ` · ${message}` : ''}`
            : `Turn failed${message ? ` · ${message}` : ''}`,
        turn,
        detail: message ? { error: message } : null,
      }),
    );
  }

  function emitTurnCancelledTimeline(turn) {
    emitTimelineEvent(
      buildTimelineEvent({
        level: 'warn',
        category: 'turn',
        code: 'turn_cancelled',
        message: turn !== null ? `Turn ${turn} cancelled` : 'Turn cancelled',
        turn,
      }),
    );
  }

  function emitTurnCompletedTimeline(turn, tokens) {
    emitTimelineEvent(
      buildTimelineEvent({
        category: 'turn',
        code: 'turn_completed',
        message: formatTurnCompletedMessage(turn, tokens),
        turn,
        detail: tokens
          ? {
              input_tokens: tokens.input || 0,
              output_tokens: tokens.output || 0,
              total_tokens: tokens.total || 0,
            }
          : null,
      }),
    );
  }

  function resetTurnState() {
    runtime.timelineState.assistantThinkingTurn = null;
    runtime.pendingToolUses.clear();
  }

  function completeTurnIfNeeded(tokens) {
    if (
      runtime.pendingOrchTurn === null ||
      runtime.lastOrchTurnCompleted === runtime.pendingOrchTurn
    ) {
      return;
    }

    const turn = runtime.pendingOrchTurn;
    const finalTokens = tokens || { input: 0, output: 0, total: 0 };
    runtime.apiCallCount = Math.max(1, runtime.apiCallCount || 1);

    emitTurnCompletedTimeline(turn, finalTokens);
    sendToOrchestrator({
      method: 'turn/completed',
      result: {
        turn: {
          id: `adapter-turn-${turn}`,
          api_calls: runtime.apiCallCount,
          tokens: finalTokens,
        },
      },
    });

    runtime.lastOrchTurnCompleted = turn;
    runtime.processingOrchTurns.delete(turn);
    runtime.apiCallCount = 0;
  }

  function failCurrentTurn(message) {
    if (
      runtime.pendingOrchTurn === null ||
      runtime.lastOrchTurnCompleted === runtime.pendingOrchTurn
    ) {
      return;
    }

    emitTurnFailedTimeline(runtime.pendingOrchTurn, message);
    sendToOrchestrator({
      method: 'turn/failed',
      result: { error: message },
    });
    runtime.lastOrchTurnCompleted = runtime.pendingOrchTurn;
    runtime.processingOrchTurns.delete(runtime.pendingOrchTurn);
    runtime.apiCallCount = 0;
  }

  function describeUnavailableChildProcess() {
    const lastError = typeof runtime.lastChildErrorMessage === 'string'
      ? runtime.lastChildErrorMessage.trim()
      : '';
    if (lastError) {
      return `Claude process unavailable: ${lastError}`;
    }
    return 'Claude process not spawned or stdin closed.';
  }

  function sendClaudeControlResponse(requestId, result, error) {
    if (!runtime.childProcess || !runtime.childProcess.stdin || !runtime.childProcess.stdin.writable) {
      emitDebugLog(`Claude stdin unavailable while answering control request ${requestId}`);
      return;
    }

    const payload = error
      ? {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: requestId,
            error,
          },
        }
      : {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: result,
          },
        };

    runtime.childProcess.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function forwardRuntimeRequest(ccMsg) {
    const subtype = ccMsg.request && ccMsg.request.subtype;
    if (runtime.readOnlyMode && subtype === 'can_use_tool') {
      const toolName = normalizeToolName(ccMsg.request && ccMsg.request.tool_name);
      if (READ_ONLY_BLOCKED_TOOLS.has(toolName)) {
        sendClaudeControlResponse(ccMsg.request_id, {
          behavior: 'deny',
          message: `${toolName} is disabled in read-only repo understanding mode.`,
          ...(ccMsg.request?.tool_use_id ? { toolUseID: ccMsg.request.tool_use_id } : {}),
        });
        return;
      }
      if (READ_ONLY_EXTERNAL_TOOLS.has(toolName) && !runtime.allowExternalWebTools) {
        sendClaudeControlResponse(ccMsg.request_id, {
          behavior: 'deny',
          message: `${toolName} is disabled unless the user explicitly asks for external research.`,
          ...(ccMsg.request?.tool_use_id ? { toolUseID: ccMsg.request.tool_use_id } : {}),
        });
        return;
      }
    }

    const runnerRequestId = runtime.nextRuntimeRequestId++;
    runtime.pendingControlRequests.set(runnerRequestId, {
      claudeRequestId: ccMsg.request_id,
      subtype,
    });

    if (subtype === 'can_use_tool') {
      sendToOrchestrator({
        id: runnerRequestId,
        method: 'approval/request',
        params: {
          request_id: ccMsg.request_id,
          turn: runtime.pendingOrchTurn,
          request: ccMsg.request,
        },
      });
      return;
    }

    if (subtype === 'elicitation') {
      sendToOrchestrator({
        id: runnerRequestId,
        method: 'item/tool/requestUserInput',
        params: {
          request_id: ccMsg.request_id,
          turn: runtime.pendingOrchTurn,
          request: ccMsg.request,
        },
      });
      return;
    }

    emitTimelineEvent(
      buildTimelineEvent({
        level: 'error',
        category: 'diagnostic',
        code: 'turn_failed',
        message: `Unsupported control request subtype: ${subtype || 'unknown'}`,
        turn: runtime.pendingOrchTurn,
        detail: {
          subtype: subtype || null,
        },
      }),
    );
    runtime.pendingControlRequests.delete(runnerRequestId);
    sendClaudeControlResponse(
      ccMsg.request_id,
      null,
      `Unsupported control request subtype: ${subtype || 'unknown'}`,
    );
  }

  function processToolLifecycle(ccMsg) {
    for (const toolUse of extractToolUses(ccMsg)) {
      if (toolUse.id) {
        runtime.pendingToolUses.set(toolUse.id, {
          toolName: toolUse.name,
          input: toolUse.input || {},
        });
      }
    }

    if (ccMsg.type !== 'user') {
      return;
    }

    for (const toolResult of extractToolResultBlocks(ccMsg)) {
      const pendingTool = runtime.pendingToolUses.get(toolResult.tool_use_id);
      const toolName = pendingTool?.toolName || 'Tool';
      const resultText = extractContentText(toolResult.content);
      const failed = Boolean(toolResult.is_error);

      for (const event of buildToolResultTimelineEvents({
        toolName,
        failed,
        resultText,
        turn: runtime.pendingOrchTurn,
        toolInput: pendingTool?.input || {},
      })) {
        emitTimelineEvent(event);
      }

      runtime.pendingToolUses.delete(toolResult.tool_use_id);
    }
  }

  function processClaudeStderrChunk(chunk) {
    runtime.childStderrBuffer += chunk.toString();
    const lines = runtime.childStderrBuffer.split('\n');
    runtime.childStderrBuffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        runtime.lastChildErrorMessage = line.trim();
        emitDebugLog(`Claude stderr: ${line.trim()}`);
      }
    }
  }

  function processClaudeStdoutChunk(chunk) {
    runtime.childStdoutBuffer += chunk.toString();
    const lines = runtime.childStdoutBuffer.split('\n');
    runtime.childStdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const ccMsg = JSON.parse(line);
        emitDebugLog(
          `Claude emitted: ${ccMsg.type}${ccMsg.subtype ? `/${ccMsg.subtype}` : ''}`,
        );

        if (ccMsg.type === 'control_request') {
          forwardRuntimeRequest(ccMsg);
          continue;
        }

        if (ccMsg.type === 'control_cancel_request') {
          for (const [runnerRequestId, pending] of runtime.pendingControlRequests.entries()) {
            if (pending.claudeRequestId === ccMsg.request_id) {
              runtime.pendingControlRequests.delete(runnerRequestId);
            }
          }
          continue;
        }

        const { events } = collectTimelineEventsFromClaudeMessage(ccMsg, {
          turn: runtime.pendingOrchTurn,
          timelineState: runtime.timelineState,
        });
        for (const event of events) {
          emitTimelineEvent(event);
        }

        for (const transcriptEvent of collectTranscriptEventsFromClaudeMessage(ccMsg, {
          turn: runtime.pendingOrchTurn,
          pendingToolUses: runtime.pendingToolUses,
        })) {
          emitTranscriptEvent(transcriptEvent);
        }

        processToolLifecycle(ccMsg);

        if (ccMsg.type === 'result' && ccMsg.subtype === 'success') {
          runtime.apiCallCount = Math.max(
            Number(ccMsg.num_turns) || 0,
            runtime.apiCallCount || 0,
            1,
          );
          const usage = ccMsg.usage || {};
          completeTurnIfNeeded({
            input: Number(usage.input_tokens) || 0,
            output: Number(usage.output_tokens) || 0,
            total:
              (Number(usage.input_tokens) || 0) +
              (Number(usage.output_tokens) || 0),
          });
          continue;
        }

        if (ccMsg.type === 'result' && ccMsg.is_error) {
          const errorMessage =
            Array.isArray(ccMsg.errors) && ccMsg.errors.length > 0
              ? ccMsg.errors.join('; ')
              : ccMsg.result || 'Claude turn failed';
          failCurrentTurn(String(errorMessage));
          continue;
        }

        if (ccMsg.type === 'error') {
          const errorMessage =
            ccMsg.message || ccMsg.error || 'Unknown Claude error';
          failCurrentTurn(
            typeof errorMessage === 'object'
              ? JSON.stringify(errorMessage)
              : String(errorMessage),
          );
          continue;
        }

        if (ccMsg.type === 'text_delta') {
          sendToOrchestrator({ method: 'turn/progress', text: ccMsg.text });
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        emitDebugLog(`Ignoring non-JSON Claude output line: ${errorMessage}`);
      }
    }
  }

  runtime.rl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }

    try {
      const msg = JSON.parse(line);

      if (
        typeof msg.id === 'number' &&
        !msg.method &&
        runtime.pendingControlRequests.has(msg.id)
      ) {
        const pending = runtime.pendingControlRequests.get(msg.id);
        runtime.pendingControlRequests.delete(msg.id);
        if (pending) {
          if (msg.error) {
            sendClaudeControlResponse(
              pending.claudeRequestId,
              null,
              msg.error.message || 'Runtime request failed',
            );
          } else {
            sendClaudeControlResponse(pending.claudeRequestId, msg.result || {});
          }
        }
        return;
      }

      if (msg.method === 'initialize') {
        emitDebugLog('Received initialize');
        sendToOrchestrator({ method: 'initialized' });
        sendToOrchestrator({ id: msg.id, result: { thread: { id: 'adapter-thread-1' } } });
        return;
      }

      if (msg.method === 'thread/start') {
        const cwd = msg.params?.cwd || process.cwd();
        const sandbox = String(msg.params?.sandbox || '').toLowerCase();
        runtime.readOnlyMode = sandbox === 'workspace-read' || sandbox === 'read-only';
        runtime.allowExternalWebTools = false;
        runtime.childCwd = cwd;
        runtime.childStdoutBuffer = '';
        runtime.childStderrBuffer = '';
        runtime.lastChildErrorMessage = null;
        runtime.timelineState = createTimelineState();
        runtime.pendingToolUses.clear();
        emitDebugLog(`Received thread/start. Spawning Claude Code at ${cwd}`);

        const cliPath = path.resolve(__dirname, '../claude-code/bin/claude-haha');
        const args = [
          '--bare',
          '-c',
          '-p',
          '--verbose',
          '--input-format', 'stream-json',
          '--output-format', 'stream-json',
          '--replay-user-messages',
          '--permission-mode', 'default',
          '--permission-prompt-tool', 'stdio',
        ];

        runtime.childProcess = cp.spawn(cliPath, args, {
          cwd,
          env: {
            ...env,
            CLAUDE_CODE_SIMPLE: env.CLAUDE_CODE_SIMPLE || '1',
            CLAUDE_CODE_GLOB_HIDDEN: env.CLAUDE_CODE_GLOB_HIDDEN || 'false',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || '1',
            CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS || '1',
            CLAUDE_CODE_READ_ONLY: runtime.readOnlyMode ? '1' : env.CLAUDE_CODE_READ_ONLY || '0',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        runtime.childProcess.stdout.on('data', processClaudeStdoutChunk);
        runtime.childProcess.stderr.on('data', processClaudeStderrChunk);
        runtime.childProcess.on('error', (error) => {
          runtime.lastChildErrorMessage = error instanceof Error ? error.message : String(error);
          emitDebugLog(`Claude process spawn error: ${runtime.lastChildErrorMessage}`);
        });
        runtime.childProcess.on('exit', (code) => {
          const trailingStderr = runtime.childStderrBuffer.trim();
          if (trailingStderr) {
            runtime.lastChildErrorMessage = trailingStderr;
          } else if (!runtime.lastChildErrorMessage && code !== 0) {
            runtime.lastChildErrorMessage = `process exited with code ${code}`;
          }
          emitDebugLog(`Claude process exited with code ${code}`);
        });

        emitTimelineEvent(
          buildTimelineEvent({
            category: 'session',
            code: 'session_started',
            message: 'Session started',
            detail: { cwd },
          }),
        );

        sendToOrchestrator({
          id: msg.id,
          result: { thread: { id: 'adapter-thread-1' } },
        });
        return;
      }

      if (msg.method === 'turn/start') {
        const requestId = msg.id ?? `turn-start-${runtime.turnCounter + 1}`;
        if (runtime.seenTurnRequestIds.has(requestId)) {
          emitDebugLog(`Received duplicate turn/start request id=${requestId}, ignoring`);
          return;
        }

        runtime.seenTurnRequestIds.add(requestId);
        runtime.turnCounter += 1;
        runtime.processingOrchTurns.add(runtime.turnCounter);
        runtime.pendingOrchTurn = runtime.turnCounter;
        const sandboxPolicy = msg.params?.sandboxPolicy;
        runtime.allowExternalWebTools = Boolean(
          sandboxPolicy &&
          typeof sandboxPolicy === 'object' &&
          (
            sandboxPolicy.allowExternalResearch === true ||
            sandboxPolicy.allowExternalWebTools === true
          )
        );
        resetTurnState();
        emitDebugLog(`Received turn/start (orch=${runtime.pendingOrchTurn})`);

        sendToOrchestrator({
          id: msg.id,
          result: { turn: { id: `adapter-turn-${runtime.pendingOrchTurn}` } },
        });
        emitTurnStartedTimeline(runtime.pendingOrchTurn);

        if (
          runtime.childProcess &&
          runtime.childProcess.stdin &&
          runtime.childProcess.stdin.writable
        ) {
          let textPrompt = '';
          if (msg.params?.input && msg.params.input.length > 0) {
            textPrompt = msg.params.input[0].text;
          } else if (msg.params?.text) {
            textPrompt = msg.params.text;
          }

          runtime.childProcess.stdin.write(
            `${JSON.stringify({
              type: 'user',
              message: { role: 'user', content: textPrompt },
            })}\n`,
          );
        } else {
          failCurrentTurn(describeUnavailableChildProcess());
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      emitDebugLog(`Input parsing error: ${errorMessage}`);
    }
  });

  runtime.rl.on('close', () => {
    emitDebugLog(
      'Standard input stream severed. Parent must have died. Committing suicide.',
    );
    if (
      runtime.pendingOrchTurn !== null &&
      runtime.lastOrchTurnCompleted !== runtime.pendingOrchTurn
    ) {
      emitTurnCancelledTimeline(runtime.pendingOrchTurn);
    }
    if (runtime.childProcess) {
      runtime.childProcess.kill('SIGKILL');
    }
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    if (
      runtime.pendingOrchTurn !== null &&
      runtime.lastOrchTurnCompleted !== runtime.pendingOrchTurn
    ) {
      emitTurnCancelledTimeline(runtime.pendingOrchTurn);
    }
    if (runtime.childProcess) runtime.childProcess.kill('SIGKILL');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    if (
      runtime.pendingOrchTurn !== null &&
      runtime.lastOrchTurnCompleted !== runtime.pendingOrchTurn
    ) {
      emitTurnCancelledTimeline(runtime.pendingOrchTurn);
    }
    if (runtime.childProcess) runtime.childProcess.kill('SIGKILL');
    process.exit(0);
  });

  emitDebugLog('Started and listening for standard JSON-RPC');
  return runtime;
}

module.exports = {
  ADAPTER_TIMELINE_METHOD,
  ADAPTER_TRANSCRIPT_METHOD,
  buildTimelineEvent,
  buildToolResultTimelineEvents,
  collectTimelineEventsFromClaudeMessage,
  collectTranscriptEventsFromClaudeMessage,
  createTimelineState,
  formatCompactNumber,
  formatTurnCompletedMessage,
  isAdapterDebugEnabled,
  normalizeToolName,
  startAdapter,
};

if (require.main === module) {
  startAdapter();
}
