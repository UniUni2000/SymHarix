/**
 * symharix HTTP Server - Main Entry Point
 * Minimal Hono REST API for the control plane
 */

import { createServer as createNetServer } from 'node:net';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Database } from 'bun:sqlite';
import { createHealthRoutes } from './routes/health';
import { createWorkItemRoutes } from './routes/work-items';
import { createRuntimeRoutes } from './routes/runtime';
import { createBotRoutes } from './routes/bots';
import { DEFAULT_SERVER_CONFIG, type ServerConfig, type ApiResponse } from './types';
import type { RuntimeControlPlane } from '../runtime/types';
import { renderRuntimePage } from '../runtime/page';
import { renderRuntimeMiniAppPage } from '../runtime/miniAppPage';
import { renderRuntimeLoginPage } from '../runtime/loginPage';
import { createBotGatewayFromEnv } from '../bots/gateway';
import type { BotGateway } from '../bots/types';
import {
  createRuntimeAccessControllerFromEnv,
  type RuntimeAccessController,
} from './runtimeAccess';
import { readSymHarixEnv } from '../config/env';
import {
  createTelegramMiniAppAuthConfigFromEnv,
  type TelegramMiniAppAuthConfig,
} from './telegramMiniAppAuth';

const QUIET_ACCESS_LOG_PATHS = new Set([
  '/',
  '/api/v1/bots/manifest',
]);

export function shouldLogAccessRequest(method: string, pathname: string): boolean {
  const normalizedPath = pathname.trim() || '/';
  if (method.toUpperCase() === 'GET' && QUIET_ACCESS_LOG_PATHS.has(normalizedPath)) {
    return false;
  }
  return true;
}

async function reserveEphemeralPort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error('Failed to reserve an ephemeral server port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function resolveServePort(port: number, hostname: string): Promise<number> {
  if (port !== 0) {
    return port;
  }
  return reserveEphemeralPort(hostname);
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

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
  private telegramMiniAppAuthConfig: TelegramMiniAppAuthConfig | null;
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
    telegramMiniAppAuthConfig: TelegramMiniAppAuthConfig | null = runtimeControlPlane
      ? createTelegramMiniAppAuthConfigFromEnv()
      : null,
  ) {
    this.db = db;
    this.config = {
      ...DEFAULT_SERVER_CONFIG,
      ...config,
      corsOrigins: [...(config.corsOrigins ?? DEFAULT_SERVER_CONFIG.corsOrigins)],
    };
    this.runtimeControlPlane = runtimeControlPlane;
    this.botGateway = botGateway;
    this.runtimeAccessController = runtimeAccessController;
    this.telegramMiniAppAuthConfig = telegramMiniAppAuthConfig;
    this.app = new Hono();

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup middleware
   */
  private setupMiddleware(): void {
    this.app.use('*', async (c, next) => {
      const startedAt = Date.now();
      await next();
      const url = new URL(c.req.url);
      if (!shouldLogAccessRequest(c.req.method, url.pathname)) {
        return;
      }
      console.log(`[http] ${c.req.method} ${url.pathname} ${c.res.status} ${Date.now() - startedAt}ms`);
    });

    if (this.config.corsOrigins.length > 0) {
      const allowedOrigins = new Set(this.config.corsOrigins);
      this.app.use('*', cors({
        origin: (origin) => (
          allowedOrigins.has('*') || allowedOrigins.has(origin)
            ? origin
            : null
        ),
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Request-ID',
          'X-SymHarix-Runtime-Token',
          'X-SymHarix-Runtime-CSRF',
        ],
        exposeHeaders: ['X-Request-ID', 'X-Total-Count'],
        maxAge: 86400,
      }));
    }

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
    apiV1.route('/health', createHealthRoutes(this.db, {
      runtimeControlPlane: this.runtimeControlPlane,
      botGateway: this.botGateway,
      runtimeAccessController: this.runtimeAccessController,
    }));
    apiV1.route('/work-items', createWorkItemRoutes(this.db, this.runtimeAccessController));
    if (this.runtimeControlPlane && this.runtimeAccessController) {
      apiV1.route('/runtime', createRuntimeRoutes(this.runtimeControlPlane, this.runtimeAccessController, {
        getPublicBaseUrl: () => this.getPublicBaseUrl(),
        botGateway: this.botGateway,
        telegramMiniAppAuth: this.telegramMiniAppAuthConfig,
      }));
    }
    if (this.botGateway) {
      apiV1.route('/bots', createBotRoutes(this.botGateway, this.runtimeAccessController));
    }

    // Mount API v1 under /api/v1
    this.app.route('/api/v1', apiV1);

    if (this.runtimeControlPlane) {
      const renderProtectedRuntimePage = (c: Context, render: () => string) => {
        const access = this.runtimeAccessController?.authorizeRead(c.req.raw);
        c.header('Cache-Control', 'private, no-store');
        if (!access?.allowed) {
          c.header('WWW-Authenticate', 'Bearer realm="SymHarix Runtime"');
          const requestUrl = new URL(c.req.url);
          return c.html(renderRuntimeLoginPage(`${requestUrl.pathname}${requestUrl.search}`), 401);
        }
        return c.html(render());
      };
      this.app.get('/runtime', (c) => renderProtectedRuntimePage(c, renderRuntimePage));
      this.app.get('/runtime/issues/:id/app', (c) => (
        renderProtectedRuntimePage(c, () => renderRuntimeMiniAppPage(c.req.param('id')))
      ));
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
    const transports = this.botGateway?.getManifest().transports;
    const manifestUrl = transports?.telegram?.public_base_url
      ?? transports?.feishu?.public_base_url
      ?? null;
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
        if (!isLoopbackHostname(this.config.hostname)) {
          if (this.runtimeAccessController && !this.runtimeAccessController.hasReadCredential()) {
            throw new Error(
              'Refusing to expose the Runtime control plane without SYMHARIX_RUNTIME_VIEWER_TOKEN or SYMHARIX_RUNTIME_WRITE_TOKEN',
            );
          }
          if (this.config.corsOrigins.includes('*')) {
            throw new Error(
              'Refusing to expose the server with wildcard CORS; configure exact origins',
            );
          }
        }
        const requestedPort = await resolveServePort(this.config.port, this.config.hostname);
        this.server = Bun.serve({
          port: requestedPort,
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
