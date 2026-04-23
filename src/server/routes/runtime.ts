import { Hono } from 'hono';
import type { ApiResponse } from '../types';
import type { RuntimeControlPlane } from '../../runtime/types';
import { buildRuntimeManifest, type RuntimeAccessController } from '../runtimeAccess';

type RuntimeRouteStatus = 200 | 201 | 202 | 400 | 403 | 404 | 409;

function buildActionStatus(result: { accepted: boolean; status: string }): RuntimeRouteStatus {
  if (result.status === 'not_found') {
    return 404;
  }
  if (!result.accepted || result.status === 'rejected') {
    return 409;
  }
  if (result.status === 'completed') {
    return 200;
  }
  return 202;
}

export function createRuntimeRoutes(
  controlPlane: RuntimeControlPlane,
  accessController: RuntimeAccessController,
): Hono {
  const runtime = new Hono();

  runtime.get('/manifest', (c) => {
    return c.json({
      success: true,
      data: buildRuntimeManifest(accessController.describe(c.req.raw.headers)),
    });
  });

  runtime.get('/overview', (c) => {
    const response: ApiResponse = {
      success: true,
      data: controlPlane.getOverview(),
    };
    return c.json(response);
  });

  runtime.get('/issues/:id', (c) => {
    const issue = controlPlane.getIssue(c.req.param('id'));
    if (!issue) {
      return c.json(
        {
          success: false,
          error: 'Issue not found',
        },
        404,
      );
    }

    return c.json({
      success: true,
      data: issue,
    });
  });

  runtime.get('/issues/:id/timeline', (c) => {
    const issue = controlPlane.getIssue(c.req.param('id'));
    if (!issue) {
      return c.json(
        {
          success: false,
          error: 'Issue not found',
        },
        404,
      );
    }

    const limit = Number.parseInt(c.req.query('limit') || '100', 10);
    return c.json({
      success: true,
      data: controlPlane.getTimeline(issue.issue_id, Number.isFinite(limit) ? limit : 100),
    });
  });

  runtime.get('/issues/:id/history', (c) => {
    const historyView = controlPlane.getHistoryView(c.req.param('id'), Number.parseInt(c.req.query('limit') || '20', 10));
    if (!historyView) {
      return c.json(
        {
          success: false,
          error: 'Issue not found',
        },
        404,
      );
    }

    return c.json({
      success: true,
      data: historyView,
    });
  });

  runtime.get('/stream', () => {
    return new Response(controlPlane.createStream(), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  runtime.post('/issues', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw.headers);
    if (!access.allowed) {
      return c.json(
        {
          success: false,
          error: 'Write access requires an operator token.',
        },
        403,
      );
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json(
        {
          success: false,
          error: 'Invalid JSON body',
        },
        400,
      );
    }

    const payload = body as Record<string, unknown>;
    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (!title) {
      return c.json(
        {
          success: false,
          error: 'title is required',
        },
        400,
      );
    }

    const result = await controlPlane.createIssue({
      title,
      description:
        typeof payload.description === 'string' && payload.description.trim()
          ? payload.description.trim()
          : null,
      team_id:
        typeof payload.team_id === 'string' && payload.team_id.trim()
          ? payload.team_id.trim()
          : null,
      project_slug:
        typeof payload.project_slug === 'string' && payload.project_slug.trim()
          ? payload.project_slug.trim()
          : null,
      project_id:
        typeof payload.project_id === 'string' && payload.project_id.trim()
          ? payload.project_id.trim()
          : null,
      state_id:
        typeof payload.state_id === 'string' && payload.state_id.trim()
          ? payload.state_id.trim()
          : null,
    });

    return c.json(
      {
        success: result.accepted,
        data: result,
        error: result.accepted ? undefined : result.message,
      },
      (result.accepted ? 201 : buildActionStatus(result)) as RuntimeRouteStatus,
    );
  });

  runtime.post('/issues/:id/stop', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw.headers);
    if (!access.allowed) {
      return c.json(
        {
          success: false,
          error: 'Write access requires an operator token.',
        },
        403,
      );
    }

    const result = await controlPlane.stopIssue(c.req.param('id'));
    return c.json(
      {
        success: result.accepted,
        data: result,
        error: result.accepted ? undefined : result.message,
      },
      buildActionStatus(result),
    );
  });

  runtime.post('/issues/:id/retry', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw.headers);
    if (!access.allowed) {
      return c.json(
        {
          success: false,
          error: 'Write access requires an operator token.',
        },
        403,
      );
    }

    const result = await controlPlane.retryIssue(c.req.param('id'));
    return c.json(
      {
        success: result.accepted,
        data: result,
        error: result.accepted ? undefined : result.message,
      },
      buildActionStatus(result),
    );
  });

  runtime.post('/issues/:id/governance/override', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw.headers);
    if (!access.allowed) {
      return c.json(
        {
          success: false,
          error: 'Write access requires an operator token.',
        },
        403,
      );
    }

    const result = await controlPlane.overrideGovernance(c.req.param('id'));
    return c.json(
      {
        success: result.accepted,
        data: result,
        error: result.accepted ? undefined : result.message,
      },
      buildActionStatus(result),
    );
  });

  runtime.post('/issues/:id/governance/rewrite', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw.headers);
    if (!access.allowed) {
      return c.json(
        {
          success: false,
          error: 'Write access requires an operator token.',
        },
        403,
      );
    }

    const result = await controlPlane.rewriteGovernance(c.req.param('id'));
    return c.json(
      {
        success: result.accepted,
        data: result,
        error: result.accepted ? undefined : result.message,
      },
      buildActionStatus(result),
    );
  });

  runtime.post('/issues/:id/governance/split', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw.headers);
    if (!access.allowed) {
      return c.json(
        {
          success: false,
          error: 'Write access requires an operator token.',
        },
        403,
      );
    }

    const result = await controlPlane.splitGovernance(c.req.param('id'));
    return c.json(
      {
        success: result.accepted,
        data: result,
        error: result.accepted ? undefined : result.message,
      },
      buildActionStatus(result),
    );
  });

  runtime.post('/issues/:id/governance/suggestions/:suggestionId/execute', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw.headers);
    if (!access.allowed) {
      return c.json(
        {
          success: false,
          error: 'Write access requires an operator token.',
        },
        403,
      );
    }

    const result = await controlPlane.executeGovernanceSuggestion(
      c.req.param('id'),
      c.req.param('suggestionId'),
    );
    return c.json(
      {
        success: result.accepted,
        data: result,
        error: result.accepted ? undefined : result.message,
      },
      buildActionStatus(result),
    );
  });

  runtime.post('/issues/:id/governance/suggestions/:suggestionId/dismiss', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw.headers);
    if (!access.allowed) {
      return c.json(
        {
          success: false,
          error: 'Write access requires an operator token.',
        },
        403,
      );
    }

    const result = await controlPlane.dismissGovernanceSuggestion(
      c.req.param('id'),
      c.req.param('suggestionId'),
    );
    return c.json(
      {
        success: result.accepted,
        data: result,
        error: result.accepted ? undefined : result.message,
      },
      buildActionStatus(result),
    );
  });
  return runtime;
}
