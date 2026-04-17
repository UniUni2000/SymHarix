export interface GitHubClientOptions {
  token: string;
  owner: string;
}

export class GitHubClient {
  private token: string;
  private owner: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.owner = options.owner;
  }

  async repoExists(repo: string): Promise<boolean> {
    const response = await fetch(`https://api.github.com/repos/${this.owner}/${repo}`, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    return response.status === 200;
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
      })
    });

    if (response.status === 201) {
      return { success: true };
    }

    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    return { success: false, error: error.message };
  }

  async getDefaultBranch(repo: string): Promise<string> {
    const response = await fetch(`https://api.github.com/repos/${this.owner}/${repo}`, {
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (response.status !== 200) {
      return 'main';
    }

    const data = await response.json();
    return data.default_branch || 'main';
  }
}