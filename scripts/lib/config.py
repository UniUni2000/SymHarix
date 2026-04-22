# scripts/lib/config.py
"""Configuration loader from environment variables."""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

@dataclass
class Config:
    """Symphony configuration."""

    # Required fields (no defaults)
    linear_api_key: str
    github_token: str
    github_owner: Optional[str] = None

    # Optional fields (prefer explicit repository routing or state metadata)
    github_repo: Optional[str] = None

    # Optional fields (with defaults)
    linear_endpoint: str = "https://api.linear.app/graphql"
    github_default_branch: str = "main"
    workspace_root: Path = Path("/tmp/symphony_workspaces")
    poll_interval_ms: int = 30000
    max_retries: int = 3
    retry_delays: list[int] = field(default_factory=lambda: [1, 5, 30])
    max_concurrent_agents: int = 3
    max_turns: int = 20
    codex_command: str = "node ./scripts/claude-adapter.cjs"
    # Auto-merge PR even if no reviews received
    auto_merge_no_reviews: bool = False

def load_config() -> Config:
    """Load configuration from environment variables."""
    # Linear API key
    linear_api_key = os.environ.get("LINEAR_API_KEY") or os.environ.get("SYMPHONY_TRACKER_API_KEY")
    if not linear_api_key:
        raise ValueError("LINEAR_API_KEY or SYMPHONY_TRACKER_API_KEY is required")

    # GitHub token
    github_token = os.environ.get("GITHUB_TOKEN")
    if not github_token:
        raise ValueError("GITHUB_TOKEN is required")

    # GitHub owner (optional when owner/repo is provided via route env or workspace state)
    github_owner = os.environ.get("GITHUB_OWNER") or os.environ.get("SYMPHONY_GITHUB_OWNER")

    # GitHub repo (optional - dispatch/runtime can provide the canonical owner/repo)
    github_repo = os.environ.get("GITHUB_REPO") or os.environ.get("SYMPHONY_GITHUB_REPO")

    # Workspace root
    workspace_root = os.environ.get("WORKSPACE_ROOT") or os.environ.get(
        "SYMPHONY_WORKSPACE_ROOT", "/tmp/symphony_workspaces"
    )

    # Auto-merge no reviews
    auto_merge_no_reviews = os.environ.get("SYMPHONY_AUTO_MERGE_NO_REVIEWS", "").lower() in ("true", "1", "yes")

    return Config(
        linear_api_key=linear_api_key,
        github_token=github_token,
        github_owner=github_owner,
        github_repo=github_repo,
        workspace_root=Path(workspace_root),
        auto_merge_no_reviews=auto_merge_no_reviews,
    )
