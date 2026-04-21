#!/usr/bin/env python3
"""Symphony CLI - Unified entry point for all commands."""

import json
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
@click.option("--workspace-path", "workspace_path_opt", help="Pre-created workspace path (orchestrator manages workspace creation)")
@click.pass_context
def dispatch(ctx, issue_id, workspace_path_opt):
    """Dispatch a new issue (creates state.json).

    In hybrid mode, the orchestrator creates the workspace. This command
    only initializes state and updates Linear.
    """
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

    # Create branch name (use feature/ prefix like the original system)
    branch = f"feature/{issue['identifier'].lower()}"

    # Update Linear state to In Progress
    in_progress_state_id = linear.fetch_state_id("In Progress")
    if in_progress_state_id:
        linear.update_issue_state(issue["id"], in_progress_state_id)
        click.echo(f"Updated Linear state to In Progress")
    else:
        click.echo(f"Warning: Could not find In Progress state ID", err=True)

    # Use workspace_path if provided, otherwise compute it
    # The orchestrator creates git worktree at workspace_root/project_name/issue_id
    # But for state, we use workspace_root/project_name/issue_id/.symphony (inside worktree)
    if workspace_path_opt:
        # Orchestrator provided workspace path - state goes inside it
        workspace_path = Path(workspace_path_opt)
    else:
        # Fallback for standalone use
        workspace_path = config.workspace_root / project_name / issue_id

    # Initialize state INSIDE the workspace (git worktree), not outside
    # StateStore expects: workspace_root / issue_id / .symphony
    # But we want state inside the worktree: workspace_path / .symphony
    # So we create a custom symphony_path
    symphony_path = workspace_path / ".symphony"

    # Initialize state if not already initialized
    # For state inside worktree, we need to create the symphony dir manually
    if symphony_path.exists():
        click.echo(f"State already exists for {issue_id}, skipping initialization")
    else:
        try:
            # Create the symphony directory inside workspace
            symphony_path.mkdir(parents=True, exist_ok=True)

            # Write state.json directly
            import json
            state_data = {
                "version": 1,
                "issue_id": issue_id,
                "current_state": "TODO",
                "previous_state": None,
                "transition_history": [],
                "metadata": {
                    "linear_issue_id": issue["id"],
                    "linear_state": "In Progress",
                    "github_repo": github_repo_full,
                    "branch": branch,
                },
                "error": None,
                "retry_count": 0
            }
            with open(symphony_path / "state.json", "w") as f:
                json.dump(state_data, f, indent=2)
        except Exception as e:
            click.echo(f"Error: {e}", err=True)
            sys.exit(1)

    click.echo(f"Issue {issue_id} dispatched")
    click.echo(f"GitHub repo: {github_repo_full}, branch: {branch}")


@cli.command("dev")
@click.argument("issue_id")
@click.option("--workspace-path", "workspace_path_opt", help="Workspace path for state lookup")
@click.pass_context
def dev(ctx, issue_id, workspace_path_opt):
    """Run development phase for an issue."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from hooks.dev import DevHook
    from lib.linear_client import LinearClient
    from lib.github_client import GitHubClient

    config = ctx.obj["config"]

    linear = LinearClient(api_key=config.linear_api_key, endpoint=config.linear_endpoint)

    # Use workspace_path if provided - state is at workspace_path/.symphony/state.json
    if workspace_path_opt:
        workspace_path = Path(workspace_path_opt)
        symphony_path = workspace_path / ".symphony"
        state_file = symphony_path / "state.json"
        if not state_file.exists():
            click.echo(f"No state found for {issue_id} at {state_file}", err=True)
            sys.exit(1)
        import json
        with open(state_file) as f:
            state = json.load(f)
        workspace_root = workspace_path
    else:
        workspace_root = config.workspace_root
        store = StateStore(workspace_root, issue_id)
        state = store.get_state()
        if not state:
            click.echo(f"No state found for {issue_id}", err=True)
            sys.exit(1)
    if not state:
        click.echo(f"No state found for {issue_id}", err=True)
        sys.exit(1)

    # Get github repo from state metadata (set during dispatch from Linear project)
    # github_repo in state is stored as "owner/repo" format
    metadata = state.get("metadata", {})
    github_repo_full = metadata.get("github_repo", f"{config.github_owner}/{config.github_repo}")
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

    hook = DevHook(
        workspace_root=workspace_root,
        issue_id=issue_id,
        linear_issue_id=state["metadata"]["linear_issue_id"],
        linear_state=state["metadata"]["linear_state"],
        github_repo=github_repo_full,
        branch=state["metadata"]["branch"],
        linear_client=linear,
        github_client=github,
        config=config,
    )

    hook.initialize()
    success = hook.run()
    if success:
        click.echo(f"Dev phase completed for {issue_id}")
        click.echo(f"SYMPHONY_STATS:{json.dumps({
            'linear_api_calls': 0,
            'github_api_calls': 0,
            'final_state': 'In Review'
        })}")
    else:
        click.echo(f"Dev phase failed for {issue_id}", err=True)
        sys.exit(1)


@cli.command("review")
@click.argument("issue_id")
@click.option("--workspace-path", "workspace_path_opt", help="Workspace path for state lookup")
@click.pass_context
def review(ctx, issue_id, workspace_path_opt):
    """Run review phase (review + merge) for an issue."""
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from hooks.review import ReviewHook
    from lib.linear_client import LinearClient
    from lib.github_client import GitHubClient

    config = ctx.obj["config"]

    linear = LinearClient(api_key=config.linear_api_key, endpoint=config.linear_endpoint)

    # Use workspace_path if provided - state is at workspace_path/.symphony/state.json
    if workspace_path_opt:
        workspace_path = Path(workspace_path_opt)
        symphony_path = workspace_path / ".symphony"
        state_file = symphony_path / "state.json"
        if not state_file.exists():
            click.echo(f"No state found for {issue_id} at {state_file}", err=True)
            sys.exit(1)
        import json
        with open(state_file) as f:
            state = json.load(f)
        workspace_root = workspace_path
    else:
        workspace_root = config.workspace_root
        store = StateStore(workspace_root, issue_id)
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
        workspace_root=workspace_root,
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
        click.echo(f"SYMPHONY_STATS:{json.dumps({
            'linear_api_calls': 0,
            'github_api_calls': 0,
            'final_state': final_state.value if final_state else 'unknown'
        })}")
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
