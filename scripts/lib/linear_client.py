# scripts/lib/linear_client.py
"""Linear GraphQL API client."""

import time
from typing import Optional

import requests

from .retry import retry_with_backoff

class LinearClient:
    """Client for Linear GraphQL API."""

    def __init__(self, api_key: str, endpoint: str = "https://api.linear.app/graphql"):
        self.api_key = api_key
        self.endpoint = endpoint
        self.headers = {
            "Authorization": api_key,
            "Content-Type": "application/json",
        }

    def _post(self, query: str, variables: Optional[dict] = None) -> dict:
        """Execute a GraphQL query."""
        payload = {"query": query}
        if variables:
            payload["variables"] = variables

        response = requests.post(
            self.endpoint,
            json=payload,
            headers=self.headers,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    def fetch_issue_by_identifier(self, identifier: str) -> Optional[dict]:
        """
        Fetch issue by identifier (e.g., 'INT-23').
        Returns issue dict or None if not found.
        Linear API doesn't support filtering by identifier directly,
        so we fetch from teams and filter client-side.
        """
        # Parse identifier to get team key and issue number (e.g., "INT-24" -> "INT", "24")
        parts = identifier.rsplit("-", 1)
        if len(parts) != 2:
            return None
        team_key, issue_num = parts

        # First get teams to find the right team ID
        teams_query = """
        query GetTeams {
            teams(first: 10) {
                nodes {
                    id
                    key
                }
            }
        }
        """
        teams_result = self._post(teams_query)
        teams = teams_result.get("data", {}).get("teams", {}).get("nodes", [])

        # Find team matching the key
        team_id = None
        for team in teams:
            if team.get("key", "").upper() == team_key.upper():
                team_id = team.get("id")
                break

        if not team_id:
            return None

        # Now fetch issues from that team
        issues_query = """
        query GetTeamIssues($teamId: String!) {
            team(id: $teamId) {
                issues(first: 100) {
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
                        project {
                            name
                        }
                        createdAt
                        updatedAt
                    }
                }
            }
        }
        """
        issues_result = self._post(issues_query, {"teamId": team_id})
        nodes = issues_result.get("data", {}).get("team", {}).get("issues", {}).get("nodes", [])

        # Filter by identifier (case-insensitive)
        for node in nodes:
            if node.get("identifier", "").lower() == identifier.lower():
                return node
        return None

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
