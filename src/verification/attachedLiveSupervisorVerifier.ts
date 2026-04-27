import type { RuntimeIssueView, RuntimeOverview } from '../runtime/types';
import type { LiveLifecycleCheckpoint, LiveLifecycleVerificationResult } from './liveLifecycleVerifier';

export interface AttachedLiveSupervisorVerifyInput {
  serverUrl: string;
  projectSlug: string;
  timeoutMs?: number | null;
  titleSuffix?: string | null;
  telegramChatId?: string | null;
  webhookSecret?: string | null;
  supervisorLiveScenario?: SupervisorLiveScenario | null;
  reporter?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type SupervisorLiveScenario = 'simple' | 'governed_split' | 'destructive_cleanup';

export interface AttachedLiveSupervisorMatrixInput extends Omit<AttachedLiveSupervisorVerifyInput, 'supervisorLiveScenario'> {
  scenarios?: SupervisorLiveScenario[];
  verifier?: (input: AttachedLiveSupervisorVerifyInput) => Promise<LiveLifecycleVerificationResult>;
}

export interface AttachedLiveSupervisorMatrixResult {
  success: boolean;
  message: string;
  results: Array<LiveLifecycleVerificationResult & { scenario: SupervisorLiveScenario }>;
}

function createAttachCheckpoints(): LiveLifecycleCheckpoint[] {
  return [
    { code: 'issue_created', label: 'Telegram accepted supervisor request', status: 'pending', detail: null, timestamp: null },
    { code: 'work_item_created', label: 'Issue appears in running runtime overview', status: 'pending', detail: null, timestamp: null },
    { code: 'dev_started', label: 'Supervisor/dev execution started', status: 'pending', detail: null, timestamp: null },
    { code: 'merged_done', label: 'Supervisor issue reached completed delivery', status: 'pending', detail: null, timestamp: null },
  ];
}

function pass(checkpoints: LiveLifecycleCheckpoint[], code: LiveLifecycleCheckpoint['code'], detail: string | null): void {
  const checkpoint = checkpoints.find((item) => item.code === code);
  if (!checkpoint || checkpoint.status === 'passed') {
    return;
  }
  checkpoint.status = 'passed';
  checkpoint.detail = detail;
  checkpoint.timestamp = new Date().toISOString();
}

function getActiveSupervisorSessions(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = manifest.data as Record<string, unknown> | undefined;
  const supervisor = data?.supervisor as Record<string, unknown> | undefined;
  const activeSessions = supervisor?.active_sessions;
  return Array.isArray(activeSessions) ? activeSessions.filter((item): item is Record<string, unknown> => (
    Boolean(item) && typeof item === 'object'
  )) : [];
}

function timestampOf(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFreshRuntimeIssue(issue: RuntimeIssueView, startedAt: number): boolean {
  const raw = issue as RuntimeIssueView & {
    created_at?: string | null;
    updated_at?: string | null;
  };
  const createdAt = timestampOf(raw.created_at);
  const updatedAt = timestampOf(raw.updated_at);
  return Boolean(
    (createdAt !== null && createdAt >= startedAt) ||
    (updatedAt !== null && updatedAt >= startedAt),
  );
}

function isRetryingRuntimeState(issue: RuntimeIssueView): boolean {
  return issue.orchestrator_state === 'retry_scheduled' || issue.orchestrator_state === 'retrying';
}

function isTerminalRuntimeFailure(issue: RuntimeIssueView): boolean {
  if (issue.orchestrator_state === 'cancelled') {
    return true;
  }
  if (issue.orchestrator_state === 'failed') {
    return true;
  }
  return issue.delivery_state === 'delivery_failed' && !isRetryingRuntimeState(issue);
}

function validateScenarioCompletion(
  scenario: SupervisorLiveScenario,
  issue: RuntimeIssueView,
): { ok: true } | { ok: false; code: string; message: string } {
  if (scenario === 'governed_split') {
    const queue = Array.isArray(issue.governance_child_queue) ? issue.governance_child_queue : [];
    const hasCurrent = queue.some((entry) => entry.queue_state === 'current' || entry.issue_id === issue.governance_current_child?.issue_id);
    const hasQueued = queue.some((entry) => entry.queue_state === 'queued');
    const allCompleted = queue.length >= 2 && queue.every((entry) => entry.queue_state === 'completed');
    const hasValidActiveQueue = queue.length >= 2 && hasCurrent && hasQueued;
    if (!hasValidActiveQueue && !(issue.governance_thread_state === 'resolved' && allCompleted)) {
      return {
        ok: false,
        code: 'missing_split_child_queue',
        message: 'Governed split scenario completed without a visible root + child queue or resolved completed child queue.',
      };
    }
  }
  return { ok: true };
}

async function waitForSupervisorApprovalCard(params: {
  fetchImpl: typeof fetch;
  serverUrl: string;
  chatId: string;
  projectSlug: string;
  suffix: string;
  startedAt: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  deadline: number;
  reporter?: (message: string) => void;
}): Promise<{ sessionId: string; approved: boolean } | null> {
  let lastState: string | null = null;
  while (params.now() <= params.deadline) {
    const manifest = await readJson(params.fetchImpl, `${params.serverUrl}/api/v1/bots/manifest`);
    const session = getActiveSupervisorSessions(manifest).find((item) => (
      String(item.conversation_id ?? '') === params.chatId &&
      (timestampOf(item.updated_at) ?? 0) >= params.startedAt &&
      (
        String(item.title ?? '').includes(params.suffix) ||
        (String(item.repo_ref ?? '') === params.projectSlug && String(item.root_issue_id ?? '') === '')
      )
    )) ?? null;
    if (session) {
      const state = String(session.state ?? 'unknown');
      const decision = typeof session.active_decision_kind === 'string'
        ? session.active_decision_kind
        : null;
      const signature = `${state}:${decision ?? 'none'}`;
      if (signature !== lastState) {
        params.reporter?.(`Supervisor session visible: ${signature}`);
        lastState = signature;
      }
      if (state === 'awaiting_user_approval' || decision === 'plan_approval') {
        return { sessionId: String(session.session_id ?? '') || '', approved: false };
      }
      if (state === 'executing' || state === 'materialized') {
        throw new Error('Supervisor session materialized before Telegram Plan Card approval.');
      }
    }
    await params.sleep(2_000);
  }
  return null;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !json) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return json;
}

async function postTelegramWebhook(params: {
  fetchImpl: typeof fetch;
  serverUrl: string;
  chatId: string;
  text: string;
  webhookSecret: string | null;
  updateId: number;
}): Promise<void> {
  const response = await params.fetchImpl(`${params.serverUrl}/api/v1/bots/telegram/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(params.webhookSecret ? { 'x-telegram-bot-api-secret-token': params.webhookSecret } : {}),
    },
    body: JSON.stringify({
      update_id: params.updateId,
      message: {
        message_id: params.updateId,
        date: Math.floor(Date.now() / 1000),
        text: params.text,
        chat: {
          id: params.chatId,
          type: 'private',
        },
        from: {
          id: params.chatId,
          is_bot: false,
          first_name: 'live-verifier',
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram webhook returned HTTP ${response.status}`);
  }
}

