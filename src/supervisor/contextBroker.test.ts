import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  BotConversationPreferenceRepository,
  SupervisorMemoryRepository,
  initializeSchema,
} from '../database';
import type { RuntimeControlPlane, RuntimeIssueView } from '../runtime/types';
import type { BotCommandContext } from '../bots/types';
import { SupervisorContextBroker } from './contextBroker';

function issue(overrides: Partial<RuntimeIssueView> = {}): RuntimeIssueView {
  return {
    issue_id: 'issue-162',
    work_item_id: 'work-162',
    identifier: 'INT-162',
    title: 'Merged supervisor context issue',
    phase: 'DONE',
    tracker_state: 'Done',
    orchestrator_state: 'completed',
    workspace_path: null,
    branch_name: 'codex/int-162',
    github_repo: 'UniUni2000/test2',
    github_issue_number: 162,
    active_pr_number: 92,
    session: null,
    governance_status: null,
    governance_decision: null,
    governance_summary: null,
    active_governance_suggestions: [],
    milestones: [],
    actions: {
      can_stop: false,
      can_retry: false,
      can_override_governance: false,
      can_rewrite_governance: false,
      can_split_governance: false,
      can_open_pr: true,
    },
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:10:00.000Z',
    ...overrides,
  };
}

function runtime(): RuntimeControlPlane {
  const issues = [issue()];
  return {
    getOverview: () => ({
      generated_at: '2026-05-10T00:11:00.000Z',
      counts: { running: 0, retrying: 0, total: issues.length },
      issues,
    }),
    getIssue: (id) => issues.find((item) => item.issue_id === id || item.identifier === id) ?? null,
    getTimeline: () => [],
    getHistoryView: () => ({
      issue_id: 'issue-162',
      issue_identifier: 'INT-162',
      digest: {
        headline: 'INT-162 completed',
        detail: 'Tracker is Done and delivery completed.',
        history_blurb: 'PR merged.',
        updated_at: '2026-05-10T00:10:00.000Z',
      },
      entries: [],
    }),
    createIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    stopIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    retryIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    closeIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    overrideGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    rewriteGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    splitGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    executeGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    dismissGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: () => () => undefined,
  };
}

