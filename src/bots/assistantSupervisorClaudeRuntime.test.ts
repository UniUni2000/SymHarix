import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  BotConversationFocusRepository,
  BotConversationPreferenceRepository,
  BotPendingActionRepository,
  initializeSchema,
} from '../database';
import type { RuntimeControlPlane, RuntimeStreamEvent } from '../runtime/types';
import { TrackerProjectResolutionService } from '../tracker/projectResolution';
import { BotCommandService } from './commandService';
import { BotSubscriptionService } from './subscriptions';
import { BotAssistantService } from './assistant';
import type { BotCommandContext } from './types';

function createRuntimeControlPlane(): RuntimeControlPlane & {
  createIssueCalls: Array<Record<string, unknown>>;
} {
  const issues: ReturnType<RuntimeControlPlane['getOverview']>['issues'] = [];
  const createIssueCalls: Array<Record<string, unknown>> = [];
  return {
    getOverview: () => ({
      generated_at: '2026-05-10T00:00:00.000Z',
      counts: { running: 0, retrying: 0, total: 0 },
      issues,
    }),
    getIssue: (id: string) => (
      issues.find((issue) => issue.issue_id === id || issue.identifier === id) ?? null
    ),
    getTimeline: () => [],
    getHistoryView: () => null,
    createIssue: async (input) => {
      createIssueCalls.push(input as Record<string, unknown>);
      issues.push({
        issue_id: 'issue-163',
        work_item_id: 'issue-163',
        identifier: 'INT-163',
        title: typeof input.title === 'string' ? input.title : 'Created issue',
        phase: 'DEV',
        tracker_state: 'Todo',
        orchestrator_state: 'mapping',
        workspace_path: null,
        branch_name: null,
        github_repo: 'UniUni2000/test2',
        github_issue_number: null,
        active_pr_number: null,
        session: null,
        actions: {
          can_stop: false,
          can_retry: false,
          can_open_pr: false,
        },
        created_at: '2026-05-10T00:00:00.000Z',
        updated_at: '2026-05-10T00:00:00.000Z',
      });
      return {
        accepted: true,
        status: 'accepted',
        message: '已创建 INT-163',
        issue_id: 'issue-163',
        issue_identifier: 'INT-163',
        issue: null,
      };
    },
    stopIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    retryIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    closeIssue: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    overrideGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    rewriteGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    splitGovernance: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    executeGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    dismissGovernanceSuggestion: async () => ({ accepted: false, status: 'rejected', message: 'not used' }),
    createStream: () => new ReadableStream<Uint8Array>(),
    subscribe: (_listener: (event: RuntimeStreamEvent) => void) => () => undefined,
    createIssueCalls,
  };
}

