import type { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { WorkItemRepository, ReviewEventRepository } from '../database';
import type { ReviewDecision } from '../database/types';
import type { RuntimeControlPlane, RuntimeIssueView, RuntimeTimelineEvent } from '../runtime/types';
import type {
  LiveLifecycleScenarioConfig,
  RuntimeDiagnosticsSnapshot,
  ServiceConfig,
  WorkflowDefinition,
} from '../types';
import { sanitizeWorkspaceKey } from '../workspace/shared';

export interface LiveLifecycleCheckpoint {
  code:
    | 'issue_created'
    | 'route_resolved'
    | 'work_item_created'
    | 'dev_started'
    | 'pull_request_created'
    | 'tracker_in_review'
    | 'review_approved'
    | 'merged_done'
    | 'workspace_cleaned'
    | 'branch_cleaned'
    | 'runtime_cleaned';
  label: string;
  status: 'pending' | 'passed' | 'failed';
  detail: string | null;
  timestamp: string | null;
}

export interface LiveLifecycleVerificationResult {
  success: boolean;
  message: string;
  project_slug: string;
  issue_id: string | null;
  issue_identifier: string | null;
  github_repo: string | null;
  branch_name: string | null;
  pull_request_number: number | null;
  review_decision: ReviewDecision | null;
  failure_code: string | null;
  duration_ms: number;
  checkpoints: LiveLifecycleCheckpoint[];
  diagnostics: RuntimeDiagnosticsSnapshot | null;
  last_timeline_message: string | null;
}

export interface LiveLifecycleVerifyInput {
  projectSlug: string;
  timeoutMs?: number | null;
  titleSuffix?: string | null;
  reporter?: (message: string) => void;
}

type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RuntimeHostLike = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getRuntimeHub(): RuntimeControlPlane;
  getConfig(): ServiceConfig;
  getDiagnosticsSnapshot(): RuntimeDiagnosticsSnapshot;
};

interface LiveLifecycleVerifierOptions {
  db: Database;
  config: ServiceConfig;
  workflow: WorkflowDefinition;
  runtimeHostFactory: () => Promise<RuntimeHostLike>;
  sleep?: (ms: number) => Promise<void>;
  runGitCommand?: (args: string[], cwd: string) => Promise<GitCommandResult>;
  now?: () => number;
}

function formatVerificationNonce(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[:.]/g, '-');
}

type VerificationObservation = {
  issueView: RuntimeIssueView | null;
  timeline: RuntimeTimelineEvent[];
  diagnostics: RuntimeDiagnosticsSnapshot;
};

const CHECKPOINT_LABELS: Record<LiveLifecycleCheckpoint['code'], string> = {
  issue_created: 'Linear issue created',
  route_resolved: 'Repository route resolved',
  work_item_created: 'Work item created',
  dev_started: 'Development started',
  pull_request_created: 'GitHub issue, branch, and PR created',
  tracker_in_review: 'Tracker entered In Review',
  review_approved: 'Review approved',
  merged_done: 'Merged and tracker moved to Done',
  workspace_cleaned: 'Worktree cleaned',
  branch_cleaned: 'Local and remote branches cleaned',
  runtime_cleaned: 'Runtime and worker state cleaned',
};

function buildCacheKey(owner: string, repo: string): string {
  return `${sanitizeWorkspaceKey(owner.toLowerCase())}__${sanitizeWorkspaceKey(repo.toLowerCase())}`;
}

function getSourcePath(workspaceRoot: string, cacheKey: string): string {
  return path.join(workspaceRoot, cacheKey, 'source');
}

function getWorktreePath(workspaceRoot: string, cacheKey: string, issueIdentifier: string): string {
  return path.join(workspaceRoot, cacheKey, 'worktrees', sanitizeWorkspaceKey(issueIdentifier));
}

function createCheckpoints(): LiveLifecycleCheckpoint[] {
  return (Object.keys(CHECKPOINT_LABELS) as LiveLifecycleCheckpoint['code'][]).map((code) => ({
    code,
    label: CHECKPOINT_LABELS[code],
    status: 'pending',
    detail: null,
    timestamp: null,
  }));
}

