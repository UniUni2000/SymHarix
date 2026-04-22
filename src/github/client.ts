export interface GitHubClientOptions {
  token: string;
  owner: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GitHubClient {
  private token: string;
  private owner: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.owner = options.owner;
  }

  async repoExists(repo: string): Promise<{ exists: boolean; error?: string }> {
    try {
      const response = await fetch(`https://api.github.com/repos/${this.owner}/${repo}`, {
        headers: {
          'Authorization': `token ${this.token}`,
          'Accept': 'application/vnd.github.v3+json'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (response.status === 200) {
        return { exists: true };
      }

      if (response.status === 404) {
        return { exists: false };
      }

      const error = await response.text();
      return { exists: false, error: `GitHub API error: ${response.status} - ${error}` };
    } catch (err) {
      return { exists: false, error: `Request failed: ${getErrorMessage(err)}` };
    }
  }

  async createRepo(repo: string, isPrivate: boolean = true): Promise<{ success: boolean; error?: string }> {
    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `token ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        name: repo,
        private: isPrivate,
        auto_init: false
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (response.status === 201) {
      return { success: true };
    }

    const error = await response
      .json()
      .catch(() => ({ message: 'Unknown error' })) as { message?: string };
    return { success: false, error: error.message || 'Unknown error' };
  }

  async getDefaultBranch(repo: string): Promise<string> {
    const response = await fetch(`https://api.github.com/repos/${this.owner}/${repo}`, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (response.status !== 200) {
      return 'main';
    }

    const data = (await response.json()) as { default_branch?: string };
    return data.default_branch || 'main';
  }
}
