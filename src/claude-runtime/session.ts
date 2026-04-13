/**
 * Agent Session Management for Claude Code Runtime
 * Tracks session state and lifecycle for Claude Code agent sessions
 */

import type { Database } from 'bun:sqlite';
import { v4 as uuidv4 } from 'uuid';

/**
 * Session states representing the lifecycle of a Claude Code agent session
 */
export type SessionState =
  | 'starting'      // Session is being initialized
  | 'running'       // Session is actively processing
  | 'paused'        // Session is temporarily paused
  | 'completed'     // Session completed successfully
  | 'failed'        // Session failed with error
  | 'cancelled';    // Session was cancelled by user

/**
 * Session configuration options
 */
export interface SessionOptions {
  /** Working directory for the session */
  workingDirectory: string;
  /** Model to use for Claude Code */
  model?: string;
  /** Maximum turns allowed */
  maxTurns?: number;
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Custom system prompt */
  systemPrompt?: string;
  /** Append to system prompt */
  appendSystemPrompt?: string;
  /** Environment variables to pass to subprocess */
  env?: Record<string, string>;
}

/**
 * Session information returned when creating a session
 */
export interface SessionInfo {
  sessionId: string;
  taskId: string;
  state: SessionState;
  createdAt: Date;
  updatedAt: Date;
  options: SessionOptions;
}

/**
 * Runtime session data stored in memory
 */
export interface RuntimeSession {
  info: SessionInfo;
  process: Bun.ChildProcess | null;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Session Manager for tracking and managing Claude Code agent sessions
 */
export class SessionManager {
  private sessions: Map<string, RuntimeSession>;
  private db: Database | null;

  constructor(db?: Database) {
    this.sessions = new Map();
    this.db = db ?? null;
  }

  /**
   * Create a new session
   */
  createSession(taskId: string, options: SessionOptions): SessionInfo {
    const sessionId = uuidv4();
    const now = new Date();

    const info: SessionInfo = {
      sessionId,
      taskId,
      state: 'starting',
      createdAt: now,
      updatedAt: now,
      options,
    };

    this.sessions.set(sessionId, {
      info,
      process: null,
    });

    return info;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    return session?.info;
  }

  /**
   * Get all sessions
   */
  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  /**
   * Get sessions by task ID
   */
  getSessionsByTask(taskId: string): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.info.taskId === taskId)
      .map((s) => s.info);
  }

  /**
   * Get active (running or starting) sessions
   */
  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.info.state === 'running' || s.info.state === 'starting')
      .map((s) => s.info);
  }

  /**
   * Update session state
   */
  updateState(sessionId: string, state: SessionState, error?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    session.info.state = state;
    session.info.updatedAt = new Date();

    if (error) {
      session.error = error;
    }

    if (state === 'completed' || state === 'failed' || state === 'cancelled') {
      session.completedAt = new Date();
    }

    if (state === 'running' && !session.startedAt) {
      session.startedAt = new Date();
    }

    return true;
  }

  /**
   * Attach a process to a session
   */
  attachProcess(sessionId: string, process: Bun.ChildProcess): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    session.process = process;
    return true;
  }

  /**
   * Get process for a session
   */
  getProcess(sessionId: string): Bun.ChildProcess | null {
    const session = this.sessions.get(sessionId);
    return session?.process ?? null;
  }

  /**
   * Detach process from session (cleanup)
   */
  detachProcess(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    session.process = null;
    return true;
  }

  /**
   * Get session runtime data (for internal use)
   */
  getRuntimeSession(sessionId: string): RuntimeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Remove session from tracking
   */
  removeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Clear all completed/failed/cancelled sessions
   */
  cleanupFinishedSessions(): number {
    let removed = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (['completed', 'failed', 'cancelled'].includes(session.info.state)) {
        this.sessions.delete(sessionId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get session statistics
   */
  getStats(): {
    total: number;
    starting: number;
    running: number;
    paused: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const stats = {
      total: this.sessions.size,
      starting: 0,
      running: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const session of this.sessions.values()) {
      stats[session.info.state]++;
    }

    return stats;
  }

  /**
   * Clear all sessions (for testing)
   */
  clear(): void {
    this.sessions.clear();
  }
}

/**
 * Broadcast event for WebSocket clients
 */
export interface BroadcastEvent {
  type: 'session_event';
  sessionId: string;
  taskId: string;
  eventType: string;
  timestamp: Date;
  data: Record<string, unknown>;
}

/**
 * WebSocket broadcaster for session events
 */
export class SessionBroadcaster {
  private clients: Set<{
    send: (data: string) => void;
    isAlive?: () => boolean;
  }>;

  constructor() {
    this.clients = new Set();
  }

  /**
   * Add a WebSocket client
   */
  addClient(client: { send: (data: string) => void; isAlive?: () => boolean }): void {
    this.clients.add(client);
  }

  /**
   * Remove a WebSocket client
   */
  removeClient(client: { send: (data: string) => void }): void {
    this.clients.delete(client);
  }

  /**
   * Broadcast an event to all connected clients
   */
  broadcast(event: BroadcastEvent): void {
    const message = JSON.stringify({
      type: event.type,
      sessionId: event.sessionId,
      taskId: event.taskId,
      eventType: event.eventType,
      timestamp: event.timestamp.toISOString(),
      data: event.data,
    });

    const deadClients: typeof client[] = [];

    for (const client of this.clients) {
      try {
        if (client.isAlive && !client.isAlive()) {
          deadClients.push(client);
          continue;
        }
        client.send(message);
      } catch (error) {
        // Client connection failed, mark for removal
        deadClients.push(client);
      }
    }

    // Clean up dead clients
    for (const client of deadClients) {
      this.clients.delete(client);
    }
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Clear all clients (for testing)
   */
  clear(): void {
    this.clients.clear();
  }
}