function isApprovedDecision(decision: ReviewDecision | null): boolean {
  return decision === 'APPROVE' || decision === 'APPROVE_MINOR';
}

function isRejectedDecision(decision: ReviewDecision | null): boolean {
  return decision === 'REQUEST_CHANGES' || decision === 'REQUEST_TESTS' || decision === 'REJECT';
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultRunGitCommand(args: string[], cwd: string): Promise<GitCommandResult> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    exitCode,
    stdout,
    stderr,
  };
}

export class LiveLifecycleVerifier {
  private readonly workItemRepository: WorkItemRepository;
  private readonly reviewEventRepository: ReviewEventRepository;
  private readonly sleep: NonNullable<LiveLifecycleVerifierOptions['sleep']>;
  private readonly runGitCommand: NonNullable<LiveLifecycleVerifierOptions['runGitCommand']>;
  private readonly now: NonNullable<LiveLifecycleVerifierOptions['now']>;

  constructor(private readonly options: LiveLifecycleVerifierOptions) {
    this.workItemRepository = new WorkItemRepository(options.db);
    this.reviewEventRepository = new ReviewEventRepository(options.db);
    this.sleep = options.sleep ?? defaultSleep;
    this.runGitCommand = options.runGitCommand ?? defaultRunGitCommand;
    this.now = options.now ?? (() => Date.now());
  }

