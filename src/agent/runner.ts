/**
 * Agent Runner - Codex app-server client and session management
 * Section 10: Agent Runner Protocol
 */

import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as path from 'path';
import {
  AgentEvent,
  AgentEventType,
  AgentTimelinePayload,
  Issue,
  PendingRuntimeRequest,
  RuntimeRequestResponse,
  TurnTranscriptEntry,
  WorkflowDefinition,
} from '../types';
import { Liquid } from 'liquidjs';

/**
 * Codex app-server protocol message types
 */
interface CodexMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ResolvedCommandSpec {
  executable: string;
  args: string[];
}

/**
 * Agent Runner options
 */
export interface AgentRunnerOptions {
  codexCommand: string;
  approvalPolicy?: string | null;
  threadSandbox?: string | null;
  turnSandboxPolicy?: string | null;
  mcpConfig?: string | null;
  tools?: string[] | null;
  allowedTools?: string[] | null;
  systemPrompt?: string | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
  projectRoot: string;
}

/**
 * Turn result
 */
export interface TurnResult {
  success: boolean;
  completed: boolean;  // true if turn_completed, false if failed/cancelled
  cancelled: boolean;
  error?: string;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  claude_api_calls: number;
  timeline: AgentTimelinePayload[];
  transcript: TurnTranscriptEntry[];
}

/**
 * Prompt template rendering result
 */
export interface RenderedPrompt {
  prompt: string;
  error?: string;
}

/**
 * Agent Runner - manages Codex app-server sessions
 * Section 10: Agent Runner Protocol
 */
export class AgentRunner extends EventEmitter {
  private options: AgentRunnerOptions;
  private liquid: Liquid;
  private messageCounter: number = 1;
  constructor(options: AgentRunnerOptions) {
    super();
    this.options = options;
    this.liquid = new Liquid({
      strictVariables: true,  // Section 5.4: Unknown variables must fail
      strictFilters: true     // Section 5.4: Unknown filters must fail
    });
  }

  private sendSignal(
    child: cp.ChildProcess,
    signal?: NodeJS.Signals | number,
  ): boolean {
    try {
      const kill = child.kill as
        | ((signal?: NodeJS.Signals | number) => boolean)
        | undefined;
      if (typeof kill === 'function') {
        return kill(signal);
      }
      return false;
    } catch {
      return false;
    }
  }

  private shouldLogDiagnostics(): boolean {
    return process.env.SYMPHONY_ADAPTER_DEBUG === '1';
  }

  /**
   * Parse a command string into structured executable + args.
   * Uses regex split so multi-space tokens don't accumulate empty strings.
   */
  private resolveCommandSpec(command: string): ResolvedCommandSpec {
    const parts = command.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return { executable: command, args: [] };
    }

    const executable = parts[0];
    const args = parts.slice(1);

    // Resolve relative script paths against projectRoot for node / python commands
    if ((executable === 'node' || executable === 'python' || executable === 'python3') && args.length > 0) {
      const script = args[0];
      const resolvedScript = path.isAbsolute(script)
        ? script
        : path.resolve(this.options.projectRoot, script);
      return {
        executable,
        args: [resolvedScript, ...args.slice(1)],
      };
    }

