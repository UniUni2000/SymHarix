import { describe, expect, test } from 'bun:test';
import type { BotCommandContext } from '../bots/types';
import {
  SUPERVISOR_CLAUDE_ALLOWED_TOOLS,
  SupervisorClaudeRuntimeService,
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
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('mcp__supervisor-orchestrator__watch_issue');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).toContain('mcp__supervisor-orchestrator__unwatch_issue');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).not.toContain('Bash');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).not.toContain('Write');
    expect(SUPERVISOR_CLAUDE_ALLOWED_TOOLS).not.toContain('Edit');
  });

  test('describes orchestrator tools as the only business action surface', () => {
    const prompt = buildSupervisorClaudeSystemPrompt();

    expect(prompt).toContain('Telegram text is user-facing');
    expect(prompt).toContain('do not output raw JSON');
    expect(prompt).toContain('supervisor-orchestrator');
    expect(prompt).toContain('list_orchestrator_capabilities');
    expect(prompt).toContain('show_issue_card');
    expect(prompt).toContain('create_issue');
  });
});
