/**
 * Agent Runner - Codex app-server client and session management
 * Section 10: Agent Runner Protocol
 */

import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { AgentEvent, AgentEventType, LiveSession, Issue, WorkflowDefinition } from '../types';
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

/**
 * Agent Runner options
 */
export interface AgentRunnerOptions {
  codexCommand: string;
  approvalPolicy?: string | null;
  threadSandbox?: string | null;
  turnSandboxPolicy?: string | null;
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
  private pendingResponses: Map<number, (msg: CodexMessage) => void> = new Map();
  private currentStreamHandler: ((line: string, msg?: CodexMessage) => void) | null = null;
  private streamComplete: (() => void) | null = null;
  private streamError: ((err: string) => void) | null = null;

  constructor(options: AgentRunnerOptions) {
    super();
    this.options = options;
    this.liquid = new Liquid({
      strictVariables: true,  // Section 5.4: Unknown variables must fail
      strictFilters: true     // Section 5.4: Unknown filters must fail
    });
  }

  /**
   * Resolve command path relative to project root
   */
  private resolveCommandPath(command: string): string {
    // If command starts with node/python etc., extract the interpreter and script
    const parts = command.split(' ');
    if (parts.length > 0) {
      const interpreter = parts[0];
      const script = parts.slice(1).join(' ');
      
      // Check if it's a node/python command with a relative script path
      if ((interpreter === 'node' || interpreter === 'python' || interpreter === 'python3') && script) {
        const scriptPath = path.isAbsolute(script) ? script : path.resolve(this.options.projectRoot, script);
        return `${interpreter} ${scriptPath}`;
      }
    }
    
    // For absolute paths or other commands, return as is
    return command;
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
    if (method === 'item/tool/requestUserInput') {
      return 'turn_input_required';
    }
    if (method === 'approval/request') {
      // Auto-approve handling
      return 'approval_auto_approved';
    }
    if (result && (result as Record<string, unknown>)['userInputRequired']) {
      return 'turn_input_required';
    }

    return null;
  }

  /**
   * Launch Codex app-server subprocess
   * Section 10.1: Launch Contract
   */
  launch(workspacePath: string): cp.ChildProcess {
    // Find bash path dynamically for sandbox compatibility
    const bashPath = this.findBashPath();
    
    // Resolve command path relative to project root
    const resolvedCommand = this.resolveCommandPath(this.options.codexCommand);
    
    // Section 10.1: Invoke via bash -lc in workspace directory
    const child = cp.spawn(bashPath, ['-lc', resolvedCommand], {
      cwd: workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });

    return child;
  }

  /**
   * Find bash executable path
   * In sandbox environments, use 'bash' with PATH lookup rather than absolute paths
   */
  private findBashPath(): string {
    // In sandbox/container environments, using 'bash' directly often works better
    // because the sandbox may have its own PATH mapping
    return 'bash';
  }

