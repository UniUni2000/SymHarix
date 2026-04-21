# scripts/__tests__/test_github_client.py
import pytest
from unittest.mock import patch, MagicMock
from scripts.lib.github_client import GitHubClient

@patch("scripts.lib.github_client.requests.post")
@patch("scripts.lib.github_client.requests.get")
def test_create_pull_request(mock_get, mock_post):
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

@patch("scripts.lib.github_client.requests.get")
def test_get_pull_request_by_branch_not_found(mock_get):
    """Test fetching PR by branch when not found."""
    mock_response = MagicMock()
    mock_response.json.return_value = []
    mock_get.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    pr = client.get_pull_request_by_branch("nonexistent")

    assert pr is None

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

@patch("scripts.lib.github_client.requests.get")
def test_get_pr_reviews_state_approved(mock_get):
    """Test PR review state when approved."""
    mock_response = MagicMock()
    mock_response.json.return_value = [
        {"user": {"login": "reviewer1"}, "state": "APPROVED"},
    ]
    mock_get.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    state = client.get_pr_reviews_state(42)

    assert state == "approved"

@patch("scripts.lib.github_client.requests.get")
def test_get_pr_reviews_state_changes_requested(mock_get):
    """Test PR review state when changes requested."""
    mock_response = MagicMock()
    mock_response.json.return_value = [
        {"user": {"login": "reviewer1"}, "state": "CHANGES_REQUESTED"},
    ]
    mock_get.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    state = client.get_pr_reviews_state(42)

    assert state == "changes_requested"

@patch("scripts.lib.github_client.requests.get")
def test_get_pr_reviews_state_no_reviews(mock_get):
    """Test PR review state when no reviews."""
    mock_response = MagicMock()
    mock_response.json.return_value = []
    mock_get.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    state = client.get_pr_reviews_state(42)

    assert state == "no_reviews"

@patch("scripts.lib.github_client.requests.get")
def test_pr_exists(mock_get):
    """Test pr_exists method."""
    mock_response = MagicMock()
    mock_response.json.return_value = [
        {"number": 42, "title": "Test PR", "merged": False},
    ]
    mock_get.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    pr = client.pr_exists("int-23")

    assert pr is not None
    assert pr["number"] == 42


@patch("scripts.lib.github_client.requests.get")
def test_find_issue_by_identifier(mock_get):
    mock_response = MagicMock()
    mock_response.json.return_value = [
        {"number": 5, "title": "[INT-25] Something", "state": "open"},
        {"number": 6, "title": "Other issue", "state": "open"},
    ]
    mock_get.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    issue = client.find_issue_by_identifier("INT-25")

    assert issue is not None
    assert issue["number"] == 5


@patch("scripts.lib.github_client.requests.patch")
def test_close_issue(mock_patch):
    mock_response = MagicMock()
    mock_response.json.return_value = {"number": 5, "state": "closed"}
    mock_patch.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    result = client.close_issue(5)

    assert result["state"] == "closed"
    mock_patch.assert_called_once()


@patch("scripts.lib.github_client.requests.post")
def test_add_issue_comment(mock_post):
    mock_response = MagicMock()
    mock_response.json.return_value = {"id": 123, "body": "hello"}
    mock_post.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    result = client.add_issue_comment(5, "hello")

    assert result["body"] == "hello"
    mock_post.assert_called_once()


@patch("scripts.lib.github_client.requests.post")
def test_add_pull_request_comment(mock_post):
    mock_response = MagicMock()
    mock_response.json.return_value = {"id": 456, "body": "review"}
    mock_post.return_value = mock_response

    client = GitHubClient(token="ghp_test", owner="owner", repo="repo")
    result = client.add_pull_request_comment(42, "review")

    assert result["body"] == "review"
    mock_post.assert_called_once()
