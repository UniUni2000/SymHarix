import { describe, expect, test } from 'bun:test';
import {
  buildReadOnlyClaudeAdvisorPrompt,
  respondToReadOnlyClaudeRuntimeRequest,
  SupervisorReadOnlyClaudeConversationManager,
} from './readOnlyClaudeAdvisor';
import type { SupervisorAgentNormalizedInput } from './supervisorAgent';
import type { PendingRuntimeRequest } from '../types';

function makeInput(overrides: Partial<SupervisorAgentNormalizedInput> = {}): SupervisorAgentNormalizedInput {
  return {
    localPath: '/tmp/workspaces/uniuni2000__test2/source',
    repoRef: 'UniUni2000/test2',
    defaultRepoRef: 'UniUni2000/test2',
    userText: '这个仓库有哪些文件',
    normalizedUserText: '这个仓库有哪些文件',
    projectContext: 'default_project=test2',
    runtimeContext: {
      source: 'telegram_chat',
      transport: 'telegram',
      conversationId: 'chat-1',
      defaultProjectSlug: 'test2',
      activeIssueId: null,
    },
    route: null,
    repoProfile: null,
    repoUnderstanding: null,
    repoSource: {
      project_slug: 'test2',
      repo_ref: 'UniUni2000/test2',
      configured_local_path: null,
      analysis_path: '/tmp/workspaces/uniuni2000__test2/source',
      source_path: '/tmp/workspaces/uniuni2000__test2/source',
      commit_sha: 'abc123',
      status: 'ready',
      last_sync_error: null,
      updated_at: '2026-05-07T00:00:00.000Z',
    },
    allowExternalResearch: false,
    prompt: 'unused outer supervisor prompt',
    ...overrides,
  };
}

describe('buildReadOnlyClaudeAdvisorPrompt', () => {
  test('disallows external web tools unless the user explicitly asks for research', () => {
    const prompt = buildReadOnlyClaudeAdvisorPrompt(makeInput());

    expect(prompt).toContain('read-only Claude Code brain');
    expect(prompt).toContain('must not edit files');
    expect(prompt).toContain('Bash, Write, and Edit are disabled');
    expect(prompt).toContain('do not use WebFetch or WebSearch');
    expect(prompt).toContain('repo_source');
    expect(prompt).toContain('Return JSON only');
  });

  test('allows external web tools for explicit latest information requests', () => {
    const prompt = buildReadOnlyClaudeAdvisorPrompt(makeInput({
      normalizedUserText: '结合最新官方文档看看这个 API',
      allowExternalResearch: true,
    }));

    expect(prompt).toContain('WebFetch/WebSearch may be used');
  });

  test('includes read-only control-plane issue runtime context for comprehensive advisor answers', () => {
    const prompt = buildReadOnlyClaudeAdvisorPrompt(makeInput({
      normalizedUserText: 'INT-157 卡在哪里，预计什么时候完成？',
      controlPlaneSnapshot: {
        overview: {
          running: 1,
          retrying: 0,
          active_issues: [
            {
              identifier: 'INT-157',
              title: '补充 README.md 项目文档',
              tracker_state: 'In Progress',
              orchestrator_state: 'dev_running',
              session: {
                stage: 'coding',
                last_message: 'Bash · python -m pytest',
              },
            },
          ],
        },
        focus_issue: {
          issue: {
            identifier: 'INT-157',
            branch_name: 'feature/int-157',
          },
          recent_timeline: [
            {
              message: 'Bash · python -m pytest test_stellar_mass_luminosity.py',
              tool_name: 'Bash',
            },
          ],
        },
      },
    } as any));

    expect(prompt).toContain('control_plane_snapshot');
    expect(prompt).toContain('INT-157');
    expect(prompt).toContain('python -m pytest');
    expect(prompt).toContain('read-only runtime/control-plane snapshot');
  });
});

