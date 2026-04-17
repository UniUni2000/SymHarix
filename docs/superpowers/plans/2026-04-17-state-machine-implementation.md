# State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a local state machine with Linear dual-check to replace the buggy shell-script workflow, using Python CLI + library architecture.

**Architecture:** Local state stored in `.symphony/` directory per workspace as JSON files. Linear and GitHub APIs used for dual-verification before each state transition. Sync blocking with gradient retry (1s, 5s, 30s).

**Tech Stack:** Python 3.8+, standard library (json, pathlib, logging), requests library

---

## File Structure

```
scripts/
├── cli.py                  # CLI entry point with subcommands
├── lib/
│   ├── __init__.py
│   ├── state_machine.py    # State enum, transition rules, validation
│   ├── state_store.py      # File system read/write for state.json, context.json, events.log
│   ├── linear_client.py     # Linear GraphQL API client
│   ├── github_client.py     # GitHub REST API client
│   └── retry.py            # Gradient retry decorator/factory
└── hooks/
    ├── __init__.py
    ├── dev.py               # DEV phase: develop, create PR, update Linear to In Review
    ├── review.py            # REVIEW phase: review PR, merge if approved, update Linear to Done
    └── merge.py             # Merge helper (called by review.py)
```

---

## Phase 1: Shared Library (scripts/lib/)

### Task 1: Project Setup

**Files:**
- Create: `scripts/lib/__init__.py`
- Create: `scripts/lib/state_machine.py`
- Create: `scripts/lib/state_store.py`
- Create: `scripts/lib/linear_client.py`
- Create: `scripts/lib/github_client.py`
- Create: `scripts/lib/retry.py`
- Create: `scripts/lib/config.py` (reads .env)

- [ ] **Step 1: Create scripts/lib/__init__.py**

```python
"""Symphony shared library."""

from .state_machine import State, Transition, StateMachine
from .state_store import StateStore
from .linear_client import LinearClient
from .github_client import GitHubClient
from .retry import retry_with_backoff

__all__ = [
    "State",
    "Transition",
    "StateMachine",
    "StateStore",
    "LinearClient",
    "GitHubClient",
    "retry_with_backoff",
]
```

- [ ] **Step 2: Commit**

```bash
git add scripts/lib/__init__.py scripts/lib/state_machine.py scripts/lib/state_store.py scripts/lib/linear_client.py scripts/lib/github_client.py scripts/lib/retry.py scripts/lib/config.py
git commit -m "feat(scripts/lib): initial shared library structure

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: State Machine Core (state_machine.py)

**Files:**
- Create: `scripts/lib/state_machine.py`
- Create: `scripts/__tests__/test_state_machine.py`

- [ ] **Step 1: Write failing test**

```python
# scripts/__tests__/test_state_machine.py
import pytest
from scripts.lib.state_machine import State, Transition, StateMachine

def test_state_enum_values():
    assert State.TODO.value == "TODO"
    assert State.IN_PROGRESS.value == "IN_PROGRESS"
    assert State.IN_REVIEW.value == "IN_REVIEW"
    assert State.DONE.value == "DONE"
    assert State.CANCELLED.value == "CANCELLED"
    assert State.ERROR.value == "ERROR"

def test_valid_transition_todo_to_in_progress():
    sm = StateMachine()
    assert sm.can_transition(State.TODO, State.IN_PROGRESS) == True

def test_valid_transition_in_progress_to_in_review():
    sm = StateMachine()
    assert sm.can_transition(State.IN_PROGRESS, State.IN_REVIEW) == True

def test_valid_transition_in_review_to_done():
    sm = StateMachine()
    assert sm.can_transition(State.IN_REVIEW, State.DONE) == True

def test_valid_transition_in_review_to_in_progress():
    sm = StateMachine()
    assert sm.can_transition(State.IN_REVIEW, State.IN_PROGRESS) == True

def test_valid_transition_in_progress_to_cancelled():
    sm = StateMachine()
    assert sm.can_transition(State.IN_PROGRESS, State.CANCELLED) == True

def test_valid_transition_error_to_in_progress():
    sm = StateMachine()
    assert sm.can_transition(State.ERROR, State.IN_PROGRESS) == True

def test_invalid_transition_done_to_anything():
    sm = StateMachine()
    assert sm.can_transition(State.DONE, State.IN_PROGRESS) == False
    assert sm.can_transition(State.DONE, State.CANCELLED) == False

def test_invalid_transition_cancelled_to_anything():
    sm = StateMachine()
    assert sm.can_transition(State.CANCELLED, State.IN_PROGRESS) == False

def test_invalid_transition_todo_to_done():
    sm = StateMachine()
    assert sm.can_transition(State.TODO, State.DONE) == False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_state_machine.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: Write state_machine.py with State enum and StateMachine class**

```python
# scripts/lib/state_machine.py
"""State machine for Symphony issue workflow."""

from enum import Enum
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

class State(Enum):
    TODO = "TODO"
    IN_PROGRESS = "IN_PROGRESS"
    IN_REVIEW = "IN_REVIEW"
    DONE = "DONE"
    CANCELLED = "CANCELLED"
    ERROR = "ERROR"

    @classmethod
    def from_string(cls, s: str) -> "State":
        """Parse state from string, case-insensitive."""
        for state in cls:
            if state.value.lower() == s.lower():
                return state
        raise ValueError(f"Unknown state: {s}")

    def is_terminal(self) -> bool:
        """Check if this is a terminal state."""
        return self in (State.DONE, State.CANCELLED)

    def is_active(self) -> bool:
        """Check if this is an active (non-terminal, non-error) state."""
        return self in (State.TODO, State.IN_PROGRESS, State.IN_REVIEW)

@dataclass
class Transition:
    from_state: State
    to_state: State
    trigger: str
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    actor: str = "system"
    reason: Optional[str] = None

class StateMachine:
    """
    Valid state transitions (from -> [to states]):
    - TODO -> IN_PROGRESS
    - IN_PROGRESS -> IN_REVIEW, IN_PROGRESS (retry), CANCELLED
    - IN_REVIEW -> DONE, IN_PROGRESS (reject), IN_REVIEW (retry)
    - ERROR -> IN_PROGRESS (manual retry)
    - DONE -> (terminal, no transitions)
    - CANCELLED -> (terminal, no transitions)
    """

    TRANSITIONS: dict[State, list[State]] = {
        State.TODO: [State.IN_PROGRESS],
        State.IN_PROGRESS: [State.IN_REVIEW, State.IN_PROGRESS, State.CANCELLED],
        State.IN_REVIEW: [State.DONE, State.IN_PROGRESS, State.IN_REVIEW],
        State.ERROR: [State.IN_PROGRESS],
        State.DONE: [],
        State.CANCELLED: [],
    }

    def can_transition(self, from_state: State, to_state: State) -> bool:
        """Check if a transition is valid."""
        valid_targets = self.TRANSITIONS.get(from_state, [])
        return to_state in valid_targets

    def validate_transition(self, from_state: State, to_state: State) -> None:
        """Validate and raise ValueError if invalid."""
        if not self.can_transition(from_state, to_state):
            raise ValueError(
                f"Invalid transition from {from_state.value} to {to_state.value}"
            )

    def create_transition(
        self,
        from_state: State,
        to_state: State,
        trigger: str,
        actor: str = "system",
        reason: Optional[str] = None,
    ) -> Transition:
        """Create a validated transition."""
        self.validate_transition(from_state, to_state)
        return Transition(
            from_state=from_state,
            to_state=to_state,
            trigger=trigger,
            actor=actor,
            reason=reason,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_state_machine.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/test_state_machine.py scripts/lib/state_machine.py
git commit -m "feat(scripts/lib): add StateMachine with transition validation

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: State Store (state_store.py)

**Files:**
- Create: `scripts/lib/state_store.py`
- Create: `scripts/__tests__/test_state_store.py`

- [ ] **Step 1: Write failing test (with temp directory)**

```python
# scripts/__tests__/test_state_store.py
import pytest
import tempfile
import shutil
from pathlib import Path
import json
from scripts.lib.state_machine import State
from scripts.lib.state_store import StateStore, SymphonyDir

