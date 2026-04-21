# scripts/__tests__/test_state_store.py
import pytest
import tempfile
from pathlib import Path
from scripts.lib.state_machine import State
from scripts.lib.state_store import StateStore, SymphonyDir

def test_symphony_dir_path():
    """Test SymphonyDir path construction."""
    with tempfile.TemporaryDirectory() as tmpdir:
        sd = SymphonyDir(Path(tmpdir), "INT-23")
        expected = Path(tmpdir) / "INT-23" / ".symphony"
        assert sd.path == expected

def test_symphony_dir_prefers_workspace_local_path_for_git_worktree():
    """Test real git workspaces store state inside workspace/.symphony."""
    with tempfile.TemporaryDirectory() as tmpdir:
        workspace = Path(tmpdir) / "INT-23"
        workspace.mkdir()
        (workspace / ".git").write_text("gitdir: /tmp/fake-worktree\n")

        sd = SymphonyDir(workspace, "INT-23")

        assert sd.path == workspace / ".symphony"

def test_create_directory_structure():
    """Test that create() creates the directory structure."""
    with tempfile.TemporaryDirectory() as tmpdir:
        sd = SymphonyDir(Path(tmpdir), "INT-23")
        sd.create()
        assert sd.state_file.exists()
        assert sd.context_file.exists()
        assert sd.events_file.exists()

def test_write_and_read_state():
    """Test state.json write and read."""
    with tempfile.TemporaryDirectory() as tmpdir:
        sd = SymphonyDir(Path(tmpdir), "INT-23")
        sd.create()

        state_data = {
            "version": 1,
            "issue_id": "INT-23",
            "current_state": "TODO",
            "previous_state": None,
            "transition_history": [],
            "metadata": {
                "linear_issue_id": "uuid-123",
                "linear_state": "Todo",
                "pr_url": None,
                "pr_number": None,
                "pr_merged": False,
                "branch": "int-23",
                "github_repo": "owner/repo",
            },
            "error": None,
            "retry_count": 0,
        }

        sd.write_state(state_data)
        loaded = sd.read_state()

        assert loaded["issue_id"] == "INT-23"
        assert loaded["current_state"] == "TODO"
        assert loaded["metadata"]["linear_issue_id"] == "uuid-123"

def test_append_event():
    """Test events.log append."""
    with tempfile.TemporaryDirectory() as tmpdir:
        sd = SymphonyDir(Path(tmpdir), "INT-23")
        sd.create()

        sd.append_event("state_changed", {"from": "TODO", "to": "IN_PROGRESS"})

        content = sd.events_file.read_text()
        assert "state_changed" in content
        assert "TODO" in content
        assert "IN_PROGRESS" in content

def test_update_state_with_transition():
    """Test StateStore.update_state with transition."""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = StateStore(Path(tmpdir), "INT-23")
        store.initialize(
            linear_issue_id="uuid-123",
            linear_state="Todo",
            github_repo="owner/repo",
            branch="int-23",
        )

        store.update_state(
            from_state=State.TODO,
            to_state=State.IN_PROGRESS,
            trigger="dispatch",
        )

        state = store.symphony_dir.read_state()
        assert state["current_state"] == "IN_PROGRESS"
        assert state["previous_state"] == "TODO"
        assert len(state["transition_history"]) == 1
        assert state["transition_history"][0]["from"] == "TODO"
        assert state["transition_history"][0]["to"] == "IN_PROGRESS"

def test_initialize_creates_state():
    """Test StateStore.initialize creates state.json."""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = StateStore(Path(tmpdir), "INT-23")
        state = store.initialize(
            linear_issue_id="uuid-123",
            linear_state="Todo",
            github_repo="owner/repo",
            branch="int-23",
        )

        assert state["issue_id"] == "INT-23"
        assert state["current_state"] == "TODO"
        assert state["metadata"]["linear_issue_id"] == "uuid-123"
        assert state["metadata"]["branch"] == "int-23"

def test_initialize_fails_if_exists():
    """Test StateStore.initialize fails if state already exists."""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = StateStore(Path(tmpdir), "INT-23")
        store.initialize(
            linear_issue_id="uuid-123",
            linear_state="Todo",
            github_repo="owner/repo",
            branch="int-23",
        )

        with pytest.raises(ValueError) as exc_info:
            store.initialize(
                linear_issue_id="uuid-456",
                linear_state="In Progress",
                github_repo="owner/repo2",
                branch="int-24",
            )
        assert "already exists" in str(exc_info.value)

def test_get_current_state_enum():
    """Test get_current_state_enum returns State enum."""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = StateStore(Path(tmpdir), "INT-23")
        store.initialize(
            linear_issue_id="uuid-123",
            linear_state="Todo",
            github_repo="owner/repo",
            branch="int-23",
        )

        current = store.get_current_state_enum()
        assert current == State.TODO

def test_set_error():
    """Test set_error increments retry count."""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = StateStore(Path(tmpdir), "INT-23")
        store.initialize(
            linear_issue_id="uuid-123",
            linear_state="Todo",
            github_repo="owner/repo",
            branch="int-23",
        )

        store.set_error("Test error")
        state = store.get_state()
        assert state["error"] == "Test error"
        assert state["retry_count"] == 1

        store.set_error("Another error")
        state = store.get_state()
        assert state["retry_count"] == 2

def test_get_events():
    """Test get_events returns list of events."""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = StateStore(Path(tmpdir), "INT-23")
        store.initialize(
            linear_issue_id="uuid-123",
            linear_state="Todo",
            github_repo="owner/repo",
            branch="int-23",
        )

        events = store.get_events()
        assert len(events) >= 1  # At least the initialized event
        assert events[0]["event"] == "initialized"

def test_update_metadata():
    """Test update_metadata updates specific fields."""
    with tempfile.TemporaryDirectory() as tmpdir:
        store = StateStore(Path(tmpdir), "INT-23")
        store.initialize(
            linear_issue_id="uuid-123",
            linear_state="Todo",
            github_repo="owner/repo",
            branch="int-23",
        )

        store.update_metadata({
            "pr_url": "https://github.com/owner/repo/pull/42",
            "pr_number": 42,
        })

        state = store.get_state()
        assert state["metadata"]["pr_url"] == "https://github.com/owner/repo/pull/42"
        assert state["metadata"]["pr_number"] == 42
        assert state["metadata"]["branch"] == "int-23"  # Unchanged

def test_symphony_dir_delete():
    """Test SymphonyDir.delete removes entire workspace."""
    with tempfile.TemporaryDirectory() as tmpdir:
        sd = SymphonyDir(Path(tmpdir), "INT-23")
        sd.create()

        # Create a file in workspace
        workspace_dir = sd.path.parent
        (workspace_dir / "hello.py").write_text("print('hello')")

        assert workspace_dir.exists()
        sd.delete()
        assert not workspace_dir.exists()
