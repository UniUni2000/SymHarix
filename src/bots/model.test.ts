import { describe, expect, test } from 'bun:test';
import { createBotAssistantModel, type BotAssistantHttpTransport } from './model';

describe('createBotAssistantModel', () => {
  test('returns an unconfigured assistant when bot LLM settings are missing', async () => {
    const model = createBotAssistantModel({
      provider: null,
      model: null,
      apiKey: null,
      baseUrl: null,
    });

    await expect(model.decide({
      text: 'INT-31 现在怎么样了',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 0,
          retrying: 0,
          total: 0,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    })).resolves.toBeNull();

    expect(model.getDiagnostics?.()).toEqual({
      provider: null,
      model: null,
      configured: false,
      health: 'unconfigured',
      fallback_available: true,
      last_error_code: 'unconfigured',
    });
  });

  test('marks auth failures as degraded with auth_error', async () => {
    const model = createBotAssistantModel(
      {
        provider: 'anthropic',
        model: 'claude-test',
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
      },
      async () => new Response(
        JSON.stringify({ error: { message: 'invalid api key' } }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const result = await model.decide({
      text: '创建一个 issue',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 0,
          retrying: 0,
          total: 0,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    });

    expect(result).toBeNull();
    expect(model.getDiagnostics?.()).toEqual({
      provider: 'anthropic',
      model: 'claude-test',
      configured: true,
      health: 'degraded',
      fallback_available: true,
      last_error_code: 'auth_error',
      last_error_message: 'invalid api key',
    });
  });

  test('marks missing models as degraded with model_not_found', async () => {
    const model = createBotAssistantModel(
      {
        provider: 'openai',
        model: 'missing-model',
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
      },
      async () => new Response(
        JSON.stringify({ error: { message: 'model not found' } }),
        {
          status: 404,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const result = await model.decide({
      text: 'INT-31 现在怎么样了',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 0,
          retrying: 0,
          total: 0,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    });

    expect(result).toBeNull();
    expect(model.getDiagnostics?.()).toEqual({
      provider: 'openai',
      model: 'missing-model',
      configured: true,
      health: 'degraded',
      fallback_available: true,
      last_error_code: 'model_not_found',
      last_error_message: 'model not found',
    });
  });

  test('marks provider timeouts as degraded with timeout', async () => {
    const model = createBotAssistantModel(
      {
        provider: 'anthropic',
        model: 'claude-test',
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
      },
      async () => {
        const error = new Error('request timed out');
        error.name = 'AbortError';
        throw error;
      },
    );

    const result = await model.decide({
      text: '当前有哪些活跃 issue？',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 0,
          retrying: 0,
          total: 0,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    });

    expect(result).toBeNull();
    expect(model.getDiagnostics?.()).toEqual({
      provider: 'anthropic',
      model: 'claude-test',
      configured: true,
      health: 'degraded',
      fallback_available: true,
      last_error_code: 'timeout',
      last_error_message: 'request timed out',
    });
  });

  test('returns healthy diagnostics and raw text on success', async () => {
    const model = createBotAssistantModel(
      {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
      },
      async () => new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"intent":{"kind":"answer_question","answer":"INT-31 is running."}}',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const result = await model.decide({
      text: 'INT-31 现在怎么样了',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 1,
          retrying: 0,
          total: 1,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    });

    expect(result).toBe('{"intent":{"kind":"answer_question","answer":"INT-31 is running."}}');
    expect(model.getDiagnostics?.()).toEqual({
      provider: 'openai',
      model: 'gpt-test',
      configured: true,
      health: 'healthy',
      fallback_available: true,
      last_error_code: null,
    });
  });

  test('includes explicit greeting handling guidance in the prompt', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const model = createBotAssistantModel(
      {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
      },
      async (_input, init) => {
        requests.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"intent":{"kind":"answer_question","answer":"你好"}}',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );

    await model.decide({
      text: '你好',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 0,
          retrying: 0,
          total: 0,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    });

    const messages = requests[0]?.messages as Array<{ content?: string }> | undefined;
    expect(messages?.[0]?.content).toContain('If the user message is just a greeting');
    expect(messages?.[0]?.content).toContain('answer_question');
  });

  test('adds a strict output-language contract from the latest user text', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const model = createBotAssistantModel(
      {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
      },
      async (_input, init) => {
        requests.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"intent":{"kind":"answer_question","answer":"Hello."}}',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );

    await model.decide({
      text: 'What can you do?',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 0,
          retrying: 0,
          total: 0,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    });

    const messages = requests[0]?.messages as Array<{ content?: string }> | undefined;
    expect(messages?.[0]?.content).toContain('detected_user_language: English');
    expect(messages?.[0]?.content).toContain('Every user-facing JSON string field must be English');
    expect(messages?.[0]?.content).toContain('Do not use Chinese in greetings');
    expect(messages?.[0]?.content).toContain('overrides runtime_context.recent_messages');
  });

  test('falls back to a secondary transport when the primary transport fails immediately', async () => {
    const primaryTransport: BotAssistantHttpTransport = {
      async send() {
        throw new Error('spawn curl ENOENT');
      },
    };
    const secondaryTransport: BotAssistantHttpTransport = {
      async send() {
        return {
          status: 200,
          payload: {
            choices: [
              {
                message: {
                  content: '{"intent":{"kind":"answer_question","answer":"secondary transport worked"}}',
                },
              },
            ],
          },
        };
      },
    };

    const model = createBotAssistantModel(
      {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
      },
      fetch,
      {
        primaryTransport,
        fallbackTransport: secondaryTransport,
      },
    );

    const result = await model.decide({
      text: 'INT-31 现在怎么样了',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 0,
          retrying: 0,
          total: 0,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    });

    expect(result).toBe('{"intent":{"kind":"answer_question","answer":"secondary transport worked"}}');
    expect(model.getDiagnostics?.()).toEqual({
      provider: 'openai',
      model: 'gpt-test',
      configured: true,
      health: 'healthy',
      fallback_available: true,
      last_error_code: null,
    });
  });

  test('does not retry the fallback transport when the primary transport times out', async () => {
    let fallbackCalled = false;
    const primaryTransport: BotAssistantHttpTransport = {
      async send() {
        const error = new Error('request timed out');
        error.name = 'AbortError';
        throw error;
      },
    };
    const secondaryTransport: BotAssistantHttpTransport = {
      async send() {
        fallbackCalled = true;
        return {
          status: 200,
          payload: {
            choices: [
              {
                message: {
                  content: '{"intent":{"kind":"answer_question","answer":"should not happen"}}',
                },
              },
            ],
          },
        };
      },
    };

    const model = createBotAssistantModel(
      {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
      },
      fetch,
      {
        primaryTransport,
        fallbackTransport: secondaryTransport,
      },
    );

    const result = await model.decide({
      text: 'INT-31 现在怎么样了',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 0,
          retrying: 0,
          total: 0,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    });

    expect(result).toBeNull();
    expect(fallbackCalled).toBe(false);
    expect(model.getDiagnostics?.()).toEqual({
      provider: 'openai',
      model: 'gpt-test',
      configured: true,
      health: 'degraded',
      fallback_available: true,
      last_error_code: 'timeout',
      last_error_message: 'request timed out',
    });
  });

  test('includes current local date in the prompt for date-sensitive questions', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const model = createBotAssistantModel(
      {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
      },
      async (_input, init) => {
        requests.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"intent":{"kind":"answer_question","answer":"今天是 2026-04-21。"}}',
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    );

    await model.decide({
      text: '今天是几号？',
      context: {
        default_project_slug: null,
        available_projects: [],
        watch_subscriptions: [],
        overview: {
          running: 0,
          retrying: 0,
          total: 0,
          active_issues: [],
        },
        focus_issue: null,
        assistant: {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      },
    });

    const messages = requests[0]?.messages as Array<{ content?: string }> | undefined;
    expect(messages?.[0]?.content).toContain('current_local_date:');
    expect(messages?.[0]?.content).toContain('current_local_timezone:');
  });
});
