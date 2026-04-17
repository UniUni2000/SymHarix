# scripts/__tests__/test_config.py
import pytest
import tempfile
import os
from pathlib import Path
from scripts.lib.config import Config, load_config

def test_config_defaults():
    """Test Config has sensible defaults."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config = Config(
            linear_api_key="lin_key",
            github_token="gh_token",
            github_owner="owner",
            github_repo="repo",
            workspace_root=Path(tmpdir),
        )

        assert config.linear_api_key == "lin_key"
        assert config.linear_endpoint == "https://api.linear.app/graphql"
        assert config.github_default_branch == "main"
        assert config.poll_interval_ms == 30000
        assert config.max_retries == 3
        assert config.retry_delays == [1, 5, 30]

def test_config_custom_values():
    """Test Config with custom values."""
    with tempfile.TemporaryDirectory() as tmpdir:
        config = Config(
            linear_api_key="lin_key",
            linear_endpoint="https://custom.linear.app/graphql",
            github_token="gh_token",
            github_owner="owner",
            github_repo="repo",
            github_default_branch="develop",
            workspace_root=Path(tmpdir),
            poll_interval_ms=60000,
            max_retries=5,
            retry_delays=[2, 10, 60],
            max_concurrent_agents=10,
        )

        assert config.linear_endpoint == "https://custom.linear.app/graphql"
        assert config.github_default_branch == "develop"
        assert config.poll_interval_ms == 60000
        assert config.max_retries == 5
        assert config.retry_delays == [2, 10, 60]
        assert config.max_concurrent_agents == 10

def test_load_config_from_env():
    """Test load_config loads from environment variables."""
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["LINEAR_API_KEY"] = "lin_test_key_123"
        os.environ["GITHUB_TOKEN"] = "ghp_test_token_456"
        os.environ["GITHUB_OWNER"] = "testowner"
        os.environ["GITHUB_REPO"] = "testrepo"
        os.environ["WORKSPACE_ROOT"] = tmpdir

        try:
            config = load_config()

            assert config.linear_api_key == "lin_test_key_123"
            assert config.github_token == "ghp_test_token_456"
            assert config.github_owner == "testowner"
            assert config.github_repo == "testrepo"
            assert config.workspace_root == Path(tmpdir)
        finally:
            del os.environ["LINEAR_API_KEY"]
            del os.environ["GITHUB_TOKEN"]
            del os.environ["GITHUB_OWNER"]
            del os.environ["GITHUB_REPO"]
            del os.environ["WORKSPACE_ROOT"]

def test_load_config_missing_linear_api_key():
    """Test load_config raises error without LINEAR_API_KEY."""
    # Clear the env var if it exists
    if "LINEAR_API_KEY" in os.environ:
        del os.environ["LINEAR_API_KEY"]
    if "SYMPHONY_TRACKER_API_KEY" in os.environ:
        del os.environ["SYMPHONY_TRACKER_API_KEY"]

    with pytest.raises(ValueError) as exc_info:
        load_config()
    assert "LINEAR_API_KEY" in str(exc_info.value)

def test_load_config_missing_github_token():
    """Test load_config raises error without GITHUB_TOKEN."""
    # Set only LINEAR_API_KEY
    os.environ["LINEAR_API_KEY"] = "lin_key"
    if "GITHUB_TOKEN" in os.environ:
        del os.environ["GITHUB_TOKEN"]

    try:
        with pytest.raises(ValueError) as exc_info:
            load_config()
        assert "GITHUB_TOKEN" in str(exc_info.value)
    finally:
        del os.environ["LINEAR_API_KEY"]

def test_load_config_with_symphony_prefix():
    """Test load_config supports SYMPHONY_ prefixed env vars."""
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["SYMPHONY_TRACKER_API_KEY"] = "symphony_lin_key"
        os.environ["SYMPHONY_GITHUB_OWNER"] = "symphony_owner"
        os.environ["SYMPHONY_GITHUB_REPO"] = "symphony_repo"
        os.environ["GITHUB_TOKEN"] = "gh_token"

        try:
            config = load_config()
            assert config.linear_api_key == "symphony_lin_key"
            assert config.github_owner == "symphony_owner"
            assert config.github_repo == "symphony_repo"
        finally:
            del os.environ["SYMPHONY_TRACKER_API_KEY"]
            del os.environ["SYMPHONY_GITHUB_OWNER"]
            del os.environ["SYMPHONY_GITHUB_REPO"]
            del os.environ["GITHUB_TOKEN"]
