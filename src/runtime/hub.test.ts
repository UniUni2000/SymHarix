import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventEmitter } from 'events';
import { initializeSchema } from '../database/schema';
import {
  AgentRunRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  SyncEventRepository,
  WorkItemRepository,
} from '../database';
import { RuntimeHub } from './hub';
import type { AgentEvent } from '../types';

class FakeController extends EventEmitter {
  createIssue = async () => ({
    accepted: true,
    status: 'accepted' as const,
    message: 'created',
    issue_id: 'issue-2',
    issue_identifier: 'INT-2',
    issue: null,
  });

  stopIssue = async (issueId: string) => ({
    accepted: true,
    status: 'accepted' as const,
    message: `stopping ${issueId}`,
    issue_id: issueId,
    issue_identifier: 'INT-1',
  });

  retryIssue = async (issueId: string) => ({
    accepted: true,
    status: 'queued' as const,
    message: `queued ${issueId}`,
    issue_id: issueId,
    issue_identifier: 'INT-1',
  });

  overrideGovernance = async (issueId: string) => ({
    accepted: true,
    status: 'accepted' as const,
    message: `override approved for ${issueId}`,
    issue_id: issueId,
    issue_identifier: 'INT-1',
  });

  rewriteGovernance = async (issueId: string) => ({
    accepted: true,
    status: 'accepted' as const,
    message: `rewrite applied for ${issueId}`,
    issue_id: issueId,
    issue_identifier: 'INT-1',
  });

  splitGovernance = async (issueId: string) => ({
    accepted: true,
    status: 'accepted' as const,
    message: `split applied for ${issueId}`,
    issue_id: issueId,
    issue_identifier: 'INT-1',
  });

  getStateSnapshot() {
    return {
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: {
        running: 1,
        retrying: 0,
      },
      running: [
        {
          issue_id: 'issue-1',
          issue_identifier: 'INT-1',
          state: 'In Progress',
          stage: 'coding' as const,
          session_id: 'thread-1-turn-1',
          turn_count: 2,
          last_event: 'timeline',
          last_message: 'Using Read',
          started_at: '2026-01-01T00:00:00.000Z',
          last_event_at: '2026-01-01T00:01:00.000Z',
          tokens: {
            input_tokens: 120,
            output_tokens: 30,
            total_tokens: 150,
          },
        },
      ],
      retrying: [],
      codex_totals: {
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 150,
        seconds_running: 12,
      },
      rate_limits: null,
    };
  }
}

