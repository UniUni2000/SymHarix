from pathlib import Path
from unittest.mock import MagicMock

from scripts.hooks.review import ReviewHook
def make_hook(tmp_path: Path) -> ReviewHook:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    linear = MagicMock()
    github = MagicMock()

    hook = ReviewHook(
        workspace_root=workspace,
        issue_id="INT-25",
        linear_client=linear,
        github_client=github,
    )

    hook.store.initialize(
        linear_issue_id="linear-25",
        linear_state="In Review",
        github_repo="owner/repo",
        branch="feature/int-25",
    )
    state_enum = hook.store.get_current_state_enum().__class__
    hook.store.update_state(
        from_state=state_enum.TODO,
        to_state=state_enum.IN_PROGRESS,
        trigger="dispatch",
    )
    hook.store.update_state(
        from_state=state_enum.IN_PROGRESS,
        to_state=state_enum.IN_REVIEW,
        trigger="pr_created",
        metadata_updates={
            "pr_number": 25,
        },
    )
    return hook


def test_review_hook_reads_report_from_symphony_and_comments_on_pr(tmp_path):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text(
        "## Review Decision: REQUEST_CHANGES\n\n"
        "**现状**: Missing tests\n"
        "**期望**: Add tests before merge\n"
    )

    assert hook.run() is True
    hook.github.add_pull_request_comment.assert_called_once()
    body = hook.github.add_pull_request_comment.call_args.args[1]
    assert "## Automated Review: REQUEST_CHANGES" in body
    assert "Missing tests" in body
    assert hook.store.get_current_state_enum().value == "IN_PROGRESS"


def test_review_hook_accepts_bold_decision_line(tmp_path):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text(
        "# Review Report: INT-25\n\n"
        "- **Decision**: REQUEST_CHANGES\n\n"
        "**现状**: Missing tests\n"
        "**期望**: Add tests before merge\n"
    )

    decision, _ = hook._load_review_decision()

    assert decision == "REQUEST_CHANGES"


def test_review_hook_accepts_final_decision_heading(tmp_path):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text(
        "# Review Report: INT-25\n\n"
        "## 最终决定\n"
        "**APPROVE** - Ready to merge.\n"
    )

    decision, _ = hook._load_review_decision()

    assert decision == "APPROVE"


def test_review_hook_ignores_legacy_root_report_when_canonical_report_is_missing(tmp_path):
    hook = make_hook(tmp_path)
    legacy_report_path = hook.store.symphony_dir.path.parent / "REVIEW_REPORT.md"
    legacy_report_path.write_text("## Review Decision: APPROVE\n\nLegacy root report\n")

    assert hook.run() is False
    hook.github.add_pull_request_comment.assert_not_called()
    assert hook.store.get_state()["error"] == "Missing review decision"
