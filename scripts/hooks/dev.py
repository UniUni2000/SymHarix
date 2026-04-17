# scripts/hooks/dev.py
"""DEV phase hook - handles development and PR creation."""

import subprocess
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

from lib.config import Config
from lib.github_client import GitHubClient
from lib.linear_client import LinearClient
from lib.retry import retry_with_backoff, RetryExhaustedError
from lib.state_machine import State
from lib.state_store import StateStore


class DevHook:
    """Handles the DEV phase of issue workflow."""

    def __init__(
        self,
        workspace_root: Path,
        issue_id: str,
        linear_issue_id: str,
        linear_state: str,
        github_repo: str,
        branch: str,
        linear_client: Optional[LinearClient] = None,
        github_client: Optional[GitHubClient] = None,
        config: Optional[Config] = None,
    ):
        self.workspace_root = workspace_root
        self.issue_id = issue_id
        self.linear_issue_id = linear_issue_id
        self.linear_state = linear_state
        self.github_repo = github_repo
        self.branch = branch

        # Use provided clients or load from config
        if config:
            self.linear = linear_client or LinearClient(
                api_key=config.linear_api_key,
                endpoint=config.linear_endpoint,
            )
            self.github = github_client or GitHubClient(
                token=config.github_token,
                owner=config.github_owner,
                repo=config.github_repo,
                default_branch=config.github_default_branch,
            )
        else:
            self.linear = linear_client
            self.github = github_client

        self.store = StateStore(workspace_root, issue_id)

    def initialize(self) -> None:
        """Initialize state.json for the issue."""
        if self.store.symphony_dir.exists():
            # Already initialized, check current state
            current = self.store.get_current_state_enum()
            if current and current != State.TODO:
                print(f"Issue {self.issue_id} already in state {current.value}")
                return

            # If TODO, proceed to transition
        else:
            self.store.initialize(
                linear_issue_id=self.linear_issue_id,
                linear_state=self.linear_state,
                github_repo=self.github_repo,
                branch=self.branch,
            )

        # Transition TODO -> IN_PROGRESS
        current = self.store.get_current_state_enum()
        if current == State.TODO:
            self.store.update_state(
                from_state=State.TODO,
                to_state=State.IN_PROGRESS,
                trigger="dispatch",
                actor="orchestrator",
            )

    def run(self) -> bool:
        """
        Run the DEV phase:
        1. Wait for Linear state to confirm IN_PROGRESS
        2. Run Claude Code agent
        3. Create/update PR
        4. Update Linear to In Review
        5. Wait for Linear to confirm In Review
        """
        # Step 1: Dual-check Linear state
        print(f"[DEV] Verifying Linear state for {self.issue_id}...")
        linear_current = self.linear.fetch_issue_state(self.issue_id)
        print(f"[DEV] Linear state: {linear_current}")

        current = self.store.get_current_state_enum()
        if current != State.IN_PROGRESS:
            print(f"[DEV] Issue not in IN_PROGRESS state, current: {current}")
            return False

        # Step 2: Run Claude Code agent
        print(f"[DEV] Running Claude Code agent...")
        success = self._run_agent()
        if not success:
            self.store.set_error("Claude Code agent failed")
            return False

        # Step 3: Create PR if not exists
        pr_info = self._ensure_pr_exists()
        if not pr_info:
            self.store.set_error("Failed to create PR")
            return False

        # Step 4: Update Linear to In Review
        print(f"[DEV] Updating Linear state to In Review...")
        in_review_state_id = self.linear.fetch_state_id("In Review")
        if not in_review_state_id:
            print("[DEV] ERROR: Could not find In Review state ID")
            self.store.set_error("Could not find In Review state ID")
            return False

        self.linear.update_issue_state(self.linear_issue_id, in_review_state_id)

        # Step 5: Wait for Linear to confirm
        print(f"[DEV] Waiting for Linear to confirm In Review...")
        confirmed = self.linear.wait_for_state(
            self.issue_id,
            "In Review",
            max_wait_seconds=30,
            poll_interval=2,
        )

        if not confirmed:
            print("[DEV] WARNING: Linear state not confirmed after update")
            # Continue anyway - might be eventual consistency

        # Step 6: Transition state to IN_REVIEW
        self.store.update_state(
            from_state=State.IN_PROGRESS,
            to_state=State.IN_REVIEW,
            trigger="pr_created",
            actor="dev-hook",
            metadata_updates={
                "pr_url": pr_info["url"],
                "pr_number": pr_info["number"],
            },
        )

        print(f"[DEV] Complete - PR: {pr_info['url']}")
        return True

    def _run_agent(self) -> bool:
        """Run Claude Code agent in the workspace."""
        workspace_path = self.store.symphony_dir.path.parent

        # Get issue info for prompt
        issue = self.linear.fetch_issue_by_identifier(self.issue_id)
        if not issue:
            print(f"[DEV] ERROR: Could not fetch issue {self.issue_id}")
            return False

        # Build prompt
        prompt = f"""Issue: {issue['identifier']} - {issue['title']}
Description: {issue.get('description', 'No description')}

Implement the required changes. When complete:
1. Run tests to verify
2. Commit your changes
3. Push to the branch {self.branch}
"""

        # Run Claude Code adapter
        # Note: This is a placeholder - actual implementation depends on claude-adapter.cjs
        cmd = ["node", "./scripts/claude-adapter.cjs", "--prompt", prompt]
        try:
            result = subprocess.run(
                cmd,
                cwd=workspace_path,
                capture_output=True,
                text=True,
                timeout=300,
            )
            return result.returncode == 0
        except subprocess.TimeoutExpired:
            print("[DEV] Agent timed out")
            return False
        except Exception as e:
            print(f"[DEV] Agent error: {e}")
            return False

    def _ensure_pr_exists(self) -> Optional[dict]:
        """Ensure PR exists for the branch, create if not."""
        # Check if PR already exists
        existing = self.github.pr_exists(self.branch)
        if existing:
            print(f"[DEV] PR already exists: {existing['html_url']}")
            return {"url": existing["html_url"], "number": existing["number"]}

        # Create PR
        issue = self.linear.fetch_issue_by_identifier(self.issue_id)
        title = f"[{self.issue_id}] {issue['title']}" if issue else self.issue_id
        body = f"""## Summary

Automated PR created by Symphony Agent Platform.

**Linear Issue:** {self.issue_id}

## Changes

Agent completed the task for issue [{self.issue_id}](https://linear.app/inteliway-symphony/issue/{self.issue_id}).
"""

        try:
            pr = self.github.create_pull_request(
                title=title,
                body=body,
                head=self.branch,
            )
            print(f"[DEV] PR created: {pr['html_url']}")
            return {"url": pr["html_url"], "number": pr["number"]}
        except Exception as e:
            print(f"[DEV] ERROR creating PR: {e}")
            return None