describe('BotAssistantService top-level Supervisor Claude runtime', () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  test('asks Supervisor Claude before falling back to legacy Telegram natural-language routing', async () => {
    const runtime = createRuntimeControlPlane();
    const commandService = new BotCommandService(runtime, new BotSubscriptionService(runtime, {}), () => true);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-1' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const seen: string[] = [];
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      null,
      null,
      null,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async (request) => {
          seen.push(request.text);
          return { message: '我看了 runtime / repo source / supervisor memory；建议先补 repo readiness issue。' };
        },
      },
    );

    const response = await assistant.respondToText(context, '这个仓库目前最需要的 issue 是？');

    expect(seen).toEqual(['这个仓库目前最需要的 issue 是？']);
    expect(response.message).toContain('repo readiness issue');
    expect(response.message).toContain('runtime / repo source / supervisor memory');
  });

  test('turns Supervisor Claude issue recommendations into pending create-issue confirmations', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-1',
      default_project_slug: 'test2',
    });
    const projectResolver = new TrackerProjectResolutionService(
      {
        listProjects: async () => ({
          projects: [
            { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' },
          ],
        }),
        findProjectBySlug: async (projectSlug: string) => ({
          project: projectSlug === 'test2'
            ? { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' }
            : null,
        }),
      } as any,
      {
        test2: {
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          local_path: null,
        },
      },
    );
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-1' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async () => ({
          message: JSON.stringify({
            mode: 'issue_recommendation',
            title: '添加 pre-commit hooks 自动化代码质量检查',
            summary: '添加 black、isort、flake8、mypy 和基础格式 hooks。',
            next_step: 'ask for approval before creating work',
          }),
        }),
      },
    );

    const first = await assistant.respondToText(context, '让你提一个 issue，你会提什么最重要');
    expect(first.message).toContain('Action: create issue');
    expect(first.message).toContain('Title: 添加 pre-commit hooks 自动化代码质量检查');
    expect(runtime.createIssueCalls).toHaveLength(0);

    const confirmed = await assistant.respondToText(context, '准了');
    expect(confirmed.message).toContain('已创建 INT-163');
    expect(runtime.createIssueCalls).toHaveLength(1);
    expect(runtime.createIssueCalls[0]?.project_slug).toBe('test2');

    subscriptions.dispose();
  });

  test('remembers the created issue as conversation focus after confirming a Supervisor Claude recommendation', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const preferences = new BotConversationPreferenceRepository(db);
    const pending = new BotPendingActionRepository(db);
    const focuses = new BotConversationFocusRepository(db);
    preferences.upsert({
      transport: 'telegram',
      conversation_id: 'chat-remember',
      default_project_slug: 'test2',
    });
    const projectResolver = new TrackerProjectResolutionService(
      {
        listProjects: async () => ({
          projects: [
            { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' },
          ],
        }),
        findProjectBySlug: async (projectSlug: string) => ({
          project: projectSlug === 'test2'
            ? { project_id: 'project-1', project_slug: 'test2', project_name: 'Test Two' }
            : null,
        }),
      } as any,
      {
        test2: {
          github_owner: 'UniUni2000',
          github_repo: 'test2',
          local_path: null,
        },
      },
    );
    const commandService = new BotCommandService(runtime, subscriptions, () => true, preferences, projectResolver);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-remember' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      preferences,
      pending,
      projectResolver,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      focuses,
      null,
      {
        respond: async () => ({
          message: JSON.stringify({
            mode: 'issue_recommendation',
            title: '添加 pre-commit hooks 自动化代码质量检查',
            summary: '添加 black、isort、flake8、mypy 和基础格式 hooks。',
            next_step: 'ask for approval before creating work',
          }),
        }),
      },
    );

    await assistant.respondToText(context, '让你提一个 issue，你会提什么最重要');
    await assistant.respondToText(context, '准了');

    const focus = focuses.findByConversation({
      transport: 'telegram',
      conversation_id: 'chat-remember',
    });
    expect(focus?.issue_id).toBe('issue-163');
    expect(focus?.issue_identifier).toBe('INT-163');

    subscriptions.dispose();
  });

  test('lets Supervisor Claude/orchestrator handle card requests before pending reminders', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const pending = new BotPendingActionRepository(db);
    pending.upsert({
      transport: 'telegram',
      conversation_id: 'chat-card',
      user_id: 'user-1',
      intent_kind: 'create_issue',
      normalized_payload: {
        command: 'new',
        create_issue: {
          title: '恒星质量-光度关系三联可视化图',
          description: 'stale recommendation',
          project_slug: 'test2',
        },
      },
      summary_message: 'Action: create issue\nTitle: 恒星质量-光度关系三联可视化图\nReply with: 确认 / 取消',
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
    });
    const commandService = new BotCommandService(runtime, subscriptions, () => true);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-card' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const supervisorClaudeCalls: string[] = [];
    const supervisorRuntimeCalls: string[] = [];
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      null,
      pending,
      null,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async (request) => {
          supervisorRuntimeCalls.push(request.text);
          throw new Error('legacy supervisor runtime card shortcut should not be reached');
        },
      },
      {
        respond: async (request) => {
          supervisorClaudeCalls.push(request.text);
          return {
            message: 'Issue Card · INT-163',
            media_key: 'issue-card|INT-163',
            issue_id: 'issue-163',
          };
        },
      },
    );

    const response = await assistant.respondToText(context, '卡片发我');

    expect(response.message).toBe('Issue Card · INT-163');
    expect(response.media_key).toBe('issue-card|INT-163');
    expect(supervisorClaudeCalls).toEqual(['卡片发我']);
    expect(supervisorRuntimeCalls).toEqual([]);

    subscriptions.dispose();
  });

  test('does not trust bare Supervisor Claude text for explicit issue card requests', async () => {
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const commandService = new BotCommandService(runtime, subscriptions, () => true);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-explicit-card' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const supervisorRuntimeCalls: string[] = [];
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      null,
      null,
      null,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async (request) => {
          supervisorRuntimeCalls.push(request.text);
          return {
            message: 'Issue Card · INT-163',
            media_key: 'issue-card|INT-163',
            issue_id: 'issue-163',
            action_rows: [
              [
                {
                  label: '打开运行视图',
                  command: '/issue INT-163',
                },
              ],
            ],
          };
        },
      },
      {
        respond: async () => ({
          message: '**INT-163 卡片**\n\n基本信息\n| 字段 | 值 |\n|---|---|\n| Issue | INT-163 |',
        }),
      },
    );

    const response = await assistant.respondToText(context, '给我看 163 卡片');

    expect(response.message).toBe('Issue Card · INT-163');
    expect(response.media_key).toBe('issue-card|INT-163');
    expect(response.action_rows?.[0]?.[0]?.label).toBe('打开运行视图');
    expect(supervisorRuntimeCalls).toEqual(['给我看 163 卡片']);

    subscriptions.dispose();
  });

  test('routes destructive issue cleanup requests to confirmation before Supervisor Claude can disclaim tool access', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const pending = new BotPendingActionRepository(db);
    const commandService = new BotCommandService(runtime, subscriptions, () => true);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-close-issue' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const supervisorClaudeCalls: string[] = [];
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      null,
      pending,
      null,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async (request) => {
          supervisorClaudeCalls.push(request.text);
          return {
            message: '我是只读 brain，无法直接调用 `close_issue` 关闭 INT-164。需要你通过 Linear Web/Desktop 将 INT-164 状态改为 Canceled。',
          };
        },
      },
    );

    const response = await assistant.respondToText(context, '把 164 取消了吧，不做了，顺便清理');

    expect(response.message).toContain('Action: close issue');
    expect(response.message).toContain('Issue: INT-164');
    expect(response.message).toContain('Reply with: 确认 / 取消');
    expect(response.actions?.map((action) => action.label)).toEqual(['确认执行', '取消']);
    expect(supervisorClaudeCalls).toEqual([]);

    const pendingAction = pending.findLatestByConversation({
      transport: 'telegram',
      conversation_id: 'chat-close-issue',
    });
    expect(pendingAction?.intent_kind).toBe('close_issue');
    expect(pendingAction?.normalized_payload).toMatchObject({
      command: 'close_issue',
      issue_id: 'INT-164',
    });

    subscriptions.dispose();
  });

  test('does not trust bare Supervisor Claude text for control actions that require orchestrator tools', async () => {
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const commandService = new BotCommandService(runtime, subscriptions, () => true);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-retry' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const supervisorRuntimeCalls: string[] = [];
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      null,
      null,
      null,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async (request) => {
          supervisorRuntimeCalls.push(request.text);
          return {
            message: 'Retrying INT-163',
            issue_id: 'issue-163',
          };
        },
      },
      {
        respond: async () => ({
          message: '已发起 INT-163 重试请求，等待 orchestrator 响应。',
        }),
      },
    );

    const response = await assistant.respondToText(context, '重试这个 issue 吧');

    expect(response.message).toBe('Retrying INT-163');
    expect(response.issue_id).toBe('issue-163');
    expect(supervisorRuntimeCalls).toEqual(['重试这个 issue 吧']);

    subscriptions.dispose();
  });

  test('does not expose stale read-only brain capability disclaimers from Supervisor Claude', async () => {
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const commandService = new BotCommandService(runtime, subscriptions, () => true);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-capability-denial' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const supervisorRuntimeCalls: string[] = [];
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      null,
      null,
      null,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async (request) => {
          supervisorRuntimeCalls.push(request.text);
          return {
            message: '我是你的 Symphony Runtime Operator Copilot，可以创建新的 issue，查看状态，重试或关闭 issue。',
          };
        },
      },
      {
        respond: async () => ({
          message: [
            '作为只读 Claude Code brain，我能做：',
            '',
            '**不能做**',
            '- 创建/关闭/重试 Linear issue',
            '- 直接触发 orchestrator 动作',
          ].join('\n'),
        }),
      },
    );

    const response = await assistant.respondToText(context, '你能做什么');

    expect(response.message).toContain('Symphony Runtime Operator Copilot');
    expect(response.message).toContain('创建新的 issue');
    expect(response.message).not.toContain('只读 Claude Code brain');
    expect(response.message).not.toContain('不能做');
    expect(supervisorRuntimeCalls).toEqual(['你能做什么']);

    subscriptions.dispose();
  });

  test('does not let a bare Supervisor Claude diagnosis replace a retry review action', async () => {
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const commandService = new BotCommandService(runtime, subscriptions, () => true);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-retry-review' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const supervisorRuntimeCalls: string[] = [];
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      null,
      null,
      null,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async (request) => {
          supervisorRuntimeCalls.push(request.text);
          return {
            message: 'Retrying INT-163',
            issue_id: 'issue-163',
          };
        },
      },
      {
        respond: async () => ({
          message: 'INT-163 Review 停滞原因：缺少 .symphony/REVIEW_REPORT.md。',
        }),
      },
    );

    const response = await assistant.respondToText(context, '重试 review');

    expect(response.message).toBe('Retrying INT-163');
    expect(response.issue_id).toBe('issue-163');
    expect(supervisorRuntimeCalls).toEqual(['重试 review']);

    subscriptions.dispose();
  });

  test('does not trust bare Supervisor Claude text for review/status questions that need runtime evidence', async () => {
    const runtime = createRuntimeControlPlane();
    const subscriptions = new BotSubscriptionService(runtime, {});
    const commandService = new BotCommandService(runtime, subscriptions, () => true);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-review-status' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const supervisorRuntimeCalls: string[] = [];
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      null,
      null,
      null,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async (request) => {
          supervisorRuntimeCalls.push(request.text);
          return {
            message: 'INT-163 · REVIEW · In Review · failed\nReview run failed · Codex process exited with code 0',
            issue_id: 'issue-163',
          };
        },
      },
      {
        respond: async () => ({
          message: 'INT-163 当前处于 IN_REVIEW 阶段，等待 GitHub PR #112 的 CI 检查和 Review 通过。',
        }),
      },
    );

    const response = await assistant.respondToText(context, '可以，现在 review 到哪里了');

    expect(response.message).toContain('Review run failed');
    expect(response.issue_id).toBe('issue-163');
    expect(supervisorRuntimeCalls).toEqual(['可以，现在 review 到哪里了']);

    subscriptions.dispose();
  });

  test('renders Supervisor Claude structured answers as user-facing Telegram text', async () => {
    const runtime = createRuntimeControlPlane();
    const commandService = new BotCommandService(runtime, new BotSubscriptionService(runtime, {}), () => true);
    const context: BotCommandContext = {
      transport: 'telegram',
      recipient: { transport: 'telegram', conversation_id: 'chat-2' },
      identity: { user_id: 'user-1', display_name: 'Alice' },
    };
    const assistant = new BotAssistantService(
      runtime,
      commandService,
      null,
      null,
      null,
      {
        decide: async () => {
          throw new Error('legacy model should not be reached');
        },
      },
      () => true,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      {
        respond: async () => ({
          message: JSON.stringify({
            mode: 'repo_answer',
            answer: '我检查了 runtime 和 repo source，INT-162 是最近完成项。',
          }),
        }),
      },
    );

    const response = await assistant.respondToText(context, '最近完成的 issue 是？');

    expect(response.message).toBe('我检查了 runtime 和 repo source，INT-162 是最近完成项。');
  });
});
