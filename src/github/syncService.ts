import { SyncEventRepository } from '../database/repositories/syncEventRepository';
import { WorkItemRepository } from '../database/repositories/workItemRepository';
import type { WorkItem } from '../database/types';

export interface GitHubSyncClient {
  addComment(issueNumber: number, body: string): Promise<void>;
  addPullRequestComment(prNumber: number, body: string): Promise<void>;
}

export interface GitHubSyncServiceOptions {
  workItemRepository: WorkItemRepository;
  syncEventRepository: SyncEventRepository;
  githubClientFactory: (repo: string) => GitHubSyncClient;
}

export class GitHubSyncService {
  constructor(private options: GitHubSyncServiceOptions) {}

  async postIssueComment(workItemId: string, body: string, action: string = 'comment_issue'): Promise<void> {
    const workItem = this.getWorkItemOrThrow(workItemId);
    if (!workItem.github_issue_number) {
      throw new Error(`Work item ${workItemId} has no GitHub issue mapping`);
    }

    await this.runSync(
      workItem,
      action,
      { issue_number: workItem.github_issue_number, body },
      client => client.addComment(workItem.github_issue_number!, body)
    );
  }

  async postPullRequestComment(workItemId: string, body: string, action: string = 'comment_pull_request'): Promise<void> {
    const workItem = this.getWorkItemOrThrow(workItemId);
    if (!workItem.active_pr_number) {
      throw new Error(`Work item ${workItemId} has no active pull request`);
    }

    await this.runSync(
      workItem,
      action,
      { pr_number: workItem.active_pr_number, body },
      client => client.addPullRequestComment(workItem.active_pr_number!, body)
    );
  }

  async publishPullRequestSummary(workItemId: string, summaryMd: string): Promise<void> {
    const workItem = this.getWorkItemOrThrow(workItemId);
    if (!workItem.active_pr_number) {
      throw new Error(`Work item ${workItemId} has no active pull request`);
    }

    const body = [
      '## PR Update',
      `PR #${workItem.active_pr_number}${workItem.branch_name ? ` on \`${workItem.branch_name}\`` : ''}`,
      '',
      summaryMd.trim(),
    ].join('\n');

    await this.postIssueComment(workItemId, body, 'publish_pr_summary');
  }

  private getWorkItemOrThrow(workItemId: string): WorkItem {
    const workItem = this.options.workItemRepository.findById(workItemId);
    if (!workItem) {
      throw new Error(`Work item ${workItemId} not found`);
    }
    return workItem;
  }

  private async runSync(
    workItem: WorkItem,
    action: string,
    payload: Record<string, unknown>,
    operation: (client: GitHubSyncClient) => Promise<void>
  ): Promise<void> {
    const client = this.options.githubClientFactory(workItem.github_repo);
    try {
      await operation(client);
      this.options.syncEventRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        target_system: 'github',
        action,
        payload_json: payload,
      });
    } catch (error) {
      this.options.syncEventRepository.create({
        id: crypto.randomUUID(),
        work_item_id: workItem.id,
        target_system: 'github',
        action,
        payload_json: payload,
        result: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
