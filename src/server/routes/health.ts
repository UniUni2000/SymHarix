/**
 * Health Check Routes for Symphony HTTP Server
 */

import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { HealthResponse, ApiResponse } from '../types';

/**
 * Create health check routes
 */
export function createHealthRoutes(db: Database): Hono {
  const health = new Hono();

  /**
   * GET /api/v1/health
   * Health check endpoint
   */
  health.get('/', (c) => {
    const checks = {
      database: false,
      memory: false,
    };

    // Check database connectivity
    try {
      db.exec('SELECT 1');
      checks.database = true;
    } catch {
      checks.database = false;
    }

    // Check memory usage (degraded if over 90%)
    const memUsage = process.memoryUsage();
    const heapUsedRatio = memUsage.heapUsed / memUsage.heapTotal;
    checks.memory = heapUsedRatio < 0.9;

    // Determine overall health status
    let status: HealthResponse['status'] = 'healthy';
    if (!checks.database || !checks.memory) {
      status = 'degraded';
    }
    if (!checks.database) {
      status = 'unhealthy';
    }

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
    try {
      db.exec('SELECT 1');
      return c.json({
        success: true,
        data: { ready: true },
      });
    } catch {
      return c.json(
        {
          success: false,
          error: 'Database not ready',
        },
        503,
      );
    }
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
