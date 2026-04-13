---
tracker:
  kind: linear
  api_key: $SYMPHONY_TRACKER_API_KEY
  endpoint: https://api.linear.app/graphql
  project_slug: d886490c7fda
  active_states:
    - Todo
    - In Progress
    - In Review
  terminal_states:
    - Done
    - Canceled
    - Duplicate
polling:
  interval_ms: 30000
workspace:
  root: /home/agent/test-cc/workspaces
agent:
  max_concurrent_agents: 3
  max_retry_backoff_ms: 300000
  max_turns: 100
server:
  port: 8080
---

Symphony Enterprise Agent Platform - Default Workflow
