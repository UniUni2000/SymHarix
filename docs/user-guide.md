# Symphony User Guide

This guide covers how to use the Symphony Enterprise Agent Platform, including the Web Dashboard and Telegram Bot.

## Table of Contents

- [Web Dashboard](#web-dashboard)
- [Telegram Bot](#telegram-bot)
- [Creating Tasks](#creating-tasks)
- [Monitoring Progress](#monitoring-progress)
- [Settings Configuration](#settings-configuration)

## Web Dashboard

The Web Dashboard provides a browser-based interface for managing tasks and monitoring agent activity.

### Accessing the Dashboard

1. Start the Symphony server:
   ```bash
   bun run start -- --port 3000
   ```

2. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

### Dashboard Pages

#### Task List

The main page shows all tasks with their current status:

- **Task ID**: Unique identifier (e.g., `ABC-123`)
- **Title**: Task description
- **Status**: Current state with color indicator:
  - ⚪ Unclaimed/Released
  - 🔵 Claimed
  - 🟢 Running
  - 🟡 Retry Queued
  - ✅ Completed
  - ❌ Failed
- **Priority**: Task priority level
- **Actions**: Quick actions for each task

#### Task Detail

Click on any task to view detailed information:

- Full task description
- Execution history and events
- Workspace information
- Retry count and status
- Direct link to Linear issue

#### Settings Page

Access configuration options:

1. Click **Settings** in the navigation bar
2. Configure options as described in [Settings Configuration](#settings-configuration)

### Features

#### Real-time Updates

The dashboard uses WebSocket connections to provide real-time updates:

- Task state changes
- New events and logs
- Progress indicators

#### Filtering and Search

- Filter tasks by status
- Search by task ID or title
- Sort by priority or creation date

## Telegram Bot

The Telegram Bot allows you to control Symphony from your mobile device.

### Setting Up the Bot

1. **Get a Bot Token**:
   - Open Telegram and search for `@BotFather`
   - Send `/newbot` command
   - Follow the prompts to create your bot
   - Copy the bot token (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

2. **Configure the Bot**:
   - Add the token to your `.env` file:
     ```
     TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
     ```
   - Restart the Symphony server

3. **Start the Bot**:
   - Find your bot on Telegram (search for the bot name you created)
   - Send `/start` to begin

### Bot Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/start` | Welcome message or start a task | `/start` or `/start ABC-123` |
| `/help` | Show available commands | `/help` |
| `/new_issue` | Create a new issue interactively | `/new_issue` |
| `/pause <ID>` | Pause a running task | `/pause ABC-123` |
| `/cancel <ID>` | Cancel a task | `/cancel ABC-123` |
| `/status <ID>` | Check task status | `/status ABC-123` |

### Command Usage

#### Starting the Bot

```
/start
```
Displays a welcome message with available commands.

#### Starting a Task

```
/start ABC-123
```
Begins working on the specified issue. The bot will notify you when the task completes.

#### Creating a New Issue

```
/new_issue
```
Starts an interactive flow:
1. Bot asks for the issue title
2. Bot asks for a description
3. Bot asks for priority (Low, Medium, High)
4. Issue is created and synced with Linear

#### Pausing a Task

```
/pause ABC-123
```
Pauses a running task. The task can be resumed later.

#### Canceling a Task

```
/cancel ABC-123
```
Cancels the task and cleans up the workspace.

#### Checking Status

```
/status ABC-123
```
Returns the current status of the task including:
- Current state
- Progress information
- Recent events
- Workspace details

### Notifications

The bot sends automatic notifications for:

- Task completion
- Task failures
- Important milestones
- Status updates

### Inline Buttons

Many bot messages include inline buttons for quick actions:

- **Start Task**: Begin working on an issue
- **Pause Task**: Pause a running task
- **Cancel Task**: Cancel the task
- **Refresh Status**: Get latest status

## Creating Tasks

### Via Web Dashboard

1. Navigate to the Task List page
2. Click **New Task** button
3. Fill in the form:
   - **Title**: Required, descriptive title
   - **Description**: Optional, detailed description
   - **Priority**: Select priority level
   - **Labels**: Optional, comma-separated labels
4. Click **Create Task**

### Via Telegram Bot

1. Send `/new_issue` to the bot
2. Follow the interactive prompts:
   ```
   Bot: Please enter the issue title:
   You: Fix login authentication bug

   Bot: Please enter a description (optional):
   You: Users cannot log in with OAuth providers

   Bot: Select priority (Low/Medium/High):
   You: High
   ```
3. Bot confirms creation with task ID

### Via Linear

Tasks can also be created directly in Linear:
1. Create an issue in your configured Linear project
2. Symphony will automatically sync and create a corresponding task
3. Use `/start <ISSUE-ID>` to begin working on it

## Monitoring Progress

### Web Dashboard Monitoring

#### Task List View

- **Status Indicators**: Color-coded status badges
- **Progress Bars**: Visual progress for running tasks
- **Real-time Updates**: Automatic refresh via WebSocket

#### Task Detail View

- **Event Timeline**: Chronological list of all events
- **Log Output**: Agent execution logs
- **Workspace Info**: Directory and file information
- **Retry History**: Previous attempts and outcomes

### Telegram Bot Monitoring

#### Status Command

```
/status ABC-123
```
Returns a summary:
```
📊 Task Status: ABC-123

Title: Fix login authentication bug
State: 🟢 Running
Priority: High
Progress: 60%

Recent Events:
- Agent started
- Analyzing codebase
- Implementing fix
```

#### Automatic Notifications

You'll receive push notifications for:
- Task started
- Task completed successfully
- Task failed with error details
- Retry attempts

### Event Types

The system tracks various event types:

| Event Type | Description |
|------------|-------------|
| `task_created` | Task was created |
| `task_started` | Agent began working |
| `task_paused` | Task was paused |
| `task_completed` | Task finished successfully |
| `task_failed` | Task encountered an error |
| `task_cancelled` | Task was cancelled |
| `workspace_created` | Workspace directory created |
| `workspace_cleaned` | Workspace was cleaned up |
| `agent_turn` | Agent completed a turn |
| `retry_scheduled` | Task will be retried |

## Settings Configuration

### Web Dashboard Settings

Access via **Settings** page or API.

#### Server Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| Server URL | Base URL for Symphony API | `http://localhost:3000` |

#### Telegram Integration

| Setting | Description |
|---------|-------------|
| Bot Token | Telegram bot token from @BotFather |

#### Dashboard Preferences

| Setting | Description | Default | Range |
|---------|-------------|---------|-------|
| Auto-refresh | Automatically update task list | `true` | - |
| Refresh Interval | Seconds between refreshes | `30` | 5-300 |

### Environment Variables

For server-level configuration, use environment variables:

```bash
# .env file
LINEAR_API_KEY=your_api_key
TELEGRAM_BOT_TOKEN=your_bot_token
SYMPHONY_PORT=3000
LOG_LEVEL=info
```

### WORKFLOW.md Configuration

Advanced configuration via `WORKFLOW.md`:

```yaml
---
# Tracker settings
tracker:
  project_slug: my-project
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]

# Polling interval
polling:
  interval_ms: 30000

# Agent settings
agent:
  max_concurrent_agents: 10
  max_turns: 20

# Hook scripts
hooks:
  after_create: |
    echo "Workspace created"
  timeout_ms: 60000
---
```

## Tips and Best Practices

### Task Management

1. **Use Descriptive Titles**: Clear titles make tasks easier to identify
2. **Set Appropriate Priorities**: Help the scheduler prioritize work
3. **Monitor Regularly**: Check task progress via dashboard or bot
4. **Use Labels**: Organize tasks with meaningful labels

### Bot Usage

1. **Save Bot Token Securely**: Never share your bot token
2. **Use Short IDs**: `/status ABC-123` works as well as full UUID
3. **Enable Notifications**: Stay informed of important events

### Dashboard Usage

1. **Bookmark Deep Links**: Link directly to specific tasks
2. **Use Filters**: Narrow down task lists for focus
3. **Check Event Logs**: Debug issues using detailed logs

## Troubleshooting

### Bot Not Responding

1. Verify bot token is correct in `.env`
2. Check bot is running: `/start` should respond
3. Restart the Symphony server

### Dashboard Not Loading

1. Verify server is running on correct port
2. Check browser console for errors
3. Clear browser cache

### Task Not Progressing

1. Check task status via `/status <ID>`
2. Review event logs for errors
3. Verify workspace permissions
4. Check Linear API connectivity

## Getting Help

- Check [Deployment Guide](./deployment.md) for setup issues
- Review server logs for detailed error messages
- Contact your system administrator for access issues
