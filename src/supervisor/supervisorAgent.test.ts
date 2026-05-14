import { afterEach, describe, expect, test } from 'bun:test';
import type { RepoProfile } from './repoProfileService';
import type { SupervisorRepoUnderstandingSnapshot } from './repoUnderstanding';
import {
  createSupervisorAgentFromEnv,
  DefaultSupervisorAgentService,
  shouldUseReadOnlyClaudeForText,
} from './supervisorAgent';

const supervisorAgentEnvKeys = [
  'SYMPHONY_SUPERVISOR_AGENT_PROVIDER',
  'SYMPHONY_SUPERVISOR_AGENT_MODEL',
  'SYMPHONY_SUPERVISOR_AGENT_API_KEY',
  'SYMPHONY_SUPERVISOR_AGENT_BASE_URL',
  'SYMPHONY_SUPERVISOR_CC_PROVIDER',
  'SYMPHONY_SUPERVISOR_CC_MODEL',
  'SYMPHONY_SUPERVISOR_CC_API_KEY',
  'SYMPHONY_SUPERVISOR_CC_BASE_URL',
  'SYMPHONY_SUPERVISOR_LLM_PROVIDER',
  'SYMPHONY_SUPERVISOR_LLM_MODEL',
  'SYMPHONY_SUPERVISOR_LLM_API_KEY',
  'SYMPHONY_SUPERVISOR_LLM_BASE_URL',
  'SYMPHONY_BOT_LLM_PROVIDER',
  'SYMPHONY_BOT_LLM_MODEL',
  'SYMPHONY_BOT_LLM_API_KEY',
  'SYMPHONY_BOT_LLM_BASE_URL',
  'SYMPHONY_SUPERVISOR_READONLY_ADVISOR_COMMAND',
] as const;
const originalSupervisorAgentEnv = Object.fromEntries(
  supervisorAgentEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof supervisorAgentEnvKeys)[number], string | undefined>;

const repoProfile: RepoProfile = {
  repo_ref: 'acme/demo-app',
  summary: 'Telegram-first supervisor workspace with Bun and TypeScript.',
  project_type: 'node_typescript',
  tech_stack: ['Node.js', 'Bun', 'TypeScript'],
  key_paths: ['README.md', 'src', 'docs'],
  signals: {
    readme_title: 'Demo App',
    package_name: 'demo-app',
    package_scripts: ['build', 'test'],
    top_level_directories: ['docs', 'src'],
    top_level_files: ['README.md', 'package.json'],
    sample_paths: ['src/index.ts', 'docs/ARCHITECTURE.md'],
  },
  snapshot: {
    top_level_files: ['README.md', 'package.json'],
    sample_paths: ['src/index.ts', 'docs/ARCHITECTURE.md'],
    entrypoints: [
      {
        path: 'src/index.ts',
        summary: 'Exports the Telegram-facing runtime bootstrap.',
      },
    ],
  },
  last_indexed_at: '2026-05-06T00:00:00.000Z',
};

const repoUnderstanding: SupervisorRepoUnderstandingSnapshot = {
  repo_ref: 'acme/demo-app',
  commit_sha: 'abc123',
  summary: 'Telegram supervisor that can recommend visual artifacts before execution.',
  understanding: {
    project_purpose: 'Coordinate repo-aware supervisor work from Telegram.',
    tech_stack: ['Bun', 'TypeScript', 'Telegram Bot API'],
    key_paths: ['src/bots/assistant.ts', 'src/supervisor/supervisorAgent.ts'],
    architecture_notes: ['Supervisor chat decides before session materialization.'],
    artifact_opportunities: ['Build a Telegram visual Plan Card at src/artifacts/plan-card.tsx'],
    test_commands: ['bun test src/supervisor/supervisorAgent.test.ts'],
    risks: ['Approval boundary must stay visible before creating work.'],
  },
  evidence_paths: ['src/bots/assistant.ts', 'src/supervisor/supervisorAgent.ts'],
  source: 'claude_code',
};

