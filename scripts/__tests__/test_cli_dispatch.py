from pathlib import Path

from scripts.cli import (
    reset_workspace_artifacts,
    resolve_dispatch_github_repo,
    resolve_dispatch_workspace_path,
)


def test_reset_workspace_artifacts_removes_stale_workflow_files(tmp_path: Path):
    workspace = tmp_path / "workspace"
    symphony = workspace / ".symphony"
    workspace.mkdir()
    symphony.mkdir()

    for filename in ("DEVELOPMENT_LOG.md", "HANDOVER.md", "REVIEW_REPORT.md"):
        (workspace / filename).write_text("legacy root artifact")
        (symphony / filename).write_text("stale symphony artifact")

    (symphony / "events.log").write_text("old event")
    (symphony / "context.json").write_text("{}")
    (symphony / "state.json").write_text('{"keep":"me"}')

    reset_workspace_artifacts(workspace, symphony)

    for filename in ("DEVELOPMENT_LOG.md", "HANDOVER.md", "REVIEW_REPORT.md"):
        assert (workspace / filename).exists()
        assert not (symphony / filename).exists()

    assert not (symphony / "events.log").exists()
    assert not (symphony / "context.json").exists()
    assert (symphony / "state.json").read_text() == '{"keep":"me"}'


def test_resolve_dispatch_github_repo_prefers_explicit_routing_env():
    issue = {
        "identifier": "INT-200",
        "project": {"name": "Wrong Display Name"},
    }

    owner, repo, full = resolve_dispatch_github_repo(
        issue=issue,
        default_owner="fallback-owner",
        default_repo="fallback-repo",
        env={
            "SYMPHONY_GITHUB_REPO_FULL": "acme/backend",
        },
    )

    assert owner == "acme"
    assert repo == "backend"
    assert full == "acme/backend"


def test_resolve_dispatch_workspace_path_uses_repo_cache_key_in_standalone_mode(tmp_path: Path):
    workspace_path = resolve_dispatch_workspace_path(
        workspace_root=tmp_path,
        issue_id="INT-200",
        github_repo_full="acme/backend",
        workspace_path_opt=None,
    )

    assert workspace_path == tmp_path / "acme__backend" / "worktrees" / "INT-200"