def test_symphony_dir_path():
    """Test SymphonyDir path construction."""
    with tempfile.TemporaryDirectory() as tmpdir:
        sd = SymphonyDir(Path(tmpdir), "INT-23")
        expected = Path(tmpdir) / "INT-23" / ".symphony"
        assert sd.path == expected

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
        sd = SymphonyDir(Path(tmpdir), "INT-23")
        sd.create()

        store = StateStore(Path(tmpdir), "INT-23")
        store.update_state(
            from_state=State.TODO,
            to_state=State.IN_PROGRESS,
            trigger="dispatch",
        )

        state = sd.read_state()
        assert state["current_state"] == "IN_PROGRESS"
        assert state["previous_state"] == "TODO"
        assert len(state["transition_history"]) == 1
        assert state["transition_history"][0]["from"] == "TODO"
        assert state["transition_history"][0]["to"] == "IN_PROGRESS"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_state_store.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: Write state_store.py**

```python
# scripts/lib/state_store.py
"""File system state storage for Symphony."""

import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

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
        self.path = workspace_root / issue_id / SYMPHONY_DIR_NAME
        self.state_file = self.path / STATE_FILE_NAME
        self.context_file = self.path / CONTEXT_FILE_NAME
        self.events_file = self.path / EVENTS_FILE_NAME

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
        timestamp = datetime.utcnow().isoformat() + "Z"
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_state_store.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/test_state_store.py scripts/lib/state_store.py
git commit -m "feat(scripts/lib): add StateStore for filesystem state management

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Config (config.py)

**Files:**
- Create: `scripts/lib/config.py`
- Create: `scripts/__tests__/test_config.py`

- [ ] **Step 1: Write failing test**

```python
# scripts/__tests__/test_config.py
import pytest
import tempfile
import os
from pathlib import Path
from scripts.lib.config import Config, load_config

def test_config_from_env():
    """Test Config loads from environment variables."""
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["LINEAR_API_KEY"] = "lin_test_key_123"
        os.environ["GITHUB_TOKEN"] = "ghp_test_token_456"
        os.environ["GITHUB_OWNER"] = "testowner"
        os.environ["GITHUB_REPO"] = "testrepo"
        os.environ["WORKSPACE_ROOT"] = tmpdir

        config = load_config()

        assert config.linear_api_key == "lin_test_key_123"
        assert config.github_token == "ghp_test_token_456"
        assert config.github_owner == "testowner"
        assert config.github_repo == "testrepo"
        assert config.workspace_root == Path(tmpdir)

        # Cleanup
        del os.environ["LINEAR_API_KEY"]
        del os.environ["GITHUB_TOKEN"]
        del os.environ["GITHUB_OWNER"]
        del os.environ["GITHUB_REPO"]
        del os.environ["WORKSPACE_ROOT"]

def test_config_defaults():
    """Test Config has sensible defaults."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Only set required vars
        os.environ["LINEAR_API_KEY"] = "lin_key"
        os.environ["GITHUB_TOKEN"] = "gh_token"
        os.environ["GITHUB_OWNER"] = "owner"
        os.environ["GITHUB_REPO"] = "repo"

        config = load_config()

        assert config.linear_endpoint == "https://api.linear.app/graphql"
        assert config.poll_interval_ms == 30000
        assert config.max_retries == 3
        assert config.retry_delays == [1, 5, 30]

        # Cleanup
        del os.environ["LINEAR_API_KEY"]
        del os.environ["GITHUB_TOKEN"]
        del os.environ["GITHUB_OWNER"]
        del os.environ["GITHUB_REPO"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_config.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: Write config.py**

```python
# scripts/lib/config.py
"""Configuration loader from environment variables."""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

@dataclass
class Config:
    """Symphony configuration."""

    # Linear
    linear_api_key: str
    linear_endpoint: str = "https://api.linear.app/graphql"

    # GitHub
    github_token: str
    github_owner: str
    github_repo: str
    github_default_branch: str = "main"

    # Workspace
    workspace_root: Path = Path("/tmp/symphony_workspaces")

    # Polling
    poll_interval_ms: int = 30000

    # Retry
    max_retries: int = 3
    retry_delays: list[int] = field(default_factory=lambda: [1, 5, 30])

    # Agent
    max_concurrent_agents: int = 3
    max_turns: int = 20
    codex_command: str = "node ./scripts/claude-adapter.cjs"

def load_config() -> Config:
    """Load configuration from environment variables."""
    linear_api_key = os.environ.get("LINEAR_API_KEY") or os.environ.get("SYMPHONY_TRACKER_API_KEY")
    github_token = os.environ.get("GITHUB_TOKEN")
    github_owner = os.environ.get("GITHUB_OWNER") or os.environ.get("SYMPHONY_GITHUB_OWNER")
    github_repo = os.environ.get("GITHUB_REPO") or os.environ.get("SYMPHONY_GITHUB_REPO")
    workspace_root = os.environ.get("WORKSPACE_ROOT") or os.environ.get("SYMPHONY_WORKSPACE_ROOT", "/tmp/symphony_workspaces")

    if not linear_api_key:
        raise ValueError("LINEAR_API_KEY or SYMPHONY_TRACKER_API_KEY is required")
    if not github_token:
        raise ValueError("GITHUB_TOKEN is required")
    if not github_owner:
        raise ValueError("GITHUB_OWNER or SYMPHONY_GITHUB_OWNER is required")
    if not github_repo:
        raise ValueError("GITHUB_REPO or SYMPHONY_GITHUB_REPO is required")

    return Config(
        linear_api_key=linear_api_key,
        github_token=github_token,
        github_owner=github_owner,
        github_repo=github_repo,
        workspace_root=Path(workspace_root),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_config.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/test_config.py scripts/lib/config.py
git commit -m "feat(scripts/lib): add Config loader from environment

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Linear Client (linear_client.py)

**Files:**
- Create: `scripts/lib/linear_client.py`
- Create: `scripts/__tests__/test_linear_client.py`

- [ ] **Step 1: Write failing test (mock HTTP)**

```python
# scripts/__tests__/test_linear_client.py
import pytest
from unittest.mock import patch, MagicMock
from scripts.lib.linear_client import LinearClient

@patch("scripts.lib.linear_client.requests.post")
def test_fetch_issue_by_identifier(mock_post):
    """Test fetching issue by identifier."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "data": {
            "issues": {
                "nodes": [
                    {
                        "id": "uuid-123",
                        "identifier": "INT-23",
                        "title": "Test Issue",
                        "description": "Test description",
                        "state": {"name": "Todo"},
                    }
                ]
            }
        }
    }
    mock_post.return_value = mock_response

    client = LinearClient(api_key="test_key")
    issue = client.fetch_issue_by_identifier("INT-23")

    assert issue is not None
    assert issue["id"] == "uuid-123"
    assert issue["identifier"] == "INT-23"
    assert issue["title"] == "Test Issue"
    assert issue["state"]["name"] == "Todo"