describe('DefaultSupervisorAgentService', () => {
  afterEach(() => {
    for (const key of supervisorAgentEnvKeys) {
      const original = originalSupervisorAgentEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  test('returns conversational chat_reply for ordinary supervisor chat', async () => {
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async ({ repoRef, localPath }) => {
        expect(repoRef).toBe('acme/demo-app');
        expect(localPath).toBe('/tmp/demo-app');
        return repoProfile;
      },
      analyze: async (input) => {
        expect(input.repoRef).toBe('acme/demo-app');
        expect(input.runtimeContext).toEqual({
          source: 'telegram_chat',
          defaultProjectSlug: 'demo-app',
          activeIssueId: null,
        });
        expect(input.prompt).toContain('natural conversation first');
        expect(input.prompt).toContain('detected_user_language: English');
        expect(input.prompt).toContain('Every user-facing JSON string field must be English');
        expect(input.prompt).toContain('Do not use Chinese in greetings');
        return {
          mode: 'chat_reply',
          message: 'You can keep this conversational; I can help shape the next step when you are ready.',
        };
      },
    });

    const result = await agent.respond({
      localPath: '/tmp/demo-app',
      repoRef: null,
      defaultRepoRef: 'acme/demo-app',
      userText: 'I am still thinking this through.',
      projectContext: 'Telegram supervisor chat',
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'demo-app',
        activeIssueId: null,
      },
    });

    expect(result).toEqual({
      mode: 'chat_reply',
      repoRef: 'acme/demo-app',
      message: 'You can keep this conversational; I can help shape the next step when you are ready.',
    });
  });

  test('keeps English greetings inside the supervisor agent language contract', async () => {
    const prompts: string[] = [];
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async () => repoProfile,
      analyze: async (input) => {
        prompts.push(input.prompt);
        return {
          mode: 'chat_reply',
          message: 'Hello. I can show the current repository status if you want.',
        };
      },
    });

    const result = await agent.respond({
      localPath: '/tmp/demo-app',
      repoRef: 'acme/demo-app',
      defaultRepoRef: 'fallback/repo',
      userText: 'hello',
      projectContext: null,
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'demo-app',
        activeIssueId: null,
      },
    });

    expect(result?.mode).toBe('chat_reply');
    expect(prompts[0]).toContain('detected_user_language: English');
    expect(prompts[0]).toContain('Every user-facing JSON string field must be English');
    expect(prompts[0]).toContain('Do not use Chinese in greetings');
    expect(prompts[0]).toContain('user_text: hello');
  });

  test('returns issue_recommendation for work-creation style requests', async () => {
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async () => repoProfile,
      analyze: async (input) => {
        expect(input.normalizedUserText).toContain('draft the next issue');
        return JSON.stringify({
          mode: 'issue_recommendation',
          title: 'Improve supervisor chat intake',
          summary: 'Recommend a repo-aware issue card before creating work.',
          next_step: 'Show the issue recommendation card and wait for approval.',
        });
      },
    });

    const result = await agent.respond({
      localPath: '/tmp/demo-app',
      repoRef: 'acme/demo-app',
      defaultRepoRef: 'fallback/repo',
      userText: 'Please draft the next issue for the supervisor chat intake.',
      projectContext: null,
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'demo-app',
        activeIssueId: 'INT-42',
      },
    });

    expect(result).toEqual({
      mode: 'issue_recommendation',
      repoRef: 'acme/demo-app',
      title: 'Improve supervisor chat intake',
      summary: 'Recommend a repo-aware issue card before creating work.',
      nextStep: 'Show the issue recommendation card and wait for approval.',
    });
  });

  test('includes deep repo understanding in the supervisor prompt and returns artifact ideation', async () => {
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async ({ repoRef, localPath }) => {
        expect(repoRef).toBe('acme/demo-app');
        expect(localPath).toBe('/tmp/demo-app');
        return repoProfile;
      },
      resolveRepoUnderstanding: async (input) => {
        expect(input.repoRef).toBe('acme/demo-app');
        expect(input.localPath).toBe('/tmp/demo-app');
        expect(input.forceRefresh).toBe(false);
        expect(input.cacheOnly).toBe(false);
        return repoUnderstanding;
      },
      analyze: async (input) => {
        expect(input.repoUnderstanding).toEqual(repoUnderstanding);
        expect(input.prompt).toContain('repo_understanding');
        expect(input.prompt).toContain('Build a Telegram visual Plan Card at src/artifacts/plan-card.tsx');
        expect(input.prompt).toContain('artifact_ideation');
        return {
          mode: 'artifact_ideation',
          title: 'Telegram visual Plan Card',
          recommendation: 'Create a polished Plan Card artifact at src/artifacts/plan-card.tsx.',
          rationale: 'The repo understanding identifies visual Telegram cards as the strongest artifact opportunity.',
          next_step: 'Show this artifact recommendation and wait for approval before implementation.',
        };
      },
    });

    const result = await agent.respond({
      localPath: '/tmp/demo-app',
      repoRef: null,
      defaultRepoRef: 'acme/demo-app',
      userText: 'Can you create a visual demo card for the Telegram supervisor?',
      projectContext: 'Telegram supervisor chat',
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'demo-app',
        activeIssueId: null,
      },
    });

    expect(result).toEqual({
      mode: 'artifact_ideation',
      repoRef: 'acme/demo-app',
      title: 'Telegram visual Plan Card',
      recommendation: 'Create a polished Plan Card artifact at src/artifacts/plan-card.tsx.',
      rationale: 'The repo understanding identifies visual Telegram cards as the strongest artifact opportunity.',
      nextStep: 'Show this artifact recommendation and wait for approval before implementation.',
    });
  });

  test('blank artifact_ideation required fields returns null', async () => {
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async () => repoProfile,
      analyze: async () => ({
        mode: 'artifact_ideation',
        title: ' ',
        recommendation: 'Create a visual Plan Card artifact.',
        rationale: 'Repo understanding points at this opportunity.',
        next_step: 'Wait for approval.',
      }),
    });

    const result = await agent.respond({
      localPath: '/tmp/demo-app',
      repoRef: 'acme/demo-app',
      defaultRepoRef: null,
      userText: 'Create a visual artifact.',
      projectContext: null,
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'demo-app',
        activeIssueId: null,
      },
    });

    expect(result).toBeNull();
  });

  test('ordinary chat only asks for cache-only repo understanding', async () => {
    const cacheOnlyValues: boolean[] = [];
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async () => repoProfile,
      resolveRepoUnderstanding: async (input) => {
        cacheOnlyValues.push(Boolean(input.cacheOnly));
        return repoUnderstanding;
      },
      analyze: async (input) => {
        expect(input.repoUnderstanding).toEqual(repoUnderstanding);
        return {
          mode: 'chat_reply',
          message: 'We can talk this through first.',
        };
      },
    });

    const result = await agent.respond({
      localPath: '/tmp/demo-app',
      repoRef: 'acme/demo-app',
      defaultRepoRef: null,
      userText: 'I am quiet for now; discard the start idea and we can talk later.',
      projectContext: null,
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'demo-app',
        activeIssueId: null,
      },
    });

    expect(result).toEqual({
      mode: 'chat_reply',
      repoRef: 'acme/demo-app',
      message: 'We can talk this through first.',
    });
    expect(cacheOnlyValues).toEqual([true]);
  });

  test('resolveRepoUnderstanding failure is swallowed and prompt still contains repo_understanding null', async () => {
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async () => repoProfile,
      resolveRepoUnderstanding: async () => {
        throw new Error('repo understanding unavailable');
      },
      analyze: async (input) => {
        expect(input.repoUnderstanding).toBeNull();
        expect(input.prompt).toContain('repo_understanding: null');
        return {
          mode: 'chat_reply',
          message: 'I can still help from the shallow repo profile.',
        };
      },
    });

    const result = await agent.respond({
      localPath: '/tmp/demo-app',
      repoRef: 'acme/demo-app',
      defaultRepoRef: null,
      userText: 'What can you tell me about this repo?',
      projectContext: null,
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'demo-app',
        activeIssueId: null,
      },
    });

    expect(result).toEqual({
      mode: 'chat_reply',
      repoRef: 'acme/demo-app',
      message: 'I can still help from the shallow repo profile.',
    });
  });

  test('env factory wires repo understanding resolver into the supervisor prompt', async () => {
    process.env.SYMPHONY_SUPERVISOR_AGENT_PROVIDER = 'openai';
    process.env.SYMPHONY_SUPERVISOR_AGENT_MODEL = 'supervisor-test';
    process.env.SYMPHONY_SUPERVISOR_AGENT_API_KEY = 'test-key';
    process.env.SYMPHONY_SUPERVISOR_AGENT_BASE_URL = 'https://llm.test/v1';

    let capturedPrompt = '';
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as {
        messages?: Array<{ content?: string }>;
      };
      capturedPrompt = body.messages?.[0]?.content ?? '';
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mode: 'repo_answer',
                answer: 'Repo-aware answer.',
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const agent = createSupervisorAgentFromEnv(
      {
        resolve: async () => repoProfile,
      },
      fetchImpl,
      {
        understand: async ({ repoRef, localPath, forceRefresh, cacheOnly }) => {
          expect(repoRef).toBe('acme/demo-app');
          expect(localPath).toBe('/tmp/demo-app');
          expect(forceRefresh).toBe(false);
          expect(cacheOnly).toBe(false);
          return repoUnderstanding;
        },
      },
    );

    const result = await agent?.respond({
      localPath: '/tmp/demo-app',
      repoRef: null,
      defaultRepoRef: 'acme/demo-app',
      userText: 'What visual artifact should we build?',
      projectContext: 'Telegram supervisor chat',
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'demo-app',
        activeIssueId: null,
      },
    });

    expect(result).toEqual({
      mode: 'repo_answer',
      repoRef: 'acme/demo-app',
      answer: 'Repo-aware answer.',
      citations: undefined,
    });
    expect(capturedPrompt).toContain('repo_understanding');
    expect(capturedPrompt).toContain('Build a Telegram visual Plan Card at src/artifacts/plan-card.tsx');
  });

  test('env factory keeps local read-only Claude advisor available without hosted LLM config', async () => {
    for (const key of supervisorAgentEnvKeys) {
      delete process.env[key];
    }
    process.env.SYMPHONY_SUPERVISOR_READONLY_ADVISOR_COMMAND = 'node scripts/claude-adapter.cjs';

    const agent = createSupervisorAgentFromEnv(
      {
        resolve: async () => repoProfile,
      },
      fetch,
      null,
      {
        resolve: async () => ({
          project_slug: 'demo-app',
          repo_ref: 'acme/demo-app',
          configured_local_path: null,
          analysis_path: '/tmp/workspaces/acme__demo-app/source',
          source_path: '/tmp/workspaces/acme__demo-app/source',
          commit_sha: 'abc123',
          status: 'ready',
          last_sync_error: null,
          updated_at: '2026-05-07T00:00:00.000Z',
        }),
      },
    );

    expect(agent).not.toBeNull();
    expect(agent?.hasActiveRepoConversation?.({
      transport: 'telegram',
      conversationId: 'chat-1',
      repoRef: 'acme/demo-app',
    })).toBe(false);
    await expect(agent?.respond({
      localPath: null,
      repoRef: null,
      defaultRepoRef: 'acme/demo-app',
      userText: '只是普通闲聊',
      projectContext: null,
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'demo-app',
        activeIssueId: null,
      },
    })).resolves.toBeNull();
  });

  test('uses read-only Claude Code advisor for repo file questions after resolving shared source cache', async () => {
    let analyzeCalls = 0;
    let sourceCalls = 0;
    let advisorCalls = 0;
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async ({ localPath }) => {
        expect(localPath).toBe('/tmp/workspaces/uniuni2000__test2/source');
        return repoProfile;
      },
      resolveRepoSource: async (route) => {
        sourceCalls += 1;
        expect(route.local_path).toBeNull();
        return {
          project_slug: 'test2',
          repo_ref: 'UniUni2000/test2',
          configured_local_path: null,
          analysis_path: '/tmp/workspaces/uniuni2000__test2/source',
          source_path: '/tmp/workspaces/uniuni2000__test2/source',
          commit_sha: 'abc123',
          status: 'ready',
          last_sync_error: null,
          updated_at: '2026-05-07T00:00:00.000Z',
        };
      },
      adviseWithReadOnlyClaude: async (input) => {
        advisorCalls += 1;
        expect(input.localPath).toBe('/tmp/workspaces/uniuni2000__test2/source');
        expect(input.repoSource?.commit_sha).toBe('abc123');
        expect(input.allowExternalResearch).toBe(false);
        expect(input.prompt).toContain('repo_source');
        return {
          mode: 'repo_answer',
          answer: '这个仓库当前只有 README.md。',
          citations: ['README.md'],
        };
      },
      analyze: async () => {
        analyzeCalls += 1;
        return null;
      },
    });

    const result = await agent.respond({
      localPath: null,
      repoRef: null,
      defaultRepoRef: 'UniUni2000/test2',
      userText: '这个仓库有哪些文件？',
      projectContext: 'default_project=test2',
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'test2',
        activeIssueId: null,
      },
      route: {
        project_slug: 'test2',
        project_name: null,
        github_owner: 'UniUni2000',
        github_repo: 'test2',
        github_repo_full: 'UniUni2000/test2',
        local_path: null,
        cache_key: 'uniuni2000__test2',
        require_repo_harness: false,
      },
    });

    expect(result).toEqual({
      mode: 'repo_answer',
      repoRef: 'UniUni2000/test2',
      answer: '这个仓库当前只有 README.md。',
      citations: ['README.md'],
    });
    expect(sourceCalls).toBe(1);
    expect(advisorCalls).toBe(1);
    expect(analyzeCalls).toBe(0);
  });

  test('falls back to repo profile when read-only Claude returns unstructured output after resolving source cache', async () => {
    let analyzeCalls = 0;
    let sourceCalls = 0;
    let advisorCalls = 0;
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async ({ repoRef, localPath }) => {
        expect(repoRef).toBe('UniUni2000/test2');
        expect(localPath).toBe('/tmp/workspaces/uniuni2000__test2/source');
        return {
          ...repoProfile,
          repo_ref: 'UniUni2000/test2',
          summary: 'Stellar mass-luminosity calculator with Python tests.',
          project_type: 'python',
          tech_stack: ['Python'],
          key_paths: ['README.md', 'stellar_mass_luminosity.py', 'tests'],
          signals: {
            ...repoProfile.signals,
            readme_title: 'Stellar Mass Luminosity',
          },
        };
      },
      resolveRepoSource: async () => {
        sourceCalls += 1;
        return {
          project_slug: 'test2',
          repo_ref: 'UniUni2000/test2',
          configured_local_path: null,
          analysis_path: '/tmp/workspaces/uniuni2000__test2/source',
          source_path: '/tmp/workspaces/uniuni2000__test2/source',
          commit_sha: 'abc123',
          status: 'ready',
          last_sync_error: null,
          updated_at: '2026-05-07T00:00:00.000Z',
        };
      },
      adviseWithReadOnlyClaude: async () => {
        advisorCalls += 1;
        return '这个仓库是普通文本，不是结构化 JSON';
      },
      analyze: async () => {
        analyzeCalls += 1;
        return null;
      },
    });

    const result = await agent.respond({
      localPath: null,
      repoRef: null,
      defaultRepoRef: 'UniUni2000/test2',
      userText: 'test2 仓库是干啥的呢？',
      projectContext: 'default_project=test2',
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'test2',
        activeIssueId: null,
      },
      route: {
        project_slug: 'test2',
        project_name: null,
        github_owner: 'UniUni2000',
        github_repo: 'test2',
        github_repo_full: 'UniUni2000/test2',
        local_path: null,
        cache_key: 'uniuni2000__test2',
        require_repo_harness: false,
      },
    });

    expect(result).toEqual({
      mode: 'repo_answer',
      repoRef: 'UniUni2000/test2',
      answer: [
        'UniUni2000/test2 主要是：Stellar mass-luminosity calculator with Python tests.',
        'README: Stellar Mass Luminosity',
        '类型：python',
        '技术栈：Python',
        '关键路径：README.md, stellar_mass_luminosity.py, tests',
      ].join('\n'),
      citations: ['README.md', 'stellar_mass_luminosity.py', 'tests'],
    });
    expect(sourceCalls).toBe(1);
    expect(advisorCalls).toBe(1);
    expect(analyzeCalls).toBe(0);
  });

  test('ordinary chat does not resolve source cache or invoke read-only Claude Code', async () => {
    let sourceCalls = 0;
    let advisorCalls = 0;
    let analyzeCalls = 0;
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async () => repoProfile,
      resolveRepoSource: async () => {
        sourceCalls += 1;
        throw new Error('should not resolve source');
      },
      adviseWithReadOnlyClaude: async () => {
        advisorCalls += 1;
        throw new Error('should not call read-only advisor');
      },
      analyze: async () => {
        analyzeCalls += 1;
        return {
          mode: 'chat_reply',
          message: '可以，我们先聊清楚。',
        };
      },
    });

    const result = await agent.respond({
      localPath: null,
      repoRef: null,
      defaultRepoRef: 'UniUni2000/test2',
      userText: '我今天先想轻松聊聊这个想法',
      projectContext: 'default_project=test2',
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'test2',
        activeIssueId: null,
      },
    });

    expect(result).toEqual({
      mode: 'chat_reply',
      repoRef: 'UniUni2000/test2',
      message: '可以，我们先聊清楚。',
    });
    expect(sourceCalls).toBe(0);
    expect(advisorCalls).toBe(0);
    expect(analyzeCalls).toBe(1);
  });

  test('explicit latest-docs questions enable external research for the read-only advisor', async () => {
    const externalFlags: boolean[] = [];
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async () => repoProfile,
      resolveRepoSource: async () => ({
        project_slug: 'test2',
        repo_ref: 'UniUni2000/test2',
        configured_local_path: null,
        analysis_path: '/tmp/workspaces/uniuni2000__test2/source',
        source_path: '/tmp/workspaces/uniuni2000__test2/source',
        commit_sha: 'abc123',
        status: 'ready',
        last_sync_error: null,
        updated_at: '2026-05-07T00:00:00.000Z',
      }),
      adviseWithReadOnlyClaude: async (input) => {
        externalFlags.push(input.allowExternalResearch);
        return {
          mode: 'repo_answer',
          answer: '我会结合仓库和最新官方文档回答。',
        };
      },
      analyze: async () => null,
    });

    await agent.respond({
      localPath: null,
      repoRef: null,
      defaultRepoRef: 'UniUni2000/test2',
      userText: '结合最新官方文档看一下这个 API 怎么用',
      projectContext: 'default_project=test2',
      runtimeContext: {
        source: 'telegram_chat',
        defaultProjectSlug: 'test2',
        activeIssueId: null,
      },
      route: {
        project_slug: 'test2',
        project_name: null,
        github_owner: 'UniUni2000',
        github_repo: 'test2',
        github_repo_full: 'UniUni2000/test2',
        local_path: null,
        cache_key: 'uniuni2000__test2',
        require_repo_harness: false,
      },
    });

    expect(externalFlags).toEqual([true]);
  });

  test('forceReadOnlyClaude routes file follow-ups through the read-only advisor even without repo keywords', async () => {
    let advisorCalls = 0;
    let analyzeCalls = 0;
    const agent = new DefaultSupervisorAgentService({
      resolveRepoProfile: async () => repoProfile,
      resolveRepoSource: async () => ({
        project_slug: 'test2',
        repo_ref: 'UniUni2000/test2',
        configured_local_path: null,
        analysis_path: '/tmp/workspaces/uniuni2000__test2/source',
        source_path: '/tmp/workspaces/uniuni2000__test2/source',
        commit_sha: 'abc123',
        status: 'ready',
        last_sync_error: null,
        updated_at: '2026-05-07T00:00:00.000Z',
      }),
      adviseWithReadOnlyClaude: async (input) => {
        advisorCalls += 1;
        expect(input.normalizedUserText).toBe('README.md 有啥内容');
        return {
          mode: 'repo_answer',
          answer: 'README.md 当前是空文件。',
          citations: ['README.md'],
        };
      },
      analyze: async () => {
        analyzeCalls += 1;
        return {
          mode: 'repo_answer',
          answer: 'wrong path',
        };
      },
    });

    const result = await agent.respond({
      localPath: null,
      repoRef: null,
      defaultRepoRef: 'UniUni2000/test2',
      userText: 'README.md 有啥内容',
      forceReadOnlyClaude: true,
      projectContext: 'default_project=test2',
      runtimeContext: {
        source: 'telegram_chat',
        transport: 'telegram',
        conversationId: 'chat-1',
        defaultProjectSlug: 'test2',
        activeIssueId: null,
      },
      route: {
        project_slug: 'test2',
        project_name: null,
        github_owner: 'UniUni2000',
        github_repo: 'test2',
        github_repo_full: 'UniUni2000/test2',
        local_path: null,
        cache_key: 'uniuni2000__test2',
        require_repo_harness: false,
      },
    });

    expect(result).toEqual({
      mode: 'repo_answer',
      repoRef: 'UniUni2000/test2',
      answer: 'README.md 当前是空文件。',
      citations: ['README.md'],
    });
    expect(advisorCalls).toBe(1);
    expect(analyzeCalls).toBe(0);
  });

  test('repo trigger helper distinguishes repo work from ordinary chat', () => {
    expect(shouldUseReadOnlyClaudeForText('这个仓库有哪些文件')).toBe(true);
    expect(shouldUseReadOnlyClaudeForText('README.md 有啥内容')).toBe(true);
    expect(shouldUseReadOnlyClaudeForText('src/bots/assistant.ts 这文件干啥的')).toBe(true);
    expect(shouldUseReadOnlyClaudeForText('帮我结合最新官方文档看看 API')).toBe(true);
    expect(shouldUseReadOnlyClaudeForText('INT-157 卡在哪里，预计什么时候完成')).toBe(true);
    expect(shouldUseReadOnlyClaudeForText('有哪些 issue')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('活跃的 issue 呢')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('活跃的呢')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('open issues')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('正在处理哪些任务')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('github 上还有哪些 pr 没关')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('Linear 里面还有开发中的单吗')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('默认项目是什么')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('现在 pending 的确认有哪些')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('supervisor 现在在跑什么')).toBe(false);
    expect(shouldUseReadOnlyClaudeForText('我今天只是想聊聊')).toBe(false);
  });
});
