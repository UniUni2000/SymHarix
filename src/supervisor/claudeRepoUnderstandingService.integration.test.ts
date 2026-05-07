import { describe, expect, test } from 'bun:test';
import { createClaudeCodeRepoUnderstandingRunner } from './claudeRepoUnderstandingService';

describe('createClaudeCodeRepoUnderstandingRunner', () => {
  test.skipIf(process.env.SYMPHONY_RUN_CLAUDE_REPO_UNDERSTANDING_IT !== '1')(
    'runs the bundled Claude Code path in read-only understanding mode',
    async () => {
      const runClaude = createClaudeCodeRepoUnderstandingRunner({
        command: process.env.SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND
          ?? 'node scripts/claude-adapter.cjs',
        timeoutMs: 120_000,
        projectRoot: process.cwd(),
      });

      const output = await runClaude({
        localPath: process.cwd(),
        prompt: [
          'READ-ONLY. Return JSON only:',
          '{"summary":"ok","project_purpose":"ok","tech_stack":[],"key_paths":[],"architecture_notes":[],"artifact_opportunities":[],"test_commands":[],"risks":[],"evidence_paths":[]}',
        ].join(' '),
      });

      expect(output).toContain('{');
    },
  );
});
