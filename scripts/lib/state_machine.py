# scripts/lib/state_machine.py
"""State machine for symphonyness issue workflow."""

from enum import Enum
from dataclasses import dataclass, field
from datetime import datetime, timezone
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
        """Parse internal or tracker display state names."""
        normalized = " ".join(s.replace("_", " ").replace("-", " ").split()).lower()
        aliases = {
            "todo": cls.TODO,
            "to do": cls.TODO,
            "in progress": cls.IN_PROGRESS,
            "in review": cls.IN_REVIEW,
            "done": cls.DONE,
            "cancelled": cls.CANCELLED,
            "canceled": cls.CANCELLED,
            "error": cls.ERROR,
        }
        alias = aliases.get(normalized)
        if alias:
            return alias
        for state in cls:
            state_name = " ".join(state.value.replace("_", " ").split()).lower()
            if state_name == normalized:
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
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    )
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
