import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import requests

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
        ("status", "--short"),
    ]


def test_dev_hook_reports_dirty_workspace_when_product_changes_cannot_be_staged(tmp_path, monkeypatch):
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
        elif command[0:2] == ("reset", "--"):
            result.stdout = ""
        elif command[0:3] == ("add", "--all", "--"):
            result.stdout = ""
        elif command == ("diff", "--cached", "--name-only"):
            result.stdout = ""
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


def test_dev_hook_marks_product_staging_failure_with_delivery_code(tmp_path, monkeypatch):
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
            result.stdout = "?? .gitignore\n?? physics.py\n"
        elif command[0:2] == ("reset", "--"):
            result.stdout = ""
        elif command[0:3] == ("add", "--all", "--"):
            result.returncode = 1
            result.stderr = "The following paths are ignored by one of your .gitignore files:\n.mypy_cache\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is False
    assert hook.last_delivery_code == "product_staging_failed"
    assert "Failed to stage product changes for feature/int-25" in hook.store.get_state()["error"]
    assert ".mypy_cache" in (hook.last_delivery_summary or "")


def test_dev_hook_commits_uncommitted_product_changes_before_pr(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.github.pr_exists.return_value = None
    hook.github.create_pull_request.return_value = {
        "html_url": "https://github.com/owner/repo/pull/25",
        "number": 25,
    }

    git_calls: list[tuple[str, ...]] = []
    committed = False

    def fake_run(cmd, cwd, capture_output, text, check):
        nonlocal committed
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
        elif command[0:2] == ("reset", "--"):
            result.stdout = ""
        elif command[0:3] == ("add", "--all", "--"):
            result.stdout = ""
        elif command == ("diff", "--cached", "--name-only"):
            result.stdout = ".github/workflows/test.yml\n"
        elif command == ("commit", "--no-verify", "-m", "feat(INT-25): prepare product changes for review"):
            committed = True
            result.stdout = "[feature/int-25 commit-sha] feat(INT-25): prepare product changes for review\n"
        elif command == ("rev-list", "--count", "refs/remotes/origin/main..HEAD"):
            result.stdout = "1\n" if committed else "0\n"
        elif command == ("rev-parse", "HEAD"):
            result.stdout = "committed-head-sha\n"
        elif command == ("rev-parse", "--verify", "refs/remotes/origin/feature/int-25"):
            result.returncode = 128
            result.stderr = "fatal: Needed a single revision\n"
        elif command == ("push", "-u", "origin", "HEAD:feature/int-25"):
            result.stdout = "branch set up to track origin/feature/int-25\n"
        elif command == ("status", "--short"):
            result.stdout = " M .github/workflows/test.yml\n?? .symphony/state.json\n?? __pycache__/module.pyc\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is True
    hook.github.create_pull_request.assert_called_once()
    assert ("commit", "--no-verify", "-m", "feat(INT-25): prepare product changes for review") in git_calls
    assert ("push", "-u", "origin", "HEAD:feature/int-25") in git_calls


def test_dev_hook_commits_gitignore_when_ignored_cache_dirs_exist(tmp_path):
    hook = make_hook(tmp_path)
    repo = hook.store.symphony_dir.path.parent

    def git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )

    git("init", "-b", "main")
    git("config", "user.name", "Symphony Test")
    git("config", "user.email", "symphony-test@example.com")
    (repo / "README.md").write_text("base\n", encoding="utf-8")
    git("add", "README.md")
    git("commit", "-m", "Initial commit")

    (repo / ".gitignore").write_text(".mypy_cache/\n.pytest_cache/\n", encoding="utf-8")
    (repo / "physics.py").write_text("__all__ = ['luminosity']\n", encoding="utf-8")
    (repo / ".mypy_cache").mkdir()
    (repo / ".mypy_cache" / "cache.json").write_text("{}", encoding="utf-8")
    (repo / ".pytest_cache").mkdir()
    (repo / ".pytest_cache" / "nodeids").write_text("[]", encoding="utf-8")

    assert hook._commit_product_changes_if_needed() is True

    committed_paths = set(git("show", "--name-only", "--format=", "HEAD").stdout.splitlines())
    assert ".gitignore" in committed_paths
    assert "physics.py" in committed_paths
    assert ".mypy_cache/cache.json" not in committed_paths
    assert ".pytest_cache/nodeids" not in committed_paths
    assert not any(path.startswith(".symphony/") for path in committed_paths)

    status = git("status", "--short", "--ignored").stdout
    assert "!! .mypy_cache/" in status
    assert "!! .pytest_cache/" in status
    assert "?? .symphony/" in status


def test_dev_hook_ignores_private_runtime_and_cache_changes_when_no_product_diff(tmp_path, monkeypatch):
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
        elif command[0:2] == ("reset", "--"):
            result.stdout = ""
        elif command[0:3] == ("add", "--all", "--"):
            result.stdout = ""
        elif command == ("diff", "--cached", "--name-only"):
            result.stdout = ""
        elif command == ("rev-list", "--count", "refs/remotes/origin/main..HEAD"):
            result.stdout = "0\n"
        elif command == ("status", "--short"):
            result.stdout = "?? .symphony/state.json\n?? __pycache__/module.pyc\n?? .pytest_cache/v/cache/nodeids\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is False
    assert hook.github.create_pull_request.call_count == 0
    assert hook.last_delivery_code == "no_actionable_diff"
    assert hook.store.get_state()["error"] == (
        "No commits found on feature/int-25 relative to refs/remotes/origin/main; "
        "skipping PR creation"
    )
    assert all(call[0] != "commit" for call in git_calls)


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
        elif command == ("push", "-u", "origin", "HEAD:feature/int-25"):
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
        ("push", "-u", "origin", "HEAD:feature/int-25"),
    ]


