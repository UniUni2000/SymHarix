import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSchema } from '../database/schema';
import {
  AgentRunRepository,
  GovernanceAssessmentRepository,
  GovernanceSuggestionRepository,
  ReviewEventRepository,
  ShadowHarnessRepository,
  SupervisorJobRepository,
  SupervisorSessionRepository,
  SyncEventRepository,
  WorkItemRepository,
} from '../database';
import { RuntimeHub } from './hub';
import type { AgentEvent } from '../types';
import type { OrchestratorStateSnapshot } from '../orchestrator';

class FakeController extends EventEmitter {
  snapshot: OrchestratorStateSnapshot = {
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
          uncached_input_tokens: 20,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 80,
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

  closeIssue = async (issueId: string, request: { successor_issue_id?: string | null; reason?: string | null } = {}) => ({
    accepted: true,
    status: 'accepted' as const,
    message: `closed ${issueId}${request.successor_issue_id ? ` -> ${request.successor_issue_id}` : ''}`,
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

  executeGovernanceSuggestion = async (issueId: string, suggestionId: string) => ({
    accepted: true,
    status: 'accepted' as const,
    message: `executed ${suggestionId} for ${issueId}`,
    issue_id: issueId,
    issue_identifier: 'INT-1',
  });

  dismissGovernanceSuggestion = async (issueId: string, suggestionId: string) => ({
    accepted: true,
    status: 'accepted' as const,
    message: `dismissed ${suggestionId} for ${issueId}`,
    issue_id: issueId,
    issue_identifier: 'INT-1',
  });

  getStateSnapshot() {
    return this.snapshot;
  }
}

describe('RuntimeHub', () => {
  let db: Database;
  const tempDirs: string[] = [];

  afterEach(() => {
    db?.close();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('builds runtime views from DB work items and live timeline events', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    const shadowHarnessRepository = new ShadowHarnessRepository(db);
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
      path_families: ['runtime/hub', 'server/routes'],
      boundary_edges: ['runtime<->server'],
      import_edges: ['runtime/hub->server/routes'],
      architectural_target: 'runtime<->server',
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
        successful_commands: ['build'],
        failed_commands: ['lint'],
        observed_artifacts: ['dist/index.html'],
        runtime_checks: [
          {
            hint_key: 'url',
            status: 'satisfied',
            value: 'http://localhost:3000',
          },
        ],
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
    shadowHarnessRepository.upsert({
      repo_key: 'acme/repo',
      source: 'shadow',
      config_json: {
        commands: {
          test: 'bun test',
        },
      },
      inference_details_json: {
        inferred_from: ['package.json', '.symphony/change-pack/evidence.json'],
        learning_confidence: 'medium',
        observed_commands: {
          test: {
            command: 'bun test',
            success_count: 2,
            failure_count: 0,
            last_status: 'satisfied',
          },
        },
        observed_artifacts: {
          'dist/index.html': {
            success_count: 2,
          },
        },
        observed_runtime_hints: {
          url: {
            success_count: 2,
            failure_count: 0,
          },
        },
      },
      successful_runs: 2,
      failed_runs: 0,
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
    expect(overview.issues[0]?.session?.tokens).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      uncached_input_tokens: 20,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 80,
    });
    expect(overview.issues[0]?.usage).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      uncached_input_tokens: 20,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 80,
    });
    expect(overview.issues[0]?.session?.recent_files[0]?.path).toBe('/tmp/workspaces/INT-1/app.py');
    expect(overview.issues[0]?.actions.can_stop).toBe(true);
    expect(overview.issues[0]?.actions.can_override_governance).toBe(false);
    expect(overview.issues[0]?.repo_harness_status?.status).toBe('shadow');
    expect(overview.issues[0]?.repo_harness_status?.learning_confidence).toBe('medium');
    expect(overview.issues[0]?.repo_harness_status?.learned_command_count).toBe(1);
    expect(overview.issues[0]?.repo_harness_status?.learned_artifact_count).toBe(1);
    expect(overview.issues[0]?.repo_harness_status?.learned_runtime_hint_count).toBe(1);
    expect(overview.issues[0]?.constitution_status).toBe('missing');
    expect(overview.issues[0]?.missing_requirements).toHaveLength(1);
    expect(overview.issues[0]?.architectural_target).toBe('runtime<->server');
    expect(overview.issues[0]?.path_families).toEqual(['runtime/hub', 'server/routes']);
    expect(overview.issues[0]?.boundary_edges).toEqual(['runtime<->server']);
    expect(overview.issues[0]?.import_edges).toEqual(['runtime/hub->server/routes']);
    expect(overview.issues[0]?.evidence_summary?.successful_commands).toEqual(['build']);

    const timeline = hub.getTimeline('INT-1');
    expect(timeline).toHaveLength(2);
    expect(timeline[1]?.message).toBe('Write completed');

    hub.dispose();
  });

  test('keeps aggregated issue usage across dev and review sessions after completion', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-usage',
      linear_issue_id: 'issue-usage',
      linear_identifier: 'INT-usage',
      linear_title: 'Usage issue',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-usage',
      workspace_path: '/tmp/workspaces/INT-usage',
      orchestrator_state: 'dev_running',
    });

    const controller = new FakeController();
    controller.snapshot = {
      ...controller.snapshot,
      running: [{
        ...controller.snapshot.running[0]!,
        issue_id: 'issue-usage',
        issue_identifier: 'INT-usage',
        state: 'In Progress',
        session_id: 'shared-native-session',
        tokens: {
          input_tokens: 137365,
          output_tokens: 4998,
          total_tokens: 142363,
          cache_read_input_tokens: 117248,
        },
      }],
    };
    const hub = new RuntimeHub(db, controller);

    expect(hub.getIssue('issue-usage')?.usage).toEqual({
      input_tokens: 137365,
      output_tokens: 4998,
      total_tokens: 142363,
      cache_read_input_tokens: 117248,
    });

    workItemRepository.update({
      id: 'issue-usage',
      linear_state: 'In Review',
      orchestrator_state: 'review_running',
    });
    controller.snapshot = {
      ...controller.snapshot,
      running: [{
        ...controller.snapshot.running[0]!,
        state: 'In Review',
        started_at: '2026-01-01T00:05:00.000Z',
        tokens: {
          input_tokens: 95365,
          output_tokens: 2057,
          total_tokens: 97422,
          cache_read_input_tokens: 75008,
        },
      }],
    };

    expect(hub.getIssue('issue-usage')?.usage).toEqual({
      input_tokens: 232730,
      output_tokens: 7055,
      total_tokens: 239785,
      cache_read_input_tokens: 192256,
    });

    workItemRepository.update({
      id: 'issue-usage',
      linear_state: 'Done',
      orchestrator_state: 'completed',
      delivery_summary: 'Issue is complete.',
    });
    controller.snapshot = {
      ...controller.snapshot,
      counts: {
        running: 0,
        retrying: 0,
      },
      running: [],
    };

    const completedIssue = hub.getIssue('issue-usage');
    expect(completedIssue?.session).toBeNull();
    expect(completedIssue?.usage).toEqual({
      input_tokens: 232730,
      output_tokens: 7055,
      total_tokens: 239785,
      cache_read_input_tokens: 192256,
    });

    hub.dispose();
  });

