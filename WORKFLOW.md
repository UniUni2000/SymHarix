---
tracker:
  kind: linear
  api_key: $SYMPHONY_TRACKER_API_KEY
  endpoint: https://api.linear.app/graphql
  project_slug: d886490c7fda
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Canceled
    - Duplicate
    - In Review
polling:
  interval_ms: 30000
workspace:
  root: /home/agent/test-cc/workspaces
hooks:
  after_run: /home/agent/test-cc/scripts/after-run.sh
  timeout_ms: 120000
agent:
  max_concurrent_agents: 3
  max_retry_backoff_ms: 300000
  max_turns: 100
server:
  port: 8080
---

Symphony Enterprise Agent Platform - Default Workflow
