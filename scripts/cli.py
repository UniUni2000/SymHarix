#!/usr/bin/env python3
"""SymHarix CLI - Unified entry point for all commands."""

import json
import os
import re
import sys
from pathlib import Path
from typing import Dict, Optional, Tuple

import click

# Add scripts/ to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from lib.config import load_config
from lib.state_machine import State
from lib.state_store import StateStore

RESULT_PREFIX = "SYMPHONY_RESULT:"
WORKFLOW_ARTIFACT_FILES = (
    "DEVELOPMENT_LOG.md",
    "HANDOVER.md",
    "REVIEW_REPORT.md",
    "context.json",
    "events.log",
)


def get_symharix_env(env: Dict[str, str], name: str) -> Optional[str]:
    """Read SYMHARIX_* first, then fall back to legacy SYMPHONY_*."""
    if not name.startswith("SYMPHONY_"):
        raise ValueError(f"Expected SYMPHONY_ environment variable name, got {name}")
    current_name = "SYMHARIX_" + name[len("SYMPHONY_"):]
    current_value = (env.get(current_name) or "").strip()
    if current_value:
        return current_value
    return env.get(name)


def sanitize_repo_cache_key(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", value)


def resolve_dispatch_github_repo(
    *,
    issue: dict,
    default_owner: str,
    default_repo: Optional[str],
    env: Optional[Dict[str, str]] = None,
) -> Tuple[str, str, str]:
    env = env or os.environ
    github_repo_full = (get_symharix_env(env, "SYMPHONY_GITHUB_REPO_FULL") or "").strip()
    if github_repo_full:
        if "/" not in github_repo_full:
            raise ValueError("SYMHARIX_GITHUB_REPO_FULL/SYMPHONY_GITHUB_REPO_FULL must be in owner/repo format")
        owner, repo = github_repo_full.split("/", 1)
        return owner, repo, github_repo_full

    owner = (get_symharix_env(env, "SYMPHONY_GITHUB_OWNER") or default_owner or "").strip()
    repo = (get_symharix_env(env, "SYMPHONY_GITHUB_REPO") or default_repo or "").strip()
    if not owner or not repo:
        issue_identifier = issue.get("identifier", "unknown issue")
        raise ValueError(
            f"Dispatch for {issue_identifier} requires an explicit repository route via "
            "SYMHARIX_GITHUB_REPO_FULL or SYMHARIX_GITHUB_OWNER/SYMHARIX_GITHUB_REPO "
            "(legacy SYMPHONY_* names are still accepted)",
        )

    return owner, repo, f"{owner}/{repo}"


def resolve_dispatch_workspace_path(
    *,
    workspace_root: Path,
    issue_id: str,
    github_repo_full: str,
    workspace_path_opt: Optional[str],
) -> Path:
    if workspace_path_opt:
        return Path(workspace_path_opt)

    owner, repo = github_repo_full.split("/", 1)
    cache_key = f"{sanitize_repo_cache_key(owner.lower())}__{sanitize_repo_cache_key(repo.lower())}"
    return workspace_root / cache_key / "worktrees" / issue_id


def emit_result(
    *,
    ok: bool = True,
    final_state: str = "unknown",
    review_decision: Optional[str] = None,
    feedback: Optional[str] = None,
    delivery_code: Optional[str] = None,
    delivery_summary: Optional[str] = None,
    retry_hint: Optional[str] = None,
    linear_api_calls: int = 0,
    github_api_calls: int = 0,
):
    payload = {
        "ok": ok,
        "final_state": final_state,
        "review_decision": review_decision,
        "feedback": feedback,
        "delivery_code": delivery_code,
        "delivery_summary": delivery_summary,
        "retry_hint": retry_hint,
        "linear_api_calls": linear_api_calls,
        "github_api_calls": github_api_calls,
    }
    click.echo(f"{RESULT_PREFIX}{json.dumps(payload)}")


def reset_workspace_artifacts(_workspace_path: Path, symphony_path: Path) -> None:
    """Remove stale .symphony workflow artifacts when initializing a fresh issue workspace."""
    symphony_path.mkdir(parents=True, exist_ok=True)

    for filename in WORKFLOW_ARTIFACT_FILES:
        artifact_path = symphony_path / filename
        if artifact_path.exists():
            artifact_path.unlink()


@click.group()
@click.pass_context
def cli(ctx):
    """symharix - Issue workflow automation."""
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

    try:
        gh_owner, gh_repo, github_repo_full = resolve_dispatch_github_repo(
            issue=issue,
            default_owner=config.github_owner,
            default_repo=config.github_repo,
        )
    except ValueError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    github = GitHubClient(
        token=config.github_token,
        owner=gh_owner,
        repo=gh_repo,
        default_branch=config.github_default_branch,
    )
    mapped_issue = github.find_issue_by_identifier(issue["identifier"])
    github_issue_number = mapped_issue.get("number") if mapped_issue else None

    # Create branch name (use feature/ prefix like the original system)
    branch = f"feature/{issue['identifier'].lower()}"

    workspace_path = resolve_dispatch_workspace_path(
        workspace_root=config.workspace_root,
        issue_id=issue_id,
        github_repo_full=github_repo_full,
        workspace_path_opt=workspace_path_opt,
    )

    # Initialize state INSIDE the workspace (git worktree), not outside
    # StateStore expects: workspace_root / issue_id / .symphony
    # But we want state inside the worktree: workspace_path / .symphony
    # So we create a custom symphony_path
    symphony_path = workspace_path / ".symphony"

    state_file = symphony_path / "state.json"

    # Initialize state if not already initialized.
    # The worktree manager may pre-create .symphony/ for workflow artifacts, so
    # the presence of the directory alone does not mean state exists yet.
    if state_file.exists():
        click.echo(f"State already exists for {issue_id}, skipping initialization")
    else:
        try:
            # Create the symphony directory inside workspace
            symphony_path.mkdir(parents=True, exist_ok=True)
            reset_workspace_artifacts(workspace_path, symphony_path)

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
                    "github_issue_number": github_issue_number,
                    "branch": branch,
                },
                "error": None,
                "retry_count": 0
            }
            with open(state_file, "w") as f:
                json.dump(state_data, f, indent=2)
        except Exception as e:
            click.echo(f"Error: {e}", err=True)
            sys.exit(1)

    click.echo(f"Issue {issue_id} dispatched")
    click.echo(f"GitHub repo: {github_repo_full}, branch: {branch}")
    emit_result(final_state="In Progress")


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
        store = StateStore(workspace_root, issue_id)
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
    store = StateStore(workspace_root, issue_id)

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
        final_state = store.get_current_state_enum()
        state_name = final_state.value if final_state else "IN_REVIEW"
        final_state_label = {
            "IN_PROGRESS": "In Progress",
            "IN_REVIEW": "In Review",
            "DONE": "Done",
            "CANCELLED": "Cancelled",
            "TODO": "Todo",
            "ERROR": "Error",
        }.get(state_name, state_name)
        emit_result(
            final_state=final_state_label,
            delivery_code=getattr(hook, "last_delivery_code", None),
            delivery_summary=getattr(hook, "last_delivery_summary", None),
        )
    else:
        click.echo(f"Dev phase failed for {issue_id}", err=True)
        final_state = store.get_current_state_enum()
        state_name = final_state.value if final_state else "ERROR"
        final_state_label = {
            "IN_PROGRESS": "In Progress",
            "IN_REVIEW": "In Review",
            "DONE": "Done",
            "CANCELLED": "Cancelled",
            "TODO": "Todo",
            "ERROR": "Error",
        }.get(state_name, state_name)
        emit_result(
            ok=False,
            final_state=final_state_label,
            feedback=store.get_state().get("error") if store.get_state() else None,
            delivery_code=getattr(hook, "last_delivery_code", None),
            delivery_summary=getattr(hook, "last_delivery_summary", None),
        )
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

    store = StateStore(workspace_root, issue_id)

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
        click.echo(f"Review phase completed for {issue_id}")
        final_state = store.get_current_state_enum()
        review_decision = hook.last_review_decision
        retry_hint = None
        if review_decision in ("REQUEST_CHANGES", "REQUEST_TESTS", "REJECT"):
            retry_hint = "retry_dev"
        elif review_decision == "MERGE_BLOCKED":
            retry_hint = "stop"

        state_name = final_state.value if final_state else "unknown"
        final_state_label = {
            "IN_PROGRESS": "In Progress",
            "IN_REVIEW": "In Review",
            "DONE": "Done",
            "CANCELLED": "Cancelled",
            "TODO": "Todo",
            "ERROR": "Error",
        }.get(state_name, state_name)

        emit_result(
            final_state=final_state_label,
            review_decision=review_decision,
            feedback=hook.last_review_report,
            delivery_code=getattr(hook, "last_delivery_code", None),
            delivery_summary=getattr(hook, "last_delivery_summary", None),
            retry_hint=retry_hint,
        )
    else:
        click.echo(f"Review phase failed for {issue_id}", err=True)
        final_state = store.get_current_state_enum()
        state_name = final_state.value if final_state else "ERROR"
        final_state_label = {
            "IN_PROGRESS": "In Progress",
            "IN_REVIEW": "In Review",
            "DONE": "Done",
            "CANCELLED": "Cancelled",
            "TODO": "Todo",
            "ERROR": "Error",
        }.get(state_name, state_name)
        emit_result(
            ok=False,
            final_state=final_state_label,
            review_decision=hook.last_review_decision,
            feedback=hook.last_review_report or (store.get_state().get("error") if store.get_state() else None),
            delivery_code=getattr(hook, "last_delivery_code", None),
            delivery_summary=getattr(hook, "last_delivery_summary", None),
        )
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
    store = StateStore(workspace_root, issue_id)

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
