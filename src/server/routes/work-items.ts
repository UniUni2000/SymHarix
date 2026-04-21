import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import {
  AgentRunRepository,
  ReviewEventRepository,
  WorkItemRepository
} from '../../database';
import type { ApiResponse, PaginatedResponse } from '../types';
import type { AgentRun, ReviewEvent, WorkItem } from '../../database/types';

export function createWorkItemRoutes(db: Database): Hono {
  const workItems = new Hono();
  const workItemRepository = new WorkItemRepository(db);
  const agentRunRepository = new AgentRunRepository(db);
  const reviewEventRepository = new ReviewEventRepository(db);

  workItems.get('/', (c) => {
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const state = c.req.query('state');
    const offset = (page - 1) * limit;

    const allWorkItems = state
      ? workItemRepository.findByOrchestratorState(state as WorkItem['orchestrator_state'])
      : workItemRepository.findAll();
    const total = allWorkItems.length;

    const response: PaginatedResponse<WorkItem> = {
      success: true,
      data: allWorkItems.slice(offset, offset + limit),
      pagination: {
        total,
        page,
        limit,
        hasMore: offset + limit < total,
      },
    };

    return c.json(response);
  });

  workItems.get('/:id', (c) => {
    const id = c.req.param('id');
    const workItem = workItemRepository.findById(id);

    if (!workItem) {
      return c.json(
        {
          success: false,
          error: 'Work item not found',
        },
        404
      );
    }

    const response: ApiResponse<WorkItem> = {
      success: true,
      data: workItem,
    };

    return c.json(response);
  });

  workItems.get('/:id/runs', (c) => {
    const id = c.req.param('id');
    const workItem = workItemRepository.findById(id);

    if (!workItem) {
      return c.json(
        {
          success: false,
          error: 'Work item not found',
        },
        404
      );
    }

    const response: ApiResponse<AgentRun[]> = {
      success: true,
      data: agentRunRepository.findByWorkItemId(id),
    };

    return c.json(response);
  });

  workItems.get('/:id/reviews', (c) => {
    const id = c.req.param('id');
    const workItem = workItemRepository.findById(id);

    if (!workItem) {
      return c.json(
        {
          success: false,
          error: 'Work item not found',
        },
        404
      );
    }

    const response: ApiResponse<ReviewEvent[]> = {
      success: true,
      data: reviewEventRepository.findByWorkItemId(id),
    };

    return c.json(response);
  });

  return workItems;
}
