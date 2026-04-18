# scripts/__tests__/test_linear_client.py
import pytest
from unittest.mock import patch, MagicMock
from scripts.lib.linear_client import LinearClient

@patch("scripts.lib.linear_client.requests.post")
def test_fetch_issue_by_identifier(mock_post):
    """Test fetching issue by identifier."""
    # First call: get teams
    # Second call: get issues from team
    mock_response_teams = MagicMock()
    mock_response_teams.json.return_value = {
        "data": {
            "teams": {
                "nodes": [
                    {"id": "team-uuid-1", "key": "INT"}
                ]
            }
        }
    }
    mock_response_issues = MagicMock()
    mock_response_issues.json.return_value = {
        "data": {
            "team": {
                "issues": {
                    "nodes": [
                        {
                            "id": "uuid-123",
                            "identifier": "INT-23",
                            "title": "Test Issue",
                            "description": "Test description",
                            "state": {"name": "Todo", "id": "state-1", "type": "unstarted"},
                            "createdAt": "2026-04-17T10:00:00Z",
                            "updatedAt": "2026-04-17T10:00:00Z",
                        }
                    ]
                }
            }
        }
    }
    mock_post.side_effect = [mock_response_teams, mock_response_issues]

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
    mock_response_teams = MagicMock()
    mock_response_teams.json.return_value = {
        "data": {
            "teams": {
                "nodes": [
                    {"id": "team-uuid-1", "key": "INT"}
                ]
            }
        }
    }
    mock_response_issues = MagicMock()
    mock_response_issues.json.return_value = {
        "data": {
            "team": {
                "issues": {
                    "nodes": []
                }
            }
        }
    }
    mock_post.side_effect = [mock_response_teams, mock_response_issues]

    client = LinearClient(api_key="test_key")
    issue = client.fetch_issue_by_identifier("INT-999")
    assert issue is None

@patch("scripts.lib.linear_client.requests.post")
def test_fetch_issue_state(mock_post):
    """Test fetching issue state."""
    mock_response_teams = MagicMock()
    mock_response_teams.json.return_value = {
        "data": {
            "teams": {
                "nodes": [
                    {"id": "team-uuid-1", "key": "INT"}
                ]
            }
        }
    }
    mock_response_issues = MagicMock()
    mock_response_issues.json.return_value = {
        "data": {
            "team": {
                "issues": {
                    "nodes": [
                        {"id": "uuid-123", "identifier": "INT-23", "state": {"name": "In Progress", "id": "state-2", "type": "started"}}
                    ]
                }
            }
        }
    }
    mock_post.side_effect = [mock_response_teams, mock_response_issues]

    client = LinearClient(api_key="test_key")
    state = client.fetch_issue_state("INT-23")

    assert state == "In Progress"

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
def test_update_issue_state_failure(mock_post):
    """Test updating issue state returns False on failure."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "data": {
            "issueUpdate": {
                "success": False,
            }
        }
    }
    mock_post.return_value = mock_response

    client = LinearClient(api_key="test_key")
    success = client.update_issue_state("uuid-123", "state-uuid-456")

    assert success is False

@patch("scripts.lib.linear_client.requests.post")
def test_fetch_state_id(mock_post):
    """Test fetching state ID by name."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "data": {
            "teams": {
                "nodes": [
                    {
                        "name": "Team 1",
                        "states": {
                            "nodes": [
                                {"id": "done-state-id", "name": "Done", "type": "completed"},
                                {"id": "in-progress-id", "name": "In Progress", "type": "started"},
                            ]
                        }
                    }
                ]
            }
        }
    }
    mock_post.return_value = mock_response

    client = LinearClient(api_key="test_key")

    done_id = client.fetch_state_id("Done")
    assert done_id == "done-state-id"

    in_progress_id = client.fetch_state_id("In Progress")
    assert in_progress_id == "in-progress-id"

    unknown_id = client.fetch_state_id("Unknown")
    assert unknown_id is None

@patch("scripts.lib.linear_client.requests.post")
def test_get_active_states(mock_post):
    """Test fetching active states."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "data": {
            "teams": {
                "nodes": [
                    {
                        "states": {
                            "nodes": [
                                {"name": "Todo", "type": "unstarted"},
                                {"name": "In Progress", "type": "started"},
                                {"name": "In Review", "type": "started"},
                                {"name": "Done", "type": "completed"},
                            ]
                        }
                    }
                ]
            }
        }
    }
    mock_post.return_value = mock_response

    client = LinearClient(api_key="test_key")
    states = client.get_active_states()

    assert "Todo" in states
    assert "In Progress" in states
    assert "In Review" in states
    assert "Done" not in states

@patch("scripts.lib.linear_client.requests.post")
def test_get_terminal_states(mock_post):
    """Test fetching terminal states."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "data": {
            "teams": {
                "nodes": [
                    {
                        "states": {
                            "nodes": [
                                {"name": "Todo", "type": "unstarted"},
                                {"name": "In Progress", "type": "started"},
                                {"name": "In Review", "type": "started"},
                                {"name": "Done", "type": "completed"},
                                {"name": "Cancelled", "type": "completed"},
                            ]
                        }
                    }
                ]
            }
        }
    }
    mock_post.return_value = mock_response

    client = LinearClient(api_key="test_key")
    states = client.get_terminal_states()

    assert "Done" in states
    assert "Cancelled" in states
    assert "In Progress" not in states
