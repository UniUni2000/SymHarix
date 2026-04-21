import { AgentRunRepository } from '../database/repositories/agentRunRepository';
import { ReviewEventRepository } from '../database/repositories/reviewEventRepository';
import { WorkItemRepository } from '../database/repositories/workItemRepository';
import type { AgentRun, ReviewEvent, WorkItem } from '../database/types';
import type {
  CombinedStatusContext,
  GitHubIssueComment,
  GitHubIssueDetails,
  PullRequestDetails,
  PullRequestReview,
  PullRequestReviewComment
} from './issue-client';

export interface GitHubContextClient {
  getIssue(issueNumber: number): Promise<GitHubIssueDetails>;
  listIssueComments(issueNumber: number): Promise<GitHubIssueComment[]>;
  getPullRequest(prNumber: number): Promise<PullRequestDetails>;
  findOpenPullRequestByBranch(branch: string): Promise<PullRequestDetails | null>;
  listPullRequestReviews(prNumber: number): Promise<PullRequestReview[]>;
  listPullRequestReviewComments(prNumber: number): Promise<PullRequestReviewComment[]>;
  getCombinedStatus(ref: string): Promise<CombinedStatusContext | null>;
}

export interface GitHubReviewThread {
  thread_key: string;
  path: string | null;
  line: number | null;
  resolved: boolean | null;
  comments: PullRequestReviewComment[];
}

export interface PullRequestContext extends PullRequestDetails {
  review_state: 'approved' | 'changes_requested' | 'pending' | 'no_reviews';
  reviews: PullRequestReview[];
  review_comments: PullRequestReviewComment[];
  review_threads: GitHubReviewThread[];
  combined_status: CombinedStatusContext | null;
}

export interface DevAgentContext {
  work_item: WorkItem;
  github_issue: GitHubIssueDetails | null;
  issue_comments: GitHubIssueComment[];
  active_pr: PullRequestContext | null;
  unresolved_review_threads: GitHubReviewThread[];
  latest_review: ReviewEvent | null;
  recent_agent_runs: AgentRun[];
}

export interface ReviewAgentContext {
  work_item: WorkItem;
  github_issue: GitHubIssueDetails | null;
  issue_comments: GitHubIssueComment[];
  active_pr: PullRequestContext | null;
  previous_reviews: ReviewEvent[];
  latest_dev_run: AgentRun | null;
}

export interface GitHubContextServiceOptions {
  workItemRepository: WorkItemRepository;
  reviewEventRepository: ReviewEventRepository;
  agentRunRepository: AgentRunRepository;
  githubClientFactory: (repo: string) => GitHubContextClient;
}

export class GitHubContextService {
  constructor(private options: GitHubContextServiceOptions) {}

  async buildDevContext(workItemId: string): Promise<DevAgentContext> {
    const base = await this.loadBaseContext(workItemId);
    const recentAgentRuns = this.options.agentRunRepository.findByWorkItemId(workItemId).slice(-10);

    return {
      work_item: base.workItem,
      github_issue: base.githubIssue,
      issue_comments: base.issueComments,
      active_pr: base.activePullRequest,
      unresolved_review_threads: base.activePullRequest?.review_threads ?? [],
      latest_review: this.options.reviewEventRepository.findLatestByWorkItemId(workItemId),
      recent_agent_runs: recentAgentRuns,
    };
  }

  async buildReviewContext(workItemId: string): Promise<ReviewAgentContext> {
    const base = await this.loadBaseContext(workItemId);
    const latestDevRun = [...this.options.agentRunRepository.findByWorkItemId(workItemId)]
      .reverse()
      .find(run => run.agent_type === 'dev') ?? null;

    return {
      work_item: base.workItem,
      github_issue: base.githubIssue,
      issue_comments: base.issueComments,
      active_pr: base.activePullRequest,
      previous_reviews: this.options.reviewEventRepository.findByWorkItemId(workItemId),
      latest_dev_run: latestDevRun,
    };
  }

