# Symphony Deployment Guide

This guide covers deploying the Symphony Enterprise Agent Platform to production.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Install](#quick-install)
- [Manual Installation](#manual-installation)
- [Configuration](#configuration)
- [Starting the Server](#starting-the-server)
- [Production Deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### Required Software

- **Bun** (v1.0.0 or higher) - JavaScript runtime and package manager
- **Git** - Version control
- **VPS/Server** - Linux-based server with:
  - 2+ GB RAM
  - 2+ CPU cores
  - 10+ GB disk space
  - Public IP address or domain

### Installing Bun

```bash
# Install Bun on Linux/macOS
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version
```

## Quick Install

**One-command installation:**

```bash
curl -fsSL https://symphony.dev/install.sh | bash
```

This will:
1. Check requirements (git, curl)
2. Install Bun (if not present)
3. Clone the repository to `~/symphony`
4. Install dependencies
5. Create configuration template

**After installation:**

```bash
cd ~/symphony
nano .env  # Add your API keys
bun run start
```
cd symphony
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Build the Project

```bash
bun run build
```

### 4. Install Web Dashboard Dependencies

```bash
cd src/web-dashboard
bun install
bun run build
cd ../..
```

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```bash
# .env
# Symphony Enterprise Agent Platform Configuration

# Linear API Configuration
LINEAR_API_KEY=your_linear_api_key_here

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Database Configuration (optional)
SYMPHONY_DB_PATH=./symphony.db

# Server Configuration
SYMPHONY_PORT=3000
SYMPHONY_HOST=0.0.0.0

# Workspace Configuration
WORKSPACE_ROOT=/tmp/symphony_workspaces

# Logging
LOG_LEVEL=info
```

### Environment Variables Reference

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `LINEAR_API_KEY` | Linear API key for issue tracking | - | Yes |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | - | For Telegram |
| `SYMPHONY_DB_PATH` | SQLite database file path | `./symphony.db` | No |
| `SYMPHONY_PORT` | HTTP server port | `3000` | No |
| `SYMPHONY_HOST` | HTTP server bind address | `0.0.0.0` | No |
| `WORKSPACE_ROOT` | Base directory for agent workspaces | `/tmp/symphony_workspaces` | No |
| `LOG_LEVEL` | Logging verbosity | `info` | No |

### WORKFLOW.md Configuration

Create a `WORKFLOW.md` file in the project root:

```yaml
---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: your-project-slug

  active_states:
    - Todo
    - In Progress

  terminal_states:
    - Done
    - Cancelled
    - Duplicate

polling:
  interval_ms: 30000

workspace:
  root: /tmp/symphony_workspaces

hooks:
  after_create: |
    echo "Workspace created at $(pwd)"

  before_run: |
    echo "Preparing workspace..."

  after_run: |
    echo "Run completed"

  timeout_ms: 60000

agent:
  max_concurrent_agents: 10
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

server:
  port: 3000
---

# Your prompt template goes here
# See WORKFLOW.md.example for a complete example
```

## Starting the Server

### Development Mode

```bash
# Start with default WORKFLOW.md
bun run dev

# Start with custom workflow path
bun run dev -- path/to/WORKFLOW.md

# Start with HTTP server on specific port
bun run dev -- --port 3000
```

### Production Mode

```bash
# Build first
bun run build

# Start the server
bun run start

# Or with custom port
bun run start -- --port 3000
```

### Running as a Background Service

#### Using systemd (Linux)

Create a service file `/etc/systemd/system/symphony.service`:

```ini
[Unit]
Description=Symphony Enterprise Agent Platform
After=network.target

[Service]
Type=simple
User=symphony
WorkingDirectory=/opt/symphony
ExecStart=/usr/bin/bun run start
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/symphony/.env

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable symphony
sudo systemctl start symphony
sudo systemctl status symphony
```

#### Using PM2

```bash
# Install PM2 globally
npm install -g pm2

# Start Symphony with PM2
pm2 start "bun run start" --name symphony

# Save PM2 process list
pm2 save

# Setup PM2 to start on boot
pm2 startup
```

## Production Deployment

### Using Docker (Recommended)

Create a `Dockerfile`:

```dockerfile
FROM oven/bun:1.0

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install --production

# Copy application files
COPY dist/ ./dist/
COPY src/ ./src/

# Expose port
EXPOSE 3000

# Start the application
CMD ["bun", "run", "start"]
```

Build and run:

```bash
docker build -t symphony:latest .
docker run -d -p 3000:3000 --env-file .env --name symphony symphony:latest
```

### Using nginx as Reverse Proxy

1. Install nginx:

```bash
sudo apt-get install nginx
```

2. Configure nginx `/etc/nginx/sites-available/symphony`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }

    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```

3. Enable the site and reload nginx:

```bash
sudo ln -s /etc/nginx/sites-available/symphony /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### SSL/TLS with Let's Encrypt

```bash
# Install certbot
sudo apt-get install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d your-domain.com
```

## Troubleshooting

### Common Issues

**Port already in use:**
```bash
# Find process using port 3000
lsof -i :3000
# Kill the process
kill -9 <PID>
```

**Database locked:**
```bash
# Remove WAL files if corrupted
rm -f symphony.db-wal symphony.db-shm
```

**Permission denied on workspace:**
```bash
# Ensure workspace directory exists and is writable
mkdir -p /tmp/symphony_workspaces
chmod 755 /tmp/symphony_workspaces
```

### Checking Logs

```bash
# View systemd service logs
journalctl -u symphony -f

# View PM2 logs
pm2 logs symphony

# View application logs (if configured)
tail -f /var/log/symphony/*.log
```

### Health Check

```bash
# Check API health
curl http://localhost:3000/api/v1/health

# Check if process is running
ps aux | grep symphony
```

## Support

For additional help, refer to:
- [User Guide](./user-guide.md)
- [README](../README.md)
- Project documentation