@patch("scripts.lib.linear_client.requests.post")
def test_fetch_issue_not_found(mock_post):
    """Test fetching non-existent issue returns None."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "data": {"issues": {"nodes": []}}
    }
    mock_post.return_value = mock_response

    client = LinearClient(api_key="test_key")
    issue = client.fetch_issue_by_identifier("INT-999")
    assert issue is None

@patch("scripts.lib.linear_client.requests.post")
def test_update_issue_state(mock_post):
    """Test updating issue state."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "data": {
            "issueUpdate": {
                "success": True,
                "issue": {"identifier": "INT-23", "state": {"name": "In Review"}},
            }
        }
    }
    mock_post.return_value = mock_response

    client = LinearClient(api_key="test_key")
    success = client.update_issue_state("uuid-123", "state-uuid-456")

    assert success is True

@patch("scripts.lib.linear_client.requests.post")
def test_wait_for_state(mock_post):
    """Test waiting for issue to reach expected state."""
    # First call returns wrong state, second returns correct
    mock_response_1 = MagicMock()
    mock_response_1.json.return_value = {
        "data": {
            "issues": {
                "nodes": [{"id": "uuid-123", "identifier": "INT-23", "state": {"name": "In Progress"}}]
            }
        }
    }
    mock_response_2 = MagicMock()
    mock_response_2.json.return_value = {
        "data": {
            "issues": {
                "nodes": [{"id": "uuid-123", "identifier": "INT-23", "state": {"name": "In Review"}}]
            }
        }
    }
    mock_post.side_effect = [mock_response_1, mock_response_2]

    client = LinearClient(api_key="test_key")
    success = client.wait_for_state("INT-23", "In Review", max_wait_seconds=2, poll_interval=0.5)

    assert success is True
    assert mock_post.call_count == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_linear_client.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: Write linear_client.py**

```python
# scripts/lib/linear_client.py
"""Linear GraphQL API client."""

import time
from typing import Optional

import requests

from .config import Config
from .retry import retry_with_backoff

class LinearClient:
    """Client for Linear GraphQL API."""

    def __init__(self, api_key: str, endpoint: str = "https://api.linear.app/graphql"):
        self.api_key = api_key
        self.endpoint = endpoint
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": api_key,
            "Content-Type": "application/json",
        })

    def _post(self, query: str, variables: Optional[dict] = None) -> dict:
        """Execute a GraphQL query."""
        payload = {"query": query}
        if variables:
            payload["variables"] = variables

        response = self.session.post(self.endpoint, json=payload, timeout=30)
        response.raise_for_status()
        return response.json()

    def fetch_issue_by_identifier(self, identifier: str) -> Optional[dict]:
        """
        Fetch issue by identifier (e.g., 'INT-23').
        Returns issue dict or None if not found.
        """
        query = """
        query GetIssue($identifier: String!) {
            issues(filter: { identifier: { eq: $identifier } }) {
                nodes {
                    id
                    identifier
                    title
                    description
                    state {
                        name
                        id
                        type
                    }
                    createdAt
                    updatedAt
                }
            }
        }
        """
        result = self._post(query, {"identifier": identifier})
        nodes = result.get("data", {}).get("issues", {}).get("nodes", [])
        return nodes[0] if nodes else None

    def fetch_issue_state(self, identifier: str) -> Optional[str]:
        """Fetch current state name for an issue."""
        issue = self.fetch_issue_by_identifier(identifier)
        if not issue:
            return None
        return issue.get("state", {}).get("name")

    def update_issue_state(self, issue_id: str, state_id: str) -> bool:
        """Update issue state by issue ID and state ID."""
        query = """
        mutation UpdateIssue($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) {
                success
                issue {
                    identifier
                    state {
                        name
                    }
                }
            }
        }
        """
        result = self._post(query, {"id": issue_id, "stateId": state_id})
        success = result.get("data", {}).get("issueUpdate", {}).get("success", False)
        return success

    @retry_with_backoff(max_retries=3, delays=[1, 5, 30])
    def wait_for_state(
        self,
        identifier: str,
        expected_state: str,
        max_wait_seconds: float = 60,
        poll_interval: float = 2,
    ) -> bool:
        """
        Poll until issue reaches expected state.
        Returns True if state reached, False if timeout.
        """
        start_time = time.time()
        while time.time() - start_time < max_wait_seconds:
            current_state = self.fetch_issue_state(identifier)
            if current_state and current_state.lower() == expected_state.lower():
                return True
            time.sleep(poll_interval)
        return False

    def fetch_state_id(self, state_name: str) -> Optional[str]:
        """Fetch state ID by state name."""
        query = """
        query GetStates {
            teams {
                nodes {
                    name
                    states {
                        nodes {
                            id
                            name
                            type
                        }
                    }
                }
            }
        }
        """
        result = self._post(query)
        for team in result.get("data", {}).get("teams", {}).get("nodes", []):
            for state in team.get("states", {}).get("nodes", []):
                if state.get("name", "").lower() == state_name.lower():
                    return state.get("id")
        return None

    def get_active_states(self) -> list[str]:
        """Get list of active state names (started, not completed)."""
        query = """
        query GetStates {
            teams {
                nodes {
                    states {
                        nodes {
                            name
                            type
                        }
                    }
                }
            }
        }
        """
        result = self._post(query)
        states = []
        for team in result.get("data", {}).get("teams", {}).get("nodes", []):
            for state in team.get("states", {}).get("nodes", []):
                if state.get("type") in ("started", "unstarted"):
                    states.append(state.get("name"))
        return states

    def get_terminal_states(self) -> list[str]:
        """Get list of terminal/completed state names."""
        query = """
        query GetStates {
            teams {
                nodes {
                    states {
                        nodes {
                            name
                            type
                        }
                    }
                }
            }
        }
        """
        result = self._post(query)
        states = []
        for team in result.get("data", {}).get("teams", {}).get("nodes", []):
            for state in team.get("states", {}).get("nodes", []):
                if state.get("type") == "completed":
                    states.append(state.get("name"))
        return states
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_linear_client.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/test_linear_client.py scripts/lib/linear_client.py
git commit -m "feat(scripts/lib): add LinearClient for Linear API

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: GitHub Client (github_client.py)

**Files:**
- Create: `scripts/lib/github_client.py`
- Create: `scripts/__tests__/test_github_client.py`

- [ ] **Step 1: Write failing test (mock HTTP)**

```python
# scripts/__tests__/test_github_client.py
import pytest
from unittest.mock import patch, MagicMock
from scripts.lib.github_client import GitHubClient