  private async loadBaseContext(workItemId: string): Promise<{
    workItem: WorkItem;
    githubIssue: GitHubIssueDetails | null;
    issueComments: GitHubIssueComment[];
    activePullRequest: PullRequestContext | null;
  }> {
    const workItem = this.options.workItemRepository.findById(workItemId);
    if (!workItem) {
      throw new Error(`Work item ${workItemId} not found`);
    }

    if (!workItem.github_issue_number) {
      return {
        workItem,
        githubIssue: null,
        issueComments: [],
        activePullRequest: null,
      };
    }

    const client = this.options.githubClientFactory(workItem.github_repo);
    const [githubIssue, issueComments] = await Promise.all([
      client.getIssue(workItem.github_issue_number),
      client.listIssueComments(workItem.github_issue_number),
    ]);

    const activePullRequest = await this.loadPullRequestContext(workItem, client);

    return {
      workItem,
      githubIssue,
      issueComments,
      activePullRequest,
    };
  }

  private async loadPullRequestContext(
    workItem: WorkItem,
    client: GitHubContextClient
  ): Promise<PullRequestContext | null> {
    let pullRequest: PullRequestDetails | null = null;

    if (workItem.active_pr_number) {
      try {
        pullRequest = await client.getPullRequest(workItem.active_pr_number);
      } catch {
        pullRequest = null;
      }
    }

    if (!pullRequest && workItem.branch_name) {
      pullRequest = await client.findOpenPullRequestByBranch(workItem.branch_name);
    }

    if (!pullRequest) {
      return null;
    }

    const [reviews, reviewComments, combinedStatus] = await Promise.all([
      client.listPullRequestReviews(pullRequest.number),
      client.listPullRequestReviewComments(pullRequest.number),
      client.getCombinedStatus(pullRequest.head_sha || pullRequest.head_branch),
    ]);

    return {
      ...pullRequest,
      review_state: this.computeReviewState(reviews),
      reviews,
      review_comments: reviewComments,
      review_threads: this.buildReviewThreads(reviewComments),
      combined_status: combinedStatus,
    };
  }

  private computeReviewState(reviews: PullRequestReview[]): 'approved' | 'changes_requested' | 'pending' | 'no_reviews' {
    if (reviews.length === 0) {
      return 'no_reviews';
    }

    const latestByAuthor = new Map<string, PullRequestReview>();
    for (const review of reviews) {
      const authorKey = review.author || `review-${review.id}`;
      latestByAuthor.set(authorKey, review);
    }

    const latestStates = [...latestByAuthor.values()].map(review => review.state);
    if (latestStates.includes('CHANGES_REQUESTED')) {
      return 'changes_requested';
    }
    if (latestStates.includes('APPROVED')) {
      return 'approved';
    }
    return 'pending';
  }

  private buildReviewThreads(comments: PullRequestReviewComment[]): GitHubReviewThread[] {
    if (comments.length === 0) {
      return [];
    }

    const commentById = new Map<number, PullRequestReviewComment>();
    for (const comment of comments) {
      commentById.set(comment.id, comment);
    }

    const grouped = new Map<number, PullRequestReviewComment[]>();
    for (const comment of comments) {
      let rootId = comment.id;
      let parentId = comment.in_reply_to_id;

      while (parentId && commentById.has(parentId)) {
        rootId = parentId;
        parentId = commentById.get(parentId)?.in_reply_to_id ?? null;
      }

      const existing = grouped.get(rootId) ?? [];
      existing.push(comment);
      grouped.set(rootId, existing);
    }

    return [...grouped.entries()]
      .map(([rootId, threadComments]) => {
        const sorted = [...threadComments].sort((a, b) => a.created_at.localeCompare(b.created_at));
        const head = sorted[0];
        return {
          thread_key: String(rootId),
          path: head?.path ?? null,
          line: head?.line ?? null,
          // REST v3 does not expose review-thread resolution directly.
          resolved: null,
          comments: sorted,
        };
      })
      .sort((a, b) => a.thread_key.localeCompare(b.thread_key));
  }
}
