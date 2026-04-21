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
    WORKFLOW_ARTIFACT_PATHS = (
        "DEVELOPMENT_LOG.md",
        "HANDOVER.md",
        "REVIEW_REPORT.md",
        ".symphony",
    )

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
            # Parse github_repo from state (format: "owner/repo")
            if github_repo and "/" in github_repo:
                gh_owner, gh_repo = github_repo.split("/", 1)
            else:
                gh_owner, gh_repo = config.github_owner, (github_repo or config.github_repo)
            self.github = github_client or GitHubClient(
                token=config.github_token,
                owner=gh_owner,
                repo=gh_repo,
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
        Run the DEV phase (hybrid mode - orchestrator handles agent):
        1. Verify local state
        2. (orchestrator already ran Claude Code agent)
        3. Create/update PR
        4. Move local state to IN_REVIEW
        """
        current = self.store.get_current_state_enum()
        # Allow both TODO (standalone mode) and IN_PROGRESS (orchestrator hybrid mode)
        if current not in (State.IN_PROGRESS, State.TODO):
            print(f"[DEV] Issue not in valid state for dev, current: {current}")
            return False

        # Step 2: In hybrid mode, orchestrator runs the agent.
        # If already IN_PROGRESS, agent was already run by orchestrator
        # If TODO, we're in standalone mode and should run agent (skip in hybrid)

        # Step 3: Create PR if not exists
        try:
            pr_info = self._ensure_pr_exists()
        except Exception as e:
            error_message = str(e) or "Failed to create PR"
            print(f"[DEV] ERROR: {error_message}")
            self.store.set_error(error_message)
            return False

        # Step 4: Transition local state to IN_REVIEW
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

        self._publish_handover_summary(pr_info["number"])

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
2. Write handover details to .symphony/HANDOVER.md
3. Do not commit files under .symphony/
4. Commit only product code changes
5. Push to the branch {self.branch}
"""

        # Run Claude Code adapter
        # Use absolute path since adapter is in project root, not workspace
        import os
        project_root = os.environ.get("SYMPHONY_PROJECT_ROOT", str(Path(__file__).parent.parent.parent))
        cmd = ["node", f"{project_root}/scripts/claude-adapter.cjs", "--prompt", prompt]
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
        self._prepare_branch_for_pr()

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
            raise RuntimeError(f"ERROR creating PR: {e}") from e

    def _prepare_branch_for_pr(self) -> None:
        """Verify the branch has changes and is pushed before PR creation."""
        base_ref = self._resolve_base_ref()
        self._sanitize_workflow_artifacts_for_pr(base_ref)
        ahead_count = self._count_commits_ahead(base_ref)
        if ahead_count <= 0:
            if self._workspace_has_uncommitted_changes():
                raise RuntimeError(
                    f"Workspace for {self.branch} has uncommitted changes but no commits "
                    f"relative to {base_ref}; commit and push are required before PR creation"
                )
            raise RuntimeError(
                f"No commits found on {self.branch} relative to {base_ref}; skipping PR creation"
            )

        local_head = self._git_stdout("rev-parse", "HEAD")
        remote_ref = f"refs/remotes/origin/{self.branch}"
        remote_head = self._try_git_stdout("rev-parse", "--verify", remote_ref)

        if remote_head == local_head:
            print(f"[DEV] Branch {self.branch} already pushed at {local_head[:8]}")
            return

        print(f"[DEV] Pushing branch {self.branch} to origin")
        push_result = self._git(
            "push",
            "-u",
            "origin",
            self.branch,
            check=False,
        )
        if push_result.returncode != 0:
            message = (push_result.stderr or push_result.stdout or "").strip()
            raise RuntimeError(f"Failed to push branch {self.branch}: {message or 'unknown git error'}")

    def _sanitize_workflow_artifacts_for_pr(self, base_ref: str) -> None:
        """Keep workflow/process artifacts out of the branch before PR creation."""
        branch_paths = self._git_path_list(
            "diff",
            "--name-only",
            f"{base_ref}...HEAD",
            "--",
            *self.WORKFLOW_ARTIFACT_PATHS,
        )
        if not branch_paths:
            return

        print(
            "[DEV] Removing workflow artifacts from branch diff:",
            ", ".join(branch_paths),
        )
        self._restore_paths_from_ref(base_ref, branch_paths)

        if self._workspace_has_uncommitted_changes():
            self._git("add", "--all", "--", *branch_paths)
            commit_result = self._git(
                "commit",
                "-m",
                "chore: remove workflow artifacts from submission",
                check=False,
            )
            if commit_result.returncode != 0:
                message = (commit_result.stderr or commit_result.stdout or "").strip()
                if "nothing to commit" not in message.lower():
                    raise RuntimeError(
                        f"Failed to remove workflow artifacts from branch {self.branch}: {message or 'unknown git error'}"
                    )

        remaining_paths = self._git_path_list(
            "diff",
            "--name-only",
            f"{base_ref}...HEAD",
            "--",
            *self.WORKFLOW_ARTIFACT_PATHS,
        )
        if remaining_paths:
            raise RuntimeError(
                "Workflow artifacts are still present in the branch diff: "
                + ", ".join(remaining_paths)
            )

    def _restore_paths_from_ref(self, source_ref: str, paths: list[str]) -> None:
        for workflow_path in paths:
            if self._path_exists_in_ref(source_ref, workflow_path):
                self._git(
                    "restore",
                    "--source",
                    source_ref,
                    "--staged",
                    "--worktree",
                    "--",
                    workflow_path,
                )
                continue

            self._git("rm", "-r", "-f", "--ignore-unmatch", "--", workflow_path, check=False)
            local_path = self._workspace_path() / workflow_path
            if local_path.is_dir():
                import shutil
                shutil.rmtree(local_path, ignore_errors=True)
            elif local_path.exists():
                local_path.unlink()

    def _path_exists_in_ref(self, source_ref: str, workflow_path: str) -> bool:
        result = self._git("cat-file", "-e", f"{source_ref}:{workflow_path}", check=False)
        return result.returncode == 0

    def _resolve_base_ref(self) -> str:
        """Prefer the tracked remote default branch when available."""
        default_branch = getattr(self.github, "default_branch", "main")
        remote_ref = f"refs/remotes/origin/{default_branch}"
        if self._git("rev-parse", "--verify", remote_ref, check=False).returncode == 0:
            return remote_ref
        return default_branch

    def _count_commits_ahead(self, base_ref: str) -> int:
        """Count commits on HEAD that are not in the base branch."""
        count_str = self._git_stdout("rev-list", "--count", f"{base_ref}..HEAD")
        try:
            return int(count_str)
        except ValueError as e:
            raise RuntimeError(
                f"Unexpected git rev-list output for {self.branch}: {count_str!r}"
            ) from e

    def _workspace_has_uncommitted_changes(self) -> bool:
        """Check whether the workspace has local tracked or untracked changes."""
        return bool(self._git_stdout("status", "--short"))

    def _git_path_list(self, *args: str) -> list[str]:
        output = self._git_stdout(*args)
        if not output:
            return []
        return [line.strip() for line in output.splitlines() if line.strip()]

    def _workspace_path(self) -> Path:
        """Resolve the actual git workspace path."""
        return self.store.symphony_dir.path.parent

    def _workflow_file_path(self, filename: str) -> Path:
        """Resolve workflow artifacts under the canonical .symphony/ directory."""
        return self._workspace_path() / ".symphony" / filename

    def _publish_handover_summary(self, pr_number: int) -> None:
        """Publish the dev handover into the PR timeline instead of committing it."""
        handover_path = self._workflow_file_path("HANDOVER.md")
        if not handover_path.exists():
            return

        content = handover_path.read_text().strip()
        if not content:
            return

        try:
            self.github.add_pull_request_comment(pr_number, content)
            print(f"[DEV] Published .symphony/HANDOVER.md to PR #{pr_number}")
        except Exception as e:
            print(f"[DEV] WARNING: Failed to publish handover summary to PR #{pr_number}: {e}")

    def _git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        """Run a git command inside the issue workspace."""
        return subprocess.run(
            ["git", *args],
            cwd=self._workspace_path(),
            capture_output=True,
            text=True,
            check=check,
        )

    def _git_stdout(self, *args: str) -> str:
        """Run git and return trimmed stdout."""
        result = self._git(*args)
        return result.stdout.strip()

    def _try_git_stdout(self, *args: str) -> Optional[str]:
        """Run git and return stdout when the ref exists."""
        result = self._git(*args, check=False)
        if result.returncode != 0:
            return None
        return result.stdout.strip()
