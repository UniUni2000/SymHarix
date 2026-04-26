import { WorkItemRepository } from '../database/repositories/workItemRepository';
import { SyncEventRepository } from '../database/repositories/syncEventRepository';
import type { WorkItem, WorkItemOrchestratorState } from '../database/types';
import type { Issue } from '../types';
import { sanitizeWorkspaceKey } from '../workspace/shared';
import type {
  CreateIssueParams,
  CreatePullRequestParams,
  PullRequestDetails,
  UpdatePullRequestParams
} from './issue-client';

export interface GitHubMappingClient {
  issueExists(issueNumber: number): Promise<boolean>;
  createIssue(params: CreateIssueParams): Promise<{ number: number; url: string }>;
  getPullRequest(prNumber: number): Promise<PullRequestDetails>;
  findOpenPullRequestByBranch(branch: string): Promise<PullRequestDetails | null>;
  createPullRequest(params: CreatePullRequestParams): Promise<PullRequestDetails>;
  updatePullRequest(prNumber: number, params: UpdatePullRequestParams): Promise<PullRequestDetails>;
}

export interface GitHubMappingServiceOptions {
  workItemRepository: WorkItemRepository;
  syncEventRepository?: SyncEventRepository;
  githubClientFactory: (repo: string) => GitHubMappingClient;
}

export interface EnsureGitHubIssueResult {
  workItem: WorkItem;
  created: boolean;
  issue_url: string;
}

export interface EnsurePullRequestInput {
  workItemId: string;
  title: string;
  body?: string;
  headBranch: string;
  baseBranch?: string;
  draft?: boolean;
}

export interface EnsurePullRequestResult {
  workItem: WorkItem;
  pullRequest: PullRequestDetails;
  created: boolean;
}

export class GitHubMappingService {
  constructor(private options: GitHubMappingServiceOptions) {}

  ensureWorkItem(
    issue: Issue,
    githubRepo: string,
    initialState: WorkItemOrchestratorState = 'mapping'
  ): WorkItem {
    const existing = this.options.workItemRepository.findByLinearIssueId(issue.id);
    const orchestratorState = existing?.orchestrator_state === 'discovering'
      ? initialState
      : (existing?.orchestrator_state ?? initialState);

    return this.options.workItemRepository.upsert({
      id: existing?.id ?? issue.id,
      linear_issue_id: issue.id,
      linear_identifier: issue.identifier,
      linear_title: issue.title,
      linear_state: issue.state,
      github_repo: githubRepo,
      github_issue_number: existing?.github_issue_number ?? null,
      active_pr_number: existing?.active_pr_number ?? null,
      branch_name: issue.branch_name ?? existing?.branch_name ?? null,
      workspace_path: existing?.workspace_path ?? null,
      workspace_key: existing?.workspace_key ?? sanitizeWorkspaceKey(issue.identifier),
      orchestrator_state: orchestratorState,
      dev_attempt_count: existing?.dev_attempt_count ?? 0,
      review_round: existing?.review_round ?? 0,
      last_review_decision: existing?.last_review_decision ?? null,
      last_review_summary: existing?.last_review_summary ?? null,
      governance_root_issue_id: existing?.governance_root_issue_id ?? issue.id,
      governance_parent_issue_id: existing?.governance_parent_issue_id ?? null,
      governance_generation: existing?.governance_generation ?? 0,
      supervisor_root_session_id: existing?.supervisor_root_session_id ?? null,
      supervisor_plan_summary: existing?.supervisor_plan_summary ?? null,
      supervisor_acceptance_summary: existing?.supervisor_acceptance_summary ?? null,
      supervisor_execution_mode: existing?.supervisor_execution_mode ?? null,
      cancelled_at: existing?.cancelled_at ?? null,
      merged_at: existing?.merged_at ?? null,
    });
  }

