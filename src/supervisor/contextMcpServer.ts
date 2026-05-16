import {
  SUPERVISOR_CONTEXT_TOOL_NAMES,
  type SupervisorContextToolName,
} from './contextBroker';
import { readSymHarixEnv } from '../config/env';

type JsonRpcMessage = {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const TOOL_DESCRIPTIONS: Record<SupervisorContextToolName, string> = {
  list_context_sources: 'List the available supervisor context sources and when to use them.',
  get_runtime_overview: 'Read compact runtime counts plus active, failed, and recent completed issue summaries without deep repo inspection.',
  get_recent_completed_issues: 'Read recent Done/non-cancelled completed issues ranked by review and PR delivery evidence.',
  get_issue: 'Read one issue projection including tracker, orchestrator, delivery, session, and governance state.',
  get_issue_history: 'Read a compact replay digest for one issue.',
  get_issue_timeline: 'Read recent runtime timeline events for one issue.',
  get_conversation_state: 'Read default project, focused issue/repo, and active plan state for this conversation.',
  get_repo_route: 'Resolve the configured project-to-repository route.',
  prepare_repo_source: 'Prepare or inspect the read-only repo source cache for the active route.',
  get_repo_profile: 'Read a shallow repository profile from README, manifests, and top-level paths.',
  get_repo_understanding: 'Read cached Claude Code repository understanding by commit.',
  search_supervisor_memory: 'Search prior supervisor memory for repo-specific lessons and execution patterns.',
  get_plan_session: 'Read the active supervisor Plan Card/session for this conversation.',
  get_governance_signals: 'Read governance harness, constitution, decision, conflict, and debt signals.',
  recommend_repo_issue: 'Produce one evidence-backed next issue recommendation.',
};

let useContentLengthFraming = false;

function writeMessage(message: Record<string, unknown>): void {
  const payload = JSON.stringify({ jsonrpc: '2.0', ...message });
  if (useContentLengthFraming) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
    return;
  }
  process.stdout.write(`${payload}\n`);
}

function writeResult(id: JsonRpcMessage['id'], result: Record<string, unknown>): void {
  if (id === undefined || id === null) {
    return;
  }
  writeMessage({ id, result });
}

function writeError(id: JsonRpcMessage['id'], code: number, message: string): void {
  if (id === undefined || id === null) {
    return;
  }
  writeMessage({
    id,
    error: {
      code,
      message,
    },
  });
}

function buildInputSchema(toolName: SupervisorContextToolName): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    text: {
      type: 'string',
      description: 'Optional copy of the user request for relevance and fallback issue extraction.',
    },
  };
  if (toolName === 'get_issue' || toolName === 'get_issue_history' || toolName === 'get_issue_timeline') {
    properties.issue_id = {
      type: 'string',
      description: 'Issue identifier such as INT-162 or an internal issue id.',
    };
  }
  if (
    toolName === 'get_issue_history' ||
    toolName === 'get_issue_timeline' ||
    toolName === 'search_supervisor_memory' ||
    toolName === 'get_recent_completed_issues'
  ) {
    properties.limit = {
      type: 'number',
      description: 'Maximum number of entries to return.',
    };
  }
  if (toolName === 'search_supervisor_memory') {
    properties.query = {
      type: 'string',
      description: 'Memory search query.',
    };
  }
  if (toolName === 'get_repo_understanding') {
    properties.force_refresh = {
      type: 'boolean',
      description: 'When true, request a fresh repository understanding instead of cache-only.',
    };
  }

  return {
    type: 'object',
    additionalProperties: true,
    properties,
  };
}

function listTools(): Array<Record<string, unknown>> {
  return SUPERVISOR_CONTEXT_TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: buildInputSchema(name),
  }));
}

