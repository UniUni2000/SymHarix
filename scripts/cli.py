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
    import json
    from lib.linear_client import LinearClient
    from lib.github_client import GitHubClient

    config = ctx.obj["config"]
    click.echo(f"Dispatching issue {issue_id}...")

    linear = LinearClient(api_key=config.linear_api_key, endpoint=config.linear_endpoint)

    # Fetch issue from Linear
    issue = linear.fetch_issue_by_identifier(issue_id)
    if not issue:
        click.echo(f"Issue {issue_id} not found in Linear", err=True)
        sys.exit(1)

    # Get project name from Linear issue - this is the GitHub repo name
    project_name = issue.get("project", {}).get("name", config.github_repo)

    # Create GitHub repo full name (owner/project)
    github_repo_full = f"{config.github_owner}/{project_name}"

    # Initialize GitHub client with correct repo
    github = GitHubClient(
        token=config.github_token,
        owner=config.github_owner,
        repo=project_name,
        default_branch=config.github_default_branch,
    )

    # Create branch name (use feature/ prefix like the original system)
    branch = f"feature/{issue['identifier'].lower()}"

    # Create workspace directory
    workspace_root = config.workspace_root
    workspace_path = workspace_root / issue_id

    # Initialize state
    store = StateStore(workspace_root, issue_id)
    try:
        store.initialize(
            linear_issue_id=issue["id"],
            linear_state=issue["state"]["name"],
            github_repo=github_repo_full,
            branch=branch,
        )
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    click.echo(f"Issue {issue_id} dispatched to {workspace_path}")
    click.echo(f"GitHub repo: {github_repo_full}, branch: {branch}")


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

    hook.initialize()
    success = hook.run()
    if success:
        click.echo(f"Dev phase completed for {issue_id}")
    else:
        click.echo(f"Dev phase failed for {issue_id}", err=True)
        sys.exit(1)


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

    store = StateStore(config.workspace_root, issue_id)
    state = store.get_state()
    if not state:
        click.echo(f"No state found for {issue_id}", err=True)
        sys.exit(1)

    # Get github repo from state metadata (set during dispatch from Linear project)
    metadata = state.get("metadata", {})
    github_repo_full = metadata.get("github_repo", f"{config.github_owner}/{config.github_repo}")
    # Parse owner/repo
    if "/" in github_repo_full:
        gh_owner, gh_repo = github_repo_full.split("/", 1)
    else:
        gh_owner, gh_repo = config.github_owner, github_repo_full

    github = GitHubClient(
        token=config.github_token,
        owner=gh_owner,
        repo=gh_repo,
        default_branch=config.github_default_branch,
    )

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


@cli.command("status")
@click.argument("issue_id")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
@click.pass_context
def status(ctx, issue_id, as_json):
    """Show current status of an issue."""
    import json
    config = ctx.obj["config"]

    # Find workspace for issue
    workspace_root = config.workspace_root

    # Search for issue in workspaces
    store = StateStore(workspace_root, issue_id)

    if not store.symphony_dir.exists():
        click.echo(f"Issue {issue_id} not found", err=True)
        sys.exit(1)

    state = store.get_state()

    if not state:
        click.echo(f"No state found for {issue_id}", err=True)
        sys.exit(1)

    if as_json:
        click.echo(json.dumps(state, indent=2))
    else:
        click.echo(f"Issue: {state['issue_id']}")
        click.echo(f"State: {state['current_state']}")
        if state.get("previous_state"):
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

    store = StateStore(config.workspace_root, issue_id)
    state = store.get_state()
    if not state:
        click.echo(f"No state found for {issue_id}", err=True)
        sys.exit(1)

    current_state = State.from_string(state["current_state"])
    if current_state.is_terminal():
        click.echo(f"Issue {issue_id} is already in terminal state {current_state.value}", err=True)
        sys.exit(1)

    store.update_state(
        from_state=current_state,
        to_state=State.CANCELLED,
        trigger="manual_cancel",
        actor="user",
    )
    click.echo(f"Issue {issue_id} cancelled")


@cli.command("retry")
@click.argument("issue_id")
@click.pass_context
def retry_cmd(ctx, issue_id):
    """Retry an issue in ERROR state."""
    config = ctx.obj["config"]
    click.echo(f"Retrying issue {issue_id}...")

    store = StateStore(config.workspace_root, issue_id)
    state = store.get_state()
    if not state:
        click.echo(f"No state found for {issue_id}", err=True)
        sys.exit(1)

    current_state = State.from_string(state["current_state"])
    if current_state != State.ERROR:
        click.echo(f"Issue {issue_id} is not in ERROR state (current: {current_state.value})", err=True)
        sys.exit(1)

    store.update_state(
        from_state=State.ERROR,
        to_state=State.IN_PROGRESS,
        trigger="manual_retry",
        actor="user",
    )
    click.echo(f"Issue {issue_id} retry scheduled")


@cli.command("sync")
@click.argument("issue_id")
@click.pass_context
def sync(ctx, issue_id):
    """Force sync state from Linear."""
    import json
    from lib.linear_client import LinearClient

    config = ctx.obj["config"]
    click.echo(f"Syncing issue {issue_id} from Linear...")

    linear = LinearClient(api_key=config.linear_api_key, endpoint=config.linear_endpoint)

    # Fetch latest state from Linear
    linear_state = linear.fetch_issue_state(issue_id)
    if not linear_state:
        click.echo(f"Issue {issue_id} not found in Linear", err=True)
        sys.exit(1)

    click.echo(f"Linear state: {linear_state}")

    # Update local state
    store = StateStore(config.workspace_root, issue_id)
    state = store.get_state()
    if not state:
        click.echo(f"No local state found for {issue_id}", err=True)
        sys.exit(1)

    store.update_metadata({"linear_state": linear_state})
    click.echo(f"Synced {issue_id} with Linear state: {linear_state}")


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
