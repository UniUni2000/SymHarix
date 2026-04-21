export interface GitHubIssueClientOptions {
  token: string;
  owner: string;
  repo: string;
}

export interface CreateIssueParams {
  title: string;
  body?: string;
  labels?: string[];
}

export interface GitHubIssueDetails {
  number: number;
  url: string;
  title: string;
  body: string | null;
  labels: string[];
  state: string;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  author: string | null;
  created_at: string;
  updated_at: string;
  url: string;
}

export interface CreatePullRequestParams {
  title: string;
  body?: string;
  head: string;
  base?: string;
  draft?: boolean;
}

export interface UpdatePullRequestParams {
  title?: string;
  body?: string;
  base?: string;
  state?: 'open' | 'closed';
}

export interface PullRequestDetails {
  number: number;
  url: string;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  head_branch: string;
  head_sha: string;
  base_branch: string;
  mergeable: boolean | null;
  mergeable_state: string | null;
}

export interface PullRequestReview {
  id: number;
  state: string;
  body: string | null;
  author: string | null;
  submitted_at: string | null;
  commit_id: string | null;
  url: string;
}

export interface PullRequestReviewComment {
  id: number;
  body: string;
  path: string | null;
  line: number | null;
  in_reply_to_id: number | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  url: string;
}

export interface CombinedStatusContext {
  state: string;
  statuses: Array<{
    context: string;
    state: string;
    description: string | null;
    target_url: string | null;
  }>;
}

export class GitHubIssueClient {
  private token: string;
  private owner: string;
  private repo: string;

  constructor(options: GitHubIssueClientOptions) {
    this.token = options.token;
    this.owner = options.owner;
    this.repo = options.repo;
  }

  private baseUrl(): string {
    return `https://api.github.com/repos/${this.owner}/${this.repo}`;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `token ${this.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };
  }

  private mergeHeaders(extraHeaders?: RequestInit['headers']): Record<string, string> {
    const headers = { ...this.headers() };
    if (!extraHeaders) {
      return headers;
    }

    if (Array.isArray(extraHeaders)) {
      for (const [key, value] of extraHeaders) {
        headers[key] = value;
      }
      return headers;
    }

    if (typeof Headers !== 'undefined' && extraHeaders instanceof Headers) {
      extraHeaders.forEach((value, key) => {
        headers[key] = value;
      });
      return headers;
    }

    for (const [key, value] of Object.entries(extraHeaders)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }

    return headers;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${this.baseUrl()}${path}`, {
      ...init,
      headers: this.mergeHeaders(init.headers),
      signal: AbortSignal.timeout(10000)
    });

    if (response.ok) {
      return response;
    }