describe('RuntimeHub', () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  test('builds runtime views from DB work items and live timeline events', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-1',
      linear_issue_id: 'issue-1',
      linear_identifier: 'INT-1',
      linear_title: 'Runtime hub test',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-1',
      workspace_path: '/tmp/workspaces/INT-1',
      orchestrator_state: 'dev_running',
      repo_harness_status: 'shadow',
      constitution_status: 'missing',
      governance_status: 'blocked',
      governance_decision: 'split_before_implement',
      governance_summary: 'Split this issue before dispatch.',
      change_pack_summary: {
        profile: 'coding',
        complexity: 'small',
        files: ['brief.md', 'tasks.md', 'evidence.json', 'governance.md'],
        overview: 'Small coding issue with lightweight change pack.',
      },
      evidence_summary: {
        total_requirements: 2,
        satisfied: 1,
        missing: 1,
        notes: ['Write .symphony/HANDOVER.md before finishing.'],
      },
      missing_requirements: [
        {
          key: 'handover',
          label: 'Write .symphony/HANDOVER.md',
          reason: 'Completion requires a handover artifact.',
          kind: 'artifact',
        },
      ],
    });

    const controller = new FakeController();
    const hub = new RuntimeHub(db, controller);

    const readEvent: AgentEvent = {
      event: 'timeline',
      timestamp: new Date('2026-01-01T00:01:10.000Z'),
      codex_app_server_pid: null,
      payload: {
        level: 'info',
        category: 'tool',
        code: 'tool_started',
        message: 'Using Read',
        turn: 1,
        tool_name: 'Read',
        detail: {
          path: '/tmp/workspaces/INT-1/app.py',
          summary: '/tmp/workspaces/INT-1/app.py',
        },
      },
    };
    const writeEvent: AgentEvent = {
      event: 'timeline',
      timestamp: new Date('2026-01-01T00:01:12.000Z'),
      codex_app_server_pid: null,
      payload: {
        level: 'info',
        category: 'tool',
        code: 'tool_completed',
        message: 'Write completed',
        turn: 1,
        tool_name: 'Write',
        detail: {
          path: '/tmp/workspaces/INT-1/report.txt',
          summary: '/tmp/workspaces/INT-1/report.txt',
        },
      },
    };

    controller.emit('session:event', 'issue-1', readEvent);
    controller.emit('session:event', 'issue-1', writeEvent);

    const overview = hub.getOverview();
    expect(overview.counts.running).toBe(1);
    expect(overview.issues).toHaveLength(1);
    expect(overview.issues[0]?.session?.recent_tools).toHaveLength(2);
    expect(overview.issues[0]?.session?.recent_files[0]?.path).toBe('/tmp/workspaces/INT-1/app.py');
    expect(overview.issues[0]?.actions.can_stop).toBe(true);
    expect(overview.issues[0]?.actions.can_override_governance).toBe(false);
    expect(overview.issues[0]?.repo_harness_status?.status).toBe('shadow');
    expect(overview.issues[0]?.constitution_status).toBe('missing');
    expect(overview.issues[0]?.missing_requirements).toHaveLength(1);

    const timeline = hub.getTimeline('INT-1');
    expect(timeline).toHaveLength(2);
    expect(timeline[1]?.message).toBe('Write completed');

    hub.dispose();
  });

  test('surfaces governance override as an action for halted issues blocked by governance', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-halted',
      linear_issue_id: 'issue-halted',
      linear_identifier: 'INT-HALT',
      linear_title: 'Governance blocked issue',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
      governance_status: 'advisory',
      governance_decision: 'split_before_implement',
      governance_summary: 'Split this issue before dispatch.',
    });

    const controller = new FakeController();
    controller.getStateSnapshot = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: {
        running: 0,
        retrying: 0,
      },
      running: [],
      retrying: [],
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0,
      },
      rate_limits: null,
    });

    const hub = new RuntimeHub(db, controller);
    const issue = hub.getIssue('INT-HALT');

    expect(issue?.actions.can_stop).toBe(false);
    expect(issue?.actions.can_retry).toBe(true);
    expect(issue?.actions.can_override_governance).toBe(true);
    expect(issue?.actions.can_rewrite_governance).toBe(false);
    expect(issue?.actions.can_split_governance).toBe(true);

    hub.dispose();
  });

  test('surfaces governance rewrite as an action for halted issues waiting on rewrite', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-rewrite',
      linear_issue_id: 'issue-rewrite',
      linear_identifier: 'INT-REWRITE',
      linear_title: '优化一下 runtime',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
      governance_status: 'advisory',
      governance_decision: 'accept_with_rewrite',
      governance_summary: 'Rewrite this issue into one concrete repository task.',
    });

    const controller = new FakeController();
    controller.getStateSnapshot = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: {
        running: 0,
        retrying: 0,
      },
      running: [],
      retrying: [],
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0,
      },
      rate_limits: null,
    });

    const hub = new RuntimeHub(db, controller);
    const issue = hub.getIssue('INT-REWRITE');

    expect(issue?.actions.can_override_governance).toBe(true);
    expect(issue?.actions.can_rewrite_governance).toBe(true);
    expect(issue?.actions.can_split_governance).toBe(false);

    hub.dispose();
  });

  test('proxies rewrite and split governance actions through the controller', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-1',
      linear_issue_id: 'issue-1',
      linear_identifier: 'INT-1',
      linear_title: 'Governance action proxy',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
      governance_status: 'advisory',
      governance_decision: 'split_before_implement',
      governance_summary: 'Split this issue before dispatch.',
    });

    const hub = new RuntimeHub(db, new FakeController());

    await expect(hub.rewriteGovernance('INT-1')).resolves.toMatchObject({
      accepted: true,
      message: 'rewrite applied for issue-1',
    });
    await expect(hub.splitGovernance('INT-1')).resolves.toMatchObject({
      accepted: true,
      message: 'split applied for issue-1',
    });

    hub.dispose();
  });

  test('builds summary and replay history from agent runs and review events', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    const agentRunRepository = new AgentRunRepository(db);
    const governanceAssessmentRepository = new GovernanceAssessmentRepository(db);
    const governanceSuggestionRepository = new GovernanceSuggestionRepository(db);
    const reviewEventRepository = new ReviewEventRepository(db);
    const syncEventRepository = new SyncEventRepository(db);

    workItemRepository.create({
      id: 'issue-2',
      linear_issue_id: 'issue-2',
      linear_identifier: 'INT-2',
      linear_title: 'History replay test',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-2',
      workspace_path: '/tmp/workspaces/INT-2',
      orchestrator_state: 'review_running',
      last_review_summary: 'Need one more verification pass.',
    });
    agentRunRepository.create({
      id: 'run-1',
      work_item_id: 'issue-2',
      agent_type: 'dev',
      phase: 'dev',
      run_status: 'completed',
      input_summary: 'Issue context',
      output_summary: 'Implemented the export flow.',
      started_at: new Date('2026-01-01T00:00:00.000Z'),
      finished_at: new Date('2026-01-01T00:10:00.000Z'),
    });
    reviewEventRepository.create({
      id: 'review-1',
      work_item_id: 'issue-2',
      pr_number: 42,
      review_round: 1,
      decision: 'REQUEST_CHANGES',
      summary_md: 'Need one more verification pass.',
    });
    governanceAssessmentRepository.create({
      id: 'gov-1',
      work_item_id: 'issue-2',
      issue_id: 'issue-2',
      decision: 'accept_with_rewrite',
      status: 'advisory',
      summary: 'Rewrite the issue to stay on the repo main path.',
      constitution_hits_json: [
        {
          section: 'Preferred Directions',
          phrase: 'keep runtime API as the single control plane',
        },
      ],
      detail_json: {
        repo_harness_status: 'formal',
        constitution_status: 'present',
      },
    });
    governanceSuggestionRepository.create({
      id: 'gov-suggestion-1',
      work_item_id: 'issue-2',
      issue_id: 'issue-2',
      suggestion_type: 'cleanup',
      title: 'Create a cleanup follow-up',
      summary: 'Repeated review churn suggests a cleanup issue after merge.',
      detail_json: {
        trigger: 'repeated_review_churn',
      },
    });
    syncEventRepository.create({
      id: 'sync-1',
      work_item_id: 'issue-2',
      target_system: 'github',
      action: 'publish_pr_summary',
      payload_json: {
        pr_number: 42,
        body: 'Posted summary',
      },
    });

    const controller = new FakeController();
    const hub = new RuntimeHub(db, controller);

    const historyView = (hub as any).getHistoryView('INT-2', 10);

    expect(historyView.digest.headline).toContain('INT-2');
    expect(historyView.digest.history_blurb).toBeTruthy();
    expect(historyView.entries).toHaveLength(5);
    expect(historyView.entries.some((entry: any) => entry.source === 'sync_event')).toBe(true);
    expect(historyView.entries.some((entry: any) => entry.title.includes('Sync github'))).toBe(true);
    expect(historyView.entries.some((entry: any) => entry.source === 'review')).toBe(true);
    expect(historyView.entries.some((entry: any) => entry.source === 'agent_run')).toBe(true);
    expect(historyView.entries.some((entry: any) => entry.source === 'governance')).toBe(true);
    expect(historyView.entries.some((entry: any) => entry.title.includes('Governance'))).toBe(true);

    hub.dispose();
  });

  test('surfaces route-resolution failures even when no work item was created yet', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const controller = new FakeController();
    const hub = new RuntimeHub(db, controller);
    const issue = {
      id: 'issue-route-miss',
      identifier: 'INT-404',
      title: 'Missing repository route',
      description: null,
      priority: 1,
      state: 'Todo',
      project_slug: 'missing-project',
      project_name: 'Missing Project',
      branch_name: null,
      url: null,
      labels: [],
      blocked_by: [],
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    } as const;

    controller.emit('issue:failed', issue, 'route missing');
    controller.emit('session:event', issue.id, {
      event: 'timeline',
      timestamp: new Date('2026-01-01T00:02:00.000Z'),
      codex_app_server_pid: null,
      payload: {
        level: 'error',
        category: 'diagnostic',
        code: 'missing_repository_route',
        message: 'Cannot route INT-404 because project_slug "missing-project" is not configured in repositories.routing.',
        turn: null,
        tool_name: null,
        detail: {
          project_slug: 'missing-project',
        },
      },
    } satisfies AgentEvent);

    const overview = hub.getOverview();
    expect(overview.issues.some((entry) => entry.identifier === 'INT-404')).toBe(true);

    const runtimeIssue = hub.getIssue('INT-404');
    expect(runtimeIssue?.work_item_id).toBeNull();
    expect(runtimeIssue?.orchestrator_state).toBe('failed');
    expect(runtimeIssue?.github_repo).toBeNull();

    const timeline = hub.getTimeline('issue-route-miss');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.code).toBe('missing_repository_route');

    hub.dispose();
  });

  test('can switch to a reloaded orchestrator controller without keeping stale subscriptions', () => {
    db = new Database(':memory:');
    initializeSchema(db);
    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-1',
      linear_issue_id: 'issue-1',
      linear_identifier: 'INT-1',
      linear_title: 'First controller issue',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-1',
      workspace_path: '/tmp/workspaces/INT-1',
      orchestrator_state: 'dev_running',
    });
    workItemRepository.create({
      id: 'issue-2',
      linear_issue_id: 'issue-2',
      linear_identifier: 'INT-2',
      linear_title: 'Reloaded controller issue',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-2',
      workspace_path: '/tmp/workspaces/INT-2',
      orchestrator_state: 'review_running',
    });

    const firstController = new FakeController();
    const secondController = new FakeController();
    secondController.getStateSnapshot = () => ({
      generated_at: '2026-01-02T00:00:00.000Z',
      counts: {
        running: 1,
        retrying: 0,
      },
      running: [
        {
          issue_id: 'issue-2',
          issue_identifier: 'INT-2',
          state: 'In Review',
          stage: 'coding' as const,
          session_id: 'thread-2-turn-1',
          turn_count: 1,
          last_event: 'timeline',
          last_message: 'Using Write',
          started_at: '2026-01-02T00:00:00.000Z',
          last_event_at: '2026-01-02T00:01:00.000Z',
          tokens: {
            input_tokens: 40,
            output_tokens: 20,
            total_tokens: 60,
          },
        },
      ],
      retrying: [],
      codex_totals: {
        input_tokens: 40,
        output_tokens: 20,
        total_tokens: 60,
        seconds_running: 8,
      },
      rate_limits: null,
    });

    const hub = new RuntimeHub(db, firstController);
    expect(hub.getIssue('issue-1')?.identifier).toBe('INT-1');

    hub.setController(secondController);

    firstController.emit('session:event', 'issue-1', {
      event: 'timeline',
      timestamp: new Date('2026-01-01T00:03:00.000Z'),
      codex_app_server_pid: null,
      payload: {
        level: 'info',
        category: 'tool',
        code: 'tool_started',
        message: 'Using Read',
        turn: 1,
        tool_name: 'Read',
        detail: {
          path: '/tmp/workspaces/INT-1/should-not-appear.py',
        },
      },
    } satisfies AgentEvent);

    secondController.emit('session:event', 'issue-2', {
      event: 'timeline',
      timestamp: new Date('2026-01-02T00:03:00.000Z'),
      codex_app_server_pid: null,
      payload: {
        level: 'info',
        category: 'tool',
        code: 'tool_completed',
        message: 'Write completed',
        turn: 1,
        tool_name: 'Write',
        detail: {
          path: '/tmp/workspaces/INT-2/output.txt',
        },
      },
    } satisfies AgentEvent);

    const overview = hub.getOverview();
    expect(overview.issues.some((issue) => issue.identifier === 'INT-2')).toBe(true);
    expect(hub.getTimeline('issue-1')).toHaveLength(0);
    expect(hub.getTimeline('issue-2')[0]?.message).toBe('Write completed');

    hub.dispose();
  });
});