describe('respondToReadOnlyClaudeRuntimeRequest', () => {
  function approval(toolName: string): PendingRuntimeRequest {
    return {
      kind: 'approval',
      method: 'approval/request',
      request_id: `req-${toolName}`,
      turn: 1,
      raw: {
        tool_name: toolName,
        tool_use_id: `tool-${toolName}`,
        input: { path: 'README.md' },
      },
      summary: {
        title: `Permission request for ${toolName}`,
        message: '{}',
        tool_name: toolName,
        subtype: 'can_use_tool',
      },
    };
  }

  test('allows repository read tools and denies mutating tools', () => {
    expect(respondToReadOnlyClaudeRuntimeRequest(approval('Read'), false).response).toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-Read',
      updatedInput: { path: 'README.md' },
    });
    expect(respondToReadOnlyClaudeRuntimeRequest(approval('Bash'), true).response).toMatchObject({
      behavior: 'deny',
      toolUseID: 'tool-Bash',
    });
  });

  test('allows external web tools only for explicit research requests', () => {
    expect(respondToReadOnlyClaudeRuntimeRequest(approval('WebSearch'), false).response).toMatchObject({
      behavior: 'deny',
    });
    expect(respondToReadOnlyClaudeRuntimeRequest(approval('WebSearch'), true).response).toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-WebSearch',
    });
  });
});

describe('SupervisorReadOnlyClaudeConversationManager', () => {
  test('reuses one Claude Code session for follow-up turns in the same Telegram chat and repo', async () => {
    const createdSessions: string[] = [];
    const prompts: string[] = [];
    const manager = new SupervisorReadOnlyClaudeConversationManager({
      createSession: async (input) => {
        createdSessions.push(`${input.runtimeContext.transport}:${input.runtimeContext.conversationId}:${input.repoRef}`);
        return {
          run: async (prompt) => {
            prompts.push(prompt);
            return `{"mode":"repo_answer","answer":"turn ${prompts.length}"}`;
          },
          dispose: async () => undefined,
        };
      },
      now: () => '2026-05-07T00:00:00.000Z',
    });

    await manager.advise(makeInput({
      normalizedUserText: '这个仓库有哪些文件',
      userText: '这个仓库有哪些文件',
    }));
    await manager.advise(makeInput({
      normalizedUserText: 'README.md 有啥内容',
      userText: 'README.md 有啥内容',
    }));

    expect(createdSessions).toEqual(['telegram:chat-1:UniUni2000/test2']);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('README.md 有啥内容');
    expect(manager.hasActiveConversation({
      transport: 'telegram',
      conversationId: 'chat-1',
      repoRef: 'UniUni2000/test2',
    })).toBe(true);
  });

  test('keeps separate Claude Code memory when the Telegram chat switches repos', async () => {
    const createdSessions: string[] = [];
    const manager = new SupervisorReadOnlyClaudeConversationManager({
      createSession: async (input) => {
        createdSessions.push(`${input.runtimeContext.conversationId}:${input.repoRef}`);
        return {
          run: async () => '{"mode":"repo_answer","answer":"ok"}',
          dispose: async () => undefined,
        };
      },
      now: () => '2026-05-07T00:00:00.000Z',
    });

    await manager.advise(makeInput({ repoRef: 'UniUni2000/test2', defaultRepoRef: 'UniUni2000/test2' }));
    await manager.advise(makeInput({
      repoRef: 'UniUni2000/other',
      defaultRepoRef: 'UniUni2000/other',
      repoSource: {
        project_slug: 'other',
        repo_ref: 'UniUni2000/other',
        configured_local_path: null,
        analysis_path: '/tmp/workspaces/uniuni2000__other/source',
        source_path: '/tmp/workspaces/uniuni2000__other/source',
        commit_sha: 'def456',
        status: 'ready',
        last_sync_error: null,
        updated_at: '2026-05-07T00:00:00.000Z',
      },
      localPath: '/tmp/workspaces/uniuni2000__other/source',
    }));

    expect(createdSessions).toEqual([
      'chat-1:UniUni2000/test2',
      'chat-1:UniUni2000/other',
    ]);
    expect(manager.getDiagnostics()).toHaveLength(2);
  });

  test('clears a Telegram chat repo conversation without deleting source cache state', async () => {
    const disposed: string[] = [];
    const manager = new SupervisorReadOnlyClaudeConversationManager({
      createSession: async (input) => ({
        run: async () => '{"mode":"repo_answer","answer":"ok"}',
        dispose: async () => {
          disposed.push(input.repoRef ?? 'unknown');
        },
      }),
      now: () => '2026-05-07T00:00:00.000Z',
    });

    await manager.advise(makeInput());
    const cleared = await manager.clearConversation({
      transport: 'telegram',
      conversationId: 'chat-1',
      repoRef: 'UniUni2000/test2',
    });

    expect(cleared).toBe(1);
    expect(disposed).toEqual(['UniUni2000/test2']);
    expect(manager.hasActiveConversation({
      transport: 'telegram',
      conversationId: 'chat-1',
      repoRef: 'UniUni2000/test2',
    })).toBe(false);
  });
});
