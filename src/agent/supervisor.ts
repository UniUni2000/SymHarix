import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentTimelinePayload,
  CompletionRequirement,
  Issue,
  PendingRuntimeRequest,
  RuntimeRequestResponse,
  SupervisorNextAction,
  TurnTranscriptEntry,
} from '../types';
import { parseCanonicalReviewReport } from '../hooks/review-prompt';

const DEFAULT_SUPERVISOR_MODEL =
  process.env.SYMPHONY_SUPERVISOR_LLM_MODEL ||
  process.env.SYMPHONY_BOT_LLM_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  'claude-sonnet-4-5';

const EXTERNAL_WRITE_PATTERNS = [
  /\bgh\s+pr\s+(review|comment|merge|close)\b/i,
  /\bgh\s+issue\s+(comment|close|edit)\b/i,
  /\bgh\s+api\b.*\/pulls\/.*\/reviews/i,
  /\bgh\s+api\b.*\/issues\/.*\/comments/i,
  /\bgithub\b.*\b(comment|review|merge|close|approve|request changes)\b/i,
  /\bpull request\b.*\b(comment|review|merge|close|approve|request changes)\b/i,
  /\blinear\b.*\b(comment|state|update|move|transition)\b/i,
  /\btracker\b.*\b(comment|state|update|move|transition)\b/i,
];

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function stringifyForPrompt(value: unknown, maxLength = 4000): string {
  try {
    return truncate(JSON.stringify(value, null, 2), maxLength);
  } catch {
    return truncate(String(value), maxLength);
  }
}

function extractTextBlocks(text: string): string {
  return text.trim();
}

function extractMessageText(
  content: Array<{ type?: string; text?: string } | unknown> | undefined,
): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block !== null &&
        typeof block === 'object' &&
        'type' in block &&
        (block as { type?: unknown }).type === 'text' &&
        'text' in block &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildDefaultContinueMessage(
  mode: 'dev' | 'review',
  issue: Issue,
): string {
  if (mode === 'review') {
    return `Continue reviewing ${issue.identifier}. Focus on the highest-signal correctness risks, missing tests, and merge blockers. Stop once the review outcome is complete and ready for orchestrator post-processing.`;
  }

  return `Continue working on ${issue.identifier}. Use the repo and native Claude tools to make the next concrete step. When implementation and verification are complete, clearly state that development is complete and ready for orchestrator post-processing.`;
}

function reviewReportHasDecision(reviewReport: string | null | undefined): boolean {
  return Boolean(reviewReport && parseCanonicalReviewReport(reviewReport));
}

function buildReviewReportNudge(issue: Issue): string {
  return [
    `Review ${issue.identifier} is not complete yet because .symphony/REVIEW_REPORT.md is still missing or lacks the canonical decision line and summary section.`,
    'In this turn, do only the minimum remaining review work, then overwrite .symphony/REVIEW_REPORT.md from scratch.',
    'Include one exact machine-readable line near the top:',
    '## Review Decision: APPROVE or APPROVE_MINOR or REQUEST_CHANGES or REQUEST_TESTS or REJECT',
    'Also include a non-empty ## Review Summary section.',
    'End the turn only after the final .symphony/REVIEW_REPORT.md exists.',
  ].join(' ');
}

function buildDeterministicNextAction(
  context: SupervisorDecisionContext,
): SupervisorNextAction | null {
  if (context.mode !== 'review') {
    const missingRequirements = context.completionContext?.missing_requirements ?? [];
    if (missingRequirements.length > 0) {
      const topRequirements = missingRequirements
        .slice(0, 3)
        .map((requirement) => `- ${requirement.label}: ${requirement.reason}`)
        .join(' ');
      return {
        kind: 'continue',
        message: [
          `Development for ${context.issue.identifier} is not complete yet because some required evidence is still missing.`,
          'In this turn, do only the minimum remaining work to satisfy these requirements:',
          topRequirements,
          'Keep .symphony/change-pack/tasks.md and .symphony/change-pack/evidence.json aligned with the actual state before ending the turn.',
        ].join(' '),
      };
    }

    return null;
  }

  if (reviewReportHasDecision(context.workspaceArtifacts?.reviewReport)) {
    return {
      kind: 'finish',
      reason: `Review for ${context.issue.identifier} is complete because .symphony/REVIEW_REPORT.md contains a final decision.`,
    };
  }

  return {
    kind: 'continue',
    message: buildReviewReportNudge(context.issue),
  };
}

function getBlockedExternalWriteReason(request: PendingRuntimeRequest): string | null {
  const haystack = normalizeText(
    [
      request.summary.title,
      request.summary.message,
      stringifyForPrompt(request.raw, 2000),
    ].join(' ')
  );

  for (const pattern of EXTERNAL_WRITE_PATTERNS) {
    if (pattern.test(haystack)) {
      return 'External review/comment/merge/tracker actions remain owned by the orchestrator, so this action should be denied.';
    }
  }

  return null;
}

function buildPermissionResponse(
  request: PendingRuntimeRequest,
  behavior: 'allow' | 'deny',
  message?: string,
  updatedInput?: Record<string, unknown>,
): RuntimeRequestResponse {
  const toolUseID =
    typeof request.raw.tool_use_id === 'string' ? request.raw.tool_use_id : undefined;

  if (behavior === 'allow') {
    return {
      response: {
        behavior: 'allow',
        updatedInput:
          updatedInput && Object.keys(updatedInput).length > 0
            ? updatedInput
            : ((request.raw.input as Record<string, unknown> | undefined) || {}),
        ...(toolUseID ? { toolUseID } : {}),
      },
    };
  }

  return {
    response: {
      behavior: 'deny',
      message: message || 'Permission denied by supervisor policy.',
      ...(toolUseID ? { toolUseID } : {}),
      decisionClassification: 'user_reject',
    },
  };
}

function buildElicitationCancelResponse(): RuntimeRequestResponse {
  return {
    response: {
      action: 'cancel',
    },
  };
}

export interface SupervisorDecisionContext {
  mode: 'dev' | 'review';
  issue: Issue;
  attempt: number | null;
  turnNumber: number;
  maxTurns: number;
  prompt: string;
  workspacePath: string;
  workspaceHint: string;
  workspaceArtifacts?: {
    handover: string | null;
    developmentLog: string | null;
    reviewReport: string | null;
  };
  completionContext?: {
    missing_requirements: CompletionRequirement[];
  };
  transcript: TurnTranscriptEntry[];
  timeline: AgentTimelinePayload[];
}

export interface SupervisorRuntimeRequestContext {
  mode: 'dev' | 'review';
  issue: Issue;
  attempt: number | null;
  turnNumber: number;
  prompt: string;
  workspacePath: string;
  workspaceHint: string;
  request: PendingRuntimeRequest;
  transcript: TurnTranscriptEntry[];
  timeline: AgentTimelinePayload[];
}

export interface SupervisorService {
  decideNextAction(context: SupervisorDecisionContext): Promise<SupervisorNextAction>;
  respondToRuntimeRequest(
    context: SupervisorRuntimeRequestContext,
  ): Promise<RuntimeRequestResponse>;
}

export class AnthropicSupervisorService implements SupervisorService {
  private client: Anthropic;
  private model: string;

  constructor(model = DEFAULT_SUPERVISOR_MODEL) {
    this.client = new Anthropic({
      apiKey:
        process.env.SYMPHONY_SUPERVISOR_LLM_API_KEY ||
        process.env.SYMPHONY_BOT_LLM_API_KEY ||
        process.env.ANTHROPIC_API_KEY,
      baseURL:
        process.env.SYMPHONY_SUPERVISOR_LLM_BASE_URL ||
        process.env.SYMPHONY_BOT_LLM_BASE_URL ||
        process.env.ANTHROPIC_BASE_URL,
    });
    this.model = model;
  }

