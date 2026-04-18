# scripts/hooks/review.py
"""REVIEW phase hook - handles review and merge."""

import subprocess
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

from lib.config import Config
from lib.github_client import GitHubClient
from lib.linear_client import LinearClient
from lib.state_machine import State
from lib.state_store import StateStore


class ReviewHook:
    """Handles the REVIEW phase of issue workflow."""

    def __init__(
        self,
        workspace_root: Path,
        issue_id: str,
        linear_client: Optional[LinearClient] = None,
        github_client: Optional[GitHubClient] = None,
        config: Optional[Config] = None,
    ):
        self.workspace_root = workspace_root
        self.issue_id = issue_id
        self.config = config
        self.auto_merge_no_reviews = config.auto_merge_no_reviews if config else False

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

    def check_pr_status(self) -> str:
        """
        Check PR status.
        Returns: 'merged', 'approved', 'changes_requested', 'pending', 'no_pr', 'error'
        """
        state = self.store.get_state()
        if not state:
            return "error"

        branch = state.get("metadata", {}).get("branch")
        if not branch:
            return "error"

        # Check if PR exists
        pr = self.github.get_pull_request_by_branch(branch)
        if not pr:
            return "no_pr"

        # Check if already merged
        if pr.get("merged"):
            return "merged"

        # Get review state
        review_state = self.github.get_pr_reviews_state(pr["number"])
        return review_state

    def run(self) -> bool:
        """
        Run the REVIEW phase:
        1. Check PR status
        2. If merged -> update Linear to Done, clean workspace
        3. If approved -> merge, then update Linear to Done
        4. If changes_requested -> update Linear to In Progress
        5. If pending -> wait or return error
        """
        # Step 1: Dual-check Linear state
        print(f"[REVIEW] Verifying Linear state for {self.issue_id}...")
        linear_current = self.linear.fetch_issue_state(self.issue_id)
        print(f"[REVIEW] Linear state: {linear_current}")

        current = self.store.get_current_state_enum()
        if current != State.IN_REVIEW:
            print(f"[REVIEW] Issue not in IN_REVIEW state, current: {current}")
            return False

        # Step 2: Check PR status
        pr_status = self.check_pr_status()
        print(f"[REVIEW] PR status: {pr_status}")

        state = self.store.get_state()
        pr_info = state.get("metadata", {})

        if pr_status == "merged":
            # Already merged - just update state
            print("[REVIEW] PR already merged")
            return self._handle_merged(pr_info.get("pr_number"), pr_info.get("linear_issue_id"))

        elif pr_status == "approved":
            # Need to merge
            print("[REVIEW] PR approved - merging...")
            return self._handle_merge_and_done(pr_info.get("pr_number"), pr_info.get("linear_issue_id"))

        elif pr_status == "changes_requested":
            # Send back to dev
            print("[REVIEW] Changes requested - sending back to dev")
            return self._handle_changes_requested(pr_info.get("linear_issue_id"))

        elif pr_status == "pending":
            # Still pending review
            print("[REVIEW] PR still pending review")
            self.store.set_error("PR pending review")
            return False

        elif pr_status == "no_reviews":
            # No reviews yet
            if self.auto_merge_no_reviews:
                print("[REVIEW] Auto-merging PR with no reviews (enabled)")
                return self._handle_merge_and_done(pr_info.get("pr_number"), pr_info.get("linear_issue_id"))
            else:
                print("[REVIEW] PR has no reviews yet")
                self.store.set_error("PR has no reviews")
                return False

        else:
            print(f"[REVIEW] Unexpected PR status: {pr_status}")
            self.store.set_error(f"Unexpected PR status: {pr_status}")
            return False

    def _handle_merged(self, pr_number: Optional[int], linear_issue_id: Optional[str]) -> bool:
        """Handle already merged PR."""
        if not linear_issue_id:
            print("[REVIEW] ERROR: No linear_issue_id in state")
            return False

        # Update Linear to Done
        done_state_id = self.linear.fetch_state_id("Done")
        if not done_state_id:
            print("[REVIEW] ERROR: Could not find Done state ID")
            self.store.set_error("Could not find Done state ID")
            return False

        self.linear.update_issue_state(linear_issue_id, done_state_id)

        # Wait for confirmation
        confirmed = self.linear.wait_for_state(
            self.issue_id,
            "Done",
            max_wait_seconds=30,
            poll_interval=2,
        )

        if not confirmed:
            print("[REVIEW] WARNING: Linear state not confirmed after update")

        # Update state
        self.store.update_state(
            from_state=State.IN_REVIEW,
            to_state=State.DONE,
            trigger="pr_merged",
            actor="review-hook",
            metadata_updates={"pr_merged": True},
        )

        print("[REVIEW] Issue completed")
        return True

    def _handle_merge_and_done(self, pr_number: Optional[int], linear_issue_id: Optional[str]) -> bool:
        """Merge PR and update Linear to Done."""
        if not pr_number:
            print("[REVIEW] ERROR: No pr_number in state")
            return False

        # Merge PR
        merge_result = self.github.merge_pull_request(pr_number)
        if not merge_result.get("merged"):
            error_msg = merge_result.get("message", "Merge failed")
            print(f"[REVIEW] ERROR: Merge failed: {error_msg}")
            self.store.set_error(f"Merge failed: {error_msg}")
            return False

        print("[REVIEW] PR merged successfully")

        # Now treat as merged
        return self._handle_merged(pr_number, linear_issue_id)

    def _handle_changes_requested(self, linear_issue_id: Optional[str]) -> bool:
        """Handle changes requested - send back to IN_PROGRESS."""
        if not linear_issue_id:
            print("[REVIEW] ERROR: No linear_issue_id in state")
            return False

        # Update Linear to In Progress
        in_progress_state_id = self.linear.fetch_state_id("In Progress")
        if not in_progress_state_id:
            print("[REVIEW] ERROR: Could not find In Progress state ID")
            self.store.set_error("Could not find In Progress state ID")
            return False

        self.linear.update_issue_state(linear_issue_id, in_progress_state_id)

        # Wait for confirmation
        confirmed = self.linear.wait_for_state(
            self.issue_id,
            "In Progress",
            max_wait_seconds=30,
            poll_interval=2,
        )

        if not confirmed:
            print("[REVIEW] WARNING: Linear state not confirmed after update")

        # Update state
        self.store.update_state(
            from_state=State.IN_REVIEW,
            to_state=State.IN_PROGRESS,
            trigger="review_rejected",
            actor="review-hook",
        )

        print("[REVIEW] Issue sent back to dev")
        return True

    def cleanup(self) -> bool:
        """Clean up workspace after completion."""
        if self.store.symphony_dir.exists():
            self.store.symphony_dir.delete()
            print(f"[REVIEW] Workspace for {self.issue_id} cleaned up")
            return True
        return False