function getDefaultContext(args: Record<string, unknown>): Record<string, unknown> {
  return {
    transport: readSymHarixEnv('SYMPHONY_SUPERVISOR_CONTEXT_TRANSPORT') || 'telegram',
    conversation_id:
      readSymHarixEnv('SYMPHONY_SUPERVISOR_CONTEXT_CONVERSATION_ID') ||
      (typeof args.conversation_id === 'string' ? args.conversation_id : 'supervisor-context'),
    user_id: typeof args.user_id === 'string' ? args.user_id : null,
    display_name: typeof args.display_name === 'string' ? args.display_name : null,
    repo_ref: readSymHarixEnv('SYMPHONY_SUPERVISOR_CONTEXT_REPO_REF') || null,
  };
}

async function callBroker(toolName: SupervisorContextToolName, args: Record<string, unknown>): Promise<unknown> {
  const endpoint = readSymHarixEnv('SYMPHONY_SUPERVISOR_CONTEXT_ENDPOINT')?.trim();
  if (!endpoint) {
    return {
      error: 'context_endpoint_not_configured',
      message:
        'Supervisor context MCP server needs SYMHARIX_SUPERVISOR_CONTEXT_ENDPOINT; legacy SYMPHONY_SUPERVISOR_CONTEXT_ENDPOINT is also accepted.',
    };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(readSymHarixEnv('SYMPHONY_SUPERVISOR_CONTEXT_TOKEN')
        ? { 'x-supervisor-context-token': readSymHarixEnv('SYMPHONY_SUPERVISOR_CONTEXT_TOKEN') }
        : {}),
    },
    body: JSON.stringify({
      tool: toolName,
      arguments: args,
      context: getDefaultContext(args),
      text: typeof args.text === 'string' ? args.text : null,
    }),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    return {
      error: 'context_broker_call_failed',
      status: response.status,
      body: payload,
    };
  }
  return payload?.result ?? payload;
}

async function handleMessage(message: JsonRpcMessage): Promise<void> {
  const id = message.id;
  switch (message.method) {
    case 'initialize':
      writeResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'supervisor-context',
          version: '1.0.0',
        },
      });
      return;
    case 'notifications/initialized':
      return;
    case 'ping':
      writeResult(id, {});
      return;
    case 'tools/list':
      writeResult(id, { tools: listTools() });
      return;
    case 'tools/call': {
      const params = message.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      if (!(SUPERVISOR_CONTEXT_TOOL_NAMES as readonly string[]).includes(name)) {
        writeError(id, -32602, `Unknown supervisor context tool: ${name}`);
        return;
      }
      const rawArgs = params.arguments;
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs as Record<string, unknown>
        : {};
      const result = await callBroker(name as SupervisorContextToolName, args);
      writeResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
      return;
    }
    default:
      writeError(id, -32601, `Unknown method: ${message.method ?? 'missing'}`);
  }
}

function parseContentLengthMessage(buffer: string): { message: string; rest: string } | null {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    return null;
  }
  const header = buffer.slice(0, headerEnd);
  const lengthMatch = header.match(/content-length:\s*(\d+)/i);
  if (!lengthMatch) {
    return null;
  }
  const length = Number.parseInt(lengthMatch[1], 10);
  const bodyStart = headerEnd + 4;
  if (Buffer.byteLength(buffer.slice(bodyStart), 'utf8') < length) {
    return null;
  }
  const body = buffer.slice(bodyStart, bodyStart + length);
  return {
    message: body,
    rest: buffer.slice(bodyStart + length),
  };
}

let inputBuffer = '';

function processInputBuffer(): void {
  while (inputBuffer.length > 0) {
    if (/^\s*Content-Length:/i.test(inputBuffer)) {
      useContentLengthFraming = true;
      const parsed = parseContentLengthMessage(inputBuffer.trimStart());
      if (!parsed) {
        return;
      }
      inputBuffer = parsed.rest;
      void dispatchRawMessage(parsed.message);
      continue;
    }

    const newlineIndex = inputBuffer.indexOf('\n');
    if (newlineIndex < 0) {
      return;
    }
    const line = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (line) {
      void dispatchRawMessage(line);
    }
  }
}

async function dispatchRawMessage(raw: string): Promise<void> {
  try {
    await handleMessage(JSON.parse(raw) as JsonRpcMessage);
  } catch (error) {
    process.stderr.write(`[supervisor-context-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  processInputBuffer();
});
