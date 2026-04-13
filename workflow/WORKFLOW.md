config:
  tracker:
    kind: linear
    api_key: $SYMPHONY_TRACKER_API_KEY
    endpoint: https://api.linear.app/graphql
    project_slug: SYMPH
    active_states:
      - backlog
      - unstarted
      - started
      - completed
    terminal_states:
      - done
      - cancelled
  polling:
    interval_ms: 10000
  workspace:
    root: /home/agent/symharix/workspaces
  agent:
    max_concurrent_agents: 3
    max_retry_backoff_ms: 300000
    max_turns: 100
  server:
    port: 8080

# Default workflow template
prompt: |
  You are working on issue {{issue.identifier}}: {{issue.title}}
  
  Please analyze and fix this issue.