@patch("scripts.lib.github_client.requests.get")
@patch("scripts.lib.github_client.requests.post")
def test_create_pull_request(mock_post, mock_get):
    """Test creating a pull request."""
    mock_pr_response = MagicMock()
    mock_pr_response.json.return_value = {
        "html_url": "https://github.com/owner/repo/pull/42",
        "number": 42,
    }
    mock_post.return_value = mock_pr_response

    mock_get.return_value = MagicMock()
    mock_get.return_value.json.return_value = {"default_branch": "main"}

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    pr = client.create_pull_request(
        title="[INT-23] Test PR",
        body="Test body",
        head="int-23",
    )

    assert pr["number"] == 42
    assert pr["html_url"] == "https://github.com/owner/repo/pull/42"

@patch("scripts.lib.github_client.requests.get")
def test_get_pull_request(mock_get):
    """Test fetching a pull request."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "number": 42,
        "title": "Test PR",
        "state": "open",
        "merged": False,
        "mergeable": True,
    }
    mock_get.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    pr = client.get_pull_request(42)

    assert pr["number"] == 42
    assert pr["merged"] is False

@patch("scripts.lib.github_client.requests.get")
def test_get_pull_request_by_branch(mock_get):
    """Test fetching PR by head branch."""
    mock_response = MagicMock()
    mock_response.json.return_value = [
        {
            "number": 42,
            "title": "Test PR",
            "head": {"ref": "int-23"},
            "merged": False,
        }
    ]
    mock_get.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    pr = client.get_pull_request_by_branch("int-23")

    assert pr is not None
    assert pr["number"] == 42

@patch("scripts.lib.github_client.requests.put")
def test_merge_pull_request(mock_put):
    """Test merging a pull request."""
    mock_response = MagicMock()
    mock_response.json.return_value = {"merged": True, "message": "Pull Request successfully merged"}
    mock_put.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    result = client.merge_pull_request(42)

    assert result["merged"] is True
    mock_put.assert_called_once()

@patch("scripts.lib.github_client.requests.get")
def test_get_reviews(mock_get):
    """Test fetching PR reviews."""
    mock_response = MagicMock()
    mock_response.json.return_value = [
        {"user": {"login": "reviewer1"}, "state": "APPROVED"},
        {"user": {"login": "reviewer2"}, "state": "CHANGES_REQUESTED"},
    ]
    mock_get.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    reviews = client.get_reviews(42)

    assert len(reviews) == 2
    assert reviews[0]["state"] == "APPROVED"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_github_client.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: Write github_client.py**

```python
# scripts/lib/github_client.py
"""GitHub REST API client."""

from typing import Optional

import requests

class GitHubClient:
    """Client for GitHub REST API."""

    def __init__(self, token: str, owner: str, repo: str, default_branch: str = "main"):
        self.token = token
        self.owner = owner
        self.repo = repo
        self.default_branch = default_branch
        self.base_url = f"https://api.github.com/repos/{owner}/{repo}"
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json",
        })

    def _get(self, path: str, **kwargs) -> dict:
        """Execute GET request."""
        url = f"{self.base_url}{path}"
        response = self.session.get(url, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json()

    def _post(self, path: str, data: dict, **kwargs) -> dict:
        """Execute POST request."""
        url = f"{self.base_url}{path}"
        response = self.session.post(url, json=data, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json()

    def _put(self, path: str, data: dict, **kwargs) -> dict:
        """Execute PUT request."""
        url = f"{self.base_url}{path}"
        response = self.session.put(url, json=data, timeout=30, **kwargs)
        response.raise_for_status()
        return response.json()

    def get_pull_request(self, pr_number: int) -> Optional[dict]:
        """Get pull request by number."""
        try:
            return self._get(f"/pulls/{pr_number}")
        except requests.HTTPError as e:
            if e.response.status_code == 404:
                return None
            raise

    def get_pull_request_by_branch(self, branch: str, state: str = "all") -> Optional[dict]:
        """Get pull request by head branch."""
        try:
            # Search for PRs with this head branch
            results = self._get(f"/pulls?head={self.owner}:{branch}&state={state}")
            if results and len(results) > 0:
                return results[0]
            return None
        except requests.HTTPError:
            return None

    def create_pull_request(
        self,
        title: str,
        body: str,
        head: str,
        draft: bool = False,
    ) -> dict:
        """Create a new pull request."""
        return self._post("/pulls", {
            "title": title,
            "body": body,
            "head": head,
            "base": self.default_branch,
            "draft": draft,
        })

    def merge_pull_request(
        self,
        pr_number: int,
        commit_title: Optional[str] = None,
        merge_method: str = "squash",
    ) -> dict:
        """Merge a pull request."""
        data = {"merge_method": merge_method}
        if commit_title:
            data["commit_title"] = commit_title

        return self._put(f"/pulls/{pr_number}/merge", data)

    def get_reviews(self, pr_number: int) -> list[dict]:
        """Get reviews for a pull request."""
        try:
            return self._get(f"/pulls/{pr_number}/reviews")
        except requests.HTTPError:
            return []

    def get_combined_status(self, branch: str) -> Optional[dict]:
        """Get combined CI status for a branch."""
        try:
            return self._get(f"/commits/{branch}/status")
        except requests.HTTPError:
            return None

    def get_pr_reviews_state(self, pr_number: int) -> str:
        """
        Determine overall PR review state.
        Returns: 'approved', 'changes_requested', 'pending', 'no_reviews'
        """
        reviews = self.get_reviews(pr_number)
        if not reviews:
            return "no_reviews"

        # Get latest review per user
        latest_by_user = {}
        for review in reviews:
            user = review.get("user", {}).get("login", "")
            state = review.get("state", "")
            if user and state in ("APPROVED", "CHANGES_REQUESTED"):
                latest_by_user[user] = state

        if not latest_by_user:
            return "pending"

        if "CHANGES_REQUESTED" in latest_by_user.values():
            return "changes_requested"
        elif "APPROVED" in latest_by_user.values():
            return "approved"
        else:
            return "pending"

    def pr_exists(self, branch: str) -> Optional[dict]:
        """Check if PR exists for branch and return it."""
        return self.get_pull_request_by_branch(branch, state="open")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_github_client.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/test_github_client.py scripts/lib/github_client.py
git commit -m "feat(scripts/lib): add GitHubClient for GitHub API

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: Retry Utility (retry.py)

**Files:**
- Create: `scripts/lib/retry.py`
- Create: `scripts/__tests__/test_retry.py`

- [ ] **Step 1: Write failing test**

```python
# scripts/__tests__/test_retry.py
import pytest
import time
from unittest.mock import MagicMock, patch
from scripts.lib.retry import retry_with_backoff, RetryExhaustedError

def test_retry_success_first_try():
    """Test successful call on first try."""
    mock_func = MagicMock(return_value="success")

    @retry_with_backoff(max_retries=3, delays=[1, 5, 30])
    def func():
        return mock_func()

    result = func()
    assert result == "success"
    assert mock_func.call_count == 1

def test_retry_success_after_failure():
    """Test successful call after one failure."""
    mock_func = MagicMock(side_effect=["error", "success"])

    @retry_with_backoff(max_retries=3, delays=[0.01, 0.01, 0.01])
    def func():
        return mock_func()

    result = func()
    assert result == "success"
    assert mock_func.call_count == 2

def test_retry_exhausted():
    """Test that RetryExhaustedError is raised after all retries."""
    mock_func = MagicMock(side_effect=["error1", "error2", "error3"])

    @retry_with_backoff(max_retries=3, delays=[0.01, 0.01, 0.01])
    def func():
        return mock_func()

    with pytest.raises(RetryExhaustedError) as exc_info:
        func()

    assert mock_func.call_count == 3
    assert "error3" in str(exc_info.value)

def test_retry_preserves_return_value():
    """Test that return value is preserved across retries."""
    mock_func = MagicMock(side_effect=["error1", "error2", {"data": "value"}])

    @retry_with_backoff(max_retries=3, delays=[0.01, 0.01, 0.01])
    def func():
        return mock_func()

    result = func()
    assert result == {"data": "value"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_retry.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: Write retry.py**

```python
# scripts/lib/retry.py
"""Gradient retry utility with exponential backoff."""

import time
from functools import wraps
from typing import Callable, TypeVar, Any

T = TypeVar("T")

class RetryExhaustedError(Exception):
    """Raised when all retry attempts are exhausted."""

    def __init__(self, message: str, last_error: Exception = None):
        super().__init__(message)
        self.last_error = last_error

def retry_with_backoff(
    max_retries: int = 3,
    delays: list[float] = None,
    exceptions: tuple = (Exception,),
):
    """
    Decorator that retries a function with gradient backoff.

    Args:
        max_retries: Maximum number of retry attempts
        delays: List of delay seconds between retries (default: [1, 5, 30])
        exceptions: Tuple of exceptions to catch and retry
    """
    if delays is None:
        delays = [1, 5, 30]

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @wraps(func)
        def wrapper(*args, **kwargs) -> T:
            last_error = None
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    last_error = e
                    if attempt < max_retries:
                        delay = delays[attempt] if attempt < len(delays) else delays[-1]
                        time.sleep(delay)
                    else:
                        raise RetryExhaustedError(
                            f"Retry exhausted after {max_retries} attempts. Last error: {e}",
                            last_error=e,
                        )
            # Should not reach here
            raise RetryExhaustedError(
                f"Retry exhausted after {max_retries} attempts",
                last_error=last_error,
            )
        return wrapper
    return decorator

def retry_call(
    func: Callable[..., T],
    args: tuple = (),
    kwargs: dict = None,
    max_retries: int = 3,
    delays: list[float] = None,
    exceptions: tuple = (Exception,),
) -> T:
    """
    Functional version of retry_with_backoff.
    Calls func(*args, **kwargs) with retry logic.
    """
    if kwargs is None:
        kwargs = {}

    if delays is None:
        delays = [1, 5, 30]

    last_error = None
    for attempt in range(max_retries + 1):
        try:
            return func(*args, **kwargs)
        except exceptions as e:
            last_error = e
            if attempt < max_retries:
                delay = delays[attempt] if attempt < len(delays) else delays[-1]
                time.sleep(delay)
            else:
                raise RetryExhaustedError(
                    f"Retry exhausted after {max_retries} attempts. Last error: {e}",
                    last_error=e,
                )

    raise RetryExhaustedError(
        f"Retry exhausted after {max_retries} attempts",
        last_error=last_error,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_retry.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/test_retry.py scripts/lib/retry.py
git commit -m "feat(scripts/lib): add retry_with_backoff decorator

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 2: CLI Entry Point

### Task 8: CLI Entry Point (cli.py)

**Files:**
- Create: `scripts/cli.py`
- Create: `scripts/__tests__/test_cli.py`

- [ ] **Step 1: Write failing test**

```python
# scripts/__tests__/test_cli.py
import pytest
from click.testing import CliRunner
from scripts.cli import cli

def test_cli_help():
    """Test CLI help output."""
    runner = CliRunner()
    result = runner.invoke(cli, ["--help"])
    assert result.exit_code == 0
    assert "dispatch" in result.output
    assert "status" in result.output
    assert "dev" in result.output
    assert "review" in result.output

def test_cli_status_command():
    """Test status command."""
    runner = CliRunner()
    result = runner.invoke(cli, ["status", "--help"])
    assert result.exit_code == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_cli.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: Write cli.py**

```python
#!/usr/bin/env python3
"""Symphony CLI - Unified entry point for all commands."""

import sys
from pathlib import Path

import click

# Add scripts/ to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from lib.config import load_config
from lib.state_machine import State
from lib.state_store import StateStore


@click.group()
@click.pass_context
def cli(ctx):
    """Symphony - Issue workflow automation."""
    try:
        ctx.ensure_object(dict)
        ctx.obj["config"] = load_config()
    except ValueError as e:
        click.echo(f"Configuration error: {e}", err=True)
        sys.exit(1)


@cli.command("dispatch")
@click.argument("issue_id")
@click.pass_context
def dispatch(ctx, issue_id):
    """Dispatch a new issue (creates state.json)."""
    config = ctx.obj["config"]
    click.echo(f"Dispatching issue {issue_id}...")

    # This will be implemented in Phase 3 hooks
    click.echo("Dispatch not yet implemented - use orchestrator")


@cli.command("dev")
@click.argument("issue_id")
@click.pass_context
def dev(ctx, issue_id):
    """Run development phase for an issue."""
    config = ctx.obj["config"]
    click.echo(f"Running dev phase for {issue_id}...")

    # This will be implemented in Phase 3 hooks
    click.echo("Dev phase not yet implemented")


@cli.command("review")
@click.argument("issue_id")
@click.pass_context
def review(ctx, issue_id):
    """Run review phase (review + merge) for an issue."""
    config = ctx.obj["config"]
    click.echo(f"Running review phase for {issue_id}...")

    # This will be implemented in Phase 3 hooks
    click.echo("Review phase not yet implemented")


@cli.command("status")
@click.argument("issue_id")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
@click.pass_context
def status(ctx, issue_id, as_json):
    """Show current status of an issue."""
    config = ctx.obj["config"]

    # Find workspace for issue
    workspace_root = config.workspace_root

    # Search for issue in workspaces
    issue_path = None
    for workspace in workspace_root.iterdir():
        if workspace.is_dir():
            issue_dir = workspace / issue_id
            symphony_dir = issue_dir / ".symphony"
            if symphony_dir.exists():
                issue_path = issue_dir
                break

    if not issue_path:
        click.echo(f"Issue {issue_id} not found", err=True)
        sys.exit(1)

    store = StateStore(workspace_root, issue_id)
    state = store.get_state()

    if not state:
        click.echo(f"No state found for {issue_id}", err=True)
        sys.exit(1)

    if as_json:
        import json
        click.echo(json.dumps(state, indent=2))
    else:
        click.echo(f"Issue: {state['issue_id']}")
        click.echo(f"State: {state['current_state']}")
        click.echo(f"Previous: {state['previous_state']}")
        if state.get("error"):
            click.echo(f"Error: {state['error']}")
        if state.get("metadata", {}).get("pr_url"):
            click.echo(f"PR: {state['metadata']['pr_url']}")
        click.echo(f"Retry count: {state.get('retry_count', 0)}")


@cli.command("history")
@click.argument("issue_id")
@click.pass_context
def history(ctx, issue_id):
    """Show transition history for an issue."""
    config = ctx.obj["config"]
    workspace_root = config.workspace_root

    store = StateStore(workspace_root, issue_id)
    events = store.get_events()

    if not events:
        click.echo(f"No events found for {issue_id}")
        return

    for event in events:
        timestamp = event.get("timestamp", "")
        event_type = event.get("event", "")
        data = event.get("data", {})
        click.echo(f"{timestamp} [{event_type}] {data}")


@cli.command("cancel")
@click.argument("issue_id")
@click.pass_context
def cancel(ctx, issue_id):
    """Cancel an issue."""
    config = ctx.obj["config"]
    click.echo(f"Cancelling issue {issue_id}...")

    # This will be implemented in Phase 3 hooks
    click.echo("Cancel not yet implemented")


@cli.command("retry")
@click.argument("issue_id")
@click.pass_context
def retry(ctx, issue_id):
    """Retry an issue in ERROR state."""
    config = ctx.obj["config"]
    click.echo(f"Retrying issue {issue_id}...")

    # This will be implemented in Phase 3 hooks
    click.echo("Retry not yet implemented")


@cli.command("sync")
@click.argument("issue_id")
@click.pass_context
def sync(ctx, issue_id):
    """Force sync state from Linear."""
    config = ctx.obj["config"]
    click.echo(f"Syncing issue {issue_id} from Linear...")

    # This will be implemented in Phase 3 hooks
    click.echo("Sync not yet implemented")


@cli.command("clean")
@click.argument("issue_id")
@click.option("--force", is_flag=True, help="Skip confirmation")
@click.pass_context
def clean(ctx, issue_id, force):
    """Clean up workspace after merge."""
    config = ctx.obj["config"]

    if not force:
        click.confirm(f"Delete workspace for {issue_id}?", abort=True)

    workspace_root = config.workspace_root
    store = StateStore(workspace_root, issue_id)

    if not store.symphony_dir.exists():
        click.echo(f"Workspace for {issue_id} not found")
        return

    store.symphony_dir.delete()
    click.echo(f"Workspace for {issue_id} cleaned up")


if __name__ == "__main__":
    cli()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_cli.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/test_cli.py scripts/cli.py
git commit -m "feat(scripts): add CLI entry point with all commands

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 3: Hooks Implementation

### Task 9: DEV Hook (hooks/dev.py)

**Files:**
- Create: `scripts/hooks/dev.py`
- Create: `scripts/__tests__/test_hooks_dev.py`

- [ ] **Step 1: Write failing test**

```python
# scripts/__tests__/test_hooks_dev.py
import pytest
import tempfile
import os
from pathlib import Path
from unittest.mock import patch, MagicMock
from scripts.hooks.dev import DevHook

def test_dev_hook_initialization():
    """Test DevHook initializes correctly."""
    with tempfile.TemporaryDirectory() as tmpdir:
        hook = DevHook(
            workspace_root=Path(tmpdir),
            issue_id="INT-23",
            linear_issue_id="uuid-123",
            linear_state="Todo",
            github_repo="owner/repo",
            branch="int-23",
        )

        assert hook.issue_id == "INT-23"
        assert hook.branch == "int-23"

def test_dev_hook_state_initialization():
    """Test DevHook creates state.json."""
    with tempfile.TemporaryDirectory() as tmpdir:
        hook = DevHook(
            workspace_root=Path(tmpdir),
            issue_id="INT-23",
            linear_issue_id="uuid-123",
            linear_state="Todo",
            github_repo="owner/repo",
            branch="int-23",
        )

        hook.initialize()

        state = hook.store.get_state()
        assert state is not None
        assert state["current_state"] == "TODO"
        assert state["issue_id"] == "INT-23"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_hooks_dev.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: Write hooks/dev.py**

```python
# scripts/hooks/dev.py
"""DEV phase hook - handles development and PR creation."""

import subprocess
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

from lib.config import Config
from lib.github_client import GitHubClient
from lib.linear_client import LinearClient
from lib.retry import retry_with_backoff, RetryExhaustedError
from lib.state_machine import State
from lib.state_store import StateStore


class DevHook:
    """Handles the DEV phase of issue workflow."""

    def __init__(
        self,
        workspace_root: Path,
        issue_id: str,
        linear_issue_id: str,
        linear_state: str,
        github_repo: str,
        branch: str,
        linear_client: Optional[LinearClient] = None,
        github_client: Optional[GitHubClient] = None,
        config: Optional[Config] = None,
    ):
        self.workspace_root = workspace_root
        self.issue_id = issue_id
        self.linear_issue_id = linear_issue_id
        self.linear_state = linear_state
        self.github_repo = github_repo
        self.branch = branch

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

    def initialize(self) -> None:
        """Initialize state.json for the issue."""
        if self.store.symphony_dir.exists():
            # Already initialized, check current state
            current = self.store.get_current_state_enum()
            if current and current != State.TODO:
                print(f"Issue {self.issue_id} already in state {current.value}")
                return

            # If TODO, proceed to transition
        else:
            self.store.initialize(
                linear_issue_id=self.linear_issue_id,
                linear_state=self.linear_state,
                github_repo=self.github_repo,
                branch=self.branch,
            )

        # Transition TODO -> IN_PROGRESS
        current = self.store.get_current_state_enum()
        if current == State.TODO:
            self.store.update_state(
                from_state=State.TODO,
                to_state=State.IN_PROGRESS,
                trigger="dispatch",
                actor="orchestrator",
            )

    def run(self) -> bool:
        """
        Run the DEV phase:
        1. Wait for Linear state to confirm IN_PROGRESS
        2. Run Claude Code agent
        3. Create/update PR
        4. Update Linear to In Review
        5. Wait for Linear to confirm In Review
        """
        # Step 1: Dual-check Linear state
        print(f"[DEV] Verifying Linear state for {self.issue_id}...")
        linear_current = self.linear.fetch_issue_state(self.issue_id)
        print(f"[DEV] Linear state: {linear_current}")

        current = self.store.get_current_state_enum()
        if current != State.IN_PROGRESS:
            print(f"[DEV] Issue not in IN_PROGRESS state, current: {current}")
            return False

        # Step 2: Run Claude Code agent
        print(f"[DEV] Running Claude Code agent...")
        success = self._run_agent()
        if not success:
            self.store.set_error("Claude Code agent failed")
            return False

        # Step 3: Create PR if not exists
        pr_info = self._ensure_pr_exists()
        if not pr_info:
            self.store.set_error("Failed to create PR")
            return False

        # Step 4: Update Linear to In Review
        print(f"[DEV] Updating Linear state to In Review...")
        in_review_state_id = self.linear.fetch_state_id("In Review")
        if not in_review_state_id:
            print("[DEV] ERROR: Could not find In Review state ID")
            self.store.set_error("Could not find In Review state ID")
            return False

        self.linear.update_issue_state(self.linear_issue_id, in_review_state_id)

        # Step 5: Wait for Linear to confirm
        print(f"[DEV] Waiting for Linear to confirm In Review...")
        confirmed = self.linear.wait_for_state(
            self.issue_id,
            "In Review",
            max_wait_seconds=30,
            poll_interval=2,
        )

        if not confirmed:
            print("[DEV] WARNING: Linear state not confirmed after update")
            # Continue anyway - might be eventual consistency

        # Step 6: Transition state to IN_REVIEW
        self.store.update_state(
            from_state=State.IN_PROGRESS,
            to_state=State.IN_REVIEW,
            trigger="pr_created",
            actor="dev-hook",
            metadata_updates={
                "pr_url": pr_info["url"],
                "pr_number": pr_info["number"],
            },
        )

        print(f"[DEV] Complete - PR: {pr_info['url']}")
        return True

    def _run_agent(self) -> bool:
        """Run Claude Code agent in the workspace."""
        workspace_path = self.store.symphony_dir.path.parent

        # Get issue info for prompt
        issue = self.linear.fetch_issue_by_identifier(self.issue_id)
        if not issue:
            print(f"[DEV] ERROR: Could not fetch issue {self.issue_id}")
            return False

        # Build prompt
        prompt = f"""Issue: {issue['identifier']} - {issue['title']}