  async verify(input: LiveLifecycleVerifyInput): Promise<LiveLifecycleVerificationResult> {
    const checkpoints = createCheckpoints();
    const startedAt = this.now();
    const timeoutMs = input.timeoutMs ?? this.options.config.verification.lifecycle.timeoutMs;
    const pollIntervalMs = this.options.config.verification.lifecycle.pollIntervalMs;
    const scenario = this.resolveScenario(input.projectSlug);
    if (!scenario) {
      return this.finishFailure({
        startedAt,
        projectSlug: input.projectSlug,
        checkpoints,
        failureCode: 'missing_verification_scenario',
        message: `No verification.lifecycle scenario is configured for project_slug "${input.projectSlug}".`,
      });
    }

    const route = this.resolveRoute(input.projectSlug);
    if (!route) {
      return this.finishFailure({
        startedAt,
        projectSlug: input.projectSlug,
        checkpoints,
        failureCode: 'missing_repository_route',
        message: `No repositories.routing entry is configured for project_slug "${input.projectSlug}".`,
      });
    }

    this.reportPassed(checkpoints, 'route_resolved', `${route.owner}/${route.repo}`, input.reporter);

    let host: RuntimeHostLike | null = null;
    let issueId: string | null = null;
    let issueIdentifier: string | null = null;
    let diagnostics: RuntimeDiagnosticsSnapshot | null = null;
    let lastTimelineMessage: string | null = null;
    let branchName: string | null = null;
    let pullRequestNumber: number | null = null;
    let reviewDecision: ReviewDecision | null = null;
    let githubRepo: string | null = null;

    try {
      host = await this.options.runtimeHostFactory();
      await host.start();
      input.reporter?.(`Started dedicated runtime host for ${input.projectSlug}`);

      const runtime = host.getRuntimeHub();
      const created = await runtime.createIssue({
        title: this.buildIssueTitle(scenario, input.titleSuffix),
        description: this.buildIssueDescription(scenario, input.titleSuffix),
        project_slug: input.projectSlug,
      });

      if (!created.accepted || !created.issue_id || !created.issue_identifier) {
        return this.finishFailure({
          startedAt,
          projectSlug: input.projectSlug,
          checkpoints,
          diagnostics: host.getDiagnosticsSnapshot(),
          failureCode: 'issue_create_rejected',
          message: created.message || 'Live lifecycle issue creation failed.',
        });
      }

      issueId = created.issue_id;
      issueIdentifier = created.issue_identifier;
      this.reportPassed(checkpoints, 'issue_created', `${issueIdentifier}`, input.reporter);
      input.reporter?.(`Created ${issueIdentifier}`);

      const deadline = startedAt + timeoutMs;
      while (this.now() <= deadline) {
        const observation = this.collectObservation(runtime, host, issueId);
        diagnostics = observation.diagnostics;
        lastTimelineMessage = observation.timeline.at(-1)?.message ?? lastTimelineMessage;

        const workItem = this.workItemRepository.findByLinearIssueId(issueId);
        const issueView = observation.issueView;
        const latestReview = workItem ? this.reviewEventRepository.findLatestByWorkItemId(workItem.id) : null;
        reviewDecision = latestReview?.decision ?? reviewDecision;
        branchName = issueView?.branch_name ?? workItem?.branch_name ?? branchName;
        pullRequestNumber = issueView?.active_pr_number ?? workItem?.active_pr_number ?? pullRequestNumber;
        githubRepo = issueView?.github_repo ?? workItem?.github_repo ?? githubRepo;

        if (workItem) {
          this.reportPassed(checkpoints, 'work_item_created', workItem.github_repo, input.reporter);
        }

        if (issueView && issueView.phase === 'DEV') {
          this.reportPassed(
            checkpoints,
            'dev_started',
            issueView.orchestrator_state || issueView.tracker_state,
            input.reporter,
          );
        }

        if ((issueView?.github_issue_number || workItem?.github_issue_number) && branchName && pullRequestNumber) {
          this.reportPassed(checkpoints, 'pull_request_created', `PR #${pullRequestNumber}`, input.reporter);
        }

        if (issueView?.tracker_state === 'In Review' || workItem?.linear_state === 'In Review') {
          this.reportPassed(checkpoints, 'tracker_in_review', 'In Review', input.reporter);
        }

        if (isRejectedDecision(reviewDecision)) {
          this.reportFailed(checkpoints, 'review_approved', String(reviewDecision), input.reporter);
          return this.finishFailure({
            startedAt,
            projectSlug: input.projectSlug,
            checkpoints,
            diagnostics,
            issueId,
            issueIdentifier,
            githubRepo,
            branchName,
            pullRequestNumber,
            reviewDecision,
            lastTimelineMessage,
            failureCode: 'review_not_approved',
            message: `Review finished with ${reviewDecision}, so the lifecycle verification did not complete.`,
          });
        }

        if (reviewDecision === 'MERGE_BLOCKED') {
          this.reportFailed(checkpoints, 'review_approved', 'MERGE_BLOCKED', input.reporter);
          return this.finishFailure({
            startedAt,
            projectSlug: input.projectSlug,
            checkpoints,
            diagnostics,
            issueId,
            issueIdentifier,
            githubRepo,
            branchName,
            pullRequestNumber,
            reviewDecision,
            lastTimelineMessage,
            failureCode: 'merge_blocked',
            message: 'Review passed but the merge was blocked.',
          });
        }

        if (isApprovedDecision(reviewDecision)) {
          this.reportPassed(checkpoints, 'review_approved', String(reviewDecision), input.reporter);
        }

        if (issueView?.tracker_state === 'Done' || workItem?.linear_state === 'Done') {
          this.reportPassed(checkpoints, 'merged_done', 'Done', input.reporter);
        }

        if (this.isCheckpointPassed(checkpoints, 'merged_done') && issueIdentifier) {
          const expectedWorktreePath = getWorktreePath(this.options.config.workspaceRoot, route.cacheKey, issueIdentifier);
          if (!fs.existsSync(expectedWorktreePath)) {
            this.reportPassed(checkpoints, 'workspace_cleaned', expectedWorktreePath, input.reporter);
          }

          if (branchName) {
            const branchCleaned = await this.checkBranchesCleaned(
              getSourcePath(this.options.config.workspaceRoot, route.cacheKey),
              branchName,
            );
            if (branchCleaned.ok) {
              this.reportPassed(checkpoints, 'branch_cleaned', branchName, input.reporter);
            }
          }

          if (
            diagnostics.running_issue_count === 0 &&
            diagnostics.retry_count === 0 &&
            diagnostics.worker_process_count === 0 &&
            diagnostics.active_session_count === 0 &&
            diagnostics.claimed_issue_count === 0 &&
            runtime.getOverview().counts.running === 0 &&
            runtime.getOverview().counts.retrying === 0
          ) {
            this.reportPassed(checkpoints, 'runtime_cleaned', 'No active runtime state', input.reporter);
          }
        }

        if (checkpoints.every((checkpoint) => checkpoint.status === 'passed')) {
          return {
            success: true,
            message: `Live lifecycle verification succeeded for ${issueIdentifier}.`,
            project_slug: input.projectSlug,
            issue_id: issueId,
            issue_identifier: issueIdentifier,
            github_repo: githubRepo,
            branch_name: branchName,
            pull_request_number: pullRequestNumber,
            review_decision: reviewDecision,
            failure_code: null,
            duration_ms: this.now() - startedAt,
            checkpoints,
            diagnostics,
            last_timeline_message: lastTimelineMessage,
          };
        }

        await this.sleep(Math.max(1, pollIntervalMs));
      }

      return this.finishFailure({
        startedAt,
        projectSlug: input.projectSlug,
        checkpoints,
        diagnostics,
        issueId,
        issueIdentifier,
        githubRepo,
        branchName,
        pullRequestNumber,
        reviewDecision,
        lastTimelineMessage,
        failureCode: 'timed_out',
        message: `Timed out waiting for the lifecycle verification of ${issueIdentifier ?? input.projectSlug}.`,
      });
    } catch (error) {
      const message = (error as Error).message;
      return this.finishFailure({
        startedAt,
        projectSlug: input.projectSlug,
        checkpoints,
        diagnostics,
        issueId,
        issueIdentifier,
        githubRepo,
        branchName,
        pullRequestNumber,
        reviewDecision,
        lastTimelineMessage,
        failureCode: /primary lease/i.test(message)
          ? 'orchestrator_lease_unavailable'
          : 'runtime_host_error',
        message,
      });
    } finally {
      if (host) {
        await host.stop();
      }
    }
  }