    return { executable, args };
  }

  /**
   * Resolve the Bun executable, preferring the current runtime over a PATH lookup.
   */
  private resolveBunExecutable(): string {
    const currentExec = typeof process.execPath === 'string' ? process.execPath.trim() : '';
    if (currentExec && path.basename(currentExec).toLowerCase().includes('bun')) {
      return currentExec;
    }
    return 'bun';
  }

  /**
   * Build spawn argument array keeping the adapter script path intact
   * even when the project root contains spaces.
   */
  private buildSpawnArgs(command: string): string[] {
    const resolvedCommand = this.resolveCommandSpec(command);

    // node / python / python3 with a script path
    if (
      resolvedCommand.args.length > 0 &&
      (resolvedCommand.executable === 'node' ||
        resolvedCommand.executable === 'python' ||
        resolvedCommand.executable === 'python3')
    ) {
      return [resolvedCommand.executable, ...resolvedCommand.args];
    }

    // CLI command without path separators – invoke directly (e.g. "codex app-server")
    if (
      resolvedCommand.args.length > 0 &&
      !resolvedCommand.executable.includes('/') &&
      !resolvedCommand.executable.includes('\\')
    ) {
      return [resolvedCommand.executable, ...resolvedCommand.args];
    }

    // Other commands with path – wrap with bun run
    return [this.resolveBunExecutable(), 'run', resolvedCommand.executable, ...resolvedCommand.args];
  }

  /**
   * Render prompt template with issue and attempt variables
   * Section 12: Prompt Construction and Context Assembly
   */
  renderPrompt(
    workflow: WorkflowDefinition,
    issue: Issue,
    attempt: number | null
  ): RenderedPrompt {
    try {
      const template = workflow.prompt_template || 'You are working on an issue from Linear.';

      // Convert issue to template-compatible object
      const issueObj: Record<string, unknown> = {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        state: issue.state,
        branch_name: issue.branch_name,
        url: issue.url,
        labels: issue.labels,
        blocked_by: issue.blocked_by.map(b => ({
          id: b.id,
          identifier: b.identifier,
          state: b.state
        })),
        created_at: issue.created_at?.toISOString(),
        updated_at: issue.updated_at?.toISOString()
      };

      const context: Record<string, unknown> = {
        issue: issueObj,
        attempt
      };

      const prompt = this.liquid.parseAndRenderSync(template, context);
      return { prompt };
    } catch (err) {
      const error = err as Error;
      return {
        prompt: '',
        error: `Prompt rendering failed: ${error.message}`
      };
    }
  }

  /**
   * Parse a JSON line from app-server stdout
   */
  private parseLine(line: string): CodexMessage | null {
    try {
      return JSON.parse(line) as CodexMessage;
    } catch {
      return null;
    }
  }

  /**
   * Extract token usage from app-server message
   * Section 13.5: Token Accounting
   */
  private extractTokens(msg: CodexMessage): { input: number; output: number; total: number } | null {
    // Look for token counts in various payload shapes

    // Check msg.params first (standard usage object)
    const params = msg.params as Record<string, unknown> | undefined;
    if (params) {
      const usage = params.usage as Record<string, unknown> | undefined;
      if (usage) {
        return {
          input: (usage.input_tokens as number) || (usage.inputTokens as number) || 0,
          output: (usage.output_tokens as number) || (usage.outputTokens as number) || 0,
          total: (usage.total_tokens as number) || (usage.totalTokens as number) || 0
        };
      }

      // Check for tokenUsage nested object
      const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
      if (tokenUsage) {
        return {
          input: (tokenUsage.inputTokens as number) || 0,
          output: (tokenUsage.outputTokens as number) || 0,
          total: (tokenUsage.totalTokens as number) || 0
        };
      }
    }

    // Also check msg.result.turn.tokens (adapter format)
    const result = msg.result as Record<string, unknown> | undefined;
    if (result) {
      const turn = result.turn as Record<string, unknown> | undefined;
      if (turn) {
        const turnTokens = turn.tokens as Record<string, number> | undefined;
        if (turnTokens) {
          return {
            input: turnTokens.input || 0,
            output: turnTokens.output || 0,
            total: turnTokens.total || 0
          };
        }
      }
    }

    return null;
  }

  /**
   * Extract session IDs from thread/start result
   */
  private extractThreadInfo(result: Record<string, unknown>): { threadId: string } | null {
    const thread = result.thread as Record<string, unknown> | undefined;
    if (thread?.id) {
      return { threadId: String(thread.id) };
    }
    return null;
  }

  /**
   * Extract turn ID from turn/start result
   */
  private extractTurnInfo(result: Record<string, unknown>): { turnId: string } | null {
    const turn = result.turn as Record<string, unknown> | undefined;
    if (turn?.id) {
      return { turnId: String(turn.id) };
    }
    return null;
  }

  /**
   * Determine event type from app-server message
   * Section 10.4: Emitted Runtime Events
   */
  private determineEventType(msg: CodexMessage): AgentEventType | null {
    const method = msg.method;
    const result = msg.result as Record<string, unknown> | undefined;

    if (method === 'agent/timeline') {
      return 'timeline';
    }
    if (method === 'session/started' || (result && result['sessionStarted'])) {
      return 'session_started';
    }
    if (method === 'turn/completed') {
      return 'turn_completed';
    }
    if (method === 'turn/failed') {
      return 'turn_failed';
    }
    if (method === 'turn/cancelled') {
      return 'turn_cancelled';
    }
    if (result && (result as Record<string, unknown>)['userInputRequired']) {
      return 'turn_input_required';
    }

    return null;
  }

  private extractEventPayload(msg: CodexMessage): Record<string, unknown> | AgentTimelinePayload | undefined {
    if (msg.method === 'agent/timeline') {
      return msg.params as AgentTimelinePayload | undefined;
    }
    return (msg.result || msg.params) as Record<string, unknown> | undefined;
  }

  private buildRuntimeRequest(msg: CodexMessage): PendingRuntimeRequest | null {
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params) {
      return null;
    }

    if (msg.method === 'approval/request') {
      const request = (params.request as Record<string, unknown> | undefined) || {};
      const toolName =
        typeof request.tool_name === 'string' ? request.tool_name : null;
      const description = [
        typeof request.title === 'string' ? request.title : null,
        typeof request.description === 'string' ? request.description : null,
        typeof request.decision_reason === 'string' ? request.decision_reason : null,
      ]
        .filter(Boolean)
        .join(' · ');

      return {
        kind: 'approval',
        method: 'approval/request',
        request_id:
          typeof params.request_id === 'string'
            ? params.request_id
            : typeof request.tool_use_id === 'string'
              ? request.tool_use_id
              : String(msg.id || ''),
        turn: typeof params.turn === 'number' ? params.turn : null,
        raw: request,
        summary: {
          title: toolName ? `Permission request for ${toolName}` : 'Permission request',
          message: description || JSON.stringify(request.input || {}),
          tool_name: toolName,
          subtype: typeof request.subtype === 'string' ? request.subtype : 'can_use_tool',
        },
      };
    }

    if (msg.method === 'item/tool/requestUserInput') {
      const request = (params.request as Record<string, unknown> | undefined) || params;
      const subtype =
        typeof request.subtype === 'string' ? request.subtype : 'elicitation';
      const toolName =
        typeof request.mcp_server_name === 'string' ? request.mcp_server_name : null;
      const title =
        typeof request.title === 'string'
          ? request.title
          : toolName
            ? `Input requested by ${toolName}`
            : 'Input requested';
      const message =
        typeof request.message === 'string'
          ? request.message
          : JSON.stringify(request.requested_schema || request);

      return {
        kind: 'user_input',
        method: 'item/tool/requestUserInput',
        request_id:
          typeof params.request_id === 'string'
            ? params.request_id
            : typeof request.elicitation_id === 'string'
              ? request.elicitation_id
              : String(msg.id || ''),
        turn: typeof params.turn === 'number' ? params.turn : null,
        raw: request,
        summary: {
          title,
          message,
          tool_name: toolName,
          subtype,
        },
      };
    }

    return null;
  }

  private buildFallbackRuntimeResponse(
    request: PendingRuntimeRequest,
  ): RuntimeRequestResponse {
    if (request.kind === 'approval') {
      const toolUseID =
        typeof request.raw.tool_use_id === 'string'
          ? request.raw.tool_use_id
          : undefined;
      return {
        response: {
          behavior: 'deny',
          message: 'No runtime request handler configured.',
          ...(toolUseID ? { toolUseID } : {}),
        },
      };
    }

    return {
      response: {
        action: 'cancel',
      },
    };
  }

  /**
   * Launch Codex app-server subprocess
   * Section 10.1: Launch Contract
   */
  launch(workspacePath: string): cp.ChildProcess {
    const spawnArgs = this.buildSpawnArgs(this.options.codexCommand);

    let child;
    try {
      child = Bun.spawn(spawnArgs, {
        cwd: workspacePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: '/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || '')
        }
      });
    } catch (err) {
      console.error('[runner] Bun.spawn failed:', err);
      throw err;
    }

    // Create async line reader for stdout
    const stdoutLineHandler = new Set<(line: string) => void>();
    const stderrLineHandler = new Set<(line: string) => void>();
    const stdoutDataHandlerMap = new Map<(data: Buffer) => void, (line: string) => void>();
    const stderrDataHandlerMap = new Map<(data: Buffer) => void, (line: string) => void>();
    const exitHandlers = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
    const errorHandlers = new Set<(error: Error) => void>();

    // Start async stdout reader
    (async () => {
      try {
        for await (const chunk of child.stdout) {
          const lines = Buffer.from(chunk).toString().split('\n');
          for (const line of lines) {
            if (line.trim()) {
              for (const handler of stdoutLineHandler) {
                handler(line.trim());
              }
            }
          }
        }
      } catch (e) {
        // Stream closed
      }
    })();

    // Start async stderr reader
    (async () => {
      try {
        for await (const chunk of child.stderr) {
          const lines = Buffer.from(chunk).toString().split('\n');
          for (const line of lines) {
            if (line.trim()) {
              for (const handler of stderrLineHandler) {
                handler(line.trim());
              }
            }
          }
        }
      } catch (e) {
        // Stream closed
      }
    })();

    child.exited.then((code) => {
      for (const handler of exitHandlers) {
        handler(code, null);
      }
    }).catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const handler of errorHandlers) {
        handler(error);
      }
    });

    // Create stdin/stdout/stderr wrapper objects with proper event handling
    const stdin = {
      write: (data: string) => {
        child.stdin?.write(data);
        return true;
      },
      end: () => {
        child.stdin?.end();
      }
    };

    const stdout = {
      on: (event: string, handler: (data: Buffer) => void) => {
        if (event === 'data') {
          const wrapped = (line: string) => {
            handler(Buffer.from(line + '\n'));
          };
          stdoutDataHandlerMap.set(handler, wrapped);
          stdoutLineHandler.add(wrapped);
        }
        return stdout;
      },
      off: (event: string, handler: (data: Buffer) => void) => {
        if (event === 'data') {
          const wrapped = stdoutDataHandlerMap.get(handler);
          if (wrapped) {
            stdoutLineHandler.delete(wrapped);
            stdoutDataHandlerMap.delete(handler);
          }
        }
        return stdout;
      },
      removeListener: (event: string, handler: (data: Buffer) => void) => {
        return stdout.off(event, handler);
      },
      removeAllListeners: (event?: string) => {
        if (!event || event === 'data') {
          stdoutLineHandler.clear();
          stdoutDataHandlerMap.clear();
        }
        return stdout;
      }
    };

    const stderr = {
      on: (event: string, handler: (data: Buffer) => void) => {
        if (event === 'data') {
          const wrapped = (line: string) => {
            handler(Buffer.from(line + '\n'));
          };
          stderrDataHandlerMap.set(handler, wrapped);
          stderrLineHandler.add(wrapped);
        }
        return stderr;
      },
      off: (event: string, handler: (data: Buffer) => void) => {
        if (event === 'data') {
          const wrapped = stderrDataHandlerMap.get(handler);
          if (wrapped) {
            stderrLineHandler.delete(wrapped);
            stderrDataHandlerMap.delete(handler);
          }
        }
        return stderr;
      },
      removeListener: (event: string, handler: (data: Buffer) => void) => {
        return stderr.off(event, handler);
      },
      removeAllListeners: (event?: string) => {
        if (!event || event === 'data') {
          stderrLineHandler.clear();
          stderrDataHandlerMap.clear();
        }
        return stderr;
      }
    };

    // Create a proper ChildProcess-like object
    const processChild: cp.ChildProcess = {
      pid: child.pid,
      kill: (signal?: NodeJS.Signals | number) => {
        child.kill(signal);
        return true;
      },
      on: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') {
          exitHandlers.add(handler as (code: number | null, signal: NodeJS.Signals | null) => void);
        }
        if (event === 'error') {
          errorHandlers.add(handler as (error: Error) => void);
        }
        return processChild;
      },
      off: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') {
          exitHandlers.delete(handler as (code: number | null, signal: NodeJS.Signals | null) => void);
        }
        if (event === 'error') {
          errorHandlers.delete(handler as (error: Error) => void);
        }
        return processChild;
      },
      removeListener: (event: string, handler: (...args: any[]) => void) => {
        return processChild.off(event, handler);
      },
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
      stdin: stdin as unknown as NodeJS.WritableStream,
      removeAllListeners: (event?: string) => {
        if (!event || event === 'exit') {
          exitHandlers.clear();
        }
        if (!event || event === 'error') {
          errorHandlers.clear();
        }
      },
      ref: () => processChild,
      unref: () => processChild
    } as unknown as cp.ChildProcess;

    return processChild;
  }

  /**
   * Find bash executable path
   */
  private findBashPath(): string {
    return '/bin/bash';
  }

  /**
   * Initialize session handshake
   * Section 10.2: Session Startup Handshake
   */
  async initializeSession(child: cp.ChildProcess, workspacePath: string): Promise<{ threadId: string }> {
    const readTimeout = this.options.readTimeoutMs;
    const initializeId = this.messageCounter++;
    const threadStartId = this.messageCounter++;

    return new Promise((resolve, reject) => {
      let stdoutBuffer = '';
      let initializeResponseReceived = false;
      let threadId: string | null = null;
      const onStdoutData = (data: Buffer) => {
        stdoutBuffer += data.toString();
        this.processLines(stdoutBuffer, (line) => {
          stdoutBuffer = stdoutBuffer.replace(line + '\n', '').replace(line + '\r\n', '');

          const msg = this.parseLine(line);
          if (!msg) return;

          // After initialize response, send thread/start
          if (msg.id === initializeId && msg.result && !initializeResponseReceived) {
            initializeResponseReceived = true;

            // Send thread/start request
            const threadStartMsg: CodexMessage = {
              id: threadStartId,
              method: 'thread/start',
              params: {
                approvalPolicy: this.options.approvalPolicy || 'on-request',
                sandbox: this.options.threadSandbox || 'workspace-write',
                cwd: String(workspacePath || ''),
                ...(this.options.mcpConfig ? { mcpConfig: this.options.mcpConfig } : {}),
                ...(this.options.tools?.length ? { tools: this.options.tools } : {}),
                ...(this.options.allowedTools?.length ? { allowedTools: this.options.allowedTools } : {}),
                ...(this.options.systemPrompt ? { systemPrompt: this.options.systemPrompt } : {}),
              }
            };
            child.stdin?.write(JSON.stringify(threadStartMsg) + '\n');
          }

          // Check for thread/start response (id=2) with threadId
          // Only look at responses to thread/start, not initialize
          if (msg.id === threadStartId && msg.result && !threadId) {
            const threadInfo = this.extractThreadInfo(msg.result);
            if (threadInfo) {
              threadId = threadInfo.threadId;
              cleanup();
              resolve({ threadId });
            }
          }

          // Handle error responses
          if (msg.error) {
            cleanup();
            reject(new Error(`Session initialization failed: ${msg.error.message}`));
          }
        });
      };

      const onStderrData = (data: Buffer) => {
        if (this.shouldLogDiagnostics()) {
          console.error('[codex stderr]', data.toString().trim());
        }
      };

      // Set up stdout reader
      child.stdout?.on('data', onStdoutData);
      child.stderr?.on('data', onStderrData);

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Session initialization timed out'));
      }, readTimeout * 2);

      const cleanup = () => {
        child.stdout?.removeListener?.('data', onStdoutData);
        child.stderr?.removeListener?.('data', onStderrData);
        clearTimeout(timeout);
      };

      // Send initialize request (Section 10.2)
      const initializeMsg: CodexMessage = {
        id: initializeId,
        method: 'initialize',
        params: {
          clientInfo: { name: 'symphony', version: '1.0.0' },
          capabilities: {}  // May be empty; extendable for dynamic tools capability negotiation
        }
      };
      child.stdin?.write(JSON.stringify(initializeMsg) + '\n');
    });
  }

  /**
   * Send thread/start request after initialization
   */
  async sendThreadStart(
    child: cp.ChildProcess,
    workspacePath: string,
    approvalPolicy: string | null,
    threadSandbox: string | null
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const readTimeout = this.options.readTimeoutMs;

      const timeout = setTimeout(() => {
        reject(new Error('thread/start timed out'));
      }, readTimeout);

      const cleanup = () => {
        clearTimeout(timeout);
      };

      child.stdout?.once('data', () => {
        // Response will be handled by runTurn's message parsing
        cleanup();
        resolve();
      });

      const threadStartMsg: CodexMessage = {
        id: this.messageCounter++,
        method: 'thread/start',
        params: {
          approvalPolicy: approvalPolicy || 'auto',
          sandbox: threadSandbox || 'trusted',
          cwd: String(workspacePath || ''),
          ...(this.options.mcpConfig ? { mcpConfig: this.options.mcpConfig } : {}),
          ...(this.options.tools?.length ? { tools: this.options.tools } : {}),
          ...(this.options.allowedTools?.length ? { allowedTools: this.options.allowedTools } : {}),
          ...(this.options.systemPrompt ? { systemPrompt: this.options.systemPrompt } : {}),
        }
      };
      child.stdin?.write(JSON.stringify(threadStartMsg) + '\n');
    });
  }

  /**
   * Process complete lines from stdout buffer
   */
  private processLines(buffer: string, onLine: (line: string) => void): void {
    const lines = buffer.split('\n');
    // Process all complete lines (leave last partial line in buffer)
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (line) {
        onLine(line);
      }
    }
  }

  /**
   * Run a single turn in the session
   * Section 10.3: Streaming Turn Processing
   */
  runTurn(
    child: cp.ChildProcess,
    threadId: string,
    prompt: string,
    issueTitle: string,
    workspacePath: string,
    onEvent: (event: AgentEvent) => void,
    onRuntimeRequest?: (
      request: PendingRuntimeRequest,
      state: {
        timeline: AgentTimelinePayload[];
        transcript: TurnTranscriptEntry[];
      }
    ) => Promise<RuntimeRequestResponse>
  ): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      const turnTimeout = this.options.turnTimeoutMs;
      let stdoutBuffer = '';
      let turnId: string | null = null;
      let completed = false;
      let cancelled = false;
      let error: string | undefined;
      let tokens = { input: 0, output: 0, total: 0 };
      let claudeApiCalls = 0;  // Count each result message as one API call
      const timeline: AgentTimelinePayload[] = [];
      const transcript: TurnTranscriptEntry[] = [];
      type TurnCompletion = Omit<
        TurnResult,
        'claude_api_calls' | 'timeline' | 'transcript'
      >;

      const cleanup = () => {
        child.stdout?.removeListener?.('data', onStdoutData);
        child.stderr?.removeListener?.('data', onStderrData);
        child.removeListener?.('exit', onExit);
        child.removeListener?.('error', onError);
        clearTimeout(timeout);
      };

      const timeout = setTimeout(() => {
        if (!completed) {
          error = 'Turn timed out';
          completeTurn({ success: false, completed: false, cancelled: false, error, tokens });
        }
      }, turnTimeout);

      const completeTurn = (result: TurnCompletion) => {
        if (completed) {
          return;
        }
        completed = true;
        cleanup();
        resolve({
          ...result,
          claude_api_calls: claudeApiCalls,
          timeline,
          transcript,
        });
      };

      const onStdoutData = (data: Buffer) => {
        stdoutBuffer += data.toString();
        this.processLines(stdoutBuffer, (line) => {
          stdoutBuffer = stdoutBuffer.replace(line + '\n', '').replace(line + '\r\n', '');

          const msg = this.parseLine(line);
          if (!msg) return;

          if (msg.method === 'agent/transcript_delta') {
            const params = msg.params as Record<string, unknown> | undefined;
            if (
              params &&
              (params.role === 'assistant' || params.role === 'user') &&
              (params.kind === 'message' || params.kind === 'tool_result') &&
              typeof params.text === 'string'
            ) {
              transcript.push({
                role: params.role,
                kind: params.kind,
                text: params.text,
                turn: typeof params.turn === 'number' ? params.turn : null,
                tool_name:
                  typeof params.tool_name === 'string' ? params.tool_name : null,
              });
            }
            return;
          }

          // Extract turn ID from turn/start result
          if (msg.result && !turnId) {
            const turnInfo = this.extractTurnInfo(msg.result);
            if (turnInfo) {
              turnId = turnInfo.turnId;
            }
          }

          // Extract tokens
          const extractedTokens = this.extractTokens(msg);
          if (extractedTokens) {
            tokens = extractedTokens;
            // Don't count here - we count once per turn completion in claude-adapter
            // to avoid double-counting when multiple messages contain tokens
          }

          // Determine event type and emit
          const eventType = this.determineEventType(msg);
          if (eventType) {
            if (eventType === 'timeline' && msg.method === 'agent/timeline') {
              timeline.push((msg.params || {}) as unknown as AgentTimelinePayload);
            }
            const event: AgentEvent = {
              event: eventType,
              timestamp: new Date(),
              codex_app_server_pid: String(child.pid || ''),
              usage: tokens.total > 0 ? {
                input_tokens: tokens.input,
                output_tokens: tokens.output,
                total_tokens: tokens.total
              } : undefined,
              payload: this.extractEventPayload(msg)
            };
            onEvent(event);
          }

          const runtimeRequest = this.buildRuntimeRequest(msg);
          if (runtimeRequest && typeof msg.id === 'number') {
            void (async () => {
              try {
                const response =
                  onRuntimeRequest
                    ? await onRuntimeRequest(runtimeRequest, {
                        timeline: [...timeline],
                        transcript: [...transcript],
                      })
                    : this.buildFallbackRuntimeResponse(runtimeRequest);
                child.stdin?.write(
                  JSON.stringify({
                    id: msg.id,
                    result: response.response,
                  }) + '\n'
                );
              } catch (runtimeError) {
                const runtimeMessage =
                  runtimeError instanceof Error
                    ? runtimeError.message
                    : String(runtimeError);
                child.stdin?.write(
                  JSON.stringify({
                    id: msg.id,
                    error: {
                      code: -32000,
                      message: runtimeMessage,
                    },
                  }) + '\n'
                );
              }
            })();
            return;
          }

          // Check for completion states
          if (msg.method === 'turn/completed') {
            // Extract api_calls and tokens from the adapter's turn/completed message
            // Adapter sends: { method: "turn/completed", result: { turn: { api_calls: N, tokens: { input, output, total } } } }
            const result = msg.result as Record<string, unknown> | undefined;
            const turnData = result?.turn as Record<string, unknown> | undefined;
            claudeApiCalls = (turnData?.api_calls as number) || 0;

            // Extract tokens from adapter's turn data (overrides any tokens from earlier messages)
            const turnTokens = turnData?.tokens as { input?: number; output?: number; total?: number } | undefined;
            if (turnTokens) {
              tokens = {
                input: turnTokens.input || 0,
                output: turnTokens.output || 0,
                total: turnTokens.total || 0
              };
            }

            completeTurn({
              success: true,
              completed: true,
              cancelled: false,
              tokens
            });
          } else if (msg.method === 'turn/failed') {
            error = (msg.result as Record<string, unknown> | undefined)?.error as string || 'Turn failed';
            completeTurn({
              success: false,
              completed: false,
              cancelled: false,
              error,
              tokens
            });
          } else if (msg.method === 'turn/cancelled') {
            cancelled = true;
            completeTurn({
              success: false,
              completed: false,
              cancelled: true,
              tokens
            });
          }
        });
      };

      const onStderrData = (data: Buffer) => {
        if (this.shouldLogDiagnostics()) {
          console.error('[codex stderr]', data.toString().trim());
        }
      };

      // Send turn/start request
      const turnStartMsg: CodexMessage = {
        id: this.messageCounter++,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: prompt }],
          cwd: workspacePath,
          title: `${issueTitle}`,
          approvalPolicy: this.options.approvalPolicy || 'on-request',
          sandboxPolicy: this.options.turnSandboxPolicy ? JSON.parse(this.options.turnSandboxPolicy) : { type: 'workspace-write' }
        }
      };
      child.stdin?.write(JSON.stringify(turnStartMsg) + '\n');

      const onExit = (code: number | null) => {
        if (!completed) {
          error = `Codex process exited with code ${code}`;
          completeTurn({
            success: false,
            completed: false,
            cancelled: false,
            error,
            tokens
          });
        }
      };

      const onError = (err: Error) => {
        if (!completed) {
          error = `Codex process error: ${err.message}`;
          completeTurn({
            success: false,
            completed: false,
            cancelled: false,
            error,
            tokens
          });
        }
      };

      child.stdout?.on('data', onStdoutData);
      child.stderr?.on('data', onStderrData);
      child.on('exit', onExit);
      child.on('error', onError);
    });
  }

  /**
   * Stop a turn/session
   */
  stopSession(child: cp.ChildProcess): void {
    this.sendSignal(child, 'SIGTERM');
  }

  forceStopSession(child: cp.ChildProcess): void {
    this.sendSignal(child, 'SIGKILL');
  }
}