def test_dev_hook_pushes_current_head_to_expected_runtime_branch(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.branch = "symharix-demo/int-25-runtime-branch"
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
        elif command == ("rev-parse", "--verify", "refs/remotes/origin/symharix-demo/int-25-runtime-branch"):
            result.returncode = 128
            result.stderr = "fatal: Needed a single revision\n"
        elif command == ("push", "-u", "origin", "HEAD:symharix-demo/int-25-runtime-branch"):
            result.stdout = "branch set up to track origin/symharix-demo/int-25-runtime-branch\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is True
    hook.github.create_pull_request.assert_called_once()
    assert hook.github.create_pull_request.call_args.kwargs["head"] == "symharix-demo/int-25-runtime-branch"
    assert ("push", "-u", "origin", "HEAD:symharix-demo/int-25-runtime-branch") in git_calls


def test_dev_hook_marks_origin_push_failure_as_review_submit_failed(tmp_path, monkeypatch):
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
            result.stdout = "1\n"
        elif command == ("rev-parse", "HEAD"):
            result.stdout = "local-head-sha\n"
        elif command == ("rev-parse", "--verify", "refs/remotes/origin/feature/int-25"):
            result.returncode = 128
            result.stderr = "fatal: Needed a single revision\n"
        elif command == ("push", "-u", "origin", "HEAD:feature/int-25"):
            result.returncode = 1
            result.stderr = "remote rejected: workflow scope required\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is False
    assert hook.last_delivery_code == "review_submit_failed"
    assert "workflow scope required" in (hook.last_delivery_summary or "")
    hook.github.create_pull_request.assert_not_called()


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
        elif command == ("push", "-u", "origin", "HEAD:feature/int-25"):
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
        elif command == ("push", "-u", "origin", "HEAD:feature/int-25"):
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
        elif command == ("commit", "--no-verify", "-m", "chore: remove workflow artifacts from submission"):
            result.stdout = "[feature/int-25 abc123] cleanup\n"
        elif command == ("rev-list", "--count", "refs/remotes/origin/main..HEAD"):
            result.stdout = "2\n"
        elif command == ("rev-parse", "HEAD"):
            result.stdout = "local-head-sha\n"
        elif command == ("rev-parse", "--verify", "refs/remotes/origin/feature/int-25"):
            result.returncode = 128
            result.stderr = "fatal: Needed a single revision\n"
        elif command == ("push", "-u", "origin", "HEAD:feature/int-25"):
            result.stdout = "branch set up to track origin/feature/int-25\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is True
    assert ("commit", "--no-verify", "-m", "chore: remove workflow artifacts from submission") in git_calls


def test_dev_hook_recovers_when_pr_create_returns_422_but_pr_already_exists(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.github.pr_exists.return_value = None
    existing_pr = {
        "html_url": "https://github.com/owner/repo/pull/25",
        "number": 25,
    }

    response = MagicMock()
    response.status_code = 422
    error = requests.HTTPError("422 Client Error: Unprocessable Entity for url", response=response)

    hook.github.create_pull_request.side_effect = error
    hook.github.get_pull_request_by_branch.return_value = existing_pr

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
            result.stdout = "local-head-sha\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is True
    hook.github.create_pull_request.assert_called_once()
    hook.github.get_pull_request_by_branch.assert_called_once_with("feature/int-25", state="open")
    assert hook.store.get_current_state_enum().value == State.IN_REVIEW.value
    assert hook.store.get_state()["metadata"]["pr_number"] == 25


def test_dev_hook_pushes_to_github_remote_and_retries_when_pr_create_422_has_no_existing_pr(tmp_path, monkeypatch):
    hook = make_hook(tmp_path)
    hook.github.pr_exists.return_value = None
    hook.github.get_pull_request_by_branch.return_value = None
    response = MagicMock()
    response.status_code = 422
    error = requests.HTTPError("422 Client Error: Unprocessable Entity for url", response=response)
    hook.github.create_pull_request.side_effect = [
        error,
        {
            "html_url": "https://github.com/owner/repo/pull/25",
            "number": 25,
        },
    ]

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
            result.stdout = "local-head-sha\n"
        elif command == ("remote", "get-url", "symphony-github"):
            result.returncode = 2
            result.stderr = "error: No such remote 'symphony-github'\n"
        elif command == ("remote", "add", "symphony-github", "https://github.com/owner/repo.git"):
            result.stdout = ""
        elif command == ("push", "-u", "symphony-github", "HEAD:feature/int-25"):
            result.stdout = "branch set up to track symphony-github/feature/int-25\n"
        else:
            raise AssertionError(f"Unexpected git command: {cmd}")

        return result

    monkeypatch.setattr("scripts.hooks.dev.subprocess.run", fake_run)

    assert hook.run() is True
    assert hook.github.create_pull_request.call_count == 2
    assert ("push", "-u", "symphony-github", "HEAD:feature/int-25") in git_calls
    assert hook.store.get_current_state_enum().value == State.IN_REVIEW.value
