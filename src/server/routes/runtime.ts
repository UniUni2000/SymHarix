import { Hono, type Context } from 'hono';
import type { ApiResponse } from '../types';
import type { RuntimeControlPlane } from '../../runtime/types';
import { buildRuntimeManifest, type RuntimeAccessController } from '../runtimeAccess';
import { rememberTelegramThemePreference } from '../../bots/telegramThemePreference';
import type { BotGateway } from '../../bots/types';

type RuntimeRouteStatus = 200 | 201 | 202 | 400 | 403 | 404 | 409;

function requestUsesHttps(request: Request): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return forwardedProto === 'https' || new URL(request.url).protocol === 'https:';
}

function unauthorizedReadResponse(c: Context): Response {
  c.header('Cache-Control', 'private, no-store');
  c.header('WWW-Authenticate', 'Bearer realm="SymHarix Runtime"');
  return c.json({
    success: false,
    error: 'Runtime read access requires authentication.',
  }, 401);
}

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
  options: {
    getPublicBaseUrl?: () => string | null;
    botGateway?: BotGateway | null;
  } = {},
): Hono {
  const runtime = new Hono();

  runtime.post('/auth/token', async (c) => {
    const body = await c.req.json().catch(() => null);
    const token = body && typeof body === 'object' && typeof (body as Record<string, unknown>).token === 'string'
      ? String((body as Record<string, unknown>).token).trim()
      : '';
    const session = accessController.createTokenSession(token, {
      secure: requestUsesHttps(c.req.raw),
    });
    c.header('Cache-Control', 'private, no-store');
    if (!session.allowed || !session.set_cookie) {
      return c.json({
        success: false,
        error: 'Invalid Runtime access token.',
      }, 401);
    }
    c.header('Set-Cookie', session.set_cookie);
    return c.json({
      success: true,
      data: {
        access: session.access,
      },
    });
  });

  runtime.post('/auth/logout', (c) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Set-Cookie', accessController.clearSessionCookie({
      secure: requestUsesHttps(c.req.raw),
    }));
    return c.json({ success: true, data: { logged_out: true } });
  });

  runtime.use('*', async (c, next) => {
    const decision = accessController.authorizeRead(c.req.raw);
    if (!decision.allowed) {
      return unauthorizedReadResponse(c);
    }
    await next();
    c.header('Cache-Control', 'private, no-store');
  });

  runtime.get('/manifest', (c) => {
    const publicBaseUrl = options.getPublicBaseUrl?.() ?? null;
    return c.json({
      success: true,
      data: buildRuntimeManifest(accessController.describe(c.req.raw), {
        publicBaseUrl,
        miniAppBaseUrl: publicBaseUrl,
      }),
    });
  });

  runtime.get('/overview', (c) => {
    const response: ApiResponse = {
      success: true,
      data: controlPlane.getOverview(),
    };
    return c.json(response);
  });

  runtime.get('/plans', (c) => {
    return c.json({
      success: true,
      data: options.botGateway?.listSupervisorPlans?.() ?? [],
    });
  });

  runtime.get('/plans/:id', (c) => {
    const plan = options.botGateway?.getSupervisorPlan?.(c.req.param('id')) ?? null;
    if (!plan) {
      return c.json({ success: false, error: 'Plan session not found' }, 404);
    }
    return c.json({ success: true, data: plan });
  });

  runtime.patch('/plans/:id', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw);
    if (!access.allowed) {
      return c.json({ success: false, error: 'Write access requires an operator token.' }, 403);
    }
    const payload = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const instruction = typeof payload?.instruction === 'string' ? payload.instruction.trim() : '';
    const expectedPlanVersion = Number(payload?.expected_plan_version);
    if (!instruction || !Number.isInteger(expectedPlanVersion) || expectedPlanVersion < 1) {
      return c.json({ success: false, error: 'instruction and expected_plan_version are required' }, 400);
    }
    const result = await options.botGateway?.reviseSupervisorPlan?.({
      sessionId: c.req.param('id'),
      instruction,
      expectedPlanVersion,
    });
    if (!result) {
      return c.json({ success: false, error: 'Planner is not configured' }, 404);
    }
    return c.json({ success: true, data: result });
  });

  runtime.post('/plans/:id/actions/:action', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw);
    if (!access.allowed) {
      return c.json({ success: false, error: 'Write access requires an operator token.' }, 403);
    }
    const action = c.req.param('action');
    if (!['approve', 'alternate', 'cancel', 'rollback'].includes(action)) {
      return c.json({ success: false, error: 'Unsupported plan action' }, 400);
    }
    const payload = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const expectedPlanVersion = Number(payload.expected_plan_version);
    const targetPlanVersion = payload.target_plan_version == null ? null : Number(payload.target_plan_version);
    if (!Number.isInteger(expectedPlanVersion) || expectedPlanVersion < 1) {
      return c.json({ success: false, error: 'expected_plan_version is required' }, 400);
    }
    if (action === 'rollback' && (!Number.isInteger(targetPlanVersion) || Number(targetPlanVersion) < 1)) {
      return c.json({ success: false, error: 'target_plan_version is required for rollback' }, 400);
    }
    const result = await options.botGateway?.actOnSupervisorPlan?.({
      sessionId: c.req.param('id'),
      action: action as 'approve' | 'alternate' | 'cancel' | 'rollback',
      expectedPlanVersion,
      targetPlanVersion,
    });
    if (!result) {
      return c.json({ success: false, error: 'Planner is not configured' }, 404);
    }
    return c.json({ success: true, data: result });
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

  runtime.post('/telegram/theme-preference', async (c) => {
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
    const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id.trim() : '';
    const theme = payload.theme === 'dark' ? 'dark' : payload.theme === 'light' ? 'light' : null;
    if (!conversationId) {
      return c.json(
        {
          success: false,
          error: 'conversation_id is required',
        },
        400,
      );
    }
    if (!theme) {
      return c.json(
        {
          success: false,
          error: 'theme must be light or dark',
        },
        400,
      );
    }

    rememberTelegramThemePreference(conversationId, theme);
    return c.json({
      success: true,
      data: {
        conversation_id: conversationId,
        theme,
      },
    });
  });

  runtime.post('/issues', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw);
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
      supervisor_locale:
        payload.supervisor_locale === 'zh' || payload.supervisor_locale === 'en'
          ? payload.supervisor_locale
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
    const access = accessController.authorizeMutation(c.req.raw);
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
    const access = accessController.authorizeMutation(c.req.raw);
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

  runtime.post('/issues/:id/cost/override', async (c) => {
    const access = accessController.authorizeMutation(c.req.raw);
    if (!access.allowed) {
      return c.json(
        {
          success: false,
          error: 'Write access requires an operator token.',
        },
        403,
      );
    }

    const result = await controlPlane.overrideCostBudget?.(c.req.param('id')) ?? {
      accepted: false,
      status: 'rejected' as const,
      message: 'Cost budget override is not available',
      issue_id: c.req.param('id'),
      issue_identifier: null,
    };
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
    const access = accessController.authorizeMutation(c.req.raw);
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
    const access = accessController.authorizeMutation(c.req.raw);
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
    const access = accessController.authorizeMutation(c.req.raw);
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
    const access = accessController.authorizeMutation(c.req.raw);
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
    const access = accessController.authorizeMutation(c.req.raw);
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
