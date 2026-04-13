/**
 * Event Handler for Claude Code Runtime
 * Processes Claude Code output events and stores them in the database
 */

import type { Database } from 'bun:sqlite';
import { EventRepository } from '../database/repositories/eventRepository.js';
import type { EventSeverity } from '../database/types.js';
import type { SessionBroadcaster } from './session.js';

/**
 * Claude Code event types that can be emitted during execution
 */
export type ClaudeEventType =
  | 'session_started'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'file_change'
  | 'file_read'
  | 'command_exec'
  | 'message'
  | 'error'
  | 'complete'
  | 'cancelled'
  | 'usage'
  | 'custom';

/**
 * Base Claude event structure
 */
export interface ClaudeEvent {
  type: ClaudeEventType;
  timestamp: Date;
  sessionId: string;
  taskId: string;
}

/**
 * Thought event - Claude's reasoning/thinking output
 */
export interface ThoughtEvent extends ClaudeEvent {
  type: 'thought';
  content: string;
  turnId?: string;
}

/**
 * Tool call event - A tool being invoked
 */
export interface ToolCallEvent extends ClaudeEvent {
  type: 'tool_call';
  toolName: string;
  input: Record<string, unknown>;
  turnId?: string;
}

/**
 * Tool result event - Result from a tool invocation
 */
export interface ToolResultEvent extends ClaudeEvent {
  type: 'tool_result';
  toolName: string;
  result: unknown;
  isError?: boolean;
  turnId?: string;
}

/**
 * File change event - File was modified
 */
export interface FileChangeEvent extends ClaudeEvent {
  type: 'file_change';
  filePath: string;
  changeType: 'create' | 'modify' | 'delete';
  diff?: string;
  content?: string;
}

/**
 * File read event - File was read
 */
export interface FileReadEvent extends ClaudeEvent {
  type: 'file_read';
  filePath: string;
  content?: string;
  size?: number;
}

/**
 * Command execution event - Shell command was run
 */
export interface CommandExecEvent extends ClaudeEvent {
  type: 'command_exec';
  command: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Message event - General message output
 */
export interface MessageEvent extends ClaudeEvent {
  type: 'message';
  content: string;
  role?: 'user' | 'assistant' | 'system';
}

/**
 * Error event - An error occurred
 */
export interface ErrorEvent extends ClaudeEvent {
  type: 'error';
  message: string;
  stack?: string;
  recoverable: boolean;
}

/**
 * Complete event - Session completed successfully
 */
export interface CompleteEvent extends ClaudeEvent {
  type: 'complete';
  summary?: string;
  finalOutput?: string;
}

/**
 * Usage event - Token usage information
 */
export interface UsageEvent extends ClaudeEvent {
  type: 'usage';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Union type of all Claude events
 */
export type AnyClaudeEvent =
  | ThoughtEvent
  | ToolCallEvent
  | ToolResultEvent
  | FileChangeEvent
  | FileReadEvent
  | CommandExecEvent
  | MessageEvent
  | ErrorEvent
  | CompleteEvent
  | UsageEvent;

/**
 * Result of processing an event
 */
export interface EventProcessingResult {
  success: boolean;
  eventId?: string;
  error?: string;
}

/**
 * Options for the event handler
 */
export interface EventHandlerOptions {
  /** Enable broadcasting to WebSocket clients */
  enableBroadcast?: boolean;
  /** Enable database storage */
  enableDatabase?: boolean;
  /** Log events to console */
  enableLogging?: boolean;
  /** Minimum severity for database storage */
  minSeverity?: EventSeverity;
}

/**
 * Default event handler options
 */
const DEFAULT_OPTIONS: EventHandlerOptions = {
  enableBroadcast: true,
  enableDatabase: true,
  enableLogging: false,
  minSeverity: 'debug',
};

/**
 * Event Handler for processing Claude Code events
 */
export class EventHandler {
  private eventRepo: EventRepository | null;
  private broadcaster: SessionBroadcaster | null;
  private options: EventHandlerOptions;

