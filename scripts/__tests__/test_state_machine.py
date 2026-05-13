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

def test_valid_transition_in_review_to_error():
    sm = StateMachine()
    assert sm.can_transition(State.IN_REVIEW, State.ERROR) == True

def test_valid_transition_in_progress_to_cancelled():
    sm = StateMachine()
    assert sm.can_transition(State.IN_PROGRESS, State.CANCELLED) == True

def test_valid_transition_error_to_in_progress():
    sm = StateMachine()
    assert sm.can_transition(State.ERROR, State.IN_PROGRESS) == True

def test_valid_transition_in_progress_to_in_progress_retry():
    sm = StateMachine()
    assert sm.can_transition(State.IN_PROGRESS, State.IN_PROGRESS) == True

def test_valid_transition_in_review_to_in_review_retry():
    sm = StateMachine()
    assert sm.can_transition(State.IN_REVIEW, State.IN_REVIEW) == True

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

def test_from_string_valid():
    assert State.from_string("todo") == State.TODO
    assert State.from_string("TODO") == State.TODO
    assert State.from_string("in_progress") == State.IN_PROGRESS
    assert State.from_string("IN_PROGRESS") == State.IN_PROGRESS
    assert State.from_string("in_review") == State.IN_REVIEW
    assert State.from_string("done") == State.DONE

def test_from_string_accepts_tracker_display_names():
    assert State.from_string("Todo") == State.TODO
    assert State.from_string("In Progress") == State.IN_PROGRESS
    assert State.from_string("In Review") == State.IN_REVIEW
    assert State.from_string("Done") == State.DONE
    assert State.from_string("Cancelled") == State.CANCELLED
    assert State.from_string("Canceled") == State.CANCELLED
    assert State.from_string("Error") == State.ERROR

def test_from_string_invalid():
    with pytest.raises(ValueError):
        State.from_string("invalid")

def test_is_terminal():
    assert State.TODO.is_terminal() == False
    assert State.IN_PROGRESS.is_terminal() == False
    assert State.IN_REVIEW.is_terminal() == False
    assert State.DONE.is_terminal() == True
    assert State.CANCELLED.is_terminal() == True
    assert State.ERROR.is_terminal() == False

def test_is_active():
    assert State.TODO.is_active() == True
    assert State.IN_PROGRESS.is_active() == True
    assert State.IN_REVIEW.is_active() == True
    assert State.DONE.is_active() == False
    assert State.CANCELLED.is_active() == False
    assert State.ERROR.is_active() == False

def test_validate_transition_valid():
    sm = StateMachine()
    # Should not raise
    sm.validate_transition(State.TODO, State.IN_PROGRESS)

def test_validate_transition_invalid():
    sm = StateMachine()
    with pytest.raises(ValueError) as exc_info:
        sm.validate_transition(State.TODO, State.DONE)
    assert "Invalid transition" in str(exc_info.value)

def test_create_transition():
    sm = StateMachine()
    transition = sm.create_transition(
        from_state=State.TODO,
        to_state=State.IN_PROGRESS,
        trigger="dispatch",
        actor="system",
    )
    assert transition.from_state == State.TODO
    assert transition.to_state == State.IN_PROGRESS
    assert transition.trigger == "dispatch"
    assert transition.actor == "system"
    assert transition.timestamp is not None
