const { describe, expect, test } = require('bun:test');
const adapter = require('./claude-adapter.cjs');

describe('claude-adapter supervisor launch args', () => {
  test('builds Claude CLI args with MCP config, allowed tools, and supervisor system prompt', () => {
    const args = adapter.buildClaudeCliArgs({
      mcpConfig: JSON.stringify({
        mcpServers: {
          'supervisor-context': {
            command: 'bun',
            args: ['run', 'src/supervisor/contextMcpServer.ts'],
          },
        },
      }),
      allowedTools: ['Read', 'Grep', 'mcp__supervisor-context__get_runtime_overview'],
      systemPrompt: 'You are the top-level Supervisor Claude Code runtime.',
    });

    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toContain('supervisor-context');
    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Grep,mcp__supervisor-context__get_runtime_overview');
    expect(args).toContain('--system-prompt');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('You are the top-level Supervisor Claude Code runtime.');
  });
});
