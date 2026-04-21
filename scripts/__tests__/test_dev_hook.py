from pathlib import Path
from unittest.mock import MagicMock

from scripts.hooks.dev import DevHook
from scripts.lib.state_machine import State

WORKFLOW_DIFF_COMMAND = (
    "diff",
    "--name-only",
    "refs/remotes/origin/main...HEAD",
    "--",
    "DEVELOPMENT_LOG.md",
    "HANDOVER.md",
    "REVIEW_REPORT.md",
    ".symphony",
)


def make_hook(tmp_path: Path) -> DevHook:
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    linear = MagicMock()
    linear.fetch_issue_by_identifier.return_value = {
        "identifier": "INT-25",
        "title": "Test issue",
    }

    github = MagicMock()
    github.default_branch = "main"

    hook = DevHook(
        workspace_root=workspace,
        issue_id="INT-25",
        linear_issue_id="linear-25",
        linear_state="In Progress",
        github_repo="owner/repo",
        branch="feature/int-25",
        linear_client=linear,
        github_client=github,
    )
    hook.initialize()
    assert hook.store.get_current_state_enum().value == State.IN_PROGRESS.value
    return hook


def test_dev_hook_fails_without_new_commits(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.github.pr_exists.return_value = None

    git_calls: list[tuple[str, ...]] = []

    def fake_run(cmd, cwd, capture_output, text, check):
        assert cwd == hook.store.symphony_dir.path.parent
        assert cmd[0] == "git"
        git_calls.append(tuple(cmd[1:]))

        result = MagicMock()
        result.returncode = 0
        result.stderr = ""
        result.stdout = ""

        command = tuple(cmd[1:])

        if command == ("rev-parse", "--verify", "refs/remotes/origin/main"):
            result.stdout = "origin-main-sha\n"
        elif command == WORKFLOW_DIFF_COMMAND:
            result.stdout = ""
        elif command == ("rev-list", "--count", "refs/remotes/origin/main..HEAD"):
            result.stdout = "0\n"
        elif command == ("status", "--short"):
            result.stdout = ""
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is False
    assert hook.github.create_pull_request.call_count == 0
    assert hook.store.get_state()["error"] == (
        "No commits found on feature/int-25 relative to refs/remotes/origin/main; "
        "skipping PR creation"
    )
    assert git_calls == [
        ("rev-parse", "--verify", "refs/remotes/origin/main"),
        WORKFLOW_DIFF_COMMAND,
        ("rev-list", "--count", "refs/remotes/origin/main..HEAD"),
        ("status", "--short"),
    ]


def test_dev_hook_reports_dirty_workspace_without_commits(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.github.pr_exists.return_value = None

    def fake_run(cmd, cwd, capture_output, text, check):
        assert cwd == hook.store.symphony_dir.path.parent
        assert cmd[0] == "git"

        result = MagicMock()
        result.returncode = 0
        result.stderr = ""
        result.stdout = ""

        command = tuple(cmd[1:])

        if command == ("rev-parse", "--verify", "refs/remotes/origin/main"):
            result.stdout = "origin-main-sha\n"
        elif command == WORKFLOW_DIFF_COMMAND:
            result.stdout = ""
        elif command == ("rev-list", "--count", "refs/remotes/origin/main..HEAD"):
            result.stdout = "0\n"
        elif command == ("status", "--short"):
            result.stdout = "?? Cargo.toml\n?? src/main.rs\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is False
    assert hook.store.get_state()["error"] == (
        "Workspace for feature/int-25 has uncommitted changes but no commits "
        "relative to refs/remotes/origin/main; commit and push are required before PR creation"
    )


def test_dev_hook_pushes_branch_before_creating_pr(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.github.pr_exists.return_value = None
    hook.github.create_pull_request.return_value = {
        "html_url": "https://github.com/owner/repo/pull/25",
        "number": 25,
    }

    git_calls: list[tuple[str, ...]] = []

    def fake_run(cmd, cwd, capture_output, text, check):
        assert cwd == hook.store.symphony_dir.path.parent
        assert cmd[0] == "git"
        git_calls.append(tuple(cmd[1:]))

        result = MagicMock()
        result.returncode = 0
        result.stderr = ""
        result.stdout = ""

        command = tuple(cmd[1:])
        if command == ("rev-parse", "--verify", "refs/remotes/origin/main"):
            result.stdout = "origin-main-sha\n"
        elif command == WORKFLOW_DIFF_COMMAND:
            result.stdout = ""
        elif command == ("rev-list", "--count", "refs/remotes/origin/main..HEAD"):
            result.stdout = "2\n"
        elif command == ("rev-parse", "HEAD"):
            result.stdout = "local-head-sha\n"
        elif command == ("rev-parse", "--verify", "refs/remotes/origin/feature/int-25"):
            result.returncode = 128
            result.stderr = "fatal: Needed a single revision\n"
        elif command == ("push", "-u", "origin", "feature/int-25"):
            result.stdout = "branch set up to track origin/feature/int-25\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is True
    hook.github.create_pull_request.assert_called_once()
    assert hook.store.get_current_state_enum().value == State.IN_REVIEW.value
    assert hook.store.get_state()["metadata"]["pr_number"] == 25
    assert git_calls == [
        ("rev-parse", "--verify", "refs/remotes/origin/main"),
        WORKFLOW_DIFF_COMMAND,
        ("rev-list", "--count", "refs/remotes/origin/main..HEAD"),
        ("rev-parse", "HEAD"),
        ("rev-parse", "--verify", "refs/remotes/origin/feature/int-25"),
        ("push", "-u", "origin", "feature/int-25"),
    ]


def test_dev_hook_publishes_handover_to_pull_request_comment(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.github.pr_exists.return_value = None
    hook.github.create_pull_request.return_value = {
        "html_url": "https://github.com/owner/repo/pull/25",
        "number": 25,
    }

    handover_path = hook.store.symphony_dir.path / "HANDOVER.md"
    handover_path.write_text("# Handover\nImplemented feature.\n")

    def fake_run(cmd, cwd, capture_output, text, check):
        assert cwd == hook.store.symphony_dir.path.parent
        assert cmd[0] == "git"

        result = MagicMock()
        result.returncode = 0
        result.stderr = ""
        result.stdout = ""

        command = tuple(cmd[1:])
        if command == ("rev-parse", "--verify", "refs/remotes/origin/main"):
            result.stdout = "origin-main-sha\n"
        elif command == WORKFLOW_DIFF_COMMAND:
            result.stdout = ""
        elif command == ("rev-list", "--count", "refs/remotes/origin/main..HEAD"):
            result.stdout = "2\n"
        elif command == ("rev-parse", "HEAD"):
            result.stdout = "local-head-sha\n"
        elif command == ("rev-parse", "--verify", "refs/remotes/origin/feature/int-25"):
            result.returncode = 128
            result.stderr = "fatal: Needed a single revision\n"
        elif command == ("push", "-u", "origin", "feature/int-25"):
            result.stdout = "branch set up to track origin/feature/int-25\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is True
    hook.github.add_pull_request_comment.assert_called_once_with(25, "# Handover\nImplemented feature.")


def test_dev_hook_ignores_legacy_root_handover_when_canonical_handover_is_missing(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.github.pr_exists.return_value = None
    hook.github.create_pull_request.return_value = {
        "html_url": "https://github.com/owner/repo/pull/25",
        "number": 25,
    }

    legacy_handover_path = hook.store.symphony_dir.path.parent / "HANDOVER.md"
    legacy_handover_path.write_text("# Legacy handover\n")

    def fake_run(cmd, cwd, capture_output, text, check):
        assert cwd == hook.store.symphony_dir.path.parent
        assert cmd[0] == "git"

        result = MagicMock()
        result.returncode = 0
        result.stderr = ""
        result.stdout = ""

        command = tuple(cmd[1:])
        if command == ("rev-parse", "--verify", "refs/remotes/origin/main"):
            result.stdout = "origin-main-sha\n"
        elif command == WORKFLOW_DIFF_COMMAND:
            result.stdout = ""
        elif command == ("rev-list", "--count", "refs/remotes/origin/main..HEAD"):
            result.stdout = "2\n"
        elif command == ("rev-parse", "HEAD"):
            result.stdout = "local-head-sha\n"
        elif command == ("rev-parse", "--verify", "refs/remotes/origin/feature/int-25"):
            result.returncode = 128
            result.stderr = "fatal: Needed a single revision\n"
        elif command == ("push", "-u", "origin", "feature/int-25"):
            result.stdout = "branch set up to track origin/feature/int-25\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is True
    hook.github.add_pull_request_comment.assert_not_called()


def test_dev_hook_removes_workflow_artifacts_from_branch_diff_before_pr(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.github.pr_exists.return_value = None
    hook.github.create_pull_request.return_value = {
        "html_url": "https://github.com/owner/repo/pull/25",
        "number": 25,
    }

    git_calls: list[tuple[str, ...]] = []

    def fake_run(cmd, cwd, capture_output, text, check):
        assert cwd == hook.store.symphony_dir.path.parent
        assert cmd[0] == "git"
        git_calls.append(tuple(cmd[1:]))

        result = MagicMock()
        result.returncode = 0
        result.stderr = ""
        result.stdout = ""

        command = tuple(cmd[1:])
        if command == ("rev-parse", "--verify", "refs/remotes/origin/main"):
            result.stdout = "origin-main-sha\n"
        elif command == WORKFLOW_DIFF_COMMAND:
            diff_call_count = sum(
                1
                for existing in git_calls
                if existing == command
            )
            result.stdout = "HANDOVER.md\n" if diff_call_count == 1 else ""
        elif command == ("cat-file", "-e", "refs/remotes/origin/main:HANDOVER.md"):
            result.returncode = 0
        elif command == ("restore", "--source", "refs/remotes/origin/main", "--staged", "--worktree", "--", "HANDOVER.md"):
            result.stdout = ""
        elif command == ("status", "--short"):
            status_call_count = sum(
                1
                for existing in git_calls
                if existing == command
            )
            result.stdout = " M HANDOVER.md\n" if status_call_count == 1 else ""
        elif command == ("add", "--all", "--", "HANDOVER.md"):
            result.stdout = ""
        elif command == ("commit", "-m", "chore: remove workflow artifacts from submission"):
            result.stdout = "[feature/int-25 abc123] cleanup\n"
        elif command == ("rev-list", "--count", "refs/remotes/origin/main..HEAD"):
            result.stdout = "2\n"
        elif command == ("rev-parse", "HEAD"):
            result.stdout = "local-head-sha\n"
        elif command == ("rev-parse", "--verify", "refs/remotes/origin/feature/int-25"):
            result.returncode = 128
            result.stderr = "fatal: Needed a single revision\n"
        elif command == ("push", "-u", "origin", "feature/int-25"):
            result.stdout = "branch set up to track origin/feature/int-25\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is True
    assert ("commit", "-m", "chore: remove workflow artifacts from submission") in git_calls