function buildScenarioRequestText(params: {
  scenario: SupervisorLiveScenario;
  projectSlug: string;
  suffix: string;
  startedAt: number;
}): string {
  if (params.scenario === 'governed_split') {
    return [
      `新开线程 supervisor live E2E ${params.projectSlug}`,
      '请规划一个需要拆成两个顺序子任务的治理验证：先创建 docs/supervisor-live-root.md，再创建 docs/supervisor-live-child.md。',
      '要求使用 root + child queue，只放行当前 child，后续 child 排队接力。',
      '请先给 Plan Card，不要直接建单。',
      `nonce ${params.suffix}`,
    ].join(' ');
  }

  if (params.scenario === 'destructive_cleanup') {
    const markerPath = `docs/supervisor-live-cleanup-approval-${params.suffix}.md`;
    return [
      `新开线程 supervisor live E2E ${params.projectSlug}`,
      '请验证破坏性清理审批：这是一条 root-only 单，不要拆分，不要创建 child queue，不要创建子任务。',
      '不要扫描全仓，不要遍历大型目录；只验证“删除前必须给 Plan Card 并等待批准”这条审批语义。',
      `不要真的删除业务文件；批准后只创建这个可提交的验证标记文件：${markerPath}。`,
      '不要把最终交付文件放在 .symphony/；.symphony 只用于内部 handover/evidence，不算业务交付。',
      '标记文件内容写明：发现了哪些残余、为什么不能直接删除、需要用户批准后才会删除。',
      '请先给 Plan Card，不要直接建单。',
      `nonce ${params.suffix}`,
    ].join(' ');
  }

  return [
    `新开线程 supervisor live E2E ${params.projectSlug}`,
    `请新建一条很小的验证任务：创建 docs/supervisor-live-${params.suffix}.md，写一句 supervisor live e2e passed。`,
    '请先给 Plan Card，不要直接建单。',
    `nonce ${params.suffix}`,
  ].join(' ');
}

