/**
 * Claude Code Runtime Integration for Symphony Enterprise Agent Platform
 * Main entry point providing the ClaudeRuntime class for spawning and managing Claude Code subprocesses
 */

import { spawn } from 'bun';
import type { Database } from 'bun:sqlite';
import { SessionManager, type SessionOptions, type SessionInfo, type SessionState, SessionBroadcaster } from './session.js';
import { EventHandler, type AnyClaudeEvent, type EventHandlerOptions, parseClaudeOutputLine } from './eventHandler.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Claude Code Runtime configuration
 */
export interface ClaudeRuntimeConfig {
  /** Path to Claude Code executable */
  claudePath?: string;
  /** Default working directory */
  defaultWorkingDirectory?: string;
  /** Default model to use */
  defaultModel?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Event handler options */
  eventHandler?: EventHandlerOptions;
}

/**
 * Runtime execution result
 */
export interface ExecutionResult {
  sessionId: string;
  exitCode: number | null;
  success: boolean;
  error?: string;
  duration: number;
}

/**
 * Runtime session execution options
 */
export interface ExecutionOptions extends SessionOptions {
  /** Prompt to send to Claude */
  prompt: string;
  /** Callback for stream output */
  onOutput?: (line: string) => void;
  /** Signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Claude Code Runtime - Main class for spawning and managing Claude Code agent sessions
 */
export class ClaudeRuntime {
  private sessionManager: SessionManager;
  private eventHandler: EventHandler;
  private broadcaster: SessionBroadcaster;
  private config: ClaudeRuntimeConfig;

  constructor(db?: Database, config: ClaudeRuntimeConfig = {}) {
    this.sessionManager = new SessionManager(db);
    this.broadcaster = new SessionBroadcaster();
    this.eventHandler = new EventHandler(db, this.broadcaster, config.eventHandler);
    this.config = {
      claudePath: config.claudePath ?? 'claude',
      defaultWorkingDirectory: config.defaultWorkingDirectory ?? process.cwd(),
      defaultModel: config.defaultModel,
      verbose: config.verbose ?? false,
      ...config,
    };
  }

  /**
   * Get the session manager
   */
  get sessions(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get the event broadcaster
   */
  get broadcasterInstance(): SessionBroadcaster {
    return this.broadcaster;
  }

  /**
   * Start a new Claude Code session
   */
  async startSession(taskId: string, options: SessionOptions): Promise<SessionInfo> {
    const sessionInfo = this.sessionManager.createSession(taskId, {
      ...options,
      workingDirectory: options.workingDirectory || this.config.defaultWorkingDirectory || process.cwd(),
      model: options.model || this.config.defaultModel,
    });

    this.sessionManager.updateState(sessionInfo.sessionId, 'starting');

    if (this.config.verbose) {
      console.log(`[ClaudeRuntime] Starting session ${sessionInfo.sessionId} for task ${taskId}`);
    }

    return sessionInfo;
  }

  /**
   * Execute Claude Code with a prompt
   */
  async execute(taskId: string, execOptions: ExecutionOptions): Promise<ExecutionResult> {
    const sessionInfo = await this.startSession(taskId, execOptions);
    const startTime = Date.now();

    try {
      const result = await this.runClaudeCode(sessionInfo.sessionId, execOptions);
      const duration = Date.now() - startTime;

      return {
        sessionId: sessionInfo.sessionId,
        exitCode: result.exitCode,
        success: result.exitCode === 0,
        error: result.error,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.sessionManager.updateState(sessionInfo.sessionId, 'failed', error instanceof Error ? error.message : String(error));

      // Emit error event
      await this.eventHandler.handleEvent(
        this.eventHandler.createErrorEvent(
          sessionInfo.sessionId,
          taskId,
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error.stack : undefined,
          true,
        ),
      );

      return {
        sessionId: sessionInfo.sessionId,
        exitCode: null,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration,
      };
    }
  }

  /**
   * Run Claude Code subprocess
   */
  private async runClaudeCode(sessionId: string, options: ExecutionOptions): Promise<{ exitCode: number | null; error?: string }> {
    const session = this.sessionManager.getRuntimeSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const taskId = session.info.taskId;
    const workingDir = options.workingDirectory || this.config.defaultWorkingDirectory || process.cwd();

    // Build Claude Code command arguments
    const args: string[] = [];

    // Add prompt
    if (options.prompt) {
      args.push(options.prompt);
    }

    // Add model if specified
    if (options.model) {
      args.push('--model', options.model);
    }

    // Add max turns if specified
    if (options.maxTurns) {
      args.push('--max-turns', options.maxTurns.toString());
    }

    // Add system prompt if specified
    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }

    // Add append system prompt if specified
    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }

    // Use JSON output mode for easier parsing
    args.push('--output-format', 'json');

    if (this.config.verbose) {
      console.log(`[ClaudeRuntime] Running: ${this.config.claudePath} ${args.join(' ')}`);
      console.log(`[ClaudeRuntime] Working directory: ${workingDir}`);
    }

    // Update session state to running
    this.sessionManager.updateState(sessionId, 'running');
    session.startedAt = new Date();

    // Build environment
    const env: Record<string, string> = {
      ...process.env,
      ...(options.env || {}),
    };

    // Spawn Claude Code subprocess
    const process = spawn({
      cmd: [this.config.claudePath, ...args],
      cwd: workingDir,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
    });

    // Attach process to session
    this.sessionManager.attachProcess(sessionId, process);

    // Handle stdout
    const stdoutReader = process.stdout.getReader();
    const stderrReader = process.stderr.getReader();

    // Process output streams
    const processOutput = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      isStderr: boolean,
    ): Promise<void> => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = new TextDecoder().decode(value);
          const lines = text.split('\n').filter((l) => l.trim());