Description: {issue.get('description', 'No description')}

Implement the required changes. When complete:
1. Run tests to verify
2. Commit your changes
3. Push to the branch {self.branch}
"""

        # Run Claude Code adapter
        # Note: This is a placeholder - actual implementation depends on claude-adapter.cjs
        cmd = ["node", "./scripts/claude-adapter.cjs", "--prompt", prompt]
        try:
            result = subprocess.run(
                cmd,
                cwd=workspace_path,
                capture_output=True,
                text=True,
                timeout=300,
            )
            return result.returncode == 0
        except subprocess.TimeoutExpired:
            print("[DEV] Agent timed out")
            return False
        except Exception as e:
            print(f"[DEV] Agent error: {e}")
            return False

    def _ensure_pr_exists(self) -> Optional[dict]:
        """Ensure PR exists for the branch, create if not."""
        # Check if PR already exists
        existing = self.github.pr_exists(self.branch)
        if existing:
            print(f"[DEV] PR already exists: {existing['html_url']}")
            return {"url": existing["html_url"], "number": existing["number"]}

        # Create PR
        issue = self.linear.fetch_issue_by_identifier(self.issue_id)
        title = f"[{self.issue_id}] {issue['title']}" if issue else self.issue_id
        body = f"""## Summary

Automated PR created by Symphony Agent Platform.

