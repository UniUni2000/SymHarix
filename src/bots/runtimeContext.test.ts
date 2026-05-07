import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BotConversationPreferenceRepository, initializeSchema } from '../database';
import type { RuntimeControlPlane } from '../runtime/types';
import { DefaultRepoProfileService } from '../supervisor/repoProfileService';
import type { SupervisorRepoUnderstandingService } from '../supervisor/repoUnderstanding';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { BotRuntimeContextService } from './runtimeContext';

function createEmptyRuntime(): RuntimeControlPlane {
  return {
    getOverview: () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 0 },
      issues: [],
    }),
    getIssue: () => null,
    getTimeline: () => [],
    getHistoryView: () => null,
    createIssue: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'ok',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
      issue: null,
    }),
    stopIssue: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'ok',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    retryIssue: async () => ({
      accepted: true,
      status: 'queued',
      message: 'ok',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    overrideGovernance: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'ok',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    rewriteGovernance: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'ok',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    splitGovernance: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'ok',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    executeGovernanceSuggestion: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'ok',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    dismissGovernanceSuggestion: async () => ({
      accepted: true,
      status: 'accepted',
      message: 'ok',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: () => () => {},
  };
}

function createProjectResolver(localPath: string | null = null): TrackerProjectResolutionService {
  return new TrackerProjectResolutionService(
    {
      listProjects: async () => ({ projects: [] }),
      findProjectBySlug: async () => ({ project: null }),
    } as any,
    {
      test2: {
        github_owner: 'UniUni2000',
        github_repo: 'test2',
        local_path: localPath ?? undefined,
      },
    },
  );
}

function createPreferences(db: Database): BotConversationPreferenceRepository {
  const preferences = new BotConversationPreferenceRepository(db);
  preferences.upsert({
    transport: 'telegram',
    conversation_id: 'chat-1',
    default_project_slug: 'test2',
  });
  return preferences;
}

const telegramContext = {
  transport: 'telegram' as const,
  recipient: { transport: 'telegram' as const, conversation_id: 'chat-1' },
  identity: { user_id: 'user-1', display_name: 'Alice' },
};

const unconfiguredAssistant = {
  provider: null,
  model: null,
  configured: false,
  health: 'unconfigured' as const,
  fallback_available: true,
  last_error_code: 'unconfigured',
};

describe('BotRuntimeContextService', () => {
  test('includes repo_profile for the default project when a local path is configured', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-runtime-context-'));
    const db = new Database(':memory:');
    try {
      initializeSchema(db);
      fs.writeFileSync(
        path.join(repoRoot, 'README.md'),
        [
          '# Test Two',
          '',
          'Test Two is a Telegram-first supervisor workspace for repository-aware issue planning.',
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({
          name: 'test-two',
          dependencies: {
            hono: '^4.0.0',
          },
        }, null, 2),
        'utf8',
      );
      fs.mkdirSync(path.join(repoRoot, 'src'));

      const preferences = new BotConversationPreferenceRepository(db);
      preferences.upsert({
        transport: 'telegram',
        conversation_id: 'chat-1',
        default_project_slug: 'test2',
      });

      const runtime: RuntimeControlPlane = {
        getOverview: () => ({
          generated_at: '2026-01-01T00:00:00.000Z',
          counts: { running: 0, retrying: 0, total: 0 },
          issues: [],
        }),
        getIssue: () => null,
        getTimeline: () => [],
        getHistoryView: () => null,
        createIssue: async () => ({
          accepted: true,
          status: 'accepted',
          message: 'ok',
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
          issue: null,
        }),
        stopIssue: async () => ({
          accepted: true,
          status: 'accepted',
          message: 'ok',
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
        }),
        retryIssue: async () => ({
          accepted: true,
          status: 'queued',
          message: 'ok',
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
        }),
        overrideGovernance: async () => ({
          accepted: true,
          status: 'accepted',
          message: 'ok',
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
        }),
        rewriteGovernance: async () => ({
          accepted: true,
          status: 'accepted',
          message: 'ok',
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
        }),
        splitGovernance: async () => ({
          accepted: true,
          status: 'accepted',
          message: 'ok',
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
        }),
        executeGovernanceSuggestion: async () => ({
          accepted: true,
          status: 'accepted',
          message: 'ok',
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
        }),
        dismissGovernanceSuggestion: async () => ({
          accepted: true,
          status: 'accepted',
          message: 'ok',
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
        }),
        createStream: () => new ReadableStream<Uint8Array>(),
        subscribe: () => () => {},
      };

      const projectResolver = new TrackerProjectResolutionService(
        {
          listProjects: async () => ({ projects: [] }),
          findProjectBySlug: async () => ({ project: null }),
        } as any,
        {
          test2: {
            github_owner: 'UniUni2000',
            github_repo: 'test2',
            local_path: repoRoot,
          },
        },
      );

      const service = new BotRuntimeContextService(
        runtime,
        preferences,
        projectResolver,
        null,
        null,
        new DefaultRepoProfileService(),
      );

      const context = await service.buildContext(
        {
          transport: 'telegram',
          recipient: { transport: 'telegram', conversation_id: 'chat-1' },
          identity: { user_id: 'user-1', display_name: 'Alice' },
        },
        '这个项目主要干啥',
        {
          provider: null,
          model: null,
          configured: false,
          health: 'unconfigured',
          fallback_available: true,
          last_error_code: 'unconfigured',
        },
      );

      expect(context.repo_profile).not.toBeNull();
      expect(context.repo_profile?.repo_ref).toBe('UniUni2000/test2');
      expect(context.repo_profile?.summary).toContain('Telegram-first supervisor workspace');
      expect(context.repo_profile?.key_paths).toContain('src');
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('includes repo understanding for the default project when available', async () => {
    const db = new Database(':memory:');
    try {
      initializeSchema(db);
      const calls: Array<{
        repoRef: string;
        localPath: string | null;
        forceRefresh?: boolean;
      }> = [];
      const repoUnderstandingService: SupervisorRepoUnderstandingService = {
        understand: async (input) => {
          calls.push(input);
          return {
            repo_ref: input.repoRef,
            commit_sha: 'abc123',
            summary: 'Cached repo understanding.',
            understanding: {
              project_purpose: 'Telegram-first repo planning.',
              tech_stack: ['Bun', 'TypeScript'],
              key_paths: ['src/bots/runtimeContext.ts'],
              architecture_notes: ['Runtime context enriches Telegram chat.'],
              artifact_opportunities: ['Progressive Plan Card'],
              test_commands: ['bun test src/bots/runtimeContext.test.ts'],
              risks: ['Cache can be stale.'],
            },
            evidence_paths: ['README.md', 'src/bots/runtimeContext.ts'],
            source: 'cache',
          };
        },
      };
      const service = new BotRuntimeContextService(
        createEmptyRuntime(),
        createPreferences(db),
        createProjectResolver('/tmp/test2'),
        null,
        null,
        new DefaultRepoProfileService(),
        repoUnderstandingService,
      );

      const context = await service.buildContext(
        telegramContext,
        '这个项目主要干啥',
        unconfiguredAssistant,
      );

      expect(calls).toEqual([
        {
          repoRef: 'UniUni2000/test2',
          localPath: '/tmp/test2',
          forceRefresh: false,
          cacheOnly: true,
        },
      ]);
      expect(context.repo_understanding).toEqual({
        repo_ref: 'UniUni2000/test2',
        commit_sha: 'abc123',
        summary: 'Cached repo understanding.',
        understanding: {
          project_purpose: 'Telegram-first repo planning.',
          tech_stack: ['Bun', 'TypeScript'],
          key_paths: ['src/bots/runtimeContext.ts'],
          architecture_notes: ['Runtime context enriches Telegram chat.'],
          artifact_opportunities: ['Progressive Plan Card'],
          test_commands: ['bun test src/bots/runtimeContext.test.ts'],
          risks: ['Cache can be stale.'],
        },
        evidence_paths: ['README.md', 'src/bots/runtimeContext.ts'],
        source: 'cache',
      });
    } finally {
      db.close();
    }
  });

  test('repo understanding failure is swallowed while context still builds', async () => {
    const db = new Database(':memory:');
    try {
      initializeSchema(db);
      const repoUnderstandingService: SupervisorRepoUnderstandingService = {
        understand: async () => {
          throw new Error('repo cache unavailable');
        },
      };
      const service = new BotRuntimeContextService(
        createEmptyRuntime(),
        createPreferences(db),
        createProjectResolver('/tmp/test2'),
        null,
        null,
        new DefaultRepoProfileService(),
        repoUnderstandingService,
      );

      const context = await service.buildContext(
        telegramContext,
        '这个项目主要干啥',
        unconfiguredAssistant,
      );

      expect(context.default_project_slug).toBe('test2');
      expect(context.available_projects).toContainEqual({
        project_slug: 'test2',
        github_repo_full: 'UniUni2000/test2',
      });
      expect(context.repo_understanding).toBeNull();
    } finally {
      db.close();
    }
  });
});
