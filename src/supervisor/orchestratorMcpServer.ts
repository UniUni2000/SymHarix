import {
  SUPERVISOR_ORCHESTRATOR_TOOL_NAMES,
  type SupervisorOrchestratorToolName,
} from './orchestratorBroker';

type JsonRpcMessage = {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const TOOL_DESCRIPTIONS: Record<SupervisorOrchestratorToolName, string> = {
  list_orchestrator_capabilities: 'List the Supervisor business/control tools, risk levels, and confirmation policies.',
  get_pending_action: 'Read the current open pending approval for this Telegram conversation, if any.',
  list_issues: 'List current tracked issues with optional active/state filters.',
  diagnose_issue: 'Diagnose one issue using tracker, runtime/orchestrator, delivery, and recent event evidence.',
  show_issue_card: 'Render a Telegram issue card. Omit issue_id only when the conversation has a focused issue.',
  show_plan_card: 'Render the active Supervisor plan card when one is available.',
  watch_issue: 'Subscribe this Telegram conversation to issue progress updates. This is a low-risk user-control action.',
  unwatch_issue: 'Remove this Telegram conversation from issue progress updates. This is a low-risk user-control action.',
  retry_issue: 'Retry a retryable issue through the orchestrator policy layer.',
  stop_issue: 'Stop a running issue through the orchestrator policy layer.',
  switch_repository: 'Switch the default repository for this Telegram conversation. Accepts project slug, owner/repo, or repo basename.',
  set_default_project: 'Set the default project for this Telegram conversation.',
  create_issue: 'Create a new issue through the orchestrator. This is confirmation-gated by default.',
  close_issue: 'Close or discard an issue through the orchestrator. This is confirmation-gated by default.',
  supersede_issue: 'Supersede an issue with another issue through the orchestrator. This is confirmation-gated by default.',
  override_governance: 'Override a governance block through the orchestrator. This is confirmation-gated by default.',
  rewrite_governance: 'Ask governance to rewrite the current issue. This is confirmation-gated by default.',
  split_governance: 'Ask governance to split the current issue. This is confirmation-gated by default.',
  execute_governance_suggestion: 'Execute a governance suggestion through the orchestrator. This is confirmation-gated by default.',
  dismiss_governance_suggestion: 'Dismiss a governance suggestion through the orchestrator. This is confirmation-gated by default.',
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
    error: { code, message },
  });
}

function buildInputSchema(toolName: SupervisorOrchestratorToolName): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    text: {
      type: 'string',
      description: 'Optional copy of the user request for relevance and fallback issue extraction.',
    },
    issue_id: {
      type: 'string',
      description: 'Issue identifier such as INT-163. May be omitted for focused issue card/status/control requests.',
    },
    state_filter: {
      type: 'string',
      description: 'Optional issue state filter: active, open, failed, cancelled, completed, review.',
    },
    active_only: {
      type: 'boolean',
      description: 'When true, list only user-visible active issues.',
    },
    project_slug: {
      type: 'string',
      description: 'Configured project slug for create_issue, set_default_project, or switch_repository.',
    },
    repo_ref: {
      type: 'string',
      description: 'Repository reference for switch_repository. Can be owner/repo or a repo basename.',
    },
    title: {
      type: 'string',
      description: 'Issue title for create_issue.',
    },
    description: {
      type: 'string',
      description: 'Issue description/body for create_issue.',
    },
    successor_issue_id: {
      type: 'string',
      description: 'Successor issue identifier for supersede_issue.',
    },
    suggestion_id: {
      type: 'string',
      description: 'Governance suggestion id for execute_governance_suggestion or dismiss_governance_suggestion.',
    },
    reason: {
      type: 'string',
      description: 'Brief user-facing reason for a control action.',
    },
    watch_preset: {
      type: 'string',
      description: 'Watch preset for watch_issue: default, verbose, failures, or status.',
    },
  };

  const required = toolName === 'create_issue'
    ? ['title']
    : toolName === 'set_default_project'
      ? ['project_slug']
      : toolName === 'switch_repository'
        ? ['repo_ref']
      : [];

  return {
    type: 'object',
    additionalProperties: true,
    required,
    properties,
  };
}

function listTools(): Array<Record<string, unknown>> {
  return SUPERVISOR_ORCHESTRATOR_TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: buildInputSchema(name),
  }));
}

function getDefaultContext(args: Record<string, unknown>): Record<string, unknown> {
  return {
    transport: process.env.SYMPHONY_SUPERVISOR_ORCHESTRATOR_TRANSPORT || 'telegram',
    conversation_id:
      process.env.SYMPHONY_SUPERVISOR_ORCHESTRATOR_CONVERSATION_ID ||
      (typeof args.conversation_id === 'string' ? args.conversation_id : 'supervisor-orchestrator'),
    user_id: typeof args.user_id === 'string' ? args.user_id : null,
    display_name: typeof args.display_name === 'string' ? args.display_name : null,
    repo_ref: process.env.SYMPHONY_SUPERVISOR_ORCHESTRATOR_REPO_REF || null,
  };
}

async function callBroker(toolName: SupervisorOrchestratorToolName, args: Record<string, unknown>): Promise<unknown> {
  const endpoint = process.env.SYMPHONY_SUPERVISOR_ORCHESTRATOR_ENDPOINT?.trim();
  if (!endpoint) {
    return {
      error: 'orchestrator_endpoint_not_configured',
      message: 'Supervisor orchestrator MCP server needs SYMPHONY_SUPERVISOR_ORCHESTRATOR_ENDPOINT.',
    };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.SYMPHONY_SUPERVISOR_ORCHESTRATOR_TOKEN
        ? { 'x-supervisor-orchestrator-token': process.env.SYMPHONY_SUPERVISOR_ORCHESTRATOR_TOKEN }
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
      error: 'orchestrator_broker_call_failed',
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
        capabilities: { tools: {} },
        serverInfo: {
          name: 'supervisor-orchestrator',
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
      if (!(SUPERVISOR_ORCHESTRATOR_TOOL_NAMES as readonly string[]).includes(name)) {
        writeError(id, -32602, `Unknown supervisor orchestrator tool: ${name}`);
        return;
      }
      const rawArgs = params.arguments;
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? rawArgs as Record<string, unknown>
        : {};
      const result = await callBroker(name as SupervisorOrchestratorToolName, args);
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
  let parsed: JsonRpcMessage;
  try {
    parsed = JSON.parse(raw) as JsonRpcMessage;
  } catch {
    writeError(null, -32700, 'Invalid JSON-RPC message.');
    return;
  }
  await handleMessage(parsed).catch((error) => {
    writeError(parsed.id, -32000, error instanceof Error ? error.message : String(error));
  });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += String(chunk);
  processInputBuffer();
});
