import { Hono } from 'hono';
import type { BotGateway } from '../../bots/types';

type BotRouteStatus = 200 | 400 | 401 | 403 | 404 | 503;

export function createBotRoutes(botGateway: BotGateway): Hono {
  const bots = new Hono();

  bots.get('/manifest', (c) => {
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