    const error = await response.json().catch(async (): Promise<{ message: string }> => ({
      message: await response.text().catch(() => 'Unknown error')
    })) as { message?: string };
    throw new Error(`GitHub API error (${response.status}): ${error.message || 'Unknown error'}`);
  }

  private mapIssue(data: any): GitHubIssueDetails {
    return {
      number: data.number,
      url: data.html_url,
      title: data.title,
      body: data.body,
      labels: Array.isArray(data.labels) ? data.labels.map((label: any) => label.name) : [],
      state: data.state,
    };
  }

  private mapIssueComment(data: any): GitHubIssueComment {
    return {
      id: data.id,
      body: data.body ?? '',
      author: data.user?.login ?? null,
      created_at: data.created_at,
      updated_at: data.updated_at,
      url: data.html_url,
    };
  }

  private mapPullRequest(data: any): PullRequestDetails {
    return {
      number: data.number,
      url: data.html_url,
      title: data.title,
      body: data.body,
      state: data.state,
      draft: Boolean(data.draft),
      head_branch: data.head?.ref ?? '',
      head_sha: data.head?.sha ?? '',
      base_branch: data.base?.ref ?? '',
      mergeable: typeof data.mergeable === 'boolean' ? data.mergeable : null,
      mergeable_state: data.mergeable_state ?? null,
    };
  }

  async issueExists(issueNumber: number): Promise<boolean> {
    const response = await fetch(
      `${this.baseUrl()}/issues/${issueNumber}`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(10000)
      }
    );

    return response.status === 200;
  }

  async createIssue(params: CreateIssueParams): Promise<GitHubIssueDetails> {
    const response = await this.request('/issues', {
      method: 'POST',
      body: JSON.stringify({
        title: params.title,
        body: params.body ?? '',
        labels: params.labels ?? []
      })
    });

    const data = await response.json();
    return this.mapIssue(data);
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    await this.request(`/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body })
    });
  }

  async listIssueComments(issueNumber: number): Promise<GitHubIssueComment[]> {
    const response = await this.request(`/issues/${issueNumber}/comments`);
    const data = await response.json();
    return Array.isArray(data) ? data.map(comment => this.mapIssueComment(comment)) : [];
  }

  async getIssue(issueNumber: number): Promise<GitHubIssueDetails> {
    const response = await fetch(
      `${this.baseUrl()}/issues/${issueNumber}`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status === 404) {
      throw new Error(`Issue ${issueNumber} not found`);
    }

    if (response.status !== 200) {
      const error = await response.json().catch((): { message: string } => ({ message: 'Unknown error' })) as { message?: string };
      throw new Error(`Failed to get issue: ${error.message}`);
    }

    const data = await response.json();
    return this.mapIssue(data);
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.request(`/issues/${issueNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' })
    });
  }

  async getPullRequest(prNumber: number): Promise<PullRequestDetails> {
    const response = await this.request(`/pulls/${prNumber}`);
    const data = await response.json();
    return this.mapPullRequest(data);
  }

  async findOpenPullRequestByBranch(branch: string): Promise<PullRequestDetails | null> {
    const response = await this.request(`/pulls?head=${encodeURIComponent(`${this.owner}:${branch}`)}&state=open`);
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }
    return this.mapPullRequest(data[0]);
  }

  async createPullRequest(params: CreatePullRequestParams): Promise<PullRequestDetails> {
    const response = await this.request('/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: params.title,
        body: params.body ?? '',
        head: params.head,
        base: params.base ?? 'main',
        draft: params.draft ?? false
      })
    });
    const data = await response.json();
    return this.mapPullRequest(data);
  }

  async updatePullRequest(prNumber: number, params: UpdatePullRequestParams): Promise<PullRequestDetails> {
    const response = await this.request(`/pulls/${prNumber}`, {
      method: 'PATCH',
      body: JSON.stringify(params)
    });
    const data = await response.json();
    return this.mapPullRequest(data);
  }

  async addPullRequestComment(prNumber: number, body: string): Promise<void> {
    await this.addComment(prNumber, body);
  }

  async listPullRequestReviews(prNumber: number): Promise<PullRequestReview[]> {
    const response = await this.request(`/pulls/${prNumber}/reviews`);
    const data = await response.json();
    return Array.isArray(data)
      ? data.map((review: any) => ({
          id: review.id,
          state: review.state,
          body: review.body,
          author: review.user?.login ?? null,
          submitted_at: review.submitted_at ?? null,
          commit_id: review.commit_id ?? null,
          url: review.html_url,
        }))
      : [];
  }

  async listPullRequestReviewComments(prNumber: number): Promise<PullRequestReviewComment[]> {
    const response = await this.request(`/pulls/${prNumber}/comments`);
    const data = await response.json();
    return Array.isArray(data)
      ? data.map((comment: any) => ({
          id: comment.id,
          body: comment.body ?? '',
          path: comment.path ?? null,
          line: comment.line ?? null,
          in_reply_to_id: comment.in_reply_to_id ?? null,
          author: comment.user?.login ?? null,
          created_at: comment.created_at,
          updated_at: comment.updated_at,
          url: comment.html_url,
        }))
      : [];
  }

  async getCombinedStatus(ref: string): Promise<CombinedStatusContext | null> {
    const response = await fetch(`${this.baseUrl()}/commits/${encodeURIComponent(ref)}/status`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10000)
    });

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      const error = await response.json().catch((): { message: string } => ({ message: 'Unknown error' })) as { message?: string };
      throw new Error(`Failed to get combined status: ${error.message}`);
    }

    const data = await response.json() as { state?: string; statuses?: any[] };
    return {
      state: data.state ?? 'unknown',
      statuses: Array.isArray(data.statuses)
        ? data.statuses.map((status: any) => ({
            context: status.context ?? 'unknown',
            state: status.state ?? 'unknown',
            description: status.description ?? null,
            target_url: status.target_url ?? null,
          }))
        : [],
    };
  }

  async mergePullRequest(
    prNumber: number,
    options: { commit_title?: string; merge_method?: 'merge' | 'squash' | 'rebase' } = {}
  ): Promise<{ merged: boolean; message: string; sha?: string }> {
    const response = await fetch(`${this.baseUrl()}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({
        commit_title: options.commit_title,
        merge_method: options.merge_method ?? 'squash'
      }),
      signal: AbortSignal.timeout(10000)
    });

    const data = await response.json().catch((): { merged: boolean; message: string } => ({
      merged: false,
      message: 'Unknown error'
    })) as { merged?: boolean; message?: string; sha?: string };
    if (response.status === 200) {
      return {
        merged: Boolean(data.merged),
        message: data.message ?? 'Merged',
        sha: data.sha ?? undefined,
      };
    }

    if (response.status === 405 || response.status === 409) {
      return {
        merged: false,
        message: data.message ?? 'Merge blocked',
      };
    }

    throw new Error(`Failed to merge pull request: ${data.message || 'Unknown error'}`);
  }
}