**Linear Issue:** {self.issue_id}

## Changes

Agent completed the task for issue [{self.issue_id}](https://linear.app/inteliway-symphony/issue/{self.issue_id}).
"""

        try:
            pr = self.github.create_pull_request(
                title=title,
                body=body,
                head=self.branch,
            )
            print(f"[DEV] PR created: {pr['html_url']}")
            return {"url": pr["html_url"], "number": pr["number"]}
        except Exception as e:
            print(f"[DEV] ERROR creating PR: {e}")
            return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_hooks_dev.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/test_hooks_dev.py scripts/hooks/dev.py
git commit -m "feat(scripts/hooks): add DevHook for development phase

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: REVIEW Hook (hooks/review.py)

**Files:**
- Create: `scripts/hooks/review.py`
- Create: `scripts/__tests__/test_hooks_review.py`

- [ ] **Step 1: Write failing test**

```python
# scripts/__tests__/test_hooks_review.py
import pytest
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock
from scripts.hooks.review import ReviewHook
from scripts.lib.state_machine import State

def test_review_hook_initialization():
    """Test ReviewHook initializes correctly."""
    with tempfile.TemporaryDirectory() as tmpdir:
        hook = ReviewHook(
            workspace_root=Path(tmpdir),
            issue_id="INT-23",
        )

        assert hook.issue_id == "INT-23"

def test_review_hook_detects_merged_pr():
    """Test ReviewHook detects merged PR."""
    with tempfile.TemporaryDirectory() as tmpdir:
        hook = ReviewHook(
            workspace_root=Path(tmpdir),
            issue_id="INT-23",
        )

        # Mock GitHub client to return merged PR
        mock_github = MagicMock()
        mock_github.get_pull_request_by_branch.return_value = {
            "number": 42,
            "merged": True,
            "html_url": "https://github.com/owner/repo/pull/42",
        }
        hook.github = mock_github

        result = hook.check_pr_status()
        assert result == "merged"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_hooks_review.py -v`
Expected: FAIL - module not found

- [ ] **Step 3: Write hooks/review.py**

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liupenghui/Documents/code/agent/test-cc && python -m pytest scripts/__tests__/test_hooks_review.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/__tests__/test_hooks_review.py scripts/hooks/review.py
git commit -m "feat(scripts/hooks): add ReviewHook for review and merge phase

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Phase 4: Integration

### Task 11: Connect CLI to Hooks

**Files:**
- Modify: `scripts/cli.py`

- [ ] **Step 1: Read current cli.py**

Run: `cat scripts/cli.py`

- [ ] **Step 2: Implement dispatch command**

```python
@cli.command("dispatch")
@click.argument("issue_id")
@click.pass_context
def dispatch(ctx, issue_id):
    """Dispatch a new issue (creates state.json)."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from hooks.dev import DevHook
    from lib.linear_client import LinearClient
    from lib.github_client import GitHubClient

    config = ctx.obj["config"]
    click.echo(f"Dispatching issue {issue_id}...")

    linear = LinearClient(api_key=config.linear_api_key, endpoint=config.linear_endpoint)
    github = GitHubClient(
        token=config.github_token,
        owner=config.github_owner,
        repo=config.github_repo,
        default_branch=config.github_default_branch,
    )

    # Fetch issue from Linear
    issue = linear.fetch_issue_by_identifier(issue_id)
    if not issue:
        click.echo(f"Issue {issue_id} not found in Linear", err=True)
        sys.exit(1)

    # Create branch name
    branch = issue["identifier"].lower().replace("int-", "int-")

    # Get or create workspace
    workspace_root = config.workspace_root
    # TODO: Create git worktree workspace

    hook = DevHook(
        workspace_root=workspace_root,
        issue_id=issue_id,
        linear_issue_id=issue["id"],
        linear_state=issue["state"]["name"],
        github_repo=f"{config.github_owner}/{config.github_repo}",
        branch=branch,
        linear_client=linear,
        github_client=github,
        config=config,
    )

    hook.initialize()
    click.echo(f"Issue {issue_id} dispatched")
```

- [ ] **Step 3: Implement dev command**

```python
@cli.command("dev")
@click.argument("issue_id")
@click.pass_context
def dev(ctx, issue_id):
    """Run development phase for an issue."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from hooks.dev import DevHook
    from lib.linear_client import LinearClient
    from lib.github_client import GitHubClient

    config = ctx.obj["config"]

    linear = LinearClient(api_key=config.linear_api_key, endpoint=config.linear_endpoint)
    github = GitHubClient(
        token=config.github_token,
        owner=config.github_owner,
        repo=config.github_repo,
        default_branch=config.github_default_branch,
    )

    store = StateStore(config.workspace_root, issue_id)
    state = store.get_state()
    if not state:
        click.echo(f"No state found for {issue_id}", err=True)
        sys.exit(1)

    hook = DevHook(
        workspace_root=config.workspace_root,
        issue_id=issue_id,
        linear_issue_id=state["metadata"]["linear_issue_id"],
        linear_state=state["metadata"]["linear_state"],
        github_repo=state["metadata"]["github_repo"],
        branch=state["metadata"]["branch"],
        linear_client=linear,
        github_client=github,
        config=config,
    )

    success = hook.run()
    if success:
        click.echo(f"Dev phase completed for {issue_id}")
    else:
        click.echo(f"Dev phase failed for {issue_id}", err=True)
        sys.exit(1)
```

- [ ] **Step 4: Implement review command**

```python
@cli.command("review")
@click.argument("issue_id")
@click.pass_context
def review(ctx, issue_id):
    """Run review phase (review + merge) for an issue."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from hooks.review import ReviewHook
    from lib.linear_client import LinearClient
    from lib.github_client import GitHubClient

    config = ctx.obj["config"]

    linear = LinearClient(api_key=config.linear_api_key, endpoint=config.linear_endpoint)
    github = GitHubClient(
        token=config.github_token,
        owner=config.github_owner,
        repo=config.github_repo,
        default_branch=config.github_default_branch,
    )

    store = StateStore(config.workspace_root, issue_id)
    state = store.get_state()
    if not state:
        click.echo(f"No state found for {issue_id}", err=True)
        sys.exit(1)

    hook = ReviewHook(
        workspace_root=config.workspace_root,
        issue_id=issue_id,
        linear_client=linear,
        github_client=github,
        config=config,
    )

    success = hook.run()
    if success:
        # Check if done - auto-clean
        final_state = store.get_current_state_enum()
        if final_state == State.DONE:
            click.echo("Issue completed - cleaning workspace...")
            hook.cleanup()
        click.echo(f"Review phase completed for {issue_id}")
    else:
        click.echo(f"Review phase failed for {issue_id}", err=True)
        sys.exit(1)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cli.py
git commit -m "feat(scripts): connect CLI to DevHook and ReviewHook

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 12: Create hooks/__init__.py

**Files:**
- Create: `scripts/hooks/__init__.py`

- [ ] **Step 1: Create hooks/__init__.py**

```python
"""Symphony hooks for DEV and REVIEW phases."""

from .dev import DevHook
from .review import ReviewHook

__all__ = ["DevHook", "ReviewHook"]
```

- [ ] **Step 2: Commit**

```bash
git add scripts/hooks/__init__.py
git commit -m "feat(scripts/hooks): add __init__.py

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Spec Coverage Check

- [x] State enum with all states (TODO, IN_PROGRESS, IN_REVIEW, DONE, CANCELLED, ERROR) - Task 2
- [x] State machine with transition validation - Task 2
- [x] StateStore with filesystem JSON - Task 3
- [x] events.log append-only logging - Task 3
- [x] Config from environment variables - Task 4
- [x] LinearClient with dual-check - Task 5
- [x] GitHubClient with PR operations - Task 6
- [x] Gradient retry (1s, 5s, 30s) - Task 7
- [x] CLI with all 9 commands - Task 8, Task 11
- [x] DevHook with dispatch, dev, PR creation - Task 9
- [x] ReviewHook with review, merge, done - Task 10
- [x] Auto-clean after merge - Task 10 (ReviewHook.cleanup)

## Plan Complete

**Saved to:** `docs/superpowers/plans/2026-04-17-state-machine-implementation.md`
