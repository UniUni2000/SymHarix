import { describe, expect, test } from 'bun:test';
import {
  buildRepoUnderstandingPrompt,
  DefaultClaudeRepoUnderstandingService,
} from './claudeRepoUnderstandingService';
import type { SupervisorRepoUnderstandingSnapshot } from './repoUnderstanding';

function validClaudeOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'Repo coordinates Telegram supervisor work.',
    project_purpose: 'Turns Telegram conversations into supervised repo work.',
    tech_stack: ['Bun', 'TypeScript'],
    key_paths: ['src/bots/assistant.ts'],
    architecture_notes: ['Supervisor controls approval; dev agent mutates code later.'],
    artifact_opportunities: ['Visual issue card improvements.'],
    test_commands: ['bun test src/bots/assistant.test.ts'],
    risks: ['Do not create issues before approval.'],
    evidence_paths: ['src/bots/assistant.ts'],
    ...overrides,
  };
}

describe('DefaultClaudeRepoUnderstandingService', () => {
  test('uses cached ready understanding for same repo commit and does not call runner', async () => {
    let runnerCalls = 0;
    const cached: SupervisorRepoUnderstandingSnapshot = {
      repo_ref: 'acme/demo-app',
      commit_sha: 'abc123',
      summary: 'Cached repo understanding.',
      understanding: {
        project_purpose: 'Cached purpose.',
        tech_stack: ['Bun'],
        key_paths: ['src/bots/assistant.ts'],
        architecture_notes: [],
        artifact_opportunities: ['Improve Plan Card visuals.'],
        test_commands: ['bun test'],
        risks: [],
      },
      evidence_paths: ['src/bots/assistant.ts'],
      source: 'cache',
    };
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async ({ repoRef, commitSha }) => {
        expect(repoRef).toBe('acme/demo-app');
        expect(commitSha).toBe('abc123');
        return cached;
      },
      save: async () => undefined,
      resolveCommit: async () => 'abc123',
      runClaude: async () => {
        runnerCalls += 1;
        return '{}';
      },
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: false,
    });

    expect(result).toEqual(cached);
    expect(runnerCalls).toBe(0);
  });

  test('builds read-only prompt and normalizes Claude JSON output', async () => {
    let prompt = '';
    let saved: (SupervisorRepoUnderstandingSnapshot & { localPath: string | null }) | null = null;
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async (snapshot) => {
        saved = snapshot;
      },
      resolveCommit: async () => 'abc123',
      runClaude: async (input) => {
        prompt = input.prompt;
        expect(input.localPath).toBe('/tmp/demo-app');
        return JSON.stringify(validClaudeOutput({
          summary: ' Repo coordinates Telegram supervisor work. ',
          tech_stack: ['Bun', 'TypeScript', '', 42],
          key_paths: ['src/bots/assistant.ts', 'src/supervisor/sessionService.ts'],
        }));
      },
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: true,
    });

    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('Do not edit files');
    expect(prompt).toContain('Return JSON only');
    expect(prompt).toContain('only read/list/inspect commands are allowed');
    expect(prompt).toContain('Do not run installs');
    expect(prompt).toContain('formatters');
    expect(prompt).toContain('codegen');
    expect(prompt).toContain('snapshot-writing tests');
    expect(prompt).toContain('git writes');
    expect(prompt).toContain('network side effects');
    expect(prompt).toContain('external side effects');
    expect(prompt).toContain('summary');
    expect(prompt).toContain('project_purpose');
    expect(prompt).toContain('tech_stack');
    expect(prompt).toContain('key_paths');
    expect(prompt).toContain('architecture_notes');
    expect(prompt).toContain('artifact_opportunities');
    expect(prompt).toContain('test_commands');
    expect(prompt).toContain('risks');
    expect(prompt).toContain('evidence_paths');
    expect(result.repo_ref).toBe('acme/demo-app');
    expect(result.commit_sha).toBe('abc123');
    expect(result.summary).toBe('Repo coordinates Telegram supervisor work.');
    expect(result.understanding.tech_stack).toEqual(['Bun', 'TypeScript']);
    expect(result.understanding.key_paths).toContain('src/bots/assistant.ts');
    expect(result.evidence_paths).toContain('src/bots/assistant.ts');
    expect(result.source).toBe('claude_code');
    expect(saved).toEqual({ ...result, localPath: '/tmp/demo-app' });
  });

  test('missing localPath returns fallback and does not call resolveCommit, runner, or save', async () => {
    let resolveCommitCalls = 0;
    let runnerCalls = 0;
    let saveCalls = 0;
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async () => {
        saveCalls += 1;
      },
      resolveCommit: async () => {
        resolveCommitCalls += 1;
        return 'abc123';
      },
      runClaude: async () => {
        runnerCalls += 1;
        return '{}';
      },
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: null,
    });

    expect(result.repo_ref).toBe('acme/demo-app');
    expect(result.commit_sha).toBe('unknown');
    expect(result.source).toBe('fallback');
    expect(result.understanding.risks.join(' ')).toContain('missing local_path');
    expect(resolveCommitCalls).toBe(0);
    expect(runnerCalls).toBe(0);
    expect(saveCalls).toBe(0);
  });

  test('can parse a JSON object embedded in prose', async () => {
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async () => undefined,
      resolveCommit: async () => 'abc123',
      runClaude: async () => [
        'Here is the result:',
        JSON.stringify(validClaudeOutput({
          summary: 'Embedded JSON summary.',
          project_purpose: 'Advise the supervisor.',
          tech_stack: ['Bun'],
          key_paths: ['src/supervisor/supervisorAgent.ts'],
          architecture_notes: ['Repo understanding feeds chat.'],
          artifact_opportunities: ['Mini App detail view.'],
          evidence_paths: ['src/supervisor/supervisorAgent.ts'],
        })),
        'No edits were made.',
      ].join('\n'),
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: true,
    });

    expect(result.summary).toBe('Embedded JSON summary.');
    expect(result.understanding.artifact_opportunities).toEqual(['Mini App detail view.']);
  });

  test('malformed Claude output returns fallback and does not save', async () => {
    let saveCalls = 0;
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async () => {
        saveCalls += 1;
      },
      resolveCommit: async () => 'abc123',
      runClaude: async () => 'I inspected it, but there is no JSON here.',
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: true,
    });

    expect(result.commit_sha).toBe('abc123');
    expect(result.source).toBe('fallback');
    expect(result.summary).toContain('Claude repo understanding output was unusable');
    expect(result.understanding.risks.join(' ')).toContain('invalid/unparseable Claude repo understanding output');
    expect(saveCalls).toBe(0);
  });

  test('missing required Claude fields returns fallback and does not save', async () => {
    let saveCalls = 0;
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async () => {
        saveCalls += 1;
      },
      resolveCommit: async () => 'abc123',
      runClaude: async () => JSON.stringify({}),
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: true,
    });

    expect(result.commit_sha).toBe('abc123');
    expect(result.source).toBe('fallback');
    expect(result.summary).toContain('Claude repo understanding output was unusable');
    expect(saveCalls).toBe(0);
  });

  test('unknown commit skips cache lookup and save while still returning valid Claude output', async () => {
    let findCachedCalls = 0;
    let saveCalls = 0;
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => {
        findCachedCalls += 1;
        return null;
      },
      save: async () => {
        saveCalls += 1;
      },
      resolveCommit: async () => 'unknown',
      runClaude: async () => JSON.stringify(validClaudeOutput({
        summary: 'Fresh unknown-commit summary.',
      })),
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: false,
    });

    expect(result.commit_sha).toBe('unknown');
    expect(result.source).toBe('claude_code');
    expect(result.summary).toBe('Fresh unknown-commit summary.');
    expect(findCachedCalls).toBe(0);
    expect(saveCalls).toBe(0);
  });

  test('cache-only lookup returns fallback without running Claude when no cached row exists', async () => {
    let runnerCalls = 0;
    let saveCalls = 0;
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async () => {
        saveCalls += 1;
      },
      resolveCommit: async () => 'abc123',
      runClaude: async () => {
        runnerCalls += 1;
        return JSON.stringify(validClaudeOutput());
      },
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: false,
      cacheOnly: true,
    });

    expect(result.commit_sha).toBe('abc123');
    expect(result.source).toBe('fallback');
    expect(result.summary).toContain('No cached repo understanding');
    expect(runnerCalls).toBe(0);
    expect(saveCalls).toBe(0);
  });

  test('continues scanning when prose contains an invalid balanced object before real JSON', async () => {
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async () => undefined,
      resolveCommit: async () => 'abc123',
      runClaude: async () => [
        'Ignore this leading placeholder: {placeholder}',
        JSON.stringify(validClaudeOutput({
          summary: 'Second object is the real JSON.',
        })),
      ].join('\n'),
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: true,
    });

    expect(result.source).toBe('claude_code');
    expect(result.summary).toBe('Second object is the real JSON.');
  });

  test('continues scanning when prose contains schema-invalid JSON before real JSON', async () => {
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async () => undefined,
      resolveCommit: async () => 'abc123',
      runClaude: async () => [
        'Example: {}',
        JSON.stringify(validClaudeOutput({
          summary: 'Schema-valid object is selected.',
          project_purpose: 'Real repo understanding payload.',
        })),
      ].join('\n'),
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: true,
    });

    expect(result.source).toBe('claude_code');
    expect(result.summary).toBe('Schema-valid object is selected.');
    expect(result.understanding.project_purpose).toBe('Real repo understanding payload.');
  });

  test('braces inside JSON strings do not break embedded JSON extraction', async () => {
    const service = new DefaultClaudeRepoUnderstandingService({
      findCached: async () => null,
      save: async () => undefined,
      resolveCommit: async () => 'abc123',
      runClaude: async () => [
        'Result:',
        JSON.stringify(validClaudeOutput({
          summary: 'Handles braces in strings.',
          architecture_notes: ['Template strings may contain {repoRef} or nested-looking } braces.'],
        })),
      ].join('\n'),
    });

    const result = await service.understand({
      repoRef: 'acme/demo-app',
      localPath: '/tmp/demo-app',
      forceRefresh: true,
    });

    expect(result.source).toBe('claude_code');
    expect(result.summary).toBe('Handles braces in strings.');
    expect(result.understanding.architecture_notes).toEqual([
      'Template strings may contain {repoRef} or nested-looking } braces.',
    ]);
  });
});

describe('buildRepoUnderstandingPrompt', () => {
  test('contains the required read-only contract', () => {
    const prompt = buildRepoUnderstandingPrompt('acme/demo-app');

    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('Do not edit files');
    expect(prompt).toContain('Return JSON only');
    expect(prompt).toContain('only read/list/inspect commands are allowed');
  });
});
