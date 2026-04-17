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

export class GitHubIssueClient {
  private token: string;
  private owner: string;
  private repo: string;

  constructor(options: GitHubIssueClientOptions) {
    this.token = options.token;
    this.owner = options.owner;
    this.repo = options.repo;
  }

  private headers(): HeadersInit {
    return {
      'Authorization': `token ${this.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };
  }

  async issueExists(issueNumber: number): Promise<boolean> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(10000)
      }
    );

    return response.status === 200;
  }

  async createIssue(params: CreateIssueParams): Promise<{ number: number; url: string }> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          title: params.title,
          body: params.body ?? '',
          labels: params.labels ?? []
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status !== 201) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(`Failed to create issue: ${error.message}`);
    }

    const data = await response.json();
    return { number: data.number, url: data.html_url };
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status !== 201) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(`Failed to add comment: ${error.message}`);
    }
  }

  async getIssue(issueNumber: number): Promise<{ title: string; body: string | null; labels: string[] }> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status === 404) {
      throw new Error(`Issue ${issueNumber} not found`);
    }

    if (response.status !== 200) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(`Failed to get issue: ${error.message}`);
    }

    const data = await response.json();
    return {
      title: data.title,
      body: data.body,
      labels: data.labels.map((l: any) => l.name)
    };
  }

  async closeIssue(issueNumber: number): Promise<void> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ state: 'closed' }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status !== 200) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(`Failed to close issue: ${error.message}`);
    }
  }
}
