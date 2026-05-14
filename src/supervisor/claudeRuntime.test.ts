import { describe, expect, test } from 'bun:test';
import type { BotCommandContext } from '../bots/types';
import {
  SUPERVISOR_CLAUDE_ALLOWED_TOOLS,
  SupervisorClaudeRuntimeService,
  buildSupervisorMcpConfig,
  buildSupervisorClaudeSystemPrompt,
} from './claudeRuntime';

describe('SupervisorClaudeRuntimeService', () => {
  const context: BotCommandContext = {
    transport: 'telegram',
    recipient: {
      transport: 'telegram',
      conversation_id: 'chat-1',
    },
    identity: {
      user_id: 'user-1',
      display_name: 'Alice',
    },
  };

  test('reuses a read-only Claude Code session per Telegram conversation and repo', async () => {
    const launches: string[] = [];
    const turns: string[] = [];
    const service = new SupervisorClaudeRuntimeService({
      resolveWorkspace: async () => ({
        repoRef: 'UniUni2000/test2',
        localPath: '/tmp/source-cache/test2',
      }),
      createSession: async (workspace) => {
        launches.push(`${workspace.transport}:${workspace.conversationId}:${workspace.repoRef}:${workspace.localPath}`);
        return {
          ask: async (prompt) => {
            turns.push(prompt);
            return {
              message: '建议先做：补一张 repo readiness issue。\n依据：runtime + repo source + supervisor memory。',
            };
          },
          dispose: async () => undefined,
        };
      },
    });

    const first = await service.respond({ context, text: '这个仓库目前最需要的 issue 是？', canWrite: true });
    const second = await service.respond({ context, text: '还有别的吗？', canWrite: true });

    expect(first?.message).toContain('建议先做');
    expect(second?.message).toContain('建议先做');
    expect(launches).toEqual(['telegram:chat-1:UniUni2000/test2:/tmp/source-cache/test2']);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toContain('Context source map');
    expect(turns[0]).toContain('list_context_sources');
    expect(turns[0]).toContain('compact evidence');
    expect(turns[0]).toContain('detected_user_language: Chinese');
  });

  test('allows read-only repo tools and supervisor context MCP tools but not repo mutation tools', () => {
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('Read');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('Grep');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('Glob');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('LS');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('mcp__supervisor-context__recommend_repo_issue');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('mcp__supervisor-orchestrator__list_orchestrator_capabilities');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('mcp__supervisor-orchestrator__show_issue_card');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('mcp__supervisor-orchestrator__create_issue');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('mcp__supervisor-orchestrator__switch_repository');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('mcp__supervisor-orchestrator__watch_issue');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('mcp__supervisor-orchestrator__unwatch_issue');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).not.toContain('Bash');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).not.toContain('Write');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).not.toContain('Edit');
  });

  test('describes orchestrator tools as the only business action surface', () => {
    const prompt = buildSupervisorClaudeSystemPrompt();

    expect(prompt).toContain('Telegram text is user-facing');
    expect(prompt).toContain('Output Language block');
    expect(prompt).toContain('overrides prior session language');
    expect(prompt).toContain('do not output raw JSON');
    expect(prompt).toContain('supervisor-orchestrator');
    expect(prompt).toContain('list_orchestrator_capabilities');
    expect(prompt).toContain('show_issue_card');
    expect(prompt).toContain('create_issue');
    expect(prompt).toContain('switch_repository');
    expect(prompt).toContain('Do not call yourself a read-only brain');
    expect(prompt).toContain('For capability questions');
    expect(prompt).toContain('create, switch repositories, retry, stop, close, supersede');
  });

  test('adds a strict English output-language block for English Telegram turns', async () => {
    const turns: string[] = [];
    const service = new SupervisorClaudeRuntimeService({
      resolveWorkspace: async () => ({
        repoRef: 'DingfangHu/my-symphony-test',
        localPath: '/tmp/source-cache/my-symphony-test',
      }),
      createSession: async () => ({
        ask: async (prompt) => {
          turns.push(prompt);
          return { message: 'Hello. Current status looks stable.' };
        },
        dispose: async () => undefined,
      }),
    });

    await service.respond({ context, text: 'hello', canWrite: true });

    expect(turns[0]).toContain('## Output Language');
    expect(turns[0]).toContain('detected_user_language: English');
    expect(turns[0]).toContain('Write every user-facing sentence in English');
    expect(turns[0]).toContain('Do not use Chinese in greetings');
    expect(turns[0]).toContain('user_message: hello');
  });

  test('frames the supervisor as a repo steward that improves vague issue ideas', () => {
    const prompt = buildSupervisorClaudeSystemPrompt();

    expect(prompt).toContain('repository steward');
    expect(prompt).toContain('long-term repository health');
    expect(prompt).toContain('governance advisor');
    expect(prompt).toContain('vague issue');
    expect(prompt).toContain('acceptance criteria');
    expect(prompt).toContain('repository fit');
    expect(prompt).toContain('one clear recommendation');
    expect(prompt).toContain('1-2 alternatives');
    expect(prompt).toContain('ask one focused question');
    expect(prompt).toContain('high-leverage repo recommendation');
  });

  test('includes an intent routing guide so Claude can choose the right context and business tools', async () => {
    const turns: string[] = [];
    const service = new SupervisorClaudeRuntimeService({
      resolveWorkspace: async () => ({
        repoRef: 'UniUni2000/test2',
        localPath: '/tmp/source-cache/test2',
      }),
      createSession: async () => ({
        ask: async (prompt) => {
          turns.push(prompt);
          return { message: '我会先把模糊需求整理成更贴合仓库的 issue 草案。' };
        },
        dispose: async () => undefined,
      }),
    });

    await service.respond({ context, text: '帮我提个能提升仓库质量的 issue', canWrite: true });

    expect(turns[0]).toContain('Intent routing guide');
    expect(turns[0]).toContain('repo direction / next issue');
    expect(turns[0]).toContain('prepare_repo_source');
    expect(turns[0]).toContain('get_repo_understanding');
    expect(turns[0]).toContain('get_governance_signals');
    expect(turns[0]).toContain('recommend_repo_issue');
    expect(turns[0]).toContain('vague issue request');
    expect(turns[0]).toContain('acceptance criteria');
    expect(turns[0]).toContain('create_issue');
    expect(turns[0]).toContain('card / UI request');
    expect(turns[0]).toContain('show_issue_card');
    expect(turns[0]).toContain('blocked / retry request');
    expect(turns[0]).toContain('diagnose_issue');
  });

  test('builds MCP server entrypoints from the orchestrator project root, not the target repo cwd', () => {
    const config = JSON.parse(buildSupervisorMcpConfig(
      {
        transport: 'telegram',
        conversationId: 'chat-1',
        repoRef: 'jasperLiuzhipei/symphony-e2e-sandbox',
        localPath: '/tmp/source-cache/symphony-e2e-sandbox',
      },
      'http://127.0.0.1:3000/api/v1/bots/supervisor-context/call',
      'http://127.0.0.1:3000/api/v1/bots/supervisor-orchestrator/call',
      'token-1',
      '/srv/symharix',
    ));

    expect(config.mcpServers['supervisor-context'].args).toEqual([
      'run',
      '/srv/symharix/src/supervisor/contextMcpServer.ts',
    ]);
    expect(config.mcpServers['supervisor-orchestrator'].args).toEqual([
      'run',
      '/srv/symharix/src/supervisor/orchestratorMcpServer.ts',
    ]);
    expect(config.mcpServers['supervisor-orchestrator'].env).toMatchObject({
      SYMPHONY_SUPERVISOR_ORCHESTRATOR_ENDPOINT:
        'http://127.0.0.1:3000/api/v1/bots/supervisor-orchestrator/call',
      SYMPHONY_SUPERVISOR_ORCHESTRATOR_REPO_REF:
        'jasperLiuzhipei/symphony-e2e-sandbox',
    });
  });
});