  private collectObservation(
    runtime: RuntimeControlPlane,
    host: RuntimeHostLike,
    issueId: string,
  ): VerificationObservation {
    return {
      issueView: runtime.getIssue(issueId),
      timeline: runtime.getTimeline(issueId, 20),
      diagnostics: host.getDiagnosticsSnapshot(),
    };
  }

  private buildIssueTitle(
    scenario: LiveLifecycleScenarioConfig,
    titleSuffix?: string | null,
  ): string {
    const base = `${scenario.title} [live-lifecycle ${new Date(this.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-')}]`;
    return titleSuffix?.trim() ? `${base} ${titleSuffix.trim()}` : base;
  }

  private buildIssueDescription(
    scenario: LiveLifecycleScenarioConfig,
    titleSuffix?: string | null,
  ): string {
    const nonceBase = titleSuffix?.trim() || formatVerificationNonce(this.now());
    const nonce = nonceBase.replace(/\s+/g, '-');
    return [
      scenario.description.trim(),
      '',
      `Verification nonce: ${nonce}`,
      'Create or update one uniquely named smoke-test file or tiny repo-safe change that includes this nonce.',
      'Avoid editing previously touched smoke-test files or common demo files from earlier verification runs.',
      'Keep the change tiny, safe to merge, and easy to clean up after the PR lands.',
    ].join('\n');
  }

  private resolveScenario(projectSlug: string): LiveLifecycleScenarioConfig | null {
    return this.options.config.verification.lifecycle.projects[projectSlug] ?? null;
  }

  private resolveRoute(projectSlug: string): { owner: string; repo: string; cacheKey: string } | null {
    const route = this.options.config.repositories.routing[projectSlug];
    if (!route) {
      return null;
    }

    return {
      owner: route.github_owner,
      repo: route.github_repo,
      cacheKey: buildCacheKey(route.github_owner, route.github_repo),
    };
  }

