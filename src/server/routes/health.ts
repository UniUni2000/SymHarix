/**
 * Health Check Routes for SymHarix HTTP Server
 */

import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { HealthResponse, ApiResponse } from '../types';
import type { RuntimeControlPlane } from '../../runtime/types';
import type { BotGateway } from '../../bots/types';
import type { RuntimeAccessController } from '../runtimeAccess';

const DEFAULT_HEALTH_MAX_RSS_MB = 1536;

function resolveHealthMaxRssBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.SYMHARIX_HEALTH_MAX_RSS_MB);
  const maxRssMb = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_HEALTH_MAX_RSS_MB;
  return maxRssMb * 1024 * 1024;
}

export interface HealthRouteDependencies {
  runtimeControlPlane?: RuntimeControlPlane | null;
  botGateway?: BotGateway | null;
  runtimeAccessController?: RuntimeAccessController | null;
}

function evaluateChecks(
  db: Database,
  dependencies: HealthRouteDependencies,
): Record<string, boolean> {
  const checks: Record<string, boolean> = {
    database: false,
    memory: false,
    runtime: true,
    runtime_writes_protected: true,
    bot_transports: true,
    bot_operators: true,
    bot_natural_language: true,
  };

  try {
    db.exec('SELECT 1');
    checks.database = true;
  } catch {
    checks.database = false;
  }

  checks.memory = process.memoryUsage().rss < resolveHealthMaxRssBytes();

  if (dependencies.runtimeControlPlane) {
    try {
      dependencies.runtimeControlPlane.getOverview();
      checks.runtime = true;
    } catch {
      checks.runtime = false;
    }
    checks.runtime_writes_protected = Boolean(
      dependencies.runtimeAccessController?.hasWriteToken(),
    );
  }

  if (dependencies.botGateway) {
    try {
      const manifest = dependencies.botGateway.getManifest();
      const enabledTransports = Object.values(manifest.transports)
        .filter((transport) => transport.enabled);
      checks.bot_transports = enabledTransports.every(
        (transport) => transport.health !== 'degraded',
      );
      checks.bot_operators = enabledTransports.every(
        (transport) => transport.operator_configured === true,
      );
      checks.bot_natural_language = manifest.natural_language_enabled !== true
        || (
          manifest.assistant.configured
          && manifest.assistant.health !== 'degraded'
          && manifest.assistant.health !== 'unconfigured'
        );
    } catch {
      checks.bot_transports = false;
      checks.bot_operators = false;
      checks.bot_natural_language = false;
    }
  }

  return checks;
}

/**
 * Create health check routes
 */
export function createHealthRoutes(
  db: Database,
  dependencies: HealthRouteDependencies = {},
): Hono {
  const health = new Hono();

  const requireReadAccess = async (
    c: Parameters<Parameters<typeof health.use>[1]>[0],
    next: () => Promise<void>,
  ) => {
    if (!dependencies.runtimeAccessController?.authorizeRead(c.req.raw).allowed) {
      c.header('Cache-Control', 'private, no-store');
      c.header('WWW-Authenticate', 'Bearer realm="SymHarix Runtime"');
      return c.json({
        success: false,
        error: 'Runtime read access requires authentication.',
      }, 401);
    }
    await next();
    c.header('Cache-Control', 'private, no-store');
  };

  // Liveness remains deliberately public for local process/container probes.
  // Detailed dependency state can expose transport, operator, and model setup.
  health.use('/', requireReadAccess);
  health.use('/ready', requireReadAccess);

  /**
   * GET /api/v1/health
   * Health check endpoint
   */
  health.get('/', (c) => {
    const checks = evaluateChecks(db, dependencies);

    const status: HealthResponse['status'] = !checks.database
      ? 'unhealthy'
      : Object.values(checks).every(Boolean)
        ? 'healthy'
        : 'degraded';

    const response: ApiResponse<HealthResponse> = {
      success: true,
      data: {
        status,
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        checks,
      },
    };

    return c.json(response);
  });

  /**
   * GET /api/v1/health/ready
   * Readiness probe - checks if server is ready to accept traffic
   */
  health.get('/ready', (c) => {
    const checks = evaluateChecks(db, dependencies);
    const ready = Object.values(checks).every(Boolean);
    if (ready) {
      return c.json({
        success: true,
        data: { ready: true, checks },
      });
    }
    return c.json(
      {
        success: false,
        error: 'Dependencies not ready',
        data: { ready: false, checks },
      },
      503,
    );
  });

  /**
   * GET /api/v1/health/live
   * Liveness probe - checks if server is alive
   */
  health.get('/live', (c) => {
    return c.json({
      success: true,
      data: { alive: true },
    });
  });

  return health;
}