  /**
   * Initialize session handshake
   * Section 10.2: Session Startup Handshake
   */
  async initializeSession(child: cp.ChildProcess, workspacePath: string): Promise<{ threadId: string }> {
    const readTimeout = this.options.readTimeoutMs;

    return new Promise((resolve, reject) => {
      let stdoutBuffer = '';
      let initializedReceived = false;
      let threadStartResponseReceived = false;

      // Set up stdout reader
      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        this.processLines(stdoutBuffer, (line) => {
          stdoutBuffer = stdoutBuffer.replace(line + '\n', '').replace(line + '\r\n', '');

          const msg = this.parseLine(line);
          if (!msg) return;

          // Check for initialized notification (Section 10.2)
          if (msg.method === 'initialized') {
            initializedReceived = true;
          }

          // Check for thread/start response (Section 10.2)
          if (msg.result && !threadStartResponseReceived) {
            const threadInfo = this.extractThreadInfo(msg.result);
            if (threadInfo) {
              threadStartResponseReceived = true;
              cleanup();
              resolve(threadInfo);
            }
          }

          // Handle error responses
          if (msg.error) {
            cleanup();
            reject(new Error(`Session initialization failed: ${msg.error.message}`));
          }
        });
      });

      child.stderr?.on('data', (data: Buffer) => {
        // Stderr is not part of protocol stream - log as diagnostics
        console.error('[codex stderr]', data.toString().trim());
      });

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Session initialization timed out'));
      }, readTimeout * 2);

      const cleanup = () => {
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
        clearTimeout(timeout);
      };

      // Send initialize request (Section 10.2)
      const initializeMsg: CodexMessage = {
        id: this.messageCounter++,
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
          cwd: String(workspacePath || '')
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
    onEvent: (event: AgentEvent) => void
  ): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      const turnTimeout = this.options.turnTimeoutMs;
      const readTimeout = this.options.readTimeoutMs;
      let stdoutBuffer = '';
      let turnId: string | null = null;
      let completed = false;
      let cancelled = false;
      let error: string | undefined;
      let tokens = { input: 0, output: 0, total: 0 };
      let claudeApiCalls = 0;  // Count each result message as one API call

      const timeout = setTimeout(() => {
        if (!completed) {
          error = 'Turn timed out';
          completeTurn({ success: false, completed: false, cancelled: false, error, tokens });
        }
      }, turnTimeout);

      const completeTurn = (result: TurnResult) => {
        completed = true;
        clearTimeout(timeout);
        resolve({ ...result, claude_api_calls: claudeApiCalls });
      };

      child.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        this.processLines(stdoutBuffer, (line) => {
          stdoutBuffer = stdoutBuffer.replace(line + '\n', '').replace(line + '\r\n', '');

          const msg = this.parseLine(line);
          if (!msg) return;

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
            const event: AgentEvent = {
              event: eventType,
              timestamp: new Date(),
              codex_app_server_pid: String(child.pid || ''),
              usage: tokens.total > 0 ? {
                input_tokens: tokens.input,
                output_tokens: tokens.output,
                total_tokens: tokens.total
              } : undefined,
              payload: msg.result || msg.params
            };
            onEvent(event);
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
          } else if (msg.method === 'item/tool/requestUserInput') {
            // Section 10.5: User input requests must not stall indefinitely
            // Fail the run attempt immediately
            error = 'User input required - failing run attempt';
            completeTurn({
              success: false,
              completed: false,
              cancelled: false,
              error,
              tokens
            });
          } else if (msg.method === 'item/tool/call') {
            // Section 17.5: Unsupported dynamic tool calls must be rejected without stalling
            // Check if this is a supported tool call - if not, return failure response
            const toolName = (msg.params as Record<string, unknown> | undefined)?.name as string | undefined;
            if (toolName && toolName !== 'linear_graphql') {
              // Unsupported tool - send failure response and continue
              const toolCallId = msg.id;
              const failureResponse: CodexMessage = {
                id: toolCallId,
                result: { success: false, error: `unsupported_tool_call: ${toolName}` }
              };
              child.stdin?.write(JSON.stringify(failureResponse) + '\n');
              // Emit event for observability
              const event: AgentEvent = {
                event: 'unsupported_tool_call',
                timestamp: new Date(),
                codex_app_server_pid: String(child.pid || ''),
                payload: { toolName, error: 'unsupported_tool_call' }
              };
              onEvent(event);
            }
          }
        });
      });

      child.stderr?.on('data', (data: Buffer) => {
        // Log stderr but don't fail the turn
        console.error('[codex stderr]', data.toString().trim());
      });

      // Send turn/start request
      const turnStartMsg: CodexMessage = {
        id: this.messageCounter++,
        method: 'turn/start',
        params: {
          threadId,
          input: [{ type: 'text', text: prompt }],
          cwd: workspacePath,
          title: `${issueTitle}`,
          approvalPolicy: this.options.approvalPolicy || 'auto',
          sandboxPolicy: this.options.turnSandboxPolicy ? JSON.parse(this.options.turnSandboxPolicy) : { type: 'trusted' }
        }
      };
      child.stdin?.write(JSON.stringify(turnStartMsg) + '\n');

      child.on('exit', (code) => {
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
      });

      child.on('error', (err) => {
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
      });
    });
  }

  /**
   * Stop a turn/session
   */
  stopSession(child: cp.ChildProcess): void {
    child.kill('SIGTERM');
  }
}
