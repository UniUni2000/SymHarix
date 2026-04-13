/**
 * Symphony HTTP Server - Main Entry Point
 * Hono-based REST API server with WebSocket support
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ServerWebSocket } from 'bun';
import type { Database } from 'bun:sqlite';
import { createHealthRoutes } from './routes/health';
import { createTaskRoutes } from './routes/tasks';
import { createStatsRoutes } from './routes/stats';
import { createTaskWebSocketHandler } from './websocket/taskEvents';
import type { ServerConfig, ApiResponse } from './types';

/**
 * Default server configuration
 */
const DEFAULT_CONFIG: ServerConfig = {
  port: 3000,
  hostname: '0.0.0.0',
  corsOrigins: ['*'],
  enableWebSocket: true,
};

/**
 * SymphonyServer class
 * Main HTTP server with Hono framework
 */
export class SymphonyServer {
  private app: Hono;
  private config: ServerConfig;
  private db: Database;
  private server: Bun.HTTPServer | null = null;
  private wsHandler: ReturnType<typeof createTaskWebSocketHandler> | null = null;

  /**
   * Create a new Symphony server instance
   */
  constructor(db: Database, config: Partial<ServerConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.app = new Hono();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  /**
   * Setup middleware
   */
  private setupMiddleware(): void {
    // Logger middleware
    this.app.use('*', logger());

    // CORS middleware
    this.app.use('*', cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      exposeHeaders: ['X-Request-ID', 'X-Total-Count'],
      maxAge: 86400,
    }));

    // Error handler
    this.app.onError((err, c) => {
      console.error('Unhandled error:', err);
      const response: ApiResponse = {
        success: false,
        error: err.message || 'Internal server error',
      };
      return c.json(response, 500);
    });

    // Not found handler
    this.app.notFound((c) => {
      const response: ApiResponse = {
        success: false,
        error: 'Not found',
      };
      return c.json(response, 404);
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // API v1 routes
    const apiV1 = new Hono();

    // Mount sub-routes
    apiV1.route('/health', createHealthRoutes(this.db));
    apiV1.route('/tasks', createTaskRoutes(this.db));
    apiV1.route('/stats', createStatsRoutes(this.db));

    // Mount API v1 under /api/v1
    this.app.route('/api/v1', apiV1);

    // Root endpoint
    this.app.get('/', (c) => {
      return c.json({
        success: true,
        data: {
          name: 'Symphony HTTP Server',
          version: '1.0.0',
          endpoints: {
            health: '/api/v1/health',
            tasks: '/api/v1/tasks',
            stats: '/api/v1/stats',
            websocket: '/ws/tasks/:id',
          },
        },
      });
    });
  }

  /**
   * Setup WebSocket handlers
   */
  private setupWebSocket(): void {
    if (this.config.enableWebSocket) {
      this.wsHandler = createTaskWebSocketHandler(this.db);
    }
  }

  /**
   * Get the Hono app instance
   */
  getApp(): Hono {
    return this.app;
  }

  /**
   * Start the server
   */
  async start(): Promise<{ port: number; hostname: string }> {
    return new Promise((resolve, reject) => {
      try {
        this.server = Bun.serve({
          port: this.config.port,
          hostname: this.config.hostname,
          fetch: this.app.fetch,
          websocket: this.wsHandler
            ? {
                open: this.wsHandler.open,
                message: this.wsHandler.message,
                close: this.wsHandler.close,
                idleTimeout: 30,
              }
            : undefined,
        });

        console.log(
          `Symphony Server started on http://${this.config.hostname}:${this.server.port}`,
        );

        resolve({
          port: this.server!.port,
          hostname: this.config.hostname,
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.stop();
        this.server = null;
        console.log('Symphony Server stopped');
      }
      resolve();
    });
  }

  /**
   * Get server information
   */
  getInfo(): {
    running: boolean;
    port: number | null;
    hostname: string;
    websocketEnabled: boolean;
  } {
    return {
      running: this.server !== null,
      port: this.server?.port ?? null,
      hostname: this.config.hostname,
      websocketEnabled: this.config.enableWebSocket,
    };
  }
}

/**
 * Create and start a Symphony server
 */
export async function createServer(
  db: Database,
  config?: Partial<ServerConfig>,
): Promise<SymphonyServer> {
  const server = new SymphonyServer(db, config);
  await server.start();
  return server;
}

export default SymphonyServer;
