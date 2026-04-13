/**
 * WebSocket Task Events Handler for Symphony HTTP Server
 * Handles real-time task event streaming via WebSocket
 */

import type { ServerWebSocket } from 'bun';
import type { Database } from 'bun:sqlite';
import { EventRepository } from '../../database/repositories/eventRepository';
import type { WebSocketMessage } from '../types';

/**
 * WebSocket client subscription
 */
interface WsClient {
  ws: ServerWebSocket<unknown>;
  taskId: string;
  lastEventId?: string;
  isAlive: boolean;
}

/**
 * Task Events WebSocket Manager
 * Manages WebSocket connections for real-time task event streaming
 */
export class TaskEventsManager {
  private clients: Map<string, Set<WsClient>>;
  private eventRepo: EventRepository;

  constructor(db: Database) {
    this.clients = new Map();
    this.eventRepo = new EventRepository(db);
  }

  /**
   * Add a client subscription for a task
   */
  addClient(ws: ServerWebSocket<unknown>, taskId: string, afterId?: string): void {
    if (!this.clients.has(taskId)) {
      this.clients.set(taskId, new Set());
    }

    const client: WsClient = {
      ws,
      taskId,
      lastEventId: afterId,
      isAlive: true,
    };

    this.clients.get(taskId)!.add(client);

    // Send connected message
    this.sendMessage(ws, {
      type: 'connected',
      taskId,
      timestamp: new Date().toISOString(),
    });

    // Send historical events if afterId is provided
    if (afterId) {
      this.sendHistoricalEvents(ws, taskId, afterId);
    }
  }

  /**
   * Remove a client subscription
   */
  removeClient(ws: ServerWebSocket<unknown>): void {
    for (const [taskId, clients] of this.clients.entries()) {
      for (const client of clients) {
        if (client.ws === ws) {
          clients.delete(client);
          break;
        }
      }
      if (clients.size === 0) {
        this.clients.delete(taskId);
      }
    }
  }

  /**
   * Broadcast an event to all clients subscribed to a task
   */
  broadcast(taskId: string, message: Omit<WebSocketMessage, 'timestamp'>): void {
    const clients = this.clients.get(taskId);
    if (!clients || clients.size === 0) {
      return;
    }

    const wsMessage: WebSocketMessage = {
      ...message,
      timestamp: new Date().toISOString(),
    };

    const data = JSON.stringify(wsMessage);
    const deadClients: WsClient[] = [];

    for (const client of clients) {
      try {
        if (!client.isAlive) {
          deadClients.push(client);
          continue;
        }
        client.ws.send(data);
        client.lastEventId = message.data?.id as string | undefined;
      } catch {
        deadClients.push(client);
      }
    }

    // Clean up dead clients
    for (const client of deadClients) {
      clients.delete(client);
    }
    if (clients.size === 0) {
      this.clients.delete(taskId);
    }
  }

  /**
   * Broadcast task state change
   */
  broadcastStateChange(taskId: string, newState: string, previousState?: string): void {
    this.broadcast(taskId, {
      type: 'task_state_changed',
      taskId,
      data: {
        newState,
        previousState,
      },
    });
  }

  /**
   * Broadcast task event
   */
  broadcastEvent(taskId: string, eventType: string, eventData: Record<string, unknown>): void {
    this.broadcast(taskId, {
      type: 'task_event',
      taskId,
      data: {
        eventType,
        ...eventData,
      },
    });
  }

  /**
   * Send error message to client
   */
  sendError(ws: ServerWebSocket<unknown>, error: string): void {
    this.sendMessage(ws, {
      type: 'error',
      error,
    });
  }

  /**
   * Send pong response
   */
  sendPong(ws: ServerWebSocket<unknown>): void {
    this.sendMessage(ws, {
      type: 'pong',
    });
  }

  /**
   * Send historical events to a newly connected client
   */
  private sendHistoricalEvents(
    ws: ServerWebSocket<unknown>,
    taskId: string,
    afterId: string,
  ): void {
    try {
      const events = this.eventRepo.streamByTaskId(taskId, {
        afterId,
        limit: 50,
      });

      for (const event of events) {
        this.sendMessage(ws, {
          type: 'task_event',
          taskId,
          data: {
            id: event.id,
            eventType: event.event_type,
            eventData: event.event_data,
            severity: event.severity,
            timestamp: event.created_at.toISOString(),
          },
        });
      }
    } catch (error) {
      this.sendError(
        ws,
        error instanceof Error ? error.message : 'Failed to load historical events',
      );
    }
  }

  /**
   * Send a WebSocket message
   */
  private sendMessage(ws: ServerWebSocket<unknown>, message: WebSocketMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Client disconnected, will be cleaned up
    }
  }

  /**
   * Get number of clients subscribed to a task
   */
  getClientCount(taskId: string): number {
    return this.clients.get(taskId)?.size ?? 0;
  }

  /**
   * Get total number of connected clients
   */
  getTotalClientCount(): number {
    let total = 0;
    for (const clients of this.clients.values()) {
      total += clients.size;
    }
    return total;
  }

  /**
   * Ping all clients to check if they're alive
   */
  pingAll(): void {
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        try {
          client.ws.send(JSON.stringify({ type: 'ping' }));
          client.isAlive = true;
        } catch {
          client.isAlive = false;
        }
      }
    }
  }

  /**
   * Clean up dead clients
   */
  cleanup(): void {
    for (const [taskId, clients] of this.clients.entries()) {
      for (const client of clients) {
        if (!client.isAlive) {
          clients.delete(client);
        }
      }
      if (clients.size === 0) {
        this.clients.delete(taskId);
      }
    }
  }
}

/**
 * Create WebSocket handler for task events
 * Returns handler functions for Bun's WebSocket server
 */
export function createTaskWebSocketHandler(db: Database): {
  open: (ws: ServerWebSocket<unknown>) => void;
  message: (ws: ServerWebSocket<unknown>, message: string) => void;
  close: (ws: ServerWebSocket<unknown>) => void;
} {
  const manager = new TaskEventsManager(db);

  return {
    /**
     * Handle WebSocket connection opened
     */
    open: (ws: ServerWebSocket<unknown>) => {
      // Parse URL to extract task ID from path like /ws/tasks/:id
      const url = new URL(ws.data?.url ?? 'ws://localhost/ws');
      const pathParts = url.pathname.split('/');
      const taskId = pathParts[pathParts.length - 1];
      const afterId = url.searchParams.get('afterId') ?? undefined;

      if (!taskId || taskId === 'tasks') {
        manager.sendError(ws, 'Invalid task ID in URL. Use /ws/tasks/:id');
        ws.close();
        return;
      }

      manager.addClient(ws, taskId, afterId);
    },

    /**
     * Handle WebSocket message received
     */
    message: (ws: ServerWebSocket<unknown>, message: string) => {
      try {
        const data = JSON.parse(message);

        switch (data.type) {
          case 'ping':
            manager.sendPong(ws);
            break;
          case 'subscribe':
            // Allow client to subscribe to a different task
            if (data.taskId) {
              manager.removeClient(ws);
              manager.addClient(ws, data.taskId, data.afterId);
            }
            break;
          case 'unsubscribe':
            manager.removeClient(ws);
            break;
          default:
            manager.sendError(ws, `Unknown message type: ${data.type}`);
        }
      } catch {
        manager.sendError(ws, 'Invalid JSON message');
      }
    },

    /**
     * Handle WebSocket connection closed
     */
    close: (ws: ServerWebSocket<unknown>) => {
      manager.removeClient(ws);
    },
  };
}
