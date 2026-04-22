---
tracker:
  kind: linear
  api_key: $SYMPHONY_TRACKER_API_KEY
  endpoint: https://api.linear.app/graphql
  active_states:
    - Todo
    - In Progress
    - In Review
    - Cancelled
  terminal_states:
    - Done
    - Canceled
    - Duplicate

issue_tracking:
  enabled: true
  custom_fields:
    dev_attempts: dev_attempts
    review_round: review_round
    complexity: complexity
    last_review_decision: last_review_decision

dev_policy:
  complexity_ai_judge: true
  require_test_for_large: true
  max_dev_attempts: 3

review_policy:
  auto_merge_on_approve: true
  notify_linear_on_review: true
  allow_test_requests: true

verification:
  lifecycle:
    timeout_ms: 1800000
    poll_interval_ms: 5000
    projects:
      1d3a3f95809d:
        title: "Live lifecycle smoke test for test2"
        description: "Make a tiny repository-safe change, open a PR, complete review, merge, and leave the repository clean."
      d886490c7fda:
        title: "Live lifecycle smoke test for test-myproject"
        description: "Make a tiny repository-safe change, open a PR, complete review, merge, and leave the repository clean."

polling:
  interval_ms: 30000
hooks:
  timeout_ms: 300000
workspace:
  root: /Users/liupenghui/Documents/code/agent/test-cc/workspaces
repositories:
  routing:
    1d3a3f95809d:
      github_owner: UniUni2000
      github_repo: test2
    d886490c7fda:
      github_owner: UniUni2000
      github_repo: test-myproject
      local_path: .
codex:
  command: node ./scripts/claude-adapter.cjs
agent:
  max_concurrent_agents: 3
  max_retry_backoff_ms: 300000
  max_turns: 3
server:
  port: 8080
---

# Symphony Agent

You are an AI coding assistant.

**Task**: {{issue.identifier}} - {{issue.title}}
**Details**: {{issue.description}}
**State**: {{issue.state}}

**Instructions**:
- If Todo/In Progress: Implement the feature with progress tracking
- If In Review: Review the PR and provide structured feedback

When done, stop. The state machine handles git/PR/Linear updates.

Repository routing is explicit:

- `repositories.routing` keys must match Linear `project_slug`
- each route must declare `github_owner` and `github_repo`
- `local_path` is optional and, when relative, resolves from the repository root
- if an issue's `project_slug` does not match a configured route, Symphony will fail closed and skip dispatch
