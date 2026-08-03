import { Hono } from 'hono';
import type { BotGateway } from '../../bots/types';
import type { RuntimeAccessController } from '../runtimeAccess';

type BotRouteStatus = 200 | 400 | 401 | 403 | 404 | 503;

export function createBotRoutes(
  botGateway: BotGateway,
  accessController: RuntimeAccessController | null,
): Hono {
  const bots = new Hono();

  bots.get('/manifest', (c) => {
    if (!accessController?.authorizeRead(c.req.raw).allowed) {
      c.header('Cache-Control', 'private, no-store');
      c.header('WWW-Authenticate', 'Bearer realm="SymHarix Runtime"');
      return c.json({
        success: false,
        error: 'Runtime read access requires authentication.',
      }, 401);
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      success: true,
      data: botGateway.getManifest(),
    });
  });

  bots.post('/telegram/webhook', async (c) => {
    const body = await c.req.json().catch(() => null);
    const result = await botGateway.handleTelegramWebhook(body, c.req.raw.headers);
    return c.json(result.body, result.status as BotRouteStatus);
  });

  bots.post('/discord/interactions', async (c) => {
    const rawBody = await c.req.text();
    const result = await botGateway.handleDiscordInteraction(rawBody, c.req.raw.headers);
    return c.json(result.body, result.status as BotRouteStatus);
  });

  bots.post('/supervisor-context/call', async (c) => {
    if (!botGateway.handleSupervisorContextTool) {
      return c.json({ ok: false, error: 'Supervisor context tools are not configured' }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const result = await botGateway.handleSupervisorContextTool(body, c.req.raw.headers);
    return c.json(result.body, result.status as BotRouteStatus);
  });

  bots.post('/supervisor-orchestrator/call', async (c) => {
    if (!botGateway.handleSupervisorOrchestratorTool) {
      return c.json({ ok: false, error: 'Supervisor orchestrator tools are not configured' }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const result = await botGateway.handleSupervisorOrchestratorTool(body, c.req.raw.headers);
    return c.json(result.body, result.status as BotRouteStatus);
  });

  return bots;
}
