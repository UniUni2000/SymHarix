# scripts/hooks/review.py
"""REVIEW phase hook - handles review and merge."""

import json
import os
import sys
import re
import subprocess
from datetime import datetime, timezone
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
        self.last_pr_status: Optional[str] = None
        self.last_review_decision: Optional[str] = None
        self.last_review_report: Optional[str] = None
        self.last_delivery_code: Optional[str] = None
        self.last_delivery_summary: Optional[str] = None

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

    def _set_delivery_failure(self, code: str, summary: str) -> None:
        self.last_delivery_code = code
        self.last_delivery_summary = summary

    def _clear_delivery_failure(self) -> None:
        self.last_delivery_code = None
        self.last_delivery_summary = None

    def check_pr_status(self) -> str:
        """
        Check PR status.
        Returns: 'merged', 'approved', 'changes_requested', 'merge_blocked', 'pending', 'no_pr', 'error'
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

    def _load_review_decision(self) -> tuple[Optional[str], Optional[str]]:
        report_path = self._workflow_file_path("REVIEW_REPORT.md")
        if not report_path.exists():
            return None, None

        content = report_path.read_text().strip()
        if not content:
            return None, None

        decision_match = re.search(
            r"^## Review Decision:\s*(APPROVE|APPROVE_MINOR|REQUEST_CHANGES|REQUEST_TESTS|REJECT)\s*$",
            content,
            re.MULTILINE,
        )
        if not decision_match:
            return None, content

        summary_heading = re.search(r"^## Review Summary\s*$", content, re.MULTILINE)
        if not summary_heading:
            return None, content

        summary_start = summary_heading.end()
        remaining = content[summary_start:].lstrip()
        next_heading = re.search(r"^##\s+", remaining, re.MULTILINE)
        summary = (remaining[: next_heading.start()] if next_heading else remaining).strip()
        if not summary:
            return None, content

        return decision_match.group(1).upper(), content

    def _workflow_file_path(self, filename: str) -> Path:
        """Resolve workflow artifacts under the canonical .symphony/ directory."""
        return self.store.symphony_dir.path.parent / ".symphony" / filename

    def _append_change_pack_command_run(
        self,
        command: str,
        command_key: str,
        status: str,
        source: str,
        *,
        phase: str = "review",
        exit_code: Optional[int] = None,
        summary: Optional[str] = None,
    ) -> None:
        evidence_path = self._workflow_file_path("change-pack/evidence.json")
        if not evidence_path.exists():
            return

        try:
            payload = json.loads(evidence_path.read_text(encoding="utf-8"))
        except Exception:
            payload = {}

        if not isinstance(payload, dict):
            payload = {}

        command_runs = payload.get("command_runs")
        if not isinstance(command_runs, list):
            command_runs = []

        normalized_command = command.strip()
        dedupe_key = (
            phase,
            normalized_command,
            command_key,
            status,
            source,
        )
        existing_keys = {
            (
                str(entry.get("phase", "")).strip(),
                str(entry.get("command", "")).strip(),
                str(entry.get("command_key", "")).strip(),
                str(entry.get("status", "")).strip(),
                str(entry.get("source", "")).strip(),
            )
            for entry in command_runs
            if isinstance(entry, dict)
        }
        if dedupe_key in existing_keys:
            return

        command_runs.append(
            {
                "phase": phase,
                "command": normalized_command,
                "command_key": command_key,
                "status": status,
                "source": source,
                "turn": None,
                "exit_code": exit_code,
                "summary": summary,
                "recorded_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        payload["command_runs"] = command_runs
        evidence_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _submit_native_review(self, pr_number: Optional[int], review_decision: str, review_report: Optional[str]) -> bool:
        """Submit a native GitHub review and fail closed if GitHub rejects it."""
        if not pr_number or not review_report:
            self.store.set_error("Missing pull request review context")
            self._set_delivery_failure("review_submit_failed", "Missing pull request review context")
            return False

        body = "\n".join([
            f"## Automated Review: {review_decision}",
            "",
            review_report.strip(),
        ]).strip()

        event = None
        if review_decision in ("APPROVE", "APPROVE_MINOR"):
            event = "APPROVE"
        elif review_decision in ("REQUEST_CHANGES", "REQUEST_TESTS", "REJECT"):
            event = "REQUEST_CHANGES"

        if not event:
            self.store.set_error(f"Unsupported review decision: {review_decision}")
            self._set_delivery_failure("review_submit_failed", f"Unsupported review decision: {review_decision}")
            return False

        try:
            current_user = self.github.get_authenticated_user() if self.github else None
        except Exception:
            current_user = None
        try:
            pr = self.github.get_pull_request(pr_number) if self.github else None
        except Exception:
            pr = None

        reviewer_login = (current_user or {}).get("login")
        pr_author_login = (pr or {}).get("user", {}).get("login")
        if reviewer_login and pr_author_login and reviewer_login == pr_author_login:
            try:
                self.github.add_pull_request_comment(
                    pr_number,
                    "\n".join([
                        f"## Automated Review (Self-Review Fallback): {review_decision}",
                        "",
                        review_report.strip(),
                    ]).strip(),
                )
                print(
                    f"[REVIEW] Skipped native review for PR #{pr_number} because "
                    f"{reviewer_login} is the PR author; posted a PR comment instead"
                )
                self._clear_delivery_failure()
                return True
            except Exception as e:
                detail = (
                    f"Failed to post self-review fallback comment to PR #{pr_number}: {e} "
                    f"| reviewer={reviewer_login} | author={pr_author_login}"
                )
                print(f"[REVIEW] ERROR: {detail}")
                self.store.set_error(detail)
                self._set_delivery_failure("review_submit_failed", detail)
                return False

        try:
            self._clear_delivery_failure()
            self.github.submit_pull_request_review(pr_number, event, body=body)
            print(f"[REVIEW] Submitted native review to PR #{pr_number} ({event})")
            return True
        except Exception as e:
            equivalent_review = next((
                review for review in self.github.get_reviews(pr_number)
                if review.get("state") == event
                and (review.get("body") or "").strip() == body.strip()
            ), None)
            if equivalent_review:
                print(f"[REVIEW] Equivalent native review already exists on PR #{pr_number}; treating as success")
                self._clear_delivery_failure()
                return True

            pr_state = self.github.get_pull_request(pr_number)
            response = getattr(e, "response", None)
            response_text = None
            if response is not None:
                try:
                    response_text = response.text
                except Exception:
                    response_text = None

            detail_parts = [
                f"Failed to submit native review to PR #{pr_number}: {e}",
                f"event={event}",
                f"head={pr_state.get('head', {}).get('sha') if isinstance(pr_state, dict) else None}",
                f"state={pr_state.get('state') if isinstance(pr_state, dict) else None}",
                f"open={pr_state.get('state') == 'open' if isinstance(pr_state, dict) else None}",
                f"response={response_text}" if response_text else None,
            ]
            detail = " | ".join(part for part in detail_parts if part)
            print(f"[REVIEW] ERROR: {detail}")
            self.store.set_error(f"Failed to submit native review: {detail}")
            self._set_delivery_failure("review_submit_failed", detail)
            return False

    def _load_effective_harness(self) -> dict:
        raw = os.environ.get("SYMPHONY_EFFECTIVE_HARNESS_JSON", "").strip()
        if not raw:
            repo_harness_path = self.workspace_root / ".symphony-repo.yaml"
            if not repo_harness_path.exists():
                return {}
            try:
                import yaml  # type: ignore

                parsed = yaml.safe_load(repo_harness_path.read_text())
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                return {}

        try:
            parsed = json.loads(raw)
        except Exception:
            return {}

        return parsed if isinstance(parsed, dict) else {}

    def _run_review_checks(self) -> bool:
        harness = self._load_effective_harness()
        commands = harness.get("commands", {})
        if not isinstance(commands, dict):
            return True

        review_checks = commands.get("review_checks")
        if not isinstance(review_checks, str) or not review_checks.strip():
            return True

        try:
            subprocess.run(
                review_checks,
                cwd=self.workspace_root,
                shell=True,
                check=True,
                capture_output=True,
                text=True,
            )
            print(f"[REVIEW] review_checks passed: {review_checks}")
            self._append_change_pack_command_run(
                command=review_checks,
                command_key="review_checks",
                status="satisfied",
                source="review_checks",
                exit_code=0,
                summary="review_checks passed",
            )
            return True
        except subprocess.CalledProcessError as exc:
            stdout = (exc.stdout or "").strip()
            stderr = (exc.stderr or "").strip()
            detail = " | ".join(part for part in [stdout, stderr] if part)
            error_message = f"review_checks failed: {review_checks}"
            if detail:
                error_message = f"{error_message} ({detail})"
            print(f"[REVIEW] ERROR: {error_message}")
            self.store.set_error(error_message)
            self._append_change_pack_command_run(
                command=review_checks,
                command_key="review_checks",
                status="failed",
                source="review_checks",
                exit_code=exc.returncode,
                summary=detail or "review_checks failed",
            )
            return False

    def _build_merge_blocked_feedback(self, reason: str) -> str:
        base_report = (self.last_review_report or "").strip()
        sections = [
            "## Merge Blocked",
            "Review passed, but the merge failed, so the issue is returning to development.",
            "",
            f"Reason: {reason}",
        ]
        if base_report:
            sections = [base_report, ""] + sections
        return "\n".join(sections).strip()

    def run(self) -> bool:
        """
        Run the REVIEW phase:
        1. Read .symphony/REVIEW_REPORT.md for the reviewer decision
        2. If approved -> merge PR
        3. If changes requested -> move local state back to IN_PROGRESS
        4. If merge is blocked -> move local state back to IN_PROGRESS
        """
        current = self.store.get_current_state_enum()
        if current != State.IN_REVIEW:
            print(f"[REVIEW] Issue not in IN_REVIEW state, current: {current}")
            return False

        review_decision, review_report = self._load_review_decision()
        if not review_decision:
            print("[REVIEW] ERROR: .symphony/REVIEW_REPORT.md is missing or does not contain a final decision")
            self.store.set_error("Missing review decision")
            return False

        self.last_review_decision = review_decision
        self.last_review_report = review_report
        self._clear_delivery_failure()
        print(f"[REVIEW] Review decision: {review_decision}")

        if not self._run_review_checks():
            return False

        state = self.store.get_state()
        pr_info = state.get("metadata", {})
        if not self._submit_native_review(pr_info.get("pr_number"), review_decision, review_report):
            return False

        if review_decision in ("APPROVE", "APPROVE_MINOR"):
            self.last_pr_status = "approved"
            print("[REVIEW] PR approved - merging...")
            return self._handle_merge_and_done(pr_info.get("pr_number"), pr_info.get("linear_issue_id"))
        elif review_decision in ("REQUEST_CHANGES", "REQUEST_TESTS", "REJECT"):
            self.last_pr_status = "changes_requested"
            print("[REVIEW] Changes requested - sending back to dev")
            return self._handle_changes_requested(pr_info.get("linear_issue_id"), review_report)
        else:
            print(f"[REVIEW] Unexpected review decision: {review_decision}")
            self.store.set_error(f"Unexpected review decision: {review_decision}")
            return False

    def _handle_merged(self, pr_number: Optional[int], linear_issue_id: Optional[str]) -> bool:
        """Handle already merged PR in local state."""
        current = self.store.get_current_state_enum()
        if current != State.IN_REVIEW:
            print(f"[REVIEW] ERROR: Invalid state for merge completion: {current}")
            return False

        state = self.store.get_state() or {}
        metadata = state.get("metadata", {})
        github_issue_number = metadata.get("github_issue_number")
        if not github_issue_number:
            mapped_issue = self.github.find_issue_by_identifier(self.issue_id)
            github_issue_number = mapped_issue.get("number") if mapped_issue else None

        if github_issue_number:
            try:
                self.github.close_issue(github_issue_number)
                print(f"[REVIEW] Closed GitHub issue #{github_issue_number}")
            except Exception as e:
                print(f"[REVIEW] WARNING: Failed to close GitHub issue #{github_issue_number}: {e}")

        self.store.update_state(
            from_state=State.IN_REVIEW,
            to_state=State.DONE,
            trigger="pr_merged",
            actor="review-hook",
            metadata_updates={
                "pr_merged": True,
                "github_issue_number": github_issue_number,
            },
        )

        print("[REVIEW] Issue completed")
        return True

    def _handle_merge_and_done(self, pr_number: Optional[int], linear_issue_id: Optional[str]) -> bool:
        """Merge PR and update Linear to Done."""
        if not pr_number:
            print("[REVIEW] ERROR: No pr_number in state")
            return False

        # Merge PR
        try:
            merge_result = self.github.merge_pull_request(pr_number)
        except Exception as e:
            error_msg = str(e)
            print(f"[REVIEW] Merge blocked: {error_msg}")
            self.last_pr_status = "merge_blocked"
            self.last_review_decision = "MERGE_BLOCKED"
            self.last_review_report = self._build_merge_blocked_feedback(error_msg)
            return self._handle_changes_requested(linear_issue_id, f"Merge blocked: {error_msg}")

        if not merge_result.get("merged"):
            error_msg = merge_result.get("message", "Merge failed")
            print(f"[REVIEW] Merge blocked: {error_msg}")
            self.last_pr_status = "merge_blocked"
            self.last_review_decision = "MERGE_BLOCKED"
            self.last_review_report = self._build_merge_blocked_feedback(error_msg)
            return self._handle_changes_requested(linear_issue_id, f"Merge blocked: {error_msg}")

        self.last_pr_status = "merged"
        print("[REVIEW] PR merged successfully")

        # Now treat as merged
        return self._handle_merged(pr_number, linear_issue_id)

    def _handle_changes_requested(self, linear_issue_id: Optional[str], reason: Optional[str] = None) -> bool:
        """Handle changes requested - send back to IN_PROGRESS."""
        current = self.store.get_current_state_enum()
        if current != State.IN_REVIEW:
            print(f"[REVIEW] ERROR: Invalid state for review fallback: {current}")
            return False

        # Update state
        self.store.update_state(
            from_state=State.IN_REVIEW,
            to_state=State.IN_PROGRESS,
            trigger="review_rejected",
            actor="review-hook",
        )
        if reason:
            self.store.set_error(reason)

        print("[REVIEW] Issue sent back to dev")
        return True

    def cleanup(self) -> bool:
        """Clean up workspace after completion."""
        if self.store.symphony_dir.exists():
            self.store.symphony_dir.delete()
            print(f"[REVIEW] Workspace for {self.issue_id} cleaned up")
            return True
        return False