  async ensureGitHubIssue(issue: Issue, githubRepo: string): Promise<EnsureGitHubIssueResult> {
    let workItem = this.ensureWorkItem(issue, githubRepo);
    const client = this.options.githubClientFactory(githubRepo);

    if (workItem.github_issue_number) {
      const exists = await client.issueExists(workItem.github_issue_number);
      if (exists) {
        return {
          workItem,
          created: false,
          issue_url: `https://github.com/${githubRepo}/issues/${workItem.github_issue_number}`,
        };
      }
    }

    const payload = {
      title: this.buildIssueTitle(issue),
      body: this.buildIssueBody(issue),
      labels: issue.labels,
    };

    try {
      const created = await client.createIssue(payload);
      workItem = this.options.workItemRepository.update({
        id: workItem.id,
        github_issue_number: created.number,
        orchestrator_state: 'mapping',
      }) ?? workItem;

      this.recordSync(workItem.id, 'github', 'create_issue', {
        repo: githubRepo,
        github_issue_number: created.number,
        title: payload.title,
      });

      return {
        workItem,
        created: true,
        issue_url: created.url,
      };
    } catch (error) {
      this.recordSync(workItem.id, 'github', 'create_issue', {
        repo: githubRepo,
        title: payload.title,
      }, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  attachWorkspace(workItemId: string, workspacePath: string, workspaceKey?: string): WorkItem {
    const workItem = this.getWorkItemOrThrow(workItemId);
    return this.options.workItemRepository.update({
      id: workItem.id,
      workspace_path: workspacePath,
      workspace_key: workspaceKey ?? workItem.workspace_key,
      orchestrator_state: workItem.orchestrator_state === 'mapping' ? 'workspace_ready' : workItem.orchestrator_state,
    }) ?? workItem;
  }

  async ensurePullRequest(input: EnsurePullRequestInput): Promise<EnsurePullRequestResult> {
    const workItem = this.getWorkItemOrThrow(input.workItemId);
    const client = this.options.githubClientFactory(workItem.github_repo);

    let existingPr: PullRequestDetails | null = null;
    if (workItem.active_pr_number) {
      try {
        existingPr = await client.getPullRequest(workItem.active_pr_number);
      } catch {
        existingPr = null;
      }
    }

    if (!existingPr) {
      existingPr = await client.findOpenPullRequestByBranch(input.headBranch);
    }

    let pullRequest = existingPr;
    let created = false;

    if (!pullRequest) {
      pullRequest = await client.createPullRequest({
        title: input.title,
        body: input.body ?? '',
        head: input.headBranch,
        base: input.baseBranch,
        draft: input.draft,
      });
      created = true;
    } else if (pullRequest.title !== input.title || (pullRequest.body ?? '') !== (input.body ?? '')) {
      pullRequest = await client.updatePullRequest(pullRequest.number, {
        title: input.title,
        body: input.body ?? '',
      });
    }

    const updatedWorkItem = this.options.workItemRepository.update({
      id: workItem.id,
      active_pr_number: pullRequest.number,
      branch_name: input.headBranch,
    }) ?? workItem;

    this.recordSync(updatedWorkItem.id, 'github', created ? 'create_pr' : 'ensure_pr', {
      repo: updatedWorkItem.github_repo,
      pr_number: pullRequest.number,
      branch_name: input.headBranch,
    });

    return {
      workItem: updatedWorkItem,
      pullRequest,
      created,
    };
  }

  findByLinearIssueId(linearIssueId: string): WorkItem | null {
    return this.options.workItemRepository.findByLinearIssueId(linearIssueId);
  }

  findByIdentifier(identifier: string): WorkItem | null {
    return this.options.workItemRepository.findByIdentifier(identifier);
  }

  findByPullRequest(repo: string, prNumber: number): WorkItem | null {
    return this.options.workItemRepository.findByActivePullRequest(repo, prNumber);
  }

  findByBranch(repo: string, branchName: string): WorkItem | null {
    return this.options.workItemRepository.findByBranchName(repo, branchName);
  }

  private buildIssueTitle(issue: Issue): string {
    return `[${issue.identifier}] ${issue.title}`;
  }

  private buildIssueBody(issue: Issue): string {
    return [
      '## Linear Issue',
      issue.url ? `[${issue.identifier}](${issue.url})` : issue.identifier,
      '',
      '## Description',
      issue.description || '_No description provided_',
      '',
      '## Metadata',
      `- State: ${issue.state}`,
      `- Project: ${issue.project_name || issue.project_slug || 'Unknown'}`,
      `- Priority: ${issue.priority !== null ? `P${issue.priority}` : 'Not set'}`,
      `- Labels: ${issue.labels.length > 0 ? issue.labels.join(', ') : 'None'}`,
    ].join('\n');
  }

  private getWorkItemOrThrow(workItemId: string): WorkItem {
    const workItem = this.options.workItemRepository.findById(workItemId);
    if (!workItem) {
      throw new Error(`Work item ${workItemId} not found`);
    }
    return workItem;
  }

  private recordSync(
    workItemId: string,
    targetSystem: 'github' | 'linear',
    action: string,
    payload: Record<string, unknown>,
    result: 'success' | 'failed' = 'success',
    error?: string
  ): void {
    if (!this.options.syncEventRepository) {
      return;
    }

    this.options.syncEventRepository.create({
      id: crypto.randomUUID(),
      work_item_id: workItemId,
      target_system: targetSystem,
      action,
      payload_json: payload,
      result,
      error: error ?? null,
    });
  }
}
