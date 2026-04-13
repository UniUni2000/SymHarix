/**
 * Stats Routes for Symphony HTTP Server
 * Handles /api/v1/stats endpoints
 */

import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { TaskRepository } from '../../database/repositories/taskRepository';
import { EventRepository } from '../../database/repositories/eventRepository';
import type { ApiResponse, StatsResponse } from '../types';

/**
 * Create stats routes
 */
export function createStatsRoutes(db: Database): Hono {
  const stats = new Hono();
  const taskRepo = new TaskRepository(db);
  const eventRepo = new EventRepository(db);

  /**
   * GET /api/v1/stats
   * Get system statistics
   */
  stats.get('/', (c) => {
    // Get all tasks and count by state
    const allTasks = taskRepo.findAll();
    const tasksByState: Record<string, number> = {};

    for (const task of allTasks) {
      tasksByState[task.state] = (tasksByState[task.state] || 0) + 1;
    }

    // Get all events and count by type
    const stmt = db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM execution_events
      GROUP BY event_type
    `);
    const eventRows = stmt.all() as { event_type: string; count: number }[];

    const eventsByType: Record<string, number> = {};
    let totalEvents = 0;

    for (const row of eventRows) {
      eventsByType[row.event_type] = row.count;
      totalEvents += row.count;
    }

    // Get session stats from memory usage
    const memUsage = process.memoryUsage();

    const response: ApiResponse<StatsResponse> = {
      success: true,
      data: {
        tasks: {
          total: allTasks.length,
          byState: tasksByState,
        },
        events: {
          total: totalEvents,
          byType: eventsByType,
        },
        sessions: {
          total: allTasks.filter((t) => t.state === 'Running' || t.state === 'Claimed').length,
          running: allTasks.filter((t) => t.state === 'Running').length,
          completed: allTasks.filter((t) => t.state === 'Released').length,
          failed: allTasks.filter((t) => t.retry_count >= t.max_retries).length,
        },
      },
    };

    return c.json(response);
  });

  /**
   * GET /api/v1/stats/tasks
   * Get task-specific statistics
   */
  stats.get('/tasks', (c) => {
    const allTasks = taskRepo.findAll();
    const tasksByState: Record<string, number> = {};

    for (const task of allTasks) {
      tasksByState[task.state] = (tasksByState[task.state] || 0) + 1;
    }

    return c.json({
      success: true,
      data: {
        total: allTasks.length,
        byState: tasksByState,
      },
    });
  });

  /**
   * GET /api/v1/stats/events
   * Get event-specific statistics
   */
  stats.get('/events', (c) => {
    const stmt = db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM execution_events
      GROUP BY event_type
      ORDER BY count DESC
    `);
    const rows = stmt.all() as { event_type: string; count: number }[];

    const byType: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      byType[row.event_type] = row.count;
      total += row.count;
    }

    return c.json({
      success: true,
      data: {
        total,
        byType,
      },
    });
  });

  /**
   * GET /api/v1/stats/summary
   * Get quick summary statistics
   */
  stats.get('/summary', (c) => {
    const totalTasks = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE deleted_at IS NULL').get() as { count: number };
    const totalEvents = db.prepare('SELECT COUNT(*) as count FROM execution_events').get() as { count: number };
    const runningTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE state = 'Running' AND deleted_at IS NULL").get() as { count: number };

    return c.json({
      success: true,
      data: {
        tasks: totalTasks.count,
        events: totalEvents.count,
        running: runningTasks.count,
      },
    });
  });

  return stats;
}
