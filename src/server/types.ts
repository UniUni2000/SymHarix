/**
 * Server Types for Symphony HTTP Server
 */

import type { Context } from 'hono';
import type { Task, TaskStatus } from '../database/types';
import type { SessionBroadcaster } from '../claude-runtime/session';

/**
 * API Response wrapper
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  };
}

/**
 * Task creation request
 */
export interface CreateTaskRequest {
  identifier: string;
  title: string;
  description?: string;
  priority?: number;
  state?: TaskStatus;
  branch_name?: string;
  url?: string;
  labels?: string[];
  blocked_by?: string[];
  max_retries?: number;
}

/**
 * Task update request
 */
export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  priority?: number;
  state?: TaskStatus;
  branch_name?: string;
  url?: string;
  labels?: string[];
  blocked_by?: string[];
}

/**
 * Task action response
 */
export interface TaskActionResponse {
  success: boolean;
  taskId: string;
  action: string;
  message: string;
}

/**
 * Statistics response
 */
export interface StatsResponse {
  tasks: {
    total: number;
    byState: Record<string, number>;
  };
  events: {
    total: number;
    byType: Record<string, number>;
  };
  sessions: {
    total: number;
    running: number;
    completed: number;
    failed: number;
  };
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  timestamp: string;
  checks: {
    database: boolean;
    memory: boolean;
  };
}

/**
 * WebSocket message types
 */
export type WebSocketMessageType =
  | 'connected'
  | 'task_event'
  | 'task_state_changed'
  | 'error'
  | 'pong';

/**
 * WebSocket message structure
 */
export interface WebSocketMessage {
  type: WebSocketMessageType;
  taskId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
  error?: string;
}

/**
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  hostname: string;
  corsOrigins: string[];
  enableWebSocket: boolean;
}

/**
 * Default server configuration
 */
export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 3000,
  hostname: '0.0.0.0',
  corsOrigins: ['*'],
  enableWebSocket: true,
};

/**
 * Event subscription for WebSocket clients
 */
export interface EventSubscription {
  taskId: string;
  client: {
    send: (data: string) => void;
    isAlive?: () => boolean;
  };
}
