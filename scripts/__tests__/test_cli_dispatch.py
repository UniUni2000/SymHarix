from pathlib import Path

from scripts.cli import reset_workspace_artifacts


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
