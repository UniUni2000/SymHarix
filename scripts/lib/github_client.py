# scripts/lib/github_client.py
"""GitHub REST API client."""

from typing import Optional

import requests

class GitHubClient:
    """Client for GitHub REST API."""

    def __init__(self, token: str, owner: str, repo: str, default_branch: str = "main"):
        self.token = token
        self.owner = owner
        self.repo = repo
        self.default_branch = default_branch
        self.base_url = f"https://api.github.com/repos/{owner}/{repo}"
        self.headers = {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json",
        }

    def _get(self, path: str, **kwargs) -> dict:
        """Execute GET request."""
        url = f"{self.base_url}{path}"
        response = requests.get(url, headers=self.headers, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json()

    def _post(self, path: str, data: dict, **kwargs) -> dict:
        """Execute POST request."""
        url = f"{self.base_url}{path}"
        response = requests.post(url, json=data, headers=self.headers, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json()

    def _put(self, path: str, data: dict, **kwargs) -> dict:
        """Execute PUT request."""
        url = f"{self.base_url}{path}"
        response = requests.put(url, json=data, headers=self.headers, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json()

    def _patch(self, path: str, data: dict, **kwargs) -> dict:
        """Execute PATCH request."""
        url = f"{self.base_url}{path}"
        response = requests.patch(url, json=data, headers=self.headers, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json()

    def get_pull_request(self, pr_number: int) -> Optional[dict]:
        """Get pull request by number."""
        try:
            return self._get(f"/pulls/{pr_number}")
        except requests.HTTPError as e:
            if e.response.status_code == 404:
                return None
            raise

    def get_pull_request_by_branch(self, branch: str, state: str = "all") -> Optional[dict]:
        """Get pull request by head branch."""
        try:
            # Search for PRs with this head branch
            results = self._get(f"/pulls?head={self.owner}:{branch}&state={state}")
            if results and len(results) > 0:
                return results[0]
            return None
        except requests.HTTPError:
            return None

    def create_pull_request(
        self,
        title: str,
        body: str,
        head: str,
        draft: bool = False,
    ) -> dict:
        """Create a new pull request."""
        return self._post("/pulls", {
            "title": title,
            "body": body,
            "head": head,
            "base": self.default_branch,
            "draft": draft,
        })

    def add_issue_comment(self, issue_number: int, body: str) -> dict:
        """Post a comment to a GitHub issue."""
        return self._post(f"/issues/{issue_number}/comments", {"body": body})

    def add_pull_request_comment(self, pr_number: int, body: str) -> dict:
        """Post a timeline comment to a pull request."""
        return self._post(f"/issues/{pr_number}/comments", {"body": body})

    def merge_pull_request(
        self,
        pr_number: int,
        commit_title: Optional[str] = None,
        merge_method: str = "squash",
    ) -> dict:
        """Merge a pull request."""
        data = {"merge_method": merge_method}
        if commit_title:
            data["commit_title"] = commit_title

        return self._put(f"/pulls/{pr_number}/merge", data)

    def get_reviews(self, pr_number: int) -> list[dict]:
        """Get reviews for a pull request."""
        try:
            return self._get(f"/pulls/{pr_number}/reviews")
        except requests.HTTPError:
            return []

    def get_combined_status(self, branch: str) -> Optional[dict]:
        """Get combined CI status for a branch."""
        try:
            return self._get(f"/commits/{branch}/status")
        except requests.HTTPError:
            return None

    def get_pr_reviews_state(self, pr_number: int) -> str:
        """
        Determine overall PR review state.
        Returns: 'approved', 'changes_requested', 'pending', 'no_reviews'
        """
        reviews = self.get_reviews(pr_number)
        if not reviews:
            return "no_reviews"

        # Get latest review per user
        latest_by_user = {}
        for review in reviews:
            user = review.get("user", {}).get("login", "")
            state = review.get("state", "")
            if user and state in ("APPROVED", "CHANGES_REQUESTED"):
                latest_by_user[user] = state

        if not latest_by_user:
            return "pending"

        if "CHANGES_REQUESTED" in latest_by_user.values():
            return "changes_requested"
        elif "APPROVED" in latest_by_user.values():
            return "approved"
        else:
            return "pending"

    def pr_exists(self, branch: str) -> Optional[dict]:
        """Check if PR exists for branch and return it."""
        return self.get_pull_request_by_branch(branch, state="open")

    def list_issues(self, state: str = "all", per_page: int = 100) -> list[dict]:
        """List GitHub issues, excluding pull requests at the call site if needed."""
        return self._get(f"/issues?state={state}&per_page={per_page}")

    def find_issue_by_identifier(self, identifier: str, state: str = "all") -> Optional[dict]:
        """Find a GitHub issue whose title starts with the Linear identifier."""
        prefix = f"[{identifier.upper()}]"
        issues = self.list_issues(state=state)
        for issue in issues:
            if issue.get("pull_request"):
                continue
            title = issue.get("title", "")
            if title.upper().startswith(prefix):
                return issue
        return None

    def close_issue(self, issue_number: int) -> dict:
        """Close an existing GitHub issue."""
        return self._patch(f"/issues/{issue_number}", {"state": "closed"})