export async function verifyAttachedLiveSupervisor(
  input: AttachedLiveSupervisorVerifyInput,
): Promise<LiveLifecycleVerificationResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const timeoutMs = input.timeoutMs ?? 10 * 60_000;
  const serverUrl = input.serverUrl.replace(/\/+$/, '');
  const checkpoints = createAttachCheckpoints();
  let issueId: string | null = null;
  let issueIdentifier: string | null = null;
  let githubRepo: string | null = null;
  let branchName: string | null = null;
  let pullRequestNumber: number | null = null;
  let lastTimelineMessage: string | null = null;

  try {
    const manifest = await readJson(fetchImpl, `${serverUrl}/api/v1/bots/manifest`);
    const telegram = ((manifest.data as Record<string, unknown> | undefined)?.transports as Record<string, unknown> | undefined)?.telegram as Record<string, unknown> | undefined;
    input.reporter?.(`Telegram manifest health: ${String(telegram?.health ?? 'unknown')}`);
    if (!input.telegramChatId) {
      throw new Error('attach-mode verify-live-supervisor requires --telegram-chat-id so the request enters through Telegram.');
    }

    const suffix = input.titleSuffix ?? `attached-${new Date(startedAt).toISOString()}`;
    const scenario = input.supervisorLiveScenario ?? 'simple';
    const requestText = buildScenarioRequestText({
      scenario,
      projectSlug: input.projectSlug,
      suffix,
      startedAt,
    });
    await postTelegramWebhook({
      fetchImpl,
      serverUrl,
      chatId: input.telegramChatId,
      text: requestText,
      webhookSecret: input.webhookSecret ?? process.env.SYMPHONY_TELEGRAM_WEBHOOK_SECRET ?? null,
      updateId: Math.floor(startedAt || Date.now()),
    });
    pass(checkpoints, 'issue_created', input.telegramChatId);
    input.reporter?.('Sent supervisor request through Telegram webhook');

    const approvalSession = await waitForSupervisorApprovalCard({
      fetchImpl,
      serverUrl,
      chatId: input.telegramChatId,
      projectSlug: input.projectSlug,
      suffix,
      startedAt,
      sleep,
      now,
      deadline: Math.min(startedAt + timeoutMs, startedAt + 120_000),
      reporter: input.reporter,
    });
    if (!approvalSession) {
      throw new Error('Timed out waiting for Telegram supervisor Plan Card before approval.');
    }
    await postTelegramWebhook({
      fetchImpl,
      serverUrl,
      chatId: input.telegramChatId,
      text: '批准并开始',
      webhookSecret: input.webhookSecret ?? process.env.SYMPHONY_TELEGRAM_WEBHOOK_SECRET ?? null,
      updateId: Math.floor((startedAt || Date.now()) + 1),
    });
    input.reporter?.(`Sent supervisor approval through Telegram webhook for session ${approvalSession.sessionId}`);

    const deadline = startedAt + timeoutMs;
    while (now() <= deadline) {
      if (!issueId) {
        const manifestJson = await readJson(fetchImpl, `${serverUrl}/api/v1/bots/manifest`);
        const session = getActiveSupervisorSessions(manifestJson).find((item) => (
          String(item.session_id ?? '') === approvalSession.sessionId
        )) ?? null;
        const rootIssueId = typeof session?.root_issue_id === 'string' && session.root_issue_id
          ? session.root_issue_id
          : null;
        if (rootIssueId) {
          issueId = rootIssueId;
          input.reporter?.(`Supervisor session root issue attached: ${rootIssueId}`);
        }
      }
      const overviewJson = await readJson(fetchImpl, `${serverUrl}/api/v1/runtime/overview`);
      const overview = overviewJson.data as RuntimeOverview | undefined;
      const overviewIssue = overview?.issues?.find((issue) => (
        issue.issue_id === issueId ||
        issue.identifier === issueIdentifier ||
        (issue.title.includes(suffix) && isFreshRuntimeIssue(issue, startedAt))
      )) ?? null;
      if (overviewIssue) {
        pass(checkpoints, 'work_item_created', overviewIssue.identifier);
        issueId = overviewIssue.issue_id;
        issueIdentifier = overviewIssue.identifier;
      }
      const issue = issueId
        ? ((await readJson(fetchImpl, `${serverUrl}/api/v1/runtime/issues/${encodeURIComponent(issueId)}`)).data as RuntimeIssueView | null)
        : overviewIssue;
      if (issue) {
        issueIdentifier = issue.identifier ?? issueIdentifier;
        githubRepo = issue.github_repo ?? githubRepo;
        branchName = issue.branch_name ?? branchName;
        pullRequestNumber = issue.active_pr_number ?? pullRequestNumber;
        lastTimelineMessage = issue.delivery_summary ?? issue.latest_supervisor_directive ?? issue.next_recommended_action ?? lastTimelineMessage;
        if (issue.supervisor_session_state || issue.latest_supervisor_directive) {
          pass(checkpoints, 'dev_started', issue.latest_supervisor_directive ?? issue.supervisor_session_state ?? null);
        }
        if (isTerminalRuntimeFailure(issue)) {
          return {
            success: false,
            message: issue.delivery_summary ?? 'Attached supervisor verification failed because runtime reported failure.',
            project_slug: input.projectSlug,
            issue_id: issueId,
            issue_identifier: issueIdentifier,
            github_repo: githubRepo,
            branch_name: branchName,
            pull_request_number: pullRequestNumber,
            review_decision: null,
            failure_code: issue.delivery_code ?? 'runtime_failed',
            duration_ms: now() - startedAt,
            checkpoints,
            diagnostics: null,
            last_timeline_message: lastTimelineMessage,
          };
        }
        if (
          issue.orchestrator_state === 'completed' ||
          issue.delivery_state === 'completed' ||
          issue.supervisor_session_state === 'completed' ||
          issue.governance_thread_state === 'resolved'
        ) {
          const scenarioValidation = validateScenarioCompletion(scenario, issue);
          if (!scenarioValidation.ok) {
            return {
              success: false,
              message: scenarioValidation.message,
              project_slug: input.projectSlug,
              issue_id: issueId,
              issue_identifier: issueIdentifier,
              github_repo: githubRepo,
              branch_name: branchName,
              pull_request_number: pullRequestNumber,
              review_decision: null,
              failure_code: scenarioValidation.code,
              duration_ms: now() - startedAt,
              checkpoints,
              diagnostics: null,
              last_timeline_message: lastTimelineMessage,
            };
          }
          pass(checkpoints, 'merged_done', issue.delivery_summary ?? 'completed');
          return {
            success: true,
            message: 'Attached supervisor verification completed.',
            project_slug: input.projectSlug,
            issue_id: issueId,
            issue_identifier: issueIdentifier,
            github_repo: githubRepo,
            branch_name: branchName,
            pull_request_number: pullRequestNumber,
            review_decision: null,
            failure_code: null,
            duration_ms: now() - startedAt,
            checkpoints,
            diagnostics: null,
            last_timeline_message: lastTimelineMessage,
          };
        }
      }
      await sleep(5_000);
    }

    return {
      success: false,
      message: 'Timed out waiting for attached supervisor verification to complete.',
      project_slug: input.projectSlug,
      issue_id: issueId,
      issue_identifier: issueIdentifier,
      github_repo: githubRepo,
      branch_name: branchName,
      pull_request_number: pullRequestNumber,
      review_decision: null,
      failure_code: 'timeout',
      duration_ms: now() - startedAt,
      checkpoints,
      diagnostics: null,
      last_timeline_message: lastTimelineMessage,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      project_slug: input.projectSlug,
      issue_id: issueId,
      issue_identifier: issueIdentifier,
      github_repo: githubRepo,
      branch_name: branchName,
      pull_request_number: pullRequestNumber,
      review_decision: null,
      failure_code: 'attach_mode_error',
      duration_ms: now() - startedAt,
      checkpoints,
      diagnostics: null,
      last_timeline_message: lastTimelineMessage,
    };
  }
}

export async function verifyAttachedLiveSupervisorMatrix(
  input: AttachedLiveSupervisorMatrixInput,
): Promise<AttachedLiveSupervisorMatrixResult> {
  const scenarios = input.scenarios?.length
    ? input.scenarios
    : ['simple', 'governed_split', 'destructive_cleanup'] as SupervisorLiveScenario[];
  const verifier = input.verifier ?? verifyAttachedLiveSupervisor;
  const results: AttachedLiveSupervisorMatrixResult['results'] = [];

  for (const scenario of scenarios) {
    const result = await verifier({
      ...input,
      titleSuffix: input.titleSuffix ? `${input.titleSuffix}-${scenario}` : null,
      supervisorLiveScenario: scenario,
    });
    results.push({
      ...result,
      scenario,
    });
    if (!result.success) {
      return {
        success: false,
        message: `Supervisor live matrix stopped at ${scenario}: ${result.message}`,
        results,
      };
    }
  }

  return {
    success: true,
    message: `Supervisor live matrix passed ${results.length} scenario(s).`,
    results,
  };
}
