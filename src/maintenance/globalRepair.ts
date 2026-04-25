import type { WorkItemRepository } from '../database';
import type { PullRequestDetails, UpdatePullRequestParams, GitHubIssueDetails } from '../github/issue-client';
import type { Issue, ServiceConfig } from '../types';

export interface GlobalRepairSummary {
  terminal_issues_scanned: number;
  repos_scanned: number;
  github_issues_closed: number;
  github_prs_closed: number;
}

export interface GlobalRepairTracker {
  fetchIssuesByStates(states: string[]): Promise<{ issues: Issue[]; error?: string | null }>;
}

export interface GlobalRepairGitHubClient {
  listOpenIssues(): Promise<GitHubIssueDetails[]>;
  listOpenPullRequests(): Promise<PullRequestDetails[]>;
  closeIssue(issueNumber: number): Promise<void>;
  updatePullRequest(prNumber: number, params: UpdatePullRequestParams): Promise<PullRequestDetails>;
}

export interface GlobalRepairServiceOptions {
  config: ServiceConfig;
  tracker: GlobalRepairTracker;
  workItemRepository: WorkItemRepository;
  githubClientFactory: (repo: string) => GlobalRepairGitHubClient;
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function extractIdentifierFromText(value: string | null | undefined): string | null {
  const match = value?.match(/\b([A-Za-z]+-\d+)\b/);
  return normalizeIdentifier(match?.[1] ?? null);
}

function extractIdentifierFromBranch(branchName: string | null | undefined): string | null {
  const match = branchName?.match(/([A-Za-z]+-\d+)/);
  return normalizeIdentifier(match?.[1] ?? null);
}

function isTerminalState(states: string[], value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return states.some((state) => state.toLowerCase() === normalized);
}

export class GlobalRepairService {
  constructor(private readonly options: GlobalRepairServiceOptions) {}

  async repair(): Promise<GlobalRepairSummary> {
    const fetched = await this.options.tracker.fetchIssuesByStates(this.options.config.terminalStates);
    if (fetched.error) {
      console.warn('[repair] Failed to fetch terminal tracker issues, falling back to local terminal work items:', fetched.error);
    }
    return this.repairFromTerminalIssues(fetched.issues ?? []);
  }

  async repairFromTerminalIssues(issues: Issue[]): Promise<GlobalRepairSummary> {
    const terminalIdentifiersByRepo = new Map<string, Set<string>>();

    for (const issue of issues) {
      const repo = this.resolveRepoForIssue(issue);
      const identifier = normalizeIdentifier(issue.identifier);
      if (!repo || !identifier) {
        continue;
      }
      if (!terminalIdentifiersByRepo.has(repo)) {
        terminalIdentifiersByRepo.set(repo, new Set());
      }
      terminalIdentifiersByRepo.get(repo)?.add(identifier);
    }

    for (const workItem of this.options.workItemRepository.findAll()) {
      if (!isTerminalState(this.options.config.terminalStates, workItem.linear_state)) {
        continue;
      }
      const identifier = normalizeIdentifier(workItem.linear_identifier);
      if (!identifier) {
        continue;
      }
      if (!terminalIdentifiersByRepo.has(workItem.github_repo)) {
        terminalIdentifiersByRepo.set(workItem.github_repo, new Set());
      }
      terminalIdentifiersByRepo.get(workItem.github_repo)?.add(identifier);
    }

    let githubIssuesClosed = 0;
    let githubPrsClosed = 0;
    for (const [repo, identifiers] of terminalIdentifiersByRepo.entries()) {
      const client = this.options.githubClientFactory(repo);

      let openIssues: GitHubIssueDetails[] = [];
      try {
        openIssues = await client.listOpenIssues();
      } catch (error) {
        console.warn(`[repair] Failed to list open GitHub issues for ${repo}:`, error);
        continue;
      }
      for (const issue of openIssues) {
        const identifier =
          extractIdentifierFromText(issue.title)
          ?? extractIdentifierFromText(issue.body);
        if (!identifier || !identifiers.has(identifier)) {
          continue;
        }
        try {
          await client.closeIssue(issue.number);
          githubIssuesClosed += 1;
        } catch (error) {
          console.warn(`[repair] Failed to close GitHub issue #${issue.number} in ${repo}:`, error);
        }
      }

      let openPullRequests: PullRequestDetails[] = [];
      try {
        openPullRequests = await client.listOpenPullRequests();
      } catch (error) {
        console.warn(`[repair] Failed to list open GitHub pull requests for ${repo}:`, error);
        continue;
      }
      for (const pullRequest of openPullRequests) {
        const identifier =
          extractIdentifierFromText(pullRequest.title)
          ?? extractIdentifierFromText(pullRequest.body)
          ?? extractIdentifierFromBranch(pullRequest.head_branch);
        if (!identifier || !identifiers.has(identifier)) {
          continue;
        }
        try {
          await client.updatePullRequest(pullRequest.number, { state: 'closed' });
          githubPrsClosed += 1;
        } catch (error) {
          console.warn(`[repair] Failed to close GitHub pull request #${pullRequest.number} in ${repo}:`, error);
        }
      }
    }

    return {
      terminal_issues_scanned: issues.length,
      repos_scanned: terminalIdentifiersByRepo.size,
      github_issues_closed: githubIssuesClosed,
      github_prs_closed: githubPrsClosed,
    };
  }

  private resolveRepoForIssue(issue: Issue): string | null {
    const route = issue.project_slug ? this.options.config.repositories.routing[issue.project_slug] : null;
    if (route) {
      return `${route.github_owner}/${route.github_repo}`;
    }

    return this.options.workItemRepository.findByIdentifier(issue.identifier)?.github_repo ?? null;
  }
}