  test('restores completed issue usage from persisted agent runs when live snapshots are gone', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    const agentRunRepository = new AgentRunRepository(db);
    workItemRepository.create({
      id: 'work-usage-history',
      linear_issue_id: 'issue-usage-history',
      linear_identifier: 'INT-usage-history',
      linear_title: 'Usage history issue',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-usage-history',
      workspace_path: '/tmp/workspaces/INT-usage-history',
      orchestrator_state: 'completed',
      delivery_summary: 'Issue is complete.',
    });
    agentRunRepository.create({
      id: 'run-usage-history-dev',
      work_item_id: 'work-usage-history',
      agent_type: 'dev',
      phase: 'dev',
      run_status: 'completed',
      input_tokens: 362691,
      output_tokens: 1496,
      total_tokens: 364187,
      uncached_input_tokens: 4099,
      cache_read_input_tokens: 358592,
      input_summary: 'dev',
    });

    const hub = new RuntimeHub(db, new FakeController());
    const completedIssue = hub.getIssue('INT-usage-history');

    expect(completedIssue?.session).toBeNull();
    expect(completedIssue?.usage).toEqual({
      input_tokens: 362691,
      output_tokens: 1496,
      total_tokens: 364187,
      uncached_input_tokens: 4099,
      cache_read_input_tokens: 358592,
    });

    hub.dispose();
  });

  test('pushes live issue usage when orchestrator state changes', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-usage-push',
      linear_issue_id: 'issue-usage-push',
      linear_identifier: 'INT-usage-push',
      linear_title: 'Usage push issue',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-usage-push',
      workspace_path: '/tmp/workspaces/INT-usage-push',
      orchestrator_state: 'dev_running',
    });

    const controller = new FakeController();
    controller.snapshot = {
      ...controller.snapshot,
      running: [{
        ...controller.snapshot.running[0]!,
        issue_id: 'issue-usage-push',
        issue_identifier: 'INT-usage-push',
        tokens: {
          input_tokens: 210,
          output_tokens: 40,
          total_tokens: 250,
          cache_read_input_tokens: 120,
        },
      }],
    };
    const hub = new RuntimeHub(db, controller);
    const issueEvents: any[] = [];
    const unsubscribe = hub.subscribe((event) => {
      if (event.type === 'issue') {
        issueEvents.push(event.data);
      }
    });

    controller.snapshot = {
      ...controller.snapshot,
      running: [{
        ...controller.snapshot.running[0]!,
        tokens: {
          input_tokens: 260,
          output_tokens: 50,
          total_tokens: 310,
          cache_read_input_tokens: 160,
        },
      }],
    };
    controller.emit('state:changed', controller.snapshot);

    expect(issueEvents).toContainEqual(expect.objectContaining({
      issue_id: 'issue-usage-push',
      usage: {
        input_tokens: 260,
        output_tokens: 50,
        total_tokens: 310,
        cache_read_input_tokens: 160,
      },
    }));

    unsubscribe();
    hub.dispose();
  });

  test('shows halted for a waiting-on-child root issue when no live session exists', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-root',
      linear_issue_id: 'issue-root',
      linear_identifier: 'INT-ROOT',
      linear_title: 'Root governance issue',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'dev_running',
      governance_status: 'degraded',
      governance_decision: 'accept',
      governance_summary: 'Waiting on child work.',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: null,
      governance_generation: 0,
    });
    workItemRepository.create({
      id: 'issue-child',
      linear_issue_id: 'issue-child',
      linear_identifier: 'INT-CHILD',
      linear_title: 'Child governance issue',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'dev_running',
      governance_status: 'degraded',
      governance_decision: 'accept',
      governance_summary: 'Child is active.',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: 'issue-root',
      governance_generation: 1,
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
    const issue = hub.getIssue('INT-ROOT');

    expect(issue?.governance_thread_state).toBe('waiting_on_child');
    expect(issue?.orchestrator_state).toBe('halted');
    expect(issue?.session).toBeNull();

    hub.dispose();
  });

  test('projects a governance root thread with a single current child and delivery failure semantics', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    const agentRunRepository = new AgentRunRepository(db);

    workItemRepository.create({
      id: 'issue-root',
      linear_issue_id: 'issue-root',
      linear_identifier: 'INT-44',
      linear_title: 'Split runtime and bot work',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
      governance_status: 'degraded',
      governance_decision: 'accept',
      governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: null,
      governance_generation: 0,
    });
    workItemRepository.create({
      id: 'issue-child-1',
      linear_issue_id: 'issue-child-1',
      linear_identifier: 'INT-45',
      linear_title: '[GOVERNANCE FOLLOW-UP for INT-44] Runtime cleanup',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'failed',
      governance_status: 'degraded',
      governance_decision: 'accept',
      governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: 'issue-root',
      governance_generation: 1,
      evidence_summary: {
        total_requirements: 3,
        satisfied: 3,
        missing: 0,
        successful_commands: ['test', 'build'],
        failed_commands: [],
        observed_artifacts: ['dist/index.html'],
        runtime_checks: [],
        notes: [],
      },
      missing_requirements: [],
    });
    workItemRepository.create({
      id: 'issue-child-2',
      linear_issue_id: 'issue-child-2',
      linear_identifier: 'INT-46',
      linear_title: '[GOVERNANCE FOLLOW-UP for INT-44] Bot UX cleanup',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'failed',
      governance_status: 'degraded',
      governance_decision: 'accept',
      governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: 'issue-root',
      governance_generation: 1,
    });
    workItemRepository.create({
      id: 'issue-child-3',
      linear_issue_id: 'issue-child-3',
      linear_identifier: 'INT-47',
      linear_title: '[GOVERNANCE FOLLOW-UP for INT-44] Cleanup sweep',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'failed',
      governance_status: 'degraded',
      governance_decision: 'accept',
      governance_summary: 'No .symphony-constitution.md found yet, so governance is running in degraded mode.',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: 'issue-root',
      governance_generation: 1,
    });

    agentRunRepository.create({
      id: 'run-child-1',
      work_item_id: 'issue-child-1',
      agent_type: 'dev',
      phase: 'DEV',
      run_status: 'failed',
      error: 'Command failed with code 1: [DEV] ERROR: Workspace for feature/int-45 has uncommitted changes but no commits relative to refs/remotes/origin/main; commit and push are required before PR creation',
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
    const rootIssue = hub.getIssue('INT-44');
    const currentChild = hub.getIssue('INT-45');

    expect(rootIssue?.governance_thread_state).toBe('child_failed');
    expect(rootIssue?.governance_current_child).toEqual(expect.objectContaining({
      issue_identifier: 'INT-45',
      queue_state: 'current',
    }));
    expect(rootIssue?.governance_child_queue).toEqual([
      expect.objectContaining({ issue_identifier: 'INT-45', queue_state: 'current' }),
      expect.objectContaining({ issue_identifier: 'INT-46', queue_state: 'queued' }),
      expect.objectContaining({ issue_identifier: 'INT-47', queue_state: 'queued' }),
    ]);
    expect(rootIssue?.next_recommended_action).toBe('先处理治理子任务 INT-45；源单仍暂停，处理完后会自动接力 INT-46、INT-47。');
    expect(rootIssue?.governance_pause_reason).toContain('INT-45');
    expect(rootIssue?.governance_expected_handoff).toContain('INT-46');
    expect(rootIssue?.governance_queued_child_identifiers).toEqual(['INT-46', 'INT-47']);
    expect(currentChild?.delivery_state).toBe('delivery_failed');
    expect(currentChild?.delivery_summary).toContain('Workspace for feature/int-45 has uncommitted changes');
    expect(currentChild?.delivery_summary).toContain('证据已满足');

    hub.dispose();
  });

  test('projects supervisor session state and summary onto runtime issue views', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    const agentRunRepository = new AgentRunRepository(db);
    const reviewEventRepository = new ReviewEventRepository(db);
    const supervisorSessions = new SupervisorSessionRepository(db);

    workItemRepository.create({
      id: 'issue-root',
      linear_issue_id: 'issue-root',
      linear_identifier: 'INT-52',
      linear_title: 'Root issue with supervisor thread',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
      governance_status: 'blocked',
      governance_decision: 'split_before_implement',
      governance_summary: 'Split this issue before dispatch.',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: null,
      governance_generation: 0,
      change_pack_summary: {
        profile: 'coding',
        complexity: 'large',
        files: ['src/runtime/hub.ts'],
        overview: 'Cross-surface runtime and Telegram control work.',
      },
    });
    workItemRepository.create({
      id: 'issue-child',
      linear_issue_id: 'issue-child',
      linear_identifier: 'INT-53',
      linear_title: 'Current child',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      orchestrator_state: 'discovering',
      governance_status: 'degraded',
      governance_decision: 'accept',
      governance_summary: 'Current child is being prepared.',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: 'issue-root',
      governance_generation: 1,
    });

    supervisorSessions.create({
      id: 'session-1',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'acme/repo',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-root',
      current_child_issue_id: 'issue-child',
      last_material_outcome: {
        round_index: 2,
        round_total: 4,
        round_goal: 'Finish current child and prepare review evidence.',
        milestone_kind: 'waiting_on_child',
        milestone_key: 'waiting_on_child|issue-root|issue-child',
        user_summary: 'Current child is running.',
        risk_delta: 'Risk down after the child queue was isolated.',
      },
      plan_card: {
        title: 'Root issue with supervisor thread',
        user_goal: 'Root issue with supervisor thread',
        in_scope: ['拆分 root issue 并顺序执行 child queue'],
        out_of_scope: ['不并发放行多个 child'],
        acceptance: ['当前 child 完成后自动接力下一个 child'],
        known_risks: ['这条线程仍在等待当前 child 推进。'],
        execution_strategy: 'root issue 保持主线程，只放行 current child。',
        needs_user_approval: true,
        repo_ref: 'acme/repo',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进当前 child。',
        },
        alternate_option: {
          label: '改一下计划',
          summary: '先改计划再继续。',
        },
        governance_preview: null,
      },
    });
    agentRunRepository.create({
      id: 'run-dev-1',
      work_item_id: 'issue-root',
      agent_type: 'dev',
      phase: 'DEV',
      run_status: 'completed',
      output_summary: 'Implemented the root control card plumbing.',
      started_at: new Date('2026-01-01T00:00:00.000Z'),
      finished_at: new Date('2026-01-01T00:04:00.000Z'),
    });
    reviewEventRepository.create({
      id: 'review-1',
      work_item_id: 'issue-root',
      pr_number: 42,
      review_round: 1,
      decision: 'REQUEST_CHANGES',
      summary_md: 'Review found one missing milestone summary path.',
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
    const issue = hub.getIssue('INT-52');

    expect(issue?.supervisor_session_state).toBe('executing');
    expect(issue?.supervisor_plan_summary).toContain('当前子任务');
    expect(issue?.supervisor_plan_summary).toContain('INT-53');
    expect(issue?.complexity).toBe('L4');
    expect(issue?.round).toEqual({
      index: 2,
      total: 4,
      goal: 'Finish current child and prepare review evidence.',
    });
    expect(issue?.roundGoal).toBe('Finish current child and prepare review evidence.');
    expect(issue?.riskDelta).toBe('Risk down after the child queue was isolated.');
    expect(issue?.risk_delta).toBe('Risk down after the child queue was isolated.');
    expect(issue?.milestones?.[0]).toMatchObject({
      kind: 'waiting_on_child',
      key: 'waiting_on_child|issue-root|issue-child',
      summary: 'Current child is running.',
    });
    expect(issue?.agent_recent_progress?.dev[0]?.summary).toContain('root control card');
    expect(issue?.agent_recent_progress?.review[0]?.summary).toContain('missing milestone');
    expect(issue?.agentRecentProgress?.dev[0]?.summary).toContain('root control card');
    expect(issue?.agentRecentProgress?.review[0]?.summary).toContain('missing milestone');

    hub.dispose();
  });

  test('localizes split governance recommendations for English runtime issue views', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    const governanceSuggestions = new GovernanceSuggestionRepository(db);

    workItemRepository.create({
      id: 'issue-en-split',
      linear_issue_id: 'issue-en-split',
      linear_identifier: 'TES-126',
      linear_title: 'Build a typing speed test web app using HTML/CSS/JS',
      linear_state: 'Todo',
      github_repo: 'DingfangHu/my-symphony-test',
      orchestrator_state: 'halted',
      governance_status: 'blocked',
      governance_decision: 'split_before_implement',
      governance_summary: 'This issue spans multiple objectives across different parts of the system. Please split it before dispatch.',
      supervisor_locale: 'en',
    });
    governanceSuggestions.create({
      id: 'suggestion-en-split',
      work_item_id: 'issue-en-split',
      issue_id: 'issue-en-split',
      suggestion_type: 'architecture_alignment',
      status: 'pending',
      title: '[GOVERNANCE] Split TES-126 before implementation',
      summary: '先拆出 runtime / control-plane 变更，单独完成接口或调度主链。',
      detail_json: {},
    });

    const controller = new FakeController();
    controller.getStateSnapshot = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0 },
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
    const issue = hub.getIssue('TES-126');

    expect(issue?.next_recommended_action).toBe('Split into more focused tasks as recommended');
    expect(issue?.roundGoal).toBe('Split into more focused tasks as recommended');
    expect(issue?.active_governance_suggestions?.[0]?.summary).toBe(
      'First split out the runtime/control-plane change, then complete the interface or dispatch path separately.',
    );
    expect(JSON.stringify(issue)).not.toContain('按推荐拆成更聚焦的任务');
    expect(JSON.stringify(issue)).not.toContain('先拆出 runtime / control-plane 变更');

    hub.dispose();
  });

  test('localizes existing split child titles for English runtime issue views', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-root-title',
      linear_issue_id: 'issue-root-title',
      linear_identifier: 'TES-126',
      linear_title: '拆出 runtime / control-plane 变更',
      linear_state: 'In Progress',
      github_repo: 'DingfangHu/my-symphony-test',
      orchestrator_state: 'halted',
      governance_status: 'blocked',
      governance_decision: 'split_before_implement',
      governance_summary: 'No constitution blockers detected.',
      governance_root_issue_id: 'issue-root-title',
      governance_parent_issue_id: null,
      governance_generation: 0,
      supervisor_locale: 'en',
    });
    workItemRepository.create({
      id: 'issue-child-title',
      linear_issue_id: 'issue-child-title',
      linear_identifier: 'TES-127',
      linear_title: '[GOVERNANCE FOLLOW-UP for TES-126] 网页或 UI 改动拆成单独 issue',
      linear_state: 'Todo',
      github_repo: 'DingfangHu/my-symphony-test',
      orchestrator_state: 'halted',
      governance_status: 'advisory',
      governance_decision: 'accept',
      governance_summary: 'No constitution blockers detected.',
      governance_root_issue_id: 'issue-root-title',
      governance_parent_issue_id: 'issue-root-title',
      governance_generation: 1,
      supervisor_locale: 'en',
    });

    const controller = new FakeController();
    controller.getStateSnapshot = () => ({
      generated_at: '2026-01-01T00:00:00.000Z',
      counts: { running: 0, retrying: 0 },
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
    const issue = hub.getIssue('TES-126');

    expect(issue?.title).toBe('Split out runtime/control-plane change');
    expect(issue?.governance_current_child?.title).toBe('[GOVERNANCE FOLLOW-UP for TES-126] Split web/UI changes into their own issue');
    expect(issue?.next_recommended_action).toBe('Handle governance child task TES-127 first.');
    expect(JSON.stringify(issue)).not.toContain('网页或 UI 改动');
    expect(JSON.stringify(issue)).not.toContain('先处理治理子任务');

    hub.dispose();
  });

  test('summarizes queued child handoff in root-thread recommendations and supervisor summary', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    const supervisorSessions = new SupervisorSessionRepository(db);

    workItemRepository.create({
      id: 'issue-root-q',
      linear_issue_id: 'issue-root-q',
      linear_identifier: 'INT-70',
      linear_title: 'Queued root issue',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
      governance_root_issue_id: 'issue-root-q',
      governance_generation: 0,
    });
    workItemRepository.create({
      id: 'issue-child-q1',
      linear_issue_id: 'issue-child-q1',
      linear_identifier: 'INT-71',
      linear_title: 'First child',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'dev_running',
      governance_root_issue_id: 'issue-root-q',
      governance_parent_issue_id: 'issue-root-q',
      governance_generation: 1,
    });
    workItemRepository.create({
      id: 'issue-child-q2',
      linear_issue_id: 'issue-child-q2',
      linear_identifier: 'INT-72',
      linear_title: 'Second child',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
      governance_root_issue_id: 'issue-root-q',
      governance_parent_issue_id: 'issue-root-q',
      governance_generation: 1,
    });

    supervisorSessions.create({
      id: 'session-q',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'acme/repo',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 1,
      root_issue_id: 'issue-root-q',
      current_child_issue_id: 'issue-child-q1',
      plan_card: {
        title: 'Queued root issue',
        user_goal: 'Queued root issue',
        in_scope: ['顺序推进 child queue'],
        out_of_scope: ['不并发推进多个 child'],
        acceptance: ['INT-71 完成后自动接力 INT-72'],
        known_risks: [],
        execution_strategy: 'root 保持主线程，只放行 current child。',
        needs_user_approval: true,
        repo_ref: 'acme/repo',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进当前 child。',
        },
        alternate_option: null,
        governance_preview: null,
      },
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
    const issue = hub.getIssue('INT-70');

    expect(issue?.governance_thread_state).toBe('waiting_on_child');
    expect(issue?.next_recommended_action).toContain('INT-71');
    expect(issue?.next_recommended_action).toContain('INT-72');
    expect(issue?.governance_pause_reason).toContain('INT-71');
    expect(issue?.governance_expected_handoff).toContain('INT-72');
    expect(issue?.governance_queued_child_identifiers).toEqual(['INT-72']);
    expect(issue?.supervisor_plan_summary).toContain('INT-71');
    expect(issue?.supervisor_plan_summary).toContain('INT-72');
    expect(issue?.supervisor_plan_summary).toContain('自动接力');

    hub.dispose();
  });

  test('keeps a root thread waiting when every child completes before the root is finalized', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);

    workItemRepository.create({
      id: 'issue-root-complete',
      linear_issue_id: 'issue-root-complete',
      linear_identifier: 'INT-80',
      linear_title: 'Completed root queue',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
      governance_root_issue_id: 'issue-root-complete',
      governance_generation: 0,
    });
    workItemRepository.create({
      id: 'issue-child-complete-1',
      linear_issue_id: 'issue-child-complete-1',
      linear_identifier: 'INT-81',
      linear_title: 'First completed child',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      orchestrator_state: 'completed',
      governance_root_issue_id: 'issue-root-complete',
      governance_parent_issue_id: 'issue-root-complete',
      governance_generation: 1,
      delivery_state: 'completed',
    });
    workItemRepository.create({
      id: 'issue-child-complete-2',
      linear_issue_id: 'issue-child-complete-2',
      linear_identifier: 'INT-82',
      linear_title: 'Second completed child',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      orchestrator_state: 'completed',
      governance_root_issue_id: 'issue-root-complete',
      governance_parent_issue_id: 'issue-root-complete',
      governance_generation: 1,
      delivery_state: 'completed',
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
    const issue = hub.getIssue('INT-80');

    expect(issue?.governance_thread_state).toBe('waiting_on_child');
    expect(issue?.governance_current_child).toBeNull();
    expect(issue?.next_recommended_action).toContain('所有顺序子任务已完成');
    expect(issue?.next_recommended_action).toContain('root 线程收尾');
    expect(issue?.governance_pause_reason).toContain('等待 root 线程收尾');
    expect(issue?.governance_child_queue).toEqual([
      expect.objectContaining({ issue_identifier: 'INT-81', queue_state: 'completed' }),
      expect.objectContaining({ issue_identifier: 'INT-82', queue_state: 'completed' }),
    ]);

    hub.dispose();
  });

  test('projects a root thread as resolved only after the root delivery is finalized', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);

    workItemRepository.create({
      id: 'issue-root-complete',
      linear_issue_id: 'issue-root-complete',
      linear_identifier: 'INT-80',
      linear_title: 'Completed root queue',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      orchestrator_state: 'completed',
      delivery_state: 'completed',
      governance_root_issue_id: 'issue-root-complete',
      governance_generation: 0,
    });
    workItemRepository.create({
      id: 'issue-child-complete-1',
      linear_issue_id: 'issue-child-complete-1',
      linear_identifier: 'INT-81',
      linear_title: 'First completed child',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      orchestrator_state: 'completed',
      governance_root_issue_id: 'issue-root-complete',
      governance_parent_issue_id: 'issue-root-complete',
      governance_generation: 1,
      delivery_state: 'completed',
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
    const issue = hub.getIssue('INT-80');

    expect(issue?.governance_thread_state).toBe('resolved');
    expect(issue?.governance_current_child).toBeNull();
    expect(issue?.next_recommended_action).toBe('所有顺序子任务已完成，计划线程已完成。');
    expect(issue?.governance_pause_reason).toBeNull();

    hub.dispose();
  });

  test('preserves manual close delivery metadata for cancelled terminal issues', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-cancelled',
      linear_issue_id: 'issue-cancelled',
      linear_identifier: 'INT-90',
      linear_title: 'Cancelled cleanup smoke',
      linear_state: 'Canceled',
      github_repo: 'acme/repo',
      orchestrator_state: 'cancelled',
      delivery_code: 'manual_close',
      delivery_summary: '这张单已按用户要求关闭，不会继续自动推进。',
      cancelled_at: new Date('2026-05-08T13:16:50.000Z'),
    });

    const hub = new RuntimeHub(db, new FakeController());
    const issue = hub.getIssue('INT-90');

    expect(issue?.tracker_state).toBe('Canceled');
    expect(issue?.orchestrator_state).toBe('cancelled');
    expect(issue?.delivery_state).toBe('completed');
    expect(issue?.delivery_code).toBe('manual_close');
    expect(issue?.delivery_summary).toContain('按用户要求关闭');

    hub.dispose();
  });

  test('describes child delivery failures as a paused root thread that needs user attention', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-root',
      linear_issue_id: 'issue-root',
      linear_identifier: 'INT-52',
      linear_title: 'Root issue with supervisor thread',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
      governance_root_issue_id: 'issue-root',
      supervisor_root_session_id: 'session-root',
    });
    workItemRepository.create({
      id: 'issue-child',
      linear_issue_id: 'issue-child',
      linear_identifier: 'INT-53',
      linear_title: 'Current child',
      linear_state: 'In Review',
      github_repo: 'acme/repo',
      orchestrator_state: 'failed',
      governance_root_issue_id: 'issue-root',
      governance_parent_issue_id: 'issue-root',
      governance_generation: 1,
      delivery_code: 'review_submit_failed',
      delivery_summary: 'INT-53 代码和证据基本齐了，但卡在 review 提交。',
    });

    const sessionRepository = new SupervisorSessionRepository(db);
    sessionRepository.create({
      id: 'session-root',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'awaiting_user_decision',
      repo_ref: 'acme/repo',
      intake_mode: 'plan_then_approve',
      approval_mode: 'explicit_user_approval',
      plan_version: 2,
      root_issue_id: 'issue-root',
      current_child_issue_id: 'issue-child',
      delivery_state: 'delivery_failed',
      delivery_summary: 'INT-53 代码和证据基本齐了，但卡在 review 提交。',
      active_decision_kind: 'execution_decision',
      last_material_outcome: {
        latest_dev_directive_kind: 'pause_for_user',
        latest_dev_instruction: '不要继续重试，先让用户确认 review 提交恢复策略。',
      },
      plan_card: {
        title: 'Root issue with supervisor thread',
        user_goal: 'Root issue with supervisor thread',
        in_scope: ['拆分 root issue 并顺序执行 child queue'],
        out_of_scope: ['不并发放行多个 child'],
        acceptance: ['当前 child 完成后自动接力下一个 child'],
        known_risks: ['当前 child 卡在最终交付。'],
        execution_strategy: 'root issue 保持主线程，只放行 current child。',
        needs_user_approval: true,
        repo_ref: 'acme/repo',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_with_split_queue',
        recommended_option: {
          label: '按推荐继续',
          summary: '继续推进当前 child。',
        },
        alternate_option: null,
        governance_preview: null,
      },
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
    const issue = hub.getIssue('INT-52');

    expect(issue?.supervisor_session_state).toBe('awaiting_user_decision');
    expect(issue?.supervisor_plan_summary).toContain('源单仍暂停');
    expect(issue?.supervisor_plan_summary).toContain('INT-53');
    expect(issue?.supervisor_plan_summary).toContain('review 提交');
    expect(issue?.active_decision_kind).toBe('execution_decision');
    expect(issue?.latest_supervisor_directive).toContain('不要继续重试');
    expect(issue?.supervisor_job_state).toBe('awaiting_user_decision');

    hub.dispose();
  });

  test('projects halted merge conflicts as delivery failures for the Mini App', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-merge-blocked',
      linear_issue_id: 'issue-merge-blocked',
      linear_identifier: 'VAR-48',
      linear_title: '新增 furry fighting games 文档',
      linear_state: 'In Review',
      github_repo: 'varisnow-jeff/vj-sym',
      orchestrator_state: 'halted',
      delivery_code: 'merge_blocked',
      delivery_summary: 'Merge blocked: PR #64 has conflicts in furry_fighting_games.md.',
      active_pr_number: 64,
      branch_name: 'feature/var-48',
    });

    const hub = new RuntimeHub(db, new FakeController());
    const issue = hub.getIssue('VAR-48');

    expect(issue?.delivery_state).toBe('delivery_failed');
    expect(issue?.delivery_code).toBe('merge_blocked');
    expect(issue?.delivery_summary).toContain('PR #64');
    expect(issue?.orchestrator_state).toBe('halted');

    hub.dispose();
  });

  test('falls back to persisted supervisor execution intent when no supervisor session row exists', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-supervisor-fallback',
      linear_issue_id: 'issue-supervisor-fallback',
      linear_identifier: 'INT-SUP',
      linear_title: 'Supervisor-backed issue',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      orchestrator_state: 'discovering',
      supervisor_root_session_id: 'session-fallback',
      supervisor_plan_summary: '先收口 root thread，再让 child queue 顺序接力。',
      supervisor_acceptance_summary: '用户只看到一条清晰的根治理线程。',
      supervisor_execution_mode: 'root_with_split_queue',
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
    const issue = hub.getIssue('INT-SUP');

    expect(issue?.supervisor_session_state).toBe('materialized');
    expect(issue?.supervisor_plan_summary).toContain('先收口 root thread');
    expect(issue?.supervisor_plan_summary).toContain('用户只看到一条清晰的根治理线程');

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

  test('proxies governance suggestion execute and dismiss actions through the controller', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    const governanceSuggestionRepository = new GovernanceSuggestionRepository(db);
    workItemRepository.create({
      id: 'issue-1',
      linear_issue_id: 'issue-1',
      linear_identifier: 'INT-1',
      linear_title: 'Governance action proxy',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      orchestrator_state: 'completed',
    });
    governanceSuggestionRepository.create({
      id: 'suggestion-1',
      work_item_id: 'issue-1',
      issue_id: 'issue-1',
      suggestion_type: 'cleanup',
      title: '[GOVERNANCE] Clean runtime duplication',
      summary: 'Create a cleanup follow-up.',
    });

    const hub = new RuntimeHub(db, new FakeController());

    await expect((hub as any).executeGovernanceSuggestion('INT-1', 'suggestion-1')).resolves.toMatchObject({
      accepted: true,
      message: 'executed suggestion-1 for issue-1',
    });
    await expect((hub as any).dismissGovernanceSuggestion('INT-1', 'suggestion-1')).resolves.toMatchObject({
      accepted: true,
      message: 'dismissed suggestion-1 for issue-1',
    });

    hub.dispose();
  });

  test('falls back to rejected governance suggestion actions when controller handlers are unavailable', async () => {
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
    });

    const controller = new FakeController();
    Object.assign(controller, {
      executeGovernanceSuggestion: undefined,
      dismissGovernanceSuggestion: undefined,
    });
    const hub = new RuntimeHub(db, controller);

    await expect((hub as any).executeGovernanceSuggestion('INT-1', 'suggestion-1')).resolves.toMatchObject({
      accepted: false,
      status: 'rejected',
      message: 'Governance suggestion execution is not available',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    });
    await expect((hub as any).dismissGovernanceSuggestion('INT-1', 'suggestion-1')).resolves.toMatchObject({
      accepted: false,
      status: 'rejected',
      message: 'Governance suggestion dismissal is not available',
      issue_id: 'issue-1',
      issue_identifier: 'INT-1',
    });

    hub.dispose();
  });

  test('translates successor identifiers when closing an issue and publishes the successor view', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-1',
      linear_issue_id: 'issue-1',
      linear_identifier: 'INT-1',
      linear_title: 'Close the current issue',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'dev_running',
    });
    workItemRepository.create({
      id: 'issue-2',
      linear_issue_id: 'issue-2',
      linear_identifier: 'INT-2',
      linear_title: 'Follow-up issue',
      linear_state: 'Todo',
      github_repo: 'acme/repo',
      orchestrator_state: 'halted',
    });

    const controller = new FakeController();
    let receivedRequest: { successor_issue_id?: string | null; reason?: string | null } | null = null;
    controller.closeIssue = async (issueId: string, request = {}) => {
      receivedRequest = request;
      return {
        accepted: true,
        status: 'accepted',
        message: `closed ${issueId}`,
        issue_id: issueId,
        issue_identifier: 'INT-1',
      };
    };

    const hub = new RuntimeHub(db, controller);
    const events: Array<{ type: string; identifier?: string | null }> = [];
    const unsubscribe = hub.subscribe((event) => {
      events.push({
        type: event.type,
        identifier: event.type === 'issue' ? event.data.identifier : undefined,
      });
    });

    await expect(hub.closeIssue('INT-1', {
      successor_issue_id: 'INT-2',
      reason: 'Follow-up in a new issue',
    })).resolves.toMatchObject({
      accepted: true,
      issue_id: 'issue-1',
    });

    expect(receivedRequest).toEqual({
      successor_issue_id: 'issue-2',
      reason: 'Follow-up in a new issue',
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'issue', identifier: 'INT-1' }),
      expect.objectContaining({ type: 'issue', identifier: 'INT-2' }),
    ]));

    unsubscribe();
    hub.dispose();
  });

  test('adds and removes runtime subscribers through direct subscriptions and stream readers', async () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const hub = new RuntimeHub(db, new FakeController());
    const receivedTypes: string[] = [];
    const unsubscribe = hub.subscribe((event) => {
      receivedTypes.push(event.type);
    });

    expect((hub as any).subscribers.size).toBe(1);

    const controller = new FakeController();
    hub.setController(controller);
    controller.emit('state:changed');

    expect(receivedTypes).toContain('overview');

    unsubscribe();
    expect((hub as any).subscribers.size).toBe(0);

    const stream = hub.createStream();
    const reader = stream.getReader();
    const first = await reader.read();
    const payload = new TextDecoder().decode(first.value);

    expect(payload).toContain('event: snapshot');
    expect((hub as any).subscribers.size).toBe(1);

    await reader.cancel();
    expect((hub as any).subscribers.size).toBe(0);

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

  test('attaches full workspace file diffs to history views when a git worktree is available', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const repoDir = mkdtempSync(join(tmpdir(), 'runtime-hub-diff-'));
    tempDirs.push(repoDir);
    mkdirSync(join(repoDir, 'src', 'runtime'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'runtime', 'miniAppPage.ts'), [
      'const ring = renderProgressRing(progress);',
      'const heroWidth = 176;',
      'renderOverviewSignal(issue);',
      '',
    ].join('\n'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'feature/int-2'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'src', 'runtime', 'miniAppPage.ts'), [
      'const rail = renderProgressRail(progress, phase);',
      'const heroWidth = 148;',
      'renderOverviewSignal(issue);',
      'openDiffDrawer(index);',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'feature diff'], { cwd: repoDir, stdio: 'pipe' });

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-diff',
      linear_issue_id: 'issue-diff',
      linear_identifier: 'INT-DIFF',
      linear_title: 'Diff attachment test',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-2',
      workspace_path: repoDir,
      orchestrator_state: 'dev_running',
    });

    const controller = new FakeController();
    const hub = new RuntimeHub(db, controller);

    const historyView = (hub as any).getHistoryView('INT-DIFF', 5);

    expect(Array.isArray(historyView.file_diffs)).toBe(true);
    expect(historyView.file_diffs[0]?.path).toBe('src/runtime/miniAppPage.ts');
    expect(historyView.file_diffs[0]?.patch).toContain('diff --git');
    expect(historyView.file_diffs[0]?.patch).toContain('+const rail = renderProgressRail(progress, phase);');
    expect(historyView.file_diffs[0]?.patch).toContain('-const ring = renderProgressRing(progress);');
    expect(historyView.file_diffs[0]?.additions).toBeGreaterThan(0);
    expect(historyView.file_diffs[0]?.deletions).toBeGreaterThan(0);

    hub.dispose();
  });

  test('keeps workspace file diffs after the feature branch is merged into the base branch', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const repoDir = mkdtempSync(join(tmpdir(), 'runtime-hub-merged-diff-'));
    tempDirs.push(repoDir);
    mkdirSync(join(repoDir, 'src', 'runtime'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'runtime', 'miniAppPage.ts'), [
      'const ring = renderProgressRing(progress);',
      'renderOverviewSignal(issue);',
      '',
    ].join('\n'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'feature/int-merged'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'src', 'runtime', 'miniAppPage.ts'), [
      'const rail = renderProgressRail(progress, phase);',
      'renderOverviewSignal(issue);',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'feature diff'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', 'main'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'README.md'), 'main-only change\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'main changed after branch'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['merge', '--no-ff', 'feature/int-merged', '-m', 'merge feature'], {
      cwd: repoDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['checkout', 'feature/int-merged'], { cwd: repoDir, stdio: 'pipe' });

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-merged-diff',
      linear_issue_id: 'issue-merged-diff',
      linear_identifier: 'INT-MERGED',
      linear_title: 'Merged diff attachment test',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-merged',
      workspace_path: repoDir,
      orchestrator_state: 'completed',
    });

    const controller = new FakeController();
    const hub = new RuntimeHub(db, controller);

    const historyView = (hub as any).getHistoryView('INT-MERGED', 5);

    expect(historyView.file_diffs.map((item: any) => item.path)).toEqual(['src/runtime/miniAppPage.ts']);
    expect(historyView.file_diffs[0]?.patch).toContain('+const rail = renderProgressRail(progress, phase);');
    expect(historyView.file_diffs[0]?.patch).toContain('-const ring = renderProgressRing(progress);');
    expect(historyView.file_diffs[0]?.patch).not.toContain('README.md');

    hub.dispose();
  });

  test('recovers file diffs from the shared source repo when a completed worktree was cleaned', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'runtime-hub-source-diff-'));
    tempDirs.push(workspaceRoot);
    const sourceDir = join(workspaceRoot, 'acme__repo', 'source');
    mkdirSync(join(sourceDir, 'src', 'runtime'), { recursive: true });
    writeFileSync(join(sourceDir, 'src', 'runtime', 'miniAppPage.ts'), [
      'const ring = renderProgressRing(progress);',
      'renderOverviewSignal(issue);',
      '',
    ].join('\n'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'feature/int-cleaned'], { cwd: sourceDir, stdio: 'pipe' });
    writeFileSync(join(sourceDir, 'src', 'runtime', 'miniAppPage.ts'), [
      'const rail = renderProgressRail(progress, phase);',
      'renderOverviewSignal(issue);',
      'openDiffDrawer(index);',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'feature diff'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', 'main'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['merge', '--squash', 'feature/int-cleaned'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'feat(INT-CLEANED): mini app diff (#112)'], {
      cwd: sourceDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['branch', '-D', 'feature/int-cleaned'], { cwd: sourceDir, stdio: 'pipe' });

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-cleaned-diff',
      linear_issue_id: 'issue-cleaned-diff',
      linear_identifier: 'INT-CLEANED',
      linear_title: 'Cleaned worktree diff attachment test',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      active_pr_number: 112,
      branch_name: 'feature/int-cleaned',
      workspace_path: join(workspaceRoot, 'acme__repo', 'worktrees', 'INT-CLEANED'),
      orchestrator_state: 'completed',
    });

    const controller = new FakeController();
    const hub = new RuntimeHub(db, controller, { workspaceRoot });

    const historyView = (hub as any).getHistoryView('INT-CLEANED', 5);

    expect(historyView.file_diffs.map((item: any) => item.path)).toEqual(['src/runtime/miniAppPage.ts']);
    expect(historyView.file_diffs[0]?.patch).toContain('+const rail = renderProgressRail(progress, phase);');
    expect(historyView.file_diffs[0]?.patch).toContain('-const ring = renderProgressRing(progress);');
    expect(historyView.file_diffs[0]?.additions).toBeGreaterThan(0);
    expect(historyView.file_diffs[0]?.deletions).toBeGreaterThan(0);

    hub.dispose();
  });

  test('recovers file diffs from a fetched PR head when the worktree and branch were cleaned', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'runtime-hub-pr-head-diff-'));
    tempDirs.push(workspaceRoot);
    const remoteDir = join(workspaceRoot, 'remote.git');
    const sourceDir = join(workspaceRoot, 'acme__repo', 'source');
    mkdirSync(join(sourceDir, 'src'), { recursive: true });
    execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'pipe' });
    writeFileSync(join(sourceDir, 'src', 'calculator.py'), [
      'def value():',
      '    return 1',
      '',
    ].join('\n'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'feature/int-pr-ref'], { cwd: sourceDir, stdio: 'pipe' });
    writeFileSync(join(sourceDir, 'src', 'calculator.py'), [
      '__all__ = ["value"]',
      '',
      'def value():',
      '    return 2',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'feat(INT-PR): update calculator'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'HEAD:refs/pull/121/head'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', 'main'], { cwd: sourceDir, stdio: 'pipe' });
    execFileSync('git', ['branch', '-D', 'feature/int-pr-ref'], { cwd: sourceDir, stdio: 'pipe' });

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-pr-head-diff',
      linear_issue_id: 'issue-pr-head-diff',
      linear_identifier: 'INT-PR-HEAD',
      linear_title: 'Cleaned PR head diff attachment test',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      active_pr_number: 121,
      branch_name: 'feature/int-pr-ref',
      workspace_path: join(workspaceRoot, 'acme__repo', 'worktrees', 'INT-PR-HEAD'),
      orchestrator_state: 'completed',
    });

    const controller = new FakeController();
    const hub = new RuntimeHub(db, controller, { workspaceRoot });

    const historyView = (hub as any).getHistoryView('INT-PR-HEAD', 5);

    expect(historyView.file_diffs.map((item: any) => item.path)).toEqual(['src/calculator.py']);
    expect(historyView.file_diffs[0]?.patch).toContain('+__all__ = ["value"]');
    expect(historyView.file_diffs[0]?.patch).toContain('return 2');
    expect(historyView.file_diffs[0]?.additions).toBeGreaterThan(0);
    expect(historyView.file_diffs[0]?.deletions).toBeGreaterThan(0);
    expect(execFileSync('git', ['rev-parse', '--verify', 'refs/remotes/origin/pr/121'], {
      cwd: sourceDir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()).toMatch(/^[0-9a-f]{40}$/);

    hub.dispose();
  });

  test('includes untracked workspace files in history diffs', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const repoDir = mkdtempSync(join(tmpdir(), 'runtime-hub-untracked-diff-'));
    tempDirs.push(repoDir);
    writeFileSync(join(repoDir, 'README.md'), 'base\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'feature/int-untracked'], { cwd: repoDir, stdio: 'pipe' });
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'new-file.ts'), [
      'export const answer = 42;',
      'export const label = "runtime";',
      '',
    ].join('\n'));

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-untracked-diff',
      linear_issue_id: 'issue-untracked-diff',
      linear_identifier: 'INT-UNTRACKED',
      linear_title: 'Untracked diff attachment test',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      branch_name: 'feature/int-untracked',
      workspace_path: repoDir,
      orchestrator_state: 'dev_running',
    });

    const controller = new FakeController();
    const hub = new RuntimeHub(db, controller);

    const historyView = (hub as any).getHistoryView('INT-UNTRACKED', 5);

    expect(historyView.file_diffs[0]?.path).toBe('src/new-file.ts');
    expect(historyView.file_diffs[0]?.additions).toBe(2);
    expect(historyView.file_diffs[0]?.deletions).toBe(0);
    expect(historyView.file_diffs[0]?.patch).toContain('new file mode');
    expect(historyView.file_diffs[0]?.patch).toContain('+export const answer = 42;');

    hub.dispose();
  });

  test('surfaces governance suggestion action states on issue detail', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    const governanceSuggestionRepository = new GovernanceSuggestionRepository(db);

    workItemRepository.create({
      id: 'issue-suggestion',
      linear_issue_id: 'issue-suggestion',
      linear_identifier: 'INT-SUGGEST',
      linear_title: 'Governance suggestion state',
      linear_state: 'Done',
      github_repo: 'acme/repo',
      orchestrator_state: 'completed',
    });

    governanceSuggestionRepository.create({
      id: 'suggestion-exec',
      work_item_id: 'issue-suggestion',
      issue_id: 'issue-suggestion',
      suggestion_type: 'cleanup',
      title: '[GOVERNANCE] Clean runtime duplication',
      summary: 'Repeated review churn suggests a cleanup follow-up.',
      detail_json: {
        target_area: 'runtime',
      },
    });

    const hub = new RuntimeHub(db, new FakeController());
    const issue = hub.getIssue('INT-SUGGEST');
    const suggestion = issue?.active_governance_suggestions?.[0];

    expect(suggestion?.suggestion_type).toBe('cleanup');
    expect(suggestion?.can_execute).toBe(true);
    expect(suggestion?.can_dismiss).toBe(true);

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

  test('projects the latest durable supervisor job status onto runtime issue views', () => {
    db = new Database(':memory:');
    initializeSchema(db);

    const workItemRepository = new WorkItemRepository(db);
    workItemRepository.create({
      id: 'issue-root',
      linear_issue_id: 'issue-root',
      linear_identifier: 'INT-JOB',
      linear_title: 'Issue with supervisor job',
      linear_state: 'In Progress',
      github_repo: 'acme/repo',
      orchestrator_state: 'dev_running',
      governance_root_issue_id: 'issue-root',
      supervisor_root_session_id: 'session-job',
    });

    const sessionRepository = new SupervisorSessionRepository(db);
    sessionRepository.create({
      id: 'session-job',
      transport: 'telegram',
      conversation_id: 'chat-1',
      user_id: 'user-1',
      state: 'executing',
      repo_ref: 'acme/repo',
      root_issue_id: 'issue-root',
      plan_card: {
        title: 'Issue with supervisor job',
        user_goal: 'Observe durable jobs',
        in_scope: ['推进当前 issue'],
        out_of_scope: ['不扩大范围'],
        acceptance: ['job state visible'],
        known_risks: [],
        execution_strategy: 'supervisor watches dev loop',
        needs_user_approval: false,
        repo_ref: 'acme/repo',
        project_slug: 'test2',
        clarification_question: null,
        materialization_mode: 'root_only',
        recommended_option: { label: '继续', summary: '继续推进。' },
        alternate_option: null,
        governance_preview: null,
      },
    });

    const jobRepository = new SupervisorJobRepository(db);
    const job = jobRepository.enqueue({
      session_id: 'session-job',
      root_issue_id: 'issue-root',
      job_kind: 'issue_dev_instruction',
      idempotency_key: 'session-job|issue-root|dev|issue_dev_instruction',
      payload: { issue_id: 'issue-root' },
      run_after: new Date('2026-01-01T00:00:00.000Z'),
    });
    jobRepository.leaseNextReady({
      now: new Date('2026-01-01T00:00:01.000Z'),
      leaseOwner: 'test',
      leaseMs: 60_000,
    });

    const controller = new FakeController();
    const hub = new RuntimeHub(db, controller);
    const issue = hub.getIssue('INT-JOB');

    expect(jobRepository.findById(job.id)?.status).toBe('running');
    expect(issue?.supervisor_job_state).toBe('running:issue_dev_instruction');

    hub.dispose();
  });
});
