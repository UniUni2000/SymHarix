import { describe, expect, test } from 'bun:test';
import type { RuntimeControlPlane, RuntimeStreamEvent } from '../runtime/types';
import { DefaultBotGateway } from './gateway';

function createRuntimeControlPlane(): RuntimeControlPlane {
  return {
    getOverview: () => ({
      generated_at: '2026-05-10T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 0 },
      issues: [],
    }),
    getIssue: () => null,
    getTimeline: () => [],
    getHistoryView: () => null,
    createIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    stopIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    retryIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    closeIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    overrideGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    rewriteGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    splitGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    executeGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    dismissGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: (_listener: (event: RuntimeStreamEvent) => void) => () => undefined,
  };
}

describe('DefaultBotGateway supervisor context endpoint', () => {
  test('sets the local MCP callback endpoint and protects broker calls with the runtime token', async () => {
    let endpoint: string | null = null;
    let orchestratorEndpoint: string | null = null;
    const gateway = new DefaultBotGateway(
      createRuntimeControlPlane(),
      {
        botToken: null,
        webhookSecret: null,
        operationsChatId: null,
        operatorIds: new Set(),
      },
      {
        botToken: null,
        publicKey: null,
        operatorIds: new Set(),
      },
      undefined,
      null,
      {
        assistantModel: {
          decide: async () => ({ intent: { kind: 'help' } }),
        },
        supervisorClaudeRuntimeService: {
          respond: async () => null,
          setContextEndpoint: (value) => {
            endpoint = value;
          },
          setOrchestratorEndpoint: (value) => {
            orchestratorEndpoint = value;
          },
          getContextToken: () => 'context-token',
        },
        startupRepairDelayMs: 60_000,
      },
    );

    await gateway.initializeInboundIntegration({ localBaseUrl: 'http://127.0.0.1:3000/' });
    expect(endpoint).toBe('http://127.0.0.1:3000/api/v1/bots/supervisor-context/call');
    expect(orchestratorEndpoint).toBe('http://127.0.0.1:3000/api/v1/bots/supervisor-orchestrator/call');

    const denied = await gateway.handleSupervisorContextTool?.(
      { tool: 'list_context_sources', arguments: {} },
      { 'x-supervisor-context-token': 'wrong' },
    );
    expect(denied?.status).toBe(403);

    const result = await gateway.handleSupervisorContextTool?.(
      { tool: 'list_context_sources', arguments: {} },
      { 'x-supervisor-context-token': 'context-token' },
    );
    expect(result?.status).toBe(200);
    expect(JSON.stringify(result?.body)).toContain('repo_understanding');

    gateway.dispose();
  });
});
