import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  AnthropicSupervisorService,
  type SupervisorDecisionContext,
  type SupervisorRuntimeRequestContext,
} from './supervisor';

const decisionContext: SupervisorDecisionContext = {
  mode: 'dev',
  issue: {
    id: 'issue-1',
    identifier: 'INT-25',
    title: 'Implement native Claude bridge',
    description: 'desc',
    priority: 1,
    state: 'In Progress',
    project_slug: 'proj',
    project_name: 'repo',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2025-01-01T00:00:00Z'),
    updated_at: new Date('2025-01-01T00:00:00Z'),
  },
  attempt: null,
  turnNumber: 1,
  maxTurns: 4,
  prompt: 'Continue implementing the issue.',
  workspacePath: '/tmp/workspace',
  workspaceHint: '## main',
  transcript: [],
  timeline: [],
};

const runtimeContext: SupervisorRuntimeRequestContext = {
  mode: 'review',
  issue: decisionContext.issue,
  attempt: 1,
  turnNumber: 2,
  prompt: 'Review the pull request.',
  workspacePath: '/tmp/workspace',
  workspaceHint: '## feature/int-25',
  transcript: [],
  timeline: [],
  request: {
    kind: 'approval',
    method: 'approval/request',
    request_id: 'runtime-1',
    turn: 2,
    raw: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      input: { command: 'gh pr review --approve' },
    },
    summary: {
      title: 'Permission request for Bash',
      message: 'Run gh pr review --approve',
      tool_name: 'Bash',
      subtype: 'can_use_tool',
    },
  },
};

describe('AnthropicSupervisorService', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  test('falls back to a deterministic continue action when the provider call fails', async () => {
    const service = new AnthropicSupervisorService('test-model');
    const create = mock(async () => {
      throw new Error('provider unavailable');
    });
    (service as any).client = { messages: { create } };

    const result = await service.decideNextAction(decisionContext);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('continue');
    expect(result.message).toContain('INT-25');
  });

  test('uses deterministic missing-requirements guidance for dev turns before calling the provider', async () => {
    const service = new AnthropicSupervisorService('test-model');
    const create = mock(async () => ({
      content: [],
    }));
    (service as any).client = { messages: { create } };

    const result = await service.decideNextAction({
      ...decisionContext,
      completionContext: {
        missing_requirements: [
          {
            key: 'handover',
            label: 'Write .symphony/HANDOVER.md',
            reason: 'Completion requires a handover artifact.',
            kind: 'artifact',
          },
          {
            key: 'verification',
            label: 'Record verification evidence in .symphony/change-pack/evidence.json',
            reason: 'Need explicit proof-of-work before ending the turn.',
            kind: 'verification',
          },
        ],
      },
    });

    expect(create).not.toHaveBeenCalled();
    expect(result.kind).toBe('continue');
    expect(String(result.message || '')).toContain('HANDOVER');
    expect(String(result.message || '')).toContain('evidence');
  });

  test('uses a deterministic review nudge when the canonical review report is still missing', async () => {
    const service = new AnthropicSupervisorService('test-model');
    const create = mock(async () => {
      throw new Error('provider unavailable');
    });
    (service as any).client = { messages: { create } };

    const result = await service.decideNextAction({
      ...decisionContext,
      mode: 'review',
      workspaceArtifacts: {
        handover: '# Handover',
        developmentLog: '# Development Log',
        reviewReport: null,
      },
    });

    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'continue',
      message: expect.stringContaining('.symphony/REVIEW_REPORT.md'),
    });
    expect(String(result.message || '')).toContain('native Write tool');
    expect(String(result.message || '')).toContain('exact relative path');
    expect(String(result.message || '')).toContain('Do not use Bash heredocs');
    expect(String(result.message || '')).toContain('Read the file back');
  });

  test('finishes deterministically once the canonical review report has a decision', async () => {
    const service = new AnthropicSupervisorService('test-model');
    const create = mock(async () => ({
      content: [],
    }));
    (service as any).client = { messages: { create } };

    const result = await service.decideNextAction({
      ...decisionContext,
      mode: 'review',
      workspaceArtifacts: {
        handover: '# Handover',
        developmentLog: '# Development Log',
        reviewReport: '## Review Decision: APPROVE\n\n## Review Summary\nLooks good.',
      },
    });

    expect(create).not.toHaveBeenCalled();
    expect(result.kind).toBe('finish');
    expect(String(result.reason || '')).toContain('.symphony/REVIEW_REPORT.md');
  });

  test('keeps reviewing when the report is missing the canonical summary section', async () => {
    const service = new AnthropicSupervisorService('test-model');
    const create = mock(async () => ({
      content: [],
    }));
    (service as any).client = { messages: { create } };

    const result = await service.decideNextAction({
      ...decisionContext,
      mode: 'review',
      workspaceArtifacts: {
        handover: '# Handover',
        developmentLog: '# Development Log',
        reviewReport: '## Review Decision: APPROVE\n\nLooks good.',
      },
    });

    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'continue',
      message: expect.stringContaining('## Review Summary'),
    });
  });

  test('denies orchestrator-owned external write actions before consulting the provider', async () => {
    const service = new AnthropicSupervisorService('test-model');
    const create = mock(async () => ({
      content: [],
    }));
    (service as any).client = { messages: { create } };

    const result = await service.respondToRuntimeRequest(runtimeContext);

    expect(create).not.toHaveBeenCalled();
    expect(result.response.behavior).toBe('deny');
    expect(String(result.response.message || '')).toContain('orchestrator');
  });

  test('allows normal local tool usage when the provider call fails', async () => {
    const service = new AnthropicSupervisorService('test-model');
    const create = mock(async () => {
      throw new Error('provider unavailable');
    });
    (service as any).client = { messages: { create } };

    const result = await service.respondToRuntimeRequest({
      ...runtimeContext,
      mode: 'dev',
      request: {
        ...runtimeContext.request,
        raw: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'tool-2',
          input: { command: 'npm test' },
        },
        summary: {
          ...runtimeContext.request.summary,
          message: 'Run npm test',
        },
      },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.response.behavior).toBe('allow');
    expect(result.response.toolUseID).toBe('tool-2');
  });
});