          for (const line of lines) {
            // Call output callback if provided
            if (options.onOutput) {
              options.onOutput(line);
            }

            // Parse and handle event
            const event = parseClaudeOutputLine(line, sessionId, taskId);
            if (event) {
              await this.eventHandler.handleEvent(event);
            }

            if (this.config.verbose) {
              console.log(`[ClaudeRuntime] ${isStderr ? 'stderr' : 'stdout'}: ${line}`);
            }
          }
        }
      } catch (error) {
        if (this.config.verbose) {
          console.error('[ClaudeRuntime] Error processing output:', error);
        }
      }
    };

    // Start processing output streams in parallel
    const stdoutPromise = processOutput(stdoutReader, false);
    const stderrPromise = processOutput(stderrReader, true);

    // Handle abort signal
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        if (this.config.verbose) {
          console.log(`[ClaudeRuntime] Session ${sessionId} cancelled by user`);
        }
        this.sessionManager.updateState(sessionId, 'cancelled');
        process.kill();
      });
    }

    // Wait for process to complete
    try {
      const exitCode = await process.exited;

      // Wait for output processing to complete
      await Promise.all([stdoutPromise, stderrPromise]);

      // Determine final state
      if (exitCode === 0) {
        this.sessionManager.updateState(sessionId, 'completed');
        await this.eventHandler.handleEvent(
          this.eventHandler.createCompleteEvent(sessionId, taskId),
        );
      } else {
        this.sessionManager.updateState(sessionId, 'failed', `Process exited with code ${exitCode}`);
      }

      // Detach process
      this.sessionManager.detachProcess(sessionId);

      return { exitCode };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sessionManager.updateState(sessionId, 'failed', message);
      this.sessionManager.detachProcess(sessionId);
      return { exitCode: null, error: message };
    }
  }

  /**
   * Stop a running session
   */
  async stopSession(sessionId: string): Promise<boolean> {
    const process = this.sessionManager.getProcess(sessionId);
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      return false;
    }

    if (process) {
      process.kill();
      this.sessionManager.detachProcess(sessionId);
    }

    this.sessionManager.updateState(sessionId, 'cancelled');

    if (this.config.verbose) {
      console.log(`[ClaudeRuntime] Stopped session ${sessionId}`);
    }

    return true;
  }

  /**
   * Get session status
   */
  getSessionStatus(sessionId: string): SessionInfo | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): SessionInfo[] {
    return this.sessionManager.getActiveSessions();
  }

  /**
   * Get session statistics
   */
  getStats(): ReturnType<SessionManager['getStats']> {
    return this.sessionManager.getStats();
  }

  /**
   * Add WebSocket client for event broadcasting
   */
  addWebSocketClient(client: { send: (data: string) => void; isAlive?: () => boolean }): void {
    this.broadcaster.addClient(client);
    if (this.config.verbose) {
      console.log(`[ClaudeRuntime] WebSocket client connected. Total clients: ${this.broadcaster.getClientCount()}`);
    }
  }

  /**
   * Remove WebSocket client
   */
  removeWebSocketClient(client: { send: (data: string) => void }): void {
    this.broadcaster.removeClient(client);
    if (this.config.verbose) {
      console.log(`[ClaudeRuntime] WebSocket client disconnected. Total clients: ${this.broadcaster.getClientCount()}`);
    }
  }

  /**
   * Get connected WebSocket client count
   */
  getClientCount(): number {
    return this.broadcaster.getClientCount();
  }

  /**
   * Cleanup finished sessions
   */
  cleanupFinishedSessions(): number {
    return this.sessionManager.cleanupFinishedSessions();
  }

  /**
   * Shutdown runtime and cleanup resources
   */
  async shutdown(): Promise<void> {
    // Stop all active sessions
    const activeSessions = this.getActiveSessions();
    for (const session of activeSessions) {
      await this.stopSession(session.sessionId);
    }

    // Clear broadcaster
    this.broadcaster.clear();

    // Clear session manager
    this.sessionManager.clear();

    if (this.config.verbose) {
      console.log('[ClaudeRuntime] Shutdown complete');
    }
  }
}

/**
 * Factory function to create a ClaudeRuntime instance
 */
export function createClaudeRuntime(db?: Database, config?: ClaudeRuntimeConfig): ClaudeRuntime {
  return new ClaudeRuntime(db, config);
}

// Re-export types for convenience
export {
  SessionManager,
  SessionBroadcaster,
  EventHandler,
  type SessionOptions,
  type SessionInfo,
  type SessionState,
  type EventHandlerOptions,
  type AnyClaudeEvent,
  type ClaudeEventType,
  type ThoughtEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type FileChangeEvent,
  type FileReadEvent,
  type CommandExecEvent,
  type MessageEvent,
  type ErrorEvent,
  type CompleteEvent,
  type UsageEvent,
  parseClaudeOutputLine,
};
