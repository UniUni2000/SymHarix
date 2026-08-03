import { describe, expect, test } from 'bun:test';
import { createOpenCodeRepoUnderstandingRunner } from './openCodeRepoUnderstandingService';

describe('createOpenCodeRepoUnderstandingRunner', () => {
  test.skipIf(
    process.env.SYMHARIX_RUN_OPENCODE_REPO_UNDERSTANDING_IT !== '1'
    && process.env.SYMPHONY_RUN_CLAUDE_REPO_UNDERSTANDING_IT !== '1',
  )(
    'runs the pinned OpenCode path in read-only understanding mode',
    async () => {
      const runOpenCode = createOpenCodeRepoUnderstandingRunner({
        command: process.env.SYMHARIX_SUPERVISOR_OPENCODE_REPO_UNDERSTANDING_COMMAND
          ?? process.env.SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND
          ?? 'node scripts/opencode-adapter.cjs',
        timeoutMs: 120_000,
        projectRoot: process.cwd(),
      });

      const output = await runOpenCode({
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
