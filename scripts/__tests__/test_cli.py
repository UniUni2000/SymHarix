# scripts/__tests__/test_cli.py
import pytest
import os
from click.testing import CliRunner

# Set up environment before importing cli
os.environ["LINEAR_API_KEY"] = "test_key"
os.environ["GITHUB_TOKEN"] = "test_token"
os.environ["GITHUB_OWNER"] = "testowner"
os.environ["GITHUB_REPO"] = "testrepo"
os.environ["WORKSPACE_ROOT"] = "/tmp/symphony_test"

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
    assert "clean" in result.output
    assert "history" in result.output

def test_cli_status_command_help():
    """Test status command help."""
    runner = CliRunner()
    result = runner.invoke(cli, ["status", "--help"])
    assert result.exit_code == 0
    assert "ISSUE_ID" in result.output

def test_cli_clean_command_help():
    """Test clean command help."""
    runner = CliRunner()
    result = runner.invoke(cli, ["clean", "--help"])
    assert result.exit_code == 0
    assert "force" in result.output
