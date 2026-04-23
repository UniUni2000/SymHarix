import json
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


def test_review_hook_reads_canonical_report_from_symphony_and_submits_native_review(tmp_path):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text(
        "## Review Decision: REQUEST_CHANGES\n\n"
        "## Review Summary\n"
        "Tests are missing for the changed behavior.\n\n"
        "**现状**: Missing tests\n"
        "**期望**: Add tests before merge\n"
    )

    assert hook.run() is True
    hook.github.submit_pull_request_review.assert_called_once_with(25, "REQUEST_CHANGES", body=hook.github.submit_pull_request_review.call_args.kwargs["body"])
    body = hook.github.submit_pull_request_review.call_args.kwargs["body"]
    assert "## Automated Review: REQUEST_CHANGES" in body
    assert "## Review Summary" in body
    assert "Missing tests" in body
    assert hook.store.get_current_state_enum().value == "IN_PROGRESS"


def test_review_hook_rejects_legacy_bold_decision_line(tmp_path):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text(
        "# Review Report: INT-25\n\n"
        "- **Decision**: REQUEST_CHANGES\n\n"
        "## Review Summary\n"
        "Need tests.\n\n"
        "**现状**: Missing tests\n"
        "**期望**: Add tests before merge\n"
    )

    decision, _ = hook._load_review_decision()

    assert decision is None


def test_review_hook_rejects_legacy_final_decision_heading(tmp_path):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text(
        "# Review Report: INT-25\n\n"
        "## 最终决定\n"
        "**APPROVE** - Ready to merge.\n\n"
        "## Review Summary\n"
        "Legacy heading only.\n"
    )

    decision, _ = hook._load_review_decision()

    assert decision is None


def test_review_hook_requires_review_summary_in_canonical_report(tmp_path):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text(
        "## Review Decision: REQUEST_TESTS\n\n"
        "**现状**: Missing regression tests\n"
    )

    decision, _ = hook._load_review_decision()

    assert decision is None


def test_review_hook_ignores_legacy_root_report_when_canonical_report_is_missing(tmp_path):
    hook = make_hook(tmp_path)
    legacy_report_path = hook.store.symphony_dir.path.parent / "REVIEW_REPORT.md"
    legacy_report_path.write_text("## Review Decision: APPROVE\n\nLegacy root report\n")

    assert hook.run() is False
    hook.github.submit_pull_request_review.assert_not_called()
    assert hook.store.get_state()["error"] == "Missing review decision"


def test_review_hook_merges_and_closes_issue_on_approval(tmp_path):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text("## Review Decision: APPROVE\n\n## Review Summary\nLooks good to merge.\n")

    state = hook.store.get_state()
    state["metadata"]["github_issue_number"] = 88
    hook.store.symphony_dir.write_state(state)
    hook.github.merge_pull_request.return_value = {"merged": True}

    assert hook.run() is True
    hook.github.submit_pull_request_review.assert_called_once_with(25, "APPROVE", body=hook.github.submit_pull_request_review.call_args.kwargs["body"])
    hook.github.merge_pull_request.assert_called_once_with(25)
    hook.github.close_issue.assert_called_once_with(88)
    assert hook.store.get_current_state_enum().value == "DONE"


def test_review_hook_reports_merge_blocked_feedback_without_faking_rejection(tmp_path):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text("## Review Decision: APPROVE\n\n## Review Summary\nLooks good to merge.\n")
    hook.github.merge_pull_request.return_value = {"merged": False, "message": "Branch protection blocked merge"}

    assert hook.run() is True
    assert hook.last_review_decision == "MERGE_BLOCKED"
    assert hook.last_pr_status == "merge_blocked"
    assert hook.last_review_report is not None
    assert "Review passed, but the merge failed" in hook.last_review_report
    assert "Branch protection blocked merge" in hook.last_review_report
    assert hook.store.get_current_state_enum().value == "IN_PROGRESS"


def test_review_hook_runs_review_checks_before_submitting_native_review(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text("## Review Decision: APPROVE\n\n## Review Summary\nLooks good to merge.\n")
    change_pack_dir = hook.store.symphony_dir.path / "change-pack"
    change_pack_dir.mkdir(parents=True, exist_ok=True)
    (change_pack_dir / "evidence.json").write_text(json.dumps({}), encoding="utf-8")
    monkeypatch.setenv(
        "SYMPHONY_EFFECTIVE_HARNESS_JSON",
        json.dumps(
            {
                "commands": {
                    "review_checks": 'python3 -c "import sys; sys.exit(1)"',
                }
            }
        ),
    )

    assert hook.run() is False
    hook.github.submit_pull_request_review.assert_not_called()
    assert "review_checks failed" in hook.store.get_state()["error"]
    assert hook.store.get_current_state_enum().value == "IN_REVIEW"


def test_review_hook_records_review_check_evidence(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    report_path = hook.store.symphony_dir.path / "REVIEW_REPORT.md"
    report_path.write_text("## Review Decision: REQUEST_TESTS\n\n## Review Summary\nPlease add one more test.\n")
    change_pack_dir = hook.store.symphony_dir.path / "change-pack"
    change_pack_dir.mkdir(parents=True, exist_ok=True)
    evidence_path = change_pack_dir / "evidence.json"
    evidence_path.write_text(json.dumps({}), encoding="utf-8")
    monkeypatch.setenv(
        "SYMPHONY_EFFECTIVE_HARNESS_JSON",
        json.dumps(
            {
                "commands": {
                    "review_checks": 'python3 -c "print(\'ok\')"',
                }
            }
        ),
    )

    assert hook.run() is True
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert evidence["command_runs"][0]["command_key"] == "review_checks"
    assert evidence["command_runs"][0]["status"] == "satisfied"