  constructor(
    db?: Database,
    broadcaster?: SessionBroadcaster,
    options: EventHandlerOptions = DEFAULT_OPTIONS,
  ) {
    this.eventRepo = db ? new EventRepository(db) : null;
    this.broadcaster = broadcaster ?? null;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Process a Claude event
   */
  async handleEvent(event: AnyClaudeEvent): Promise<EventProcessingResult> {
    try {
      let eventId: string | undefined;

      // Store in database if enabled
      if (this.options.enableDatabase && this.eventRepo) {
        eventId = await this.storeEvent(event);
      }

      // Broadcast to WebSocket clients if enabled
      if (this.options.enableBroadcast && this.broadcaster) {
        this.broadcastEvent(event);
      }

      // Log if enabled
      if (this.options.enableLogging) {
        this.logEvent(event);
      }

      return { success: true, eventId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  /**
   * Store event in database
   */
  private async storeEvent(event: AnyClaudeEvent): Promise<string> {
    if (!this.eventRepo) {
      return '';
    }

    const severity = this.getSeverityForEvent(event);
    const eventData = this.serializeEventData(event);

    const created = this.eventRepo.create({
      task_id: event.taskId,
      event_type: event.type,
      event_data: eventData,
      severity,
      source: 'claude-runtime',
    });

    return created.id;
  }

  /**
   * Broadcast event to WebSocket clients
   */
  private broadcastEvent(event: AnyClaudeEvent): void {
    if (!this.broadcaster) return;

    this.broadcaster.broadcast({
      type: 'session_event',
      sessionId: event.sessionId,
      taskId: event.taskId,
      eventType: event.type,
      timestamp: event.timestamp,
      data: this.serializeEventData(event),
    });
  }

  /**
   * Log event to console
   */
  private logEvent(event: AnyClaudeEvent): void {
    const timestamp = event.timestamp.toISOString();
    const severity = this.getSeverityForEvent(event);

    switch (severity) {
      case 'error':
      case 'critical':
        console.error(`[${timestamp}] [${event.type}]`, this.serializeEventData(event));
        break;
      case 'warning':
        console.warn(`[${timestamp}] [${event.type}]`, this.serializeEventData(event));
        break;
      default:
        console.log(`[${timestamp}] [${event.type}]`, this.serializeEventData(event));
    }
  }

  /**
   * Get severity level for an event type
   */
  private getSeverityForEvent(event: AnyClaudeEvent): EventSeverity {
    switch (event.type) {
      case 'error':
        return (event as ErrorEvent).recoverable ? 'warning' : 'error';
      case 'complete':
        return 'info';
      case 'tool_result':
        return (event as ToolResultEvent).isError ? 'warning' : 'info';
      case 'thought':
        return 'debug';
      case 'usage':
        return 'debug';
      default:
        return 'info';
    }
  }

  /**
   * Serialize event data for storage
   */
  private serializeEventData(event: AnyClaudeEvent): Record<string, unknown> {
    const baseData = {
      sessionId: event.sessionId,
      timestamp: event.timestamp.toISOString(),
    };

    switch (event.type) {
      case 'thought':
        return {
          ...baseData,
          content: event.content,
          turnId: event.turnId,
        };
      case 'tool_call':
        return {
          ...baseData,
          toolName: event.toolName,
          input: event.input,
          turnId: event.turnId,
        };
      case 'tool_result':
        return {
          ...baseData,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
          turnId: event.turnId,
        };
      case 'file_change':
        return {
          ...baseData,
          filePath: event.filePath,
          changeType: event.changeType,
          diff: event.diff,
          content: event.content,
        };
      case 'file_read':
        return {
          ...baseData,
          filePath: event.filePath,
          size: event.size,
        };
      case 'command_exec':
        return {
          ...baseData,
          command: event.command,
          cwd: event.cwd,
          exitCode: event.exitCode,
          stdout: event.stdout,
          stderr: event.stderr,
        };
      case 'message':
        return {
          ...baseData,
          content: event.content,
          role: event.role,
        };
      case 'error':
        return {
          ...baseData,
          message: event.message,
          stack: event.stack,
          recoverable: event.recoverable,
        };
      case 'complete':
        return {
          ...baseData,
          summary: event.summary,
          finalOutput: event.finalOutput,
        };
      case 'usage':
        return {
          ...baseData,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
        };
      default:
        return baseData;
    }
  }

  /**
   * Create a thought event
   */
  createThoughtEvent(
    sessionId: string,
    taskId: string,
    content: string,
    turnId?: string,
  ): ThoughtEvent {
    return {
      type: 'thought',
      timestamp: new Date(),
      sessionId,
      taskId,
      content,
      turnId,
    };
  }

  /**
   * Create a tool call event
   */
  createToolCallEvent(
    sessionId: string,
    taskId: string,
    toolName: string,
    input: Record<string, unknown>,
    turnId?: string,
  ): ToolCallEvent {
    return {
      type: 'tool_call',
      timestamp: new Date(),
      sessionId,
      taskId,
      toolName,
      input,
      turnId,
    };
  }

  /**
   * Create a tool result event
   */
  createToolResultEvent(
    sessionId: string,
    taskId: string,
    toolName: string,
    result: unknown,
    isError?: boolean,
    turnId?: string,
  ): ToolResultEvent {
    return {
      type: 'tool_result',
      timestamp: new Date(),
      sessionId,
      taskId,
      toolName,
      result,
      isError,
      turnId,
    };
  }

  /**
   * Create a file change event
   */
  createFileChangeEvent(
    sessionId: string,
    taskId: string,
    filePath: string,
    changeType: 'create' | 'modify' | 'delete',
    diff?: string,
    content?: string,
  ): FileChangeEvent {
    return {
      type: 'file_change',
      timestamp: new Date(),
      sessionId,
      taskId,
      filePath,
      changeType,
      diff,
      content,
    };
  }

  /**
   * Create an error event
   */
  createErrorEvent(
    sessionId: string,
    taskId: string,
    message: string,
    stack?: string,
    recoverable: boolean = false,
  ): ErrorEvent {
    return {
      type: 'error',
      timestamp: new Date(),
      sessionId,
      taskId,
      message,
      stack,
      recoverable,
    };
  }

  /**
   * Create a complete event
   */
  createCompleteEvent(
    sessionId: string,
    taskId: string,
    summary?: string,
    finalOutput?: string,
  ): CompleteEvent {
    return {
      type: 'complete',
      timestamp: new Date(),
      sessionId,
      taskId,
      summary,
      finalOutput,
    };
  }

  /**
   * Create a usage event
   */
  createUsageEvent(
    sessionId: string,
    taskId: string,
    inputTokens: number,
    outputTokens: number,
    totalTokens: number,
    cacheReadTokens?: number,
    cacheWriteTokens?: number,
  ): UsageEvent {
    return {
      type: 'usage',
      timestamp: new Date(),
      sessionId,
      taskId,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  /**
   * Create a message event
   */
  createMessageEvent(
    sessionId: string,
    taskId: string,
    content: string,
    role?: 'user' | 'assistant' | 'system',
  ): MessageEvent {
    return {
      type: 'message',
      timestamp: new Date(),
      sessionId,
      taskId,
      content,
      role,
    };
  }
}

/**
 * Parse Claude Code output line into structured events
 * This is a basic parser - can be extended based on actual output format
 */
export function parseClaudeOutputLine(
  line: string,
  sessionId: string,
  taskId: string,
): AnyClaudeEvent | null {
  try {
    // Try to parse as JSON event
    if (line.startsWith('{')) {
      const json = JSON.parse(line);

      if (json.type === 'tool_call' || json.tool_call) {
        return {
          type: 'tool_call',
          timestamp: new Date(),
          sessionId,
          taskId,
          toolName: json.tool_name || json.tool_call?.name || 'unknown',
          input: json.input || json.tool_call?.input || {},
          turnId: json.turn_id,
        };
      }

      if (json.type === 'file_change' || json.file_change) {
        return {
          type: 'file_change',
          timestamp: new Date(),
          sessionId,
          taskId,
          filePath: json.file_path || json.file_change?.path || '',
          changeType: (json.change_type || json.file_change?.type) as 'create' | 'modify' | 'delete',
          diff: json.diff,
          content: json.content,
        };
      }

      if (json.type === 'error' || json.error) {
        return {
          type: 'error',
          timestamp: new Date(),
          sessionId,
          taskId,
          message: json.message || json.error?.message || 'Unknown error',
          stack: json.stack,
          recoverable: json.recoverable ?? false,
        };
      }

      if (json.type === 'complete' || json.done) {
        return {
          type: 'complete',
          timestamp: new Date(),
          sessionId,
          taskId,
          summary: json.summary,
          finalOutput: json.output,
        };
      }

      if (json.type === 'usage' || json.usage) {
        return {
          type: 'usage',
          timestamp: new Date(),
          sessionId,
          taskId,
          inputTokens: json.input_tokens || json.usage?.input_tokens || 0,
          outputTokens: json.output_tokens || json.usage?.output_tokens || 0,
          totalTokens: json.total_tokens || json.usage?.total_tokens || 0,
          cacheReadTokens: json.cache_read_tokens,
          cacheWriteTokens: json.cache_write_tokens,
        };
      }
    }

    // Check for thought markers (Claude thinking output)
    if (line.startsWith('Thinking:') || line.startsWith('<thought>')) {
      return {
        type: 'thought',
        timestamp: new Date(),
        sessionId,
        taskId,
        content: line.replace(/^(Thinking:|<thought>)\s*/, ''),
      };
    }

    // Default to message event for other lines
    if (line.trim()) {
      return {
        type: 'message',
        timestamp: new Date(),
        sessionId,
        taskId,
        content: line,
      };
    }

    return null;
  } catch {
    // Not JSON or parse error, return as message if non-empty
    if (line.trim()) {
      return {
        type: 'message',
        timestamp: new Date(),
        sessionId,
        taskId,
        content: line,
      };
    }
    return null;
  }
}