describe('SupervisorContextBroker', () => {
  const context: BotCommandContext = {
    transport: 'telegram',
    recipient: { transport: 'telegram', conversation_id: 'chat-1' },
    identity: { user_id: 'user-1', display_name: 'Alice' },
  };

  test('lists context sources and resolves conversation route, issue, memory, and recommendation', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const preferences = new BotConversationPreferenceRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      default_project_slug: 'test2',
    });
    const memories = new SupervisorMemoryRepository(db);
    memories.upsert({
      repo_ref: 'UniUni2000/test2',
      memory_kind: 'execution_pattern',
      subject_key: 'repo-readiness',
      summary: 'Previous work showed missing repo readiness docs confuse Telegram recommendations.',
      confidence: 0.8,
    });
    const broker = new SupervisorContextBroker({
      runtime: runtime(),
      preferences,
      supervisorMemories: memories,
      projectResolver: {
        listConfiguredRoutes: () => [{
          project_slug: 'test2',
          project_name: 'Test Two',
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          github_repo_full: 'UniUni2000/test2',
          local_path: '/tmp/test2',
          cache_key: 'uniuni2000__test2',
          require_repo_harness: false,
        }],
      } as any,
      repoProfileService: {
        resolve: async () => ({
          repo_ref: 'UniUni2000/test2',
          summary: 'Test repo',
          project_type: 'node_typescript',
          tech_stack: ['TypeScript'],
          key_paths: ['src'],
          signals: {
            readme_title: 'Test',
            package_name: 'test',
            package_scripts: ['test'],
            top_level_directories: ['src'],
            top_level_files: ['package.json'],
            sample_paths: ['src/index.ts'],
          },
          snapshot: {
            top_level_files: ['package.json'],
            sample_paths: ['src/index.ts'],
            entrypoints: [],
          },
          last_indexed_at: '2026-05-10T00:00:00.000Z',
        }),
      },
      repoUnderstandingService: {
        understand: async () => ({
          repo_ref: 'UniUni2000/test2',
          commit_sha: 'abc123',
          summary: 'Supervisor repo understanding',
          source: 'cache',
          evidence_paths: ['src/index.ts'],
          understanding: {
            project_purpose: 'Telegram supervisor',
            tech_stack: ['TypeScript'],
            key_paths: ['src/bots/assistant.ts'],
            architecture_notes: ['Telegram enters supervisor runtime'],
            artifact_opportunities: ['Add a visual plan card smoke test'],
            test_commands: ['bun test'],
            risks: ['Context sources are fragmented'],
          },
        }),
      },
    });

    const sources = await broker.callTool('list_context_sources', {}, { context });
    expect(String(JSON.stringify(sources))).toContain('repo_understanding');

    const route = await broker.callTool('get_repo_route', {}, { context });
    expect(route.route).toMatchObject({ github_repo_full: 'UniUni2000/test2' });

    const issueResult = await broker.callTool('get_issue', { issue_id: 'INT-162' }, { context });
    expect(issueResult.issue).toMatchObject({ identifier: 'INT-162', tracker_state: 'Done' });

    const memory = await broker.callTool('search_supervisor_memory', { query: 'repo readiness' }, { context });
    expect(memory.memories).toHaveLength(1);

    const recommendation = await broker.callTool('recommend_repo_issue', {}, {
      context,
      text: '这个仓库目前最需要的 issue 是？',
    });
    expect(recommendation.recommendation).toMatchObject({
      repo_ref: 'UniUni2000/test2',
      title: expect.stringContaining('Context sources are fragmented'),
    });
    expect(JSON.stringify(recommendation.recommendation)).toContain('runtime overview');
  });

  test('surfaces recent completed issues by completion evidence instead of overview list order', async () => {
    const oldBulkUpdated = issue({
      issue_id: 'issue-56',
      work_item_id: 'work-56',
      identifier: 'INT-56',
      title: 'Old smoke test completion',
      active_pr_number: 42,
      updated_at: '2026-05-10T02:16:51.896Z',
      milestones: [
        {
          kind: 'completed',
          key: 'delivery:issue-56:completed',
          summary: 'Old delivery was bulk-synced later.',
          timestamp: '2026-05-10T02:16:51.896Z',
        },
        {
          kind: 'review_completed',
          key: 'review:old',
          summary: 'Old review approved.',
          timestamp: '2026-04-25T02:41:19.100Z',
        },
      ],
    });
    const latestPrCompletion = issue({
      issue_id: 'issue-162',
      work_item_id: 'work-162',
      identifier: 'INT-162',
      title: 'Add strict mypy check',
      active_pr_number: 110,
      updated_at: '2026-05-10T02:16:51.890Z',
      milestones: [
        {
          kind: 'completed',
          key: 'delivery:issue-162:completed',
          summary: 'Delivery completed.',
          timestamp: '2026-05-10T02:16:51.890Z',
        },
        {
          kind: 'review_completed',
          key: 'review:new',
          summary: 'New review approved.',
          timestamp: '2026-05-10T02:16:47.319Z',
        },
      ],
    });
    const cancelledNoise = issue({
      issue_id: 'issue-92',
      work_item_id: 'work-92',
      identifier: 'INT-92',
      title: 'Cancelled archived supervisor test',
      tracker_state: 'Canceled',
      active_pr_number: null,
      updated_at: '2026-05-10T03:14:52.638Z',
      milestones: [
        {
          kind: 'completed',
          key: 'delivery:issue-92:completed',
          summary: 'Archived cancellation state.',
          timestamp: '2026-05-10T03:14:52.638Z',
        },
      ],
    });
    const broker = new SupervisorContextBroker({
      runtime: {
        ...runtime(),
        getOverview: () => ({
          generated_at: '2026-05-10T03:20:00.000Z',
          counts: { running: 0, retrying: 0, total: 3 },
          issues: [oldBulkUpdated, latestPrCompletion, cancelledNoise],
        }),
        getIssue: (id) => [oldBulkUpdated, latestPrCompletion, cancelledNoise]
          .find((item) => item.issue_id === id || item.identifier === id) ?? null,
      },
    });

    const recent = await broker.callTool('get_recent_completed_issues', { limit: 2 }, {
      context,
      text: '最近完成的 issue 是？',
    });
    expect(recent.issues).toMatchObject([
      {
        identifier: 'INT-162',
        active_pr_number: 110,
        completed_at: '2026-05-10T02:16:47.319Z',
        completed_at_source: 'review_completed',
      },
      {
        identifier: 'INT-56',
        active_pr_number: 42,
        completed_at: '2026-04-25T02:41:19.100Z',
        completed_at_source: 'review_completed',
      },
    ]);
    expect(JSON.stringify(recent)).not.toContain('INT-92');

    const overview = await broker.callTool('get_runtime_overview', {}, { context });
    expect(overview.overview).toMatchObject({
      counts: { running: 0, retrying: 0, total: 3 },
      recent_completed_issues: [
        { identifier: 'INT-162' },
        { identifier: 'INT-56' },
      ],
    });
  });

  test('uses prepared repo source path for profile and understanding when route local_path is not configured', async () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const preferences = new BotConversationPreferenceRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      default_project_slug: 'test2',
    });
    const seenProfilePaths: Array<string | null> = [];
    const seenUnderstandingPaths: Array<string | null> = [];
    const route = {
      project_slug: 'test2',
      project_name: 'Test Two',
      github_owner: 'UniUni2000',
      github_repo: 'test2',
      github_repo_full: 'UniUni2000/test2',
      local_path: null,
      cache_key: 'uniuni2000__test2',
      require_repo_harness: false,
    };
    const broker = new SupervisorContextBroker({
      runtime: runtime(),
      preferences,
      projectResolver: {
        listConfiguredRoutes: () => [route],
      } as any,
      repoSourceResolver: {
        resolve: async () => ({
          project_slug: 'test2',
          repo_ref: 'UniUni2000/test2',
          configured_local_path: null,
          analysis_path: '/tmp/source-cache/test2',
          source_path: '/tmp/source-cache/test2',
          commit_sha: 'abc123',
          status: 'ready',
          last_sync_error: null,
          updated_at: '2026-05-10T00:00:00.000Z',
        }),
        getDiagnostics: () => [],
      },
      repoProfileService: {
        resolve: async ({ repoRef, localPath }) => {
          seenProfilePaths.push(localPath);
          return {
            repo_ref: repoRef,
            summary: 'Prepared source profile',
            project_type: 'python',
            tech_stack: ['Python'],
            key_paths: ['README.md'],
            signals: {
              readme_title: 'test2',
              package_name: null,
              package_scripts: [],
              top_level_directories: [],
              top_level_files: ['README.md'],
              sample_paths: ['README.md'],
            },
            snapshot: {
              top_level_files: ['README.md'],
              sample_paths: ['README.md'],
              entrypoints: [],
            },
            last_indexed_at: '2026-05-10T00:00:00.000Z',
          };
        },
      },
      repoUnderstandingService: {
        understand: async ({ repoRef, localPath }) => {
          seenUnderstandingPaths.push(localPath);
          return {
            repo_ref: repoRef,
            commit_sha: 'abc123',
            summary: 'Prepared source understanding',
            source: 'cache',
            evidence_paths: ['README.md'],
            understanding: {
              project_purpose: 'Test repo',
              tech_stack: ['Python'],
              key_paths: ['README.md'],
              architecture_notes: [],
              artifact_opportunities: [],
              test_commands: [],
              risks: [],
            },
          };
        },
      },
    });

    const workspace = await broker.resolveWorkspace({ context, text: '让你提一个 issue' });
    expect(workspace).toEqual({
      repoRef: 'UniUni2000/test2',
      localPath: '/tmp/source-cache/test2',
    });

    const profile = await broker.callTool('get_repo_profile', {}, { context });
    expect(profile.profile).toMatchObject({ summary: 'Prepared source profile' });
    const understanding = await broker.callTool('get_repo_understanding', {}, { context });
    expect(understanding.understanding).toMatchObject({ summary: 'Prepared source understanding' });
    expect(seenProfilePaths).toEqual(['/tmp/source-cache/test2']);
    expect(seenUnderstandingPaths).toEqual(['/tmp/source-cache/test2']);
  });
});
