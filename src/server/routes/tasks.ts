/**
 * Task Routes for Symphony HTTP Server
 * Handles /api/v1/tasks endpoints
 */

import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { TaskRepository } from '../../database/repositories/taskRepository';
import { EventRepository } from '../../database/repositories/eventRepository';
import type {
  ApiResponse,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskActionResponse,
  PaginatedResponse,
} from '../types';
import type { Task } from '../../database/types';

/**
 * Create task routes
 */
export function createTaskRoutes(db: Database): Hono {
  const tasks = new Hono();
  const taskRepo = new TaskRepository(db);
  const eventRepo = new EventRepository(db);

  /**
   * GET /api/v1/tasks
   * List all tasks with pagination
   */
  tasks.get('/', (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '20');
    const state = c.req.query('state');
    const offset = (page - 1) * limit;

    let allTasks: Task[];

    if (state) {
      allTasks = taskRepo.findByState(state);
    } else {
      allTasks = taskRepo.findAll();
    }

    const total = allTasks.length;
    const paginatedTasks = allTasks.slice(offset, offset + limit);

    const response: PaginatedResponse<Task> = {
      success: true,
      data: paginatedTasks,
      pagination: {
        total,
        page,
        limit,
        hasMore: offset + limit < total,
      },
    };

    return c.json(response);
  });

  /**
   * GET /api/v1/tasks/:id
   * Get task by ID
   */
  tasks.get('/:id', (c) => {
    const id = c.req.param('id');
    const task = taskRepo.findById(id);

    if (!task) {
      return c.json(
        {
          success: false,
          error: 'Task not found',
        },
        404,
      );
    }

    const response: ApiResponse<Task> = {
      success: true,
      data: task,
    };

    return c.json(response);
  });

  /**
   * POST /api/v1/tasks
   * Create a new task
   */
  tasks.post('/', async (c) => {
    try {
      const body = await c.req.json<CreateTaskRequest>();

      // Validate required fields
      if (!body.identifier || !body.title) {
        return c.json(
          {
            success: false,
            error: 'identifier and title are required',
          },
          400,
        );
      }

      // Check if task with this identifier already exists
      const existing = taskRepo.findByIssueId(body.identifier);
      if (existing) {
        return c.json(
          {
            success: false,
            error: 'Task with this identifier already exists',
          },
          409,
        );
      }

      const task: Omit<Task, 'created_at' | 'updated_at'> = {
        id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        identifier: body.identifier,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? null,
        state: body.state ?? 'Unclaimed',
        branch_name: body.branch_name ?? null,
        url: body.url ?? null,
        labels: body.labels ?? [],
        blocked_by: body.blocked_by ?? [],
        workspace_key: null,
        retry_count: 0,
        max_retries: body.max_retries ?? 3,
      };

      const created = taskRepo.create(task);

      // Log task creation event
      eventRepo.create({
        task_id: created.id,
        event_type: 'task_created',
        event_data: {
          identifier: created.identifier,
          title: created.title,
        },
        source: 'api',
      });

      const response: ApiResponse<Task> = {
        success: true,
        data: created,
        message: 'Task created successfully',
      };

      return c.json(response, 201);
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Invalid request body',
        },
        400,
      );
    }
  });

  /**
   * PUT /api/v1/tasks/:id
   * Update a task
   */
  tasks.put('/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const body = await c.req.json<UpdateTaskRequest>();

      const task = taskRepo.findById(id);
      if (!task) {
        return c.json(
          {
            success: false,
            error: 'Task not found',
          },
          404,
        );
      }

      const updated = taskRepo.update({
        id,
        ...body,
      });

      if (!updated) {
        return c.json(
          {
            success: false,
            error: 'Failed to update task',
          },
          500,
        );
      }

      // Log task update event
      eventRepo.create({
        task_id: id,
        event_type: 'task_updated',
        event_data: {
          fields: Object.keys(body),
        },
        source: 'api',
      });

      const response: ApiResponse<Task> = {
        success: true,
        data: updated,
        message: 'Task updated successfully',
      };

      return c.json(response);
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Invalid request body',
        },
        400,
      );
    }
  });

  /**
   * DELETE /api/v1/tasks/:id
   * Soft delete a task
   */
  tasks.delete('/:id', (c) => {
    const id = c.req.param('id');
    const task = taskRepo.findById(id);

    if (!task) {
      return c.json(
        {
          success: false,
          error: 'Task not found',
        },
        404,
      );
    }

    const deleted = taskRepo.delete(id);

    if (!deleted) {
      return c.json(
        {
          success: false,
          error: 'Failed to delete task',
        },
        500,
      );
    }

    // Log task deletion event
    eventRepo.create({
      task_id: id,
      event_type: 'task_deleted',
      event_data: {
        identifier: task.identifier,
      },
      source: 'api',
    });

    return c.json({
      success: true,
      message: 'Task deleted successfully',
    });
  });

  /**
   * POST /api/v1/tasks/:id/pause
   * Pause a running task
   */
  tasks.post('/:id/pause', (c) => {
    const id = c.req.param('id');
    const task = taskRepo.findById(id);

    if (!task) {
      return c.json(
        {
          success: false,
          error: 'Task not found',
        },
        404,
      );
    }

    const updated = taskRepo.updateStatus(id, 'Claimed');

    if (!updated) {
      return c.json(
        {
          success: false,
          error: 'Failed to pause task',
        },
        500,
      );
    }

    // Log pause event
    eventRepo.create({
      task_id: id,
      event_type: 'task_paused',
      event_data: {
        previousState: task.state,
        newState: 'Claimed',
      },
      source: 'api',
    });

    const response: TaskActionResponse = {
      success: true,
      taskId: id,
      action: 'pause',
      message: 'Task paused successfully',
    };

    return c.json(response);
  });

  /**
   * POST /api/v1/tasks/:id/cancel
   * Cancel a task
   */
  tasks.post('/:id/cancel', (c) => {
    const id = c.req.param('id');
    const task = taskRepo.findById(id);

    if (!task) {
      return c.json(
        {
          success: false,
          error: 'Task not found',
        },
        404,
      );
    }

    const updated = taskRepo.updateStatus(id, 'Released');

    if (!updated) {
      return c.json(
        {
          success: false,
          error: 'Failed to cancel task',
        },
        500,
      );
    }

    // Log cancel event
    eventRepo.create({
      task_id: id,
      event_type: 'task_cancelled',
      event_data: {
        previousState: task.state,
        newState: 'Released',
      },
      source: 'api',
    });

    const response: TaskActionResponse = {
      success: true,
      taskId: id,
      action: 'cancel',
      message: 'Task cancelled successfully',
    };

    return c.json(response);
  });

  /**
   * GET /api/v1/tasks/:id/events
   * Get events for a specific task
   */
  tasks.get('/:id/events', (c) => {
    const id = c.req.param('id');
    const task = taskRepo.findById(id);

    if (!task) {
      return c.json(
        {
          success: false,
          error: 'Task not found',
        },
        404,
      );
    }

    const limit = parseInt(c.req.query('limit') || '100');
    const offset = parseInt(c.req.query('offset') || '0');

    const events = eventRepo.findByTaskId(id, { limit, offset });

    return c.json({
      success: true,
      data: events,
      pagination: {
        total: eventRepo.countByTaskId(id),
        limit,
        offset,
      },
    });
  });

  return tasks;
}
