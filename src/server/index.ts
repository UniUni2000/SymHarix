/**
 * symharix HTTP Server - Main Entry Point
 * Minimal Hono REST API for the control plane
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Database } from 'bun:sqlite';
import { createHealthRoutes } from './routes/health';
import { createWorkItemRoutes } from './routes/work-items';
import { createRuntimeRoutes } from './routes/runtime';
import { createBotRoutes } from './routes/bots';
import type { ServerConfig, ApiResponse } from './types';
import type { RuntimeControlPlane } from '../runtime/types';
import { renderRuntimePage } from '../runtime/page';
import { renderRuntimeMiniAppPage } from '../runtime/miniAppPage';
import { createBotGatewayFromEnv } from '../bots/gateway';
import type { BotGateway } from '../bots/types';
import {
  createRuntimeAccessControllerFromEnv,
  type RuntimeAccessController,
} from './runtimeAccess';
import { readSymHarixEnv } from '../config/env';

/**
 * Default server configuration
 */
const DEFAULT_CONFIG: ServerConfig = {
  port: 3000,
  hostname: '0.0.0.0',
  corsOrigins: ['*'],
};

/**
 * SymHarixServer class
 * Main HTTP server with Hono framework
 */
export class SymHarixServer {
  private app: Hono;
  private config: ServerConfig;
  private db: Database;
  private runtimeControlPlane: RuntimeControlPlane | null;
  private botGateway: BotGateway | null;
  private runtimeAccessController: RuntimeAccessController | null;
  private server: ReturnType<typeof Bun.serve> | null = null;

  /**
   * Create a new SymHarix server instance
   */
  constructor(
    db: Database,
    config: Partial<ServerConfig> = {},
    runtimeControlPlane: RuntimeControlPlane | null = null,
    botGateway: BotGateway | null = runtimeControlPlane ? createBotGatewayFromEnv(runtimeControlPlane, db) : null,
    runtimeAccessController: RuntimeAccessController | null = runtimeControlPlane ? createRuntimeAccessControllerFromEnv() : null,
  ) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.runtimeControlPlane = runtimeControlPlane;
    this.botGateway = botGateway;
    this.runtimeAccessController = runtimeAccessController;
    this.app = new Hono();

    this.setupMiddleware();
    this.setupRoutes();
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
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-SymHarix-Runtime-Token'],
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
    apiV1.route('/work-items', createWorkItemRoutes(this.db));
    if (this.runtimeControlPlane && this.runtimeAccessController) {
      apiV1.route('/runtime', createRuntimeRoutes(this.runtimeControlPlane, this.runtimeAccessController, {
        getPublicBaseUrl: () => this.getPublicBaseUrl(),
      }));
    }
    if (this.botGateway) {
      apiV1.route('/bots', createBotRoutes(this.botGateway));
    }

    // Mount API v1 under /api/v1
    this.app.route('/api/v1', apiV1);

    if (this.runtimeControlPlane) {
      this.app.get('/runtime', (c) => c.html(renderRuntimePage()));
      this.app.get('/runtime/issues/:id/app', (c) => c.html(renderRuntimeMiniAppPage(c.req.param('id'))));
    }

    // Root endpoint
    this.app.get('/', (c) => {
      return c.json({
        success: true,
        data: {
          name: 'symharix HTTP Server',
          version: '1.0.0',
          endpoints: {
            health: '/api/v1/health',
            workItems: '/api/v1/work-items',
            ...(this.runtimeControlPlane
              ? {
                  runtimeOverview: '/api/v1/runtime/overview',
                  runtimeManifest: '/api/v1/runtime/manifest',
                  runtimeStream: '/api/v1/runtime/stream',
                  runtimeApp: '/runtime',
                  runtimeIssueMiniApp: '/runtime/issues/:id/app',
                  ...(this.botGateway
                    ? {
                        botsManifest: '/api/v1/bots/manifest',
                      }
                    : {}),
                }
              : {}),
          },
        },
      });
    });
  }

  /**
   * Get the Hono app instance
   */
  getApp(): Hono {
    return this.app;
  }

  private getPublicBaseUrl(): string | null {
    const manifestUrl = this.botGateway?.getManifest().transports.telegram.public_base_url ?? null;
    const envUrl = readSymHarixEnv('SYMPHONY_PUBLIC_BASE_URL') || null;
    const raw = manifestUrl || envUrl;
    if (!raw) {
      return null;
    }
    return raw.replace(/\/+$/, '');
  }

  /**
   * Start the server
   */
  async start(): Promise<{ port: number; hostname: string }> {
    return new Promise((resolve, reject) => {
      void (async () => {
        this.server = Bun.serve({
          port: this.config.port,
          hostname: this.config.hostname,
          idleTimeout: 255,
          fetch: this.app.fetch,
        });

        console.log(
          `symharix server started on http://${this.config.hostname}:${this.server.port}`,
        );
        const port = this.server.port ?? this.config.port ?? 0;

        const localHost = this.config.hostname === '0.0.0.0' ? '127.0.0.1' : this.config.hostname;
        await this.botGateway?.initializeInboundIntegration?.({
          localBaseUrl: `http://${localHost}:${port}`,
          inboundPath: '/api/v1/bots/telegram/webhook',
        });

        resolve({
          port,
          hostname: this.config.hostname,
        });
      })().catch((error) => {
        reject(error);
      });
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
      console.log('symharix server stopped');
      }
      this.botGateway?.dispose?.();
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
  } {
    return {
      running: this.server !== null,
      port: this.server?.port ?? null,
      hostname: this.config.hostname,
    };
  }
}

/**
 * Create and start a SymHarix server
 */
export async function createServer(
  db: Database,
  config?: Partial<ServerConfig>,
  runtimeControlPlane?: RuntimeControlPlane | null,
  botGateway?: BotGateway | null,
  runtimeAccessController?: RuntimeAccessController | null,
): Promise<SymHarixServer> {
  const server = new SymHarixServer(
    db,
    config,
    runtimeControlPlane ?? null,
    botGateway === undefined
      ? runtimeControlPlane
        ? createBotGatewayFromEnv(runtimeControlPlane, db)
        : null
      : botGateway,
    runtimeAccessController === undefined
      ? runtimeControlPlane
        ? createRuntimeAccessControllerFromEnv()
        : null
      : runtimeAccessController,
  );
  await server.start();
  return server;
}

export default SymHarixServer;
