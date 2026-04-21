# scripts/lib/state_store.py
"""File system state storage for Symphony."""

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .state_machine import State, StateMachine, Transition

SYMPHONY_DIR_NAME = ".symphony"
STATE_FILE_NAME = "state.json"
CONTEXT_FILE_NAME = "context.json"
EVENTS_FILE_NAME = "events.log"
STATE_VERSION = 1

class SymphonyDir:
    """Manages the .symphony directory for a workspace."""

    def __init__(self, workspace_root: Path, issue_id: str):
        self.workspace_root = workspace_root
        self.issue_id = issue_id
        direct_workspace_path = workspace_root / SYMPHONY_DIR_NAME
        if direct_workspace_path.exists() or self._looks_like_git_workspace(workspace_root):
            self.path = direct_workspace_path
        else:
            self.path = workspace_root / issue_id / SYMPHONY_DIR_NAME
        self.state_file = self.path / STATE_FILE_NAME
        self.context_file = self.path / CONTEXT_FILE_NAME
        self.events_file = self.path / EVENTS_FILE_NAME

    @staticmethod
    def _looks_like_git_workspace(workspace_root: Path) -> bool:
        """Detect when the caller passed an actual git workspace/worktree path."""
        return (workspace_root / ".git").exists()

    def create(self) -> None:
        """Create the .symphony directory and empty files."""
        self.path.mkdir(parents=True, exist_ok=True)
        self.state_file.touch(exist_ok=True)
        self.context_file.touch(exist_ok=True)
        self.events_file.touch(exist_ok=True)

    def exists(self) -> bool:
        """Check if the .symphony directory exists."""
        return self.path.exists() and self.path.is_dir()

    def delete(self) -> None:
        """Delete the entire workspace directory (including dev files)."""
        workspace_dir = self.path.parent
        if workspace_dir.exists():
            shutil.rmtree(workspace_dir)

    def read_state(self) -> Optional[dict]:
        """Read state.json, returns None if not exists."""
        if not self.state_file.exists():
            return None
        content = self.state_file.read_text()
        if not content.strip():
            return None
        return json.loads(content)

    def write_state(self, data: dict) -> None:
        """Write state.json."""
        self.state_file.write_text(json.dumps(data, indent=2) + "\n")

    def read_context(self) -> Optional[dict]:
        """Read context.json, returns None if not exists."""
        if not self.context_file.exists():
            return None
        content = self.context_file.read_text()
        if not content.strip():
            return None
        return json.loads(content)

    def write_context(self, data: dict) -> None:
        """Write context.json."""
        self.context_file.write_text(json.dumps(data, indent=2) + "\n")

    def append_event(self, event_type: str, data: dict) -> None:
        """Append an event to events.log."""
        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        event = {
            "timestamp": timestamp,
            "event": event_type,
            "data": data,
        }
        with open(self.events_file, "a") as f:
            f.write(json.dumps(event) + "\n")

class StateStore:
    """
    High-level state management using StateStore.
    Reads/writes .symphony/state.json and .symphony/events.log.
    """

    def __init__(self, workspace_root: Path, issue_id: str):
        self.workspace_root = workspace_root
        self.issue_id = issue_id
        self.symphony_dir = SymphonyDir(workspace_root, issue_id)
        self.state_machine = StateMachine()

    def initialize(
        self,
        linear_issue_id: str,
        linear_state: str,
        github_repo: str,
        branch: str,
    ) -> dict:
        """Initialize a new state.json for a fresh dispatch."""
        if self.symphony_dir.exists():
            raise ValueError(f"State already exists for {self.issue_id}")

        self.symphony_dir.create()

        initial_state = {
            "version": STATE_VERSION,
            "issue_id": self.issue_id,
            "current_state": State.TODO.value,
            "previous_state": None,
            "transition_history": [],
            "metadata": {
                "linear_issue_id": linear_issue_id,
                "linear_state": linear_state,
                "pr_url": None,
                "pr_number": None,
                "pr_merged": False,
                "github_issue_number": None,
                "branch": branch,
                "github_repo": github_repo,
            },
            "error": None,
            "retry_count": 0,
        }

        self.symphony_dir.write_state(initial_state)
        self.symphony_dir.append_event("initialized", {"issue_id": self.issue_id})

        return initial_state

    def get_state(self) -> Optional[dict]:
        """Get current state."""
        return self.symphony_dir.read_state()

    def get_current_state_enum(self) -> Optional[State]:
        """Get current state as State enum."""
        state = self.get_state()
        if not state:
            return None
        return State.from_string(state["current_state"])

    def update_state(
        self,
        from_state: State,
        to_state: State,
        trigger: str,
        actor: str = "system",
        reason: Optional[str] = None,
        metadata_updates: Optional[dict] = None,
    ) -> dict:
        """Update state with a transition."""
        current = self.get_state()
        if not current:
            raise ValueError(f"No state found for {self.issue_id}")

        # Validate transition
        transition = self.state_machine.create_transition(
            from_state=from_state,
            to_state=to_state,
            trigger=trigger,
            actor=actor,
            reason=reason,
        )

        # Update state
        current["previous_state"] = current["current_state"]
        current["current_state"] = to_state.value
        current["transition_history"].append({
            "from": from_state.value,
            "to": to_state.value,
            "trigger": trigger,
            "timestamp": transition.timestamp,
            "actor": actor,
        })

        # Update metadata if provided
        if metadata_updates:
            current["metadata"].update(metadata_updates)

        # Clear error on successful transition
        if to_state != State.ERROR:
            current["error"] = None

        self.symphony_dir.write_state(current)
        self.symphony_dir.append_event("state_changed", {
            "from": from_state.value,
            "to": to_state.value,
            "trigger": trigger,
        })

        return current

    def set_error(self, error_message: str) -> dict:
        """Set error state and increment retry count."""
        current = self.get_state()
        if not current:
            raise ValueError(f"No state found for {self.issue_id}")

        current["error"] = error_message
        current["retry_count"] = current.get("retry_count", 0) + 1

        self.symphony_dir.write_state(current)
        self.symphony_dir.append_event("error", {"message": error_message})

        return current

    def get_events(self) -> list[dict]:
        """Read all events from events.log."""
        if not self.symphony_dir.events_file.exists():
            return []
        events = []
        for line in self.symphony_dir.events_file.read_text().splitlines():
            if line.strip():
                events.append(json.loads(line))
        return events

    def update_metadata(self, updates: dict) -> dict:
        """Update metadata fields."""
        current = self.get_state()
        if not current:
            raise ValueError(f"No state found for {self.issue_id}")

        current["metadata"].update(updates)
        self.symphony_dir.write_state(current)

        return current
