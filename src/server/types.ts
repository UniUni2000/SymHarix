/**
 * Server Types for Symphony HTTP Server
 */

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
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  hostname: string;
  corsOrigins: string[];
}

/**
 * Default server configuration
 */
export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 3000,
  hostname: '0.0.0.0',
  corsOrigins: ['*'],
};