  private async checkBranchesCleaned(sourcePath: string, branchName: string): Promise<{ ok: boolean; detail: string }> {
    const local = await this.runGitCommand(['branch', '--list', branchName], sourcePath);
    if (local.exitCode !== 0) {
      return {
        ok: false,
        detail: `Failed to inspect local branch cleanup: ${local.stderr || local.stdout}`.trim(),
      };
    }
    if (local.stdout.trim()) {
      return {
        ok: false,
        detail: `Local branch still exists: ${branchName}`,
      };
    }

    const remote = await this.runGitCommand(['ls-remote', '--heads', 'origin', branchName], sourcePath);
    if (remote.exitCode !== 0) {
      return {
        ok: false,
        detail: `Failed to inspect remote branch cleanup: ${remote.stderr || remote.stdout}`.trim(),
      };
    }
    if (remote.stdout.trim()) {
      return {
        ok: false,
        detail: `Remote branch still exists: ${branchName}`,
      };
    }

    return {
      ok: true,
      detail: branchName,
    };
  }

  private markPassed(
    checkpoints: LiveLifecycleCheckpoint[],
    code: LiveLifecycleCheckpoint['code'],
    detail: string | null,
  ): boolean {
    const checkpoint = checkpoints.find((entry) => entry.code === code);
    if (!checkpoint || checkpoint.status === 'passed') {
      return false;
    }

    checkpoint.status = 'passed';
    checkpoint.detail = detail;
    checkpoint.timestamp = new Date(this.now()).toISOString();
    return true;
  }

  private markFailed(
    checkpoints: LiveLifecycleCheckpoint[],
    code: LiveLifecycleCheckpoint['code'],
    detail: string | null,
  ): boolean {
    const checkpoint = checkpoints.find((entry) => entry.code === code);
    if (!checkpoint || checkpoint.status === 'failed') {
      return false;
    }

    checkpoint.status = 'failed';
    checkpoint.detail = detail;
    checkpoint.timestamp = new Date(this.now()).toISOString();
    return true;
  }

  private reportPassed(
    checkpoints: LiveLifecycleCheckpoint[],
    code: LiveLifecycleCheckpoint['code'],
    detail: string | null,
    reporter?: (message: string) => void,
  ): void {
    if (this.markPassed(checkpoints, code, detail)) {
      reporter?.(`Checkpoint passed: ${CHECKPOINT_LABELS[code]}${detail ? ` · ${detail}` : ''}`);
    }
  }

  private reportFailed(
    checkpoints: LiveLifecycleCheckpoint[],
    code: LiveLifecycleCheckpoint['code'],
    detail: string | null,
    reporter?: (message: string) => void,
  ): void {
    if (this.markFailed(checkpoints, code, detail)) {
      reporter?.(`Checkpoint failed: ${CHECKPOINT_LABELS[code]}${detail ? ` · ${detail}` : ''}`);
    }
  }

  private isCheckpointPassed(
    checkpoints: LiveLifecycleCheckpoint[],
    code: LiveLifecycleCheckpoint['code'],
  ): boolean {
    return checkpoints.some((checkpoint) => checkpoint.code === code && checkpoint.status === 'passed');
  }

  private finishFailure(params: {
    startedAt: number;
    projectSlug: string;
    checkpoints: LiveLifecycleCheckpoint[];
    failureCode: string;
    message: string;
    diagnostics?: RuntimeDiagnosticsSnapshot | null;
    issueId?: string | null;
    issueIdentifier?: string | null;
    githubRepo?: string | null;
    branchName?: string | null;
    pullRequestNumber?: number | null;
    reviewDecision?: ReviewDecision | null;
    lastTimelineMessage?: string | null;
  }): LiveLifecycleVerificationResult {
    return {
      success: false,
      message: params.message,
      project_slug: params.projectSlug,
      issue_id: params.issueId ?? null,
      issue_identifier: params.issueIdentifier ?? null,
      github_repo: params.githubRepo ?? null,
      branch_name: params.branchName ?? null,
      pull_request_number: params.pullRequestNumber ?? null,
      review_decision: params.reviewDecision ?? null,
      failure_code: params.failureCode,
      duration_ms: this.now() - params.startedAt,
      checkpoints: params.checkpoints,
      diagnostics: params.diagnostics ?? null,
      last_timeline_message: params.lastTimelineMessage ?? null,
    };
  }
}
