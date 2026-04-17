---
tracker:
  kind: linear
  api_key: $SYMPHONY_TRACKER_API_KEY
  endpoint: https://api.linear.app/graphql
  # projects 配置已移除 - 现在自动从 Linear Project 名字推导
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

polling:
  interval_ms: 30000
workspace:
  root: /Users/liupenghui/Documents/code/agent/test-cc/workspaces
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