  async decideNextAction(
    context: SupervisorDecisionContext,
  ): Promise<SupervisorNextAction> {
    const deterministicAction = buildDeterministicNextAction(context);
    if (deterministicAction) {
      return deterministicAction;
    }

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 700,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  'You are the supervisor LLM for Symphony.',
                  'Your role is to act like the human user of Claude Code and decide the next user message after a completed turn.',
                  'Return JSON only.',
                  'Allowed JSON:',
                  '{"kind":"continue","message":"..."}',
                  '{"kind":"finish","reason":"..."}',
                  '{"kind":"abort","reason":"..."}',
                  'Rules:',
                  '- Prefer continue unless the task is truly ready for orchestrator post-processing.',
                  '- If turnNumber is already equal to maxTurns, continue is no longer valid. You must choose finish or abort.',
                  '- finish means Claude has done enough and the orchestrator should run its existing dev/review hooks.',
                  '- abort means an irrecoverable blocker or a clear policy/safety stop.',
                  '- Do not delegate GitHub review/comment/merge/issue-closing/tracker-state-changing work to Claude; those remain owned by the orchestrator.',
                  '',
                  'Context:',
                  stringifyForPrompt({
                    mode: context.mode,
                    issue: {
                      identifier: context.issue.identifier,
                      title: context.issue.title,
                      description: context.issue.description,
                      state: context.issue.state,
                      labels: context.issue.labels,
                    },
                    attempt: context.attempt,
                    turnNumber: context.turnNumber,
                    maxTurns: context.maxTurns,
                    lastUserMessage: truncate(context.prompt, 1500),
                    workspacePath: context.workspacePath,
                    workspaceHint: context.workspaceHint,
                    workspaceArtifacts: context.workspaceArtifacts || null,
                    completionContext: context.completionContext || null,
                    timeline: context.timeline.map((event) => event.message),
                    transcript: context.transcript.map((entry) => ({
                      role: entry.role,
                      kind: entry.kind,
                      tool_name: entry.tool_name,
                      text: truncate(entry.text, 1200),
                    })),
                  }),
                ].join('\n'),
              },
            ],
          },
        ],
      });

      const text = extractMessageText(message.content);
      const parsed = extractJsonObject(text);

      if (
        parsed &&
        (parsed.kind === 'continue' || parsed.kind === 'finish' || parsed.kind === 'abort')
      ) {
        if (parsed.kind === 'continue' && typeof parsed.message === 'string' && parsed.message.trim()) {
          return {
            kind: 'continue',
            message: parsed.message.trim(),
          };
        }

        if (
          (parsed.kind === 'finish' || parsed.kind === 'abort') &&
          typeof parsed.reason === 'string' &&
          parsed.reason.trim()
        ) {
          return {
            kind: parsed.kind,
            reason: parsed.reason.trim(),
          };
        }
      }
    } catch {
      // Fall through to deterministic fallback below.
    }

    return {
      kind: 'continue',
      message: buildDefaultContinueMessage(context.mode, context.issue),
    };
  }

  async respondToRuntimeRequest(
    context: SupervisorRuntimeRequestContext,
  ): Promise<RuntimeRequestResponse> {
    const blockedReason = getBlockedExternalWriteReason(context.request);
    if (blockedReason) {
      if (context.request.kind === 'approval') {
        return buildPermissionResponse(context.request, 'deny', blockedReason);
      }
      return buildElicitationCancelResponse();
    }

    if (context.request.kind === 'approval') {
      try {
        const message = await this.client.messages.create({
          model: this.model,
          max_tokens: 500,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: [
                    'You are the supervisor LLM for Symphony.',
                    'A running Claude Code session requested permission to use a tool.',
                    'Return JSON only.',
                    'Allowed JSON:',
                    '{"behavior":"allow","updatedInput":{}}',
                    '{"behavior":"deny","message":"..."}',
                    'Rules:',
                    '- Allow normal local coding, testing, reading, searching, debugging, skills, plugins, MCP, and computer-use work unless it conflicts with the boundary below.',
                    '- Deny actions that would submit GitHub reviews/comments, merge PRs, close issues, change tracker states, or publish dev/review process details to external systems.',
                    '- If you allow, preserve the original input unless you have a strong reason to adjust it.',
                    '',
                    'Context:',
                    stringifyForPrompt({
                      mode: context.mode,
                      issue: {
                        identifier: context.issue.identifier,
                        title: context.issue.title,
                        state: context.issue.state,
                      },
                      request: context.request,
                      workspaceHint: context.workspaceHint,
                      recentTimeline: context.timeline.map((event) => event.message),
                      recentTranscript: context.transcript.map((entry) => ({
                        role: entry.role,
                        kind: entry.kind,
                        text: truncate(entry.text, 600),
                      })),
                    }),
                  ].join('\n'),
                },
              ],
            },
          ],
        });

        const text = extractMessageText(message.content);
        const parsed = extractJsonObject(text);

        if (parsed?.behavior === 'allow') {
          const updatedInput =
            parsed.updatedInput && typeof parsed.updatedInput === 'object'
              ? (parsed.updatedInput as Record<string, unknown>)
              : undefined;
          return buildPermissionResponse(
            context.request,
            'allow',
            undefined,
            updatedInput,
          );
        }

        if (parsed?.behavior === 'deny' && typeof parsed.message === 'string') {
          return buildPermissionResponse(
            context.request,
            'deny',
            parsed.message.trim(),
          );
        }
      } catch {
        // Fall through to deterministic fallback below.
      }

      return buildPermissionResponse(context.request, 'allow');
    }

    try {
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  'You are the supervisor LLM for Symphony.',
                  'A running Claude Code session requested user input via an elicitation request.',
                  'Return JSON only.',
                  'Allowed JSON:',
                  '{"action":"accept","content":{}}',
                  '{"action":"decline"}',
                  '{"action":"cancel"}',
                  'If the request is a form and you accept, include a content object that matches the requested schema as closely as possible.',
                  '',
                  'Context:',
                  stringifyForPrompt({
                    mode: context.mode,
                    issue: {
                      identifier: context.issue.identifier,
                      title: context.issue.title,
                      state: context.issue.state,
                    },
                    request: context.request,
                    workspaceHint: context.workspaceHint,
                    recentTimeline: context.timeline.map((event) => event.message),
                    recentTranscript: context.transcript.map((entry) => ({
                      role: entry.role,
                      kind: entry.kind,
                      text: truncate(entry.text, 600),
                    })),
                  }),
                ].join('\n'),
              },
            ],
          },
        ],
      });

      const text = extractMessageText(message.content);
      const parsed = extractJsonObject(text);

      if (
        parsed &&
        (parsed.action === 'accept' || parsed.action === 'decline' || parsed.action === 'cancel')
      ) {
        return {
          response: {
            action: parsed.action,
            ...(parsed.action === 'accept' &&
            parsed.content &&
            typeof parsed.content === 'object'
              ? { content: parsed.content }
              : {}),
          },
        };
      }
    } catch {
      // Fall through to deterministic fallback below.
    }

    return buildElicitationCancelResponse();
  }
}

export function summarizeTranscript(entries: TurnTranscriptEntry[]): string[] {
  return entries.map((entry) => {
    const prefix = entry.tool_name
      ? `${entry.role}/${entry.kind}/${entry.tool_name}`
      : `${entry.role}/${entry.kind}`;
    return `${prefix}: ${truncate(extractTextBlocks(entry.text), 600)}`;
  });
}
