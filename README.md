# Symphony Enterprise Agent Platform

A powerful enterprise software development agent platform with Claude Code orchestration, Web Dashboard, and Telegram Bot control.

This is an implementation of the [OpenAI Symphony Specification](https://github.com/openai/symphony/blob/main/SPEC.md) with extended features for enterprise use.

## Overview

Symphony is an enterprise-grade agent platform that:

1. Polls Linear for issues in active states
2. Creates isolated workspaces for each issue
3. Runs Claude Code agent sessions to work on issues
4. Manages retries, reconciliation, and concurrency
5. Supports dynamic workflow configuration via `WORKFLOW.md`
6. Provides real-time Web Dashboard for monitoring
7. Offers Telegram Bot for mobile control and notifications

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Symphony Service                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Workflow   │  │   Config    │  │      Linear         │  │
│  │   Loader    │  │   Layer     │  │     Tracker         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                  Orchestrator                        │    │
│  │  - Poll loop    - Dispatch    - Reconciliation      │    │
│  │  - Retry queue  - State mgmt  - Concurrency control │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Workspace  │  │    Agent    │  │     Logging &       │  │
│  │  Manager    │  │   Runner    │  │   Observability     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) (v1.0.0 or higher)
- Linear API key (for issue tracking)
- Telegram Bot token (optional, for bot integration)

### Installation

```bash
# Clone the repository
git clone <repository-url> symphony
cd symphony

# Install dependencies
bun install

# Build the project
bun run build
```

### Configuration

1. Create a `.env` file:

```bash
# .env
LINEAR_API_KEY=your_linear_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token  # Optional
```

2. Create a `WORKFLOW.md` file (or copy from example):

```bash
cp WORKFLOW.md.example WORKFLOW.md
```

Edit `WORKFLOW.md` with your Linear project settings.

### Running Symphony

```bash
# Start with default settings
bun run start

# Start with HTTP server on specific port
bun run start -- --port 3000

# Development mode with hot reload
bun run dev
```

### Accessing the Platform

- **Web Dashboard**: http://localhost:3000
- **Telegram Bot**: Find your bot on Telegram and send `/start`

## Documentation

- [Deployment Guide](./docs/deployment.md) - Installation, configuration, and production deployment
- [User Guide](./docs/user-guide.md) - Using the Web Dashboard and Telegram Bot

## Features

### Core Features

| Feature | Description |
|---------|-------------|
| **Linear Integration** | Automatic issue syncing from Linear projects |
| **Claude Code Orchestration** | Run Claude Code agents in isolated workspaces |
| **Web Dashboard** | Real-time monitoring and task management via browser |
| **Telegram Bot** | Mobile control and notifications via Telegram |
| **Retry Management** | Automatic retry with exponential backoff |
| **Workspace Management** | Isolated per-issue workspaces with lifecycle hooks |
| **Dynamic Configuration** | Hot-reload `WORKFLOW.md` changes |
| **Concurrency Control** | Configurable parallel agent execution |

### Core Conformance (Section 17.1-17.7)

- [x] Workflow file path precedence (explicit runtime path -> cwd default)
- [x] `WORKFLOW.md` loader with YAML front matter + prompt body split
- [x] Typed config layer with defaults and `$VAR` resolution
- [x] Dynamic `WORKFLOW.md` watch/reload/re-apply for config and prompt
- [x] Polling orchestrator with single-authority mutable state
- [x] Issue tracker client with candidate fetch + state refresh + terminal fetch
- [x] Workspace manager with sanitized per-issue workspaces
- [x] Workspace lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
- [x] Hook timeout config (`hooks.timeout_ms`, default `60000`)
- [x] Coding-agent app-server subprocess client with JSON line protocol
- [x] Codex launch command config (`codex.command`, default `codex app-server`)
- [x] Strict prompt rendering with `issue` and `attempt` variables
- [x] Exponential retry queue with continuation retries after normal exit
- [x] Configurable retry backoff cap (`agent.max_retry_backoff_ms`, default 5m)
- [x] Reconciliation that stops runs on terminal/non-active tracker states
- [x] Workspace cleanup for terminal issues (startup sweep + active transition)
- [x] Structured logs with `issue_id`, `issue_identifier`, and `session_id`
- [x] CLI accepts optional positional workflow path argument
- [x] CLI uses `./WORKFLOW.md` when no workflow path argument provided
- [x] CLI surfaces startup failure cleanly

### Extensions (Enterprise Features)

- [x] HTTP server with dashboard (`/`) and JSON API (`/api/v1/*`)
- [x] WebSocket real-time event streaming
- [x] SQLite database for persistence
- [x] Telegram Bot with interactive commands
- [x] React-based Web Dashboard with Tailwind CSS
- [ ] SSH worker execution (Appendix A)
- [ ] Persistent retry queue across restarts

## Project Structure

```
symphony/
├── src/
│   ├── cli/           # CLI entrypoint
│   ├── config/        # Configuration loading and validation
│   ├── workflow/      # WORKFLOW.md loader and watcher
│   ├── tracker/       # Linear API client
│   ├── workspace/     # Workspace lifecycle management
│   ├── agent/         # Agent runner client
│   ├── orchestrator/  # Core scheduling and state management
│   ├── logging/       # Structured logging
│   ├── database/      # SQLite database layer
│   ├── server/        # Hono HTTP server
│   ├── telegram/      # Telegram Bot (grammy)
│   ├── web-dashboard/ # React Web Dashboard
│   └── types.ts       # TypeScript type definitions
├── docs/
│   ├── deployment.md  # Deployment guide
│   └── user-guide.md  # User documentation
├── WORKFLOW.md        # Workflow configuration
├── WORKFLOW.md.example # Example workflow
├── package.json
└── README.md
```

## Configuration

Symphony is configured via a `WORKFLOW.md` file in your project root (or specified path).

### Required Configuration

```yaml
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project

codex:
  command: codex app-server
---

Your prompt template goes here.
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `LINEAR_API_KEY` | Your Linear API key | Yes |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | No |
| `SYMPHONY_PORT` | HTTP server port (default: 3000) | No |
| `WORKSPACE_ROOT` | Base directory for workspaces | No |

See `WORKFLOW.md.example` for a complete example with all options.

## Test Results

```
Test Suites: 1 passed, 1 total
Tests:       229 passing
```

## Specification Reference

This implementation follows the Symphony Service Specification v1:

- Section 4: Core Domain Model
- Section 5: Workflow Specification
- Section 6: Configuration Specification
- Section 7: Orchestration State Machine
- Section 8: Polling, Scheduling, and Reconciliation
- Section 9: Workspace Management
- Section 10: Agent Runner Protocol
- Section 11: Issue Tracker Integration
- Section 13: Logging and Observability
- Section 16: Reference Algorithms

## License

MIT
