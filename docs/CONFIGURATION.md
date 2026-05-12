# symphonyness Configuration Guide / 配置指南

This guide explains the config files and the environment variables most operators need.

这份指南说明常用配置文件和运维者最需要的环境变量。

## Configuration Layers / 配置层

symphonyness reads three layers:

symphonyness 读取三层配置：

1. `.env`: secrets, API keys, local runtime switches, Telegram tunnel/bootstrap, LLM providers.
   `.env`：密钥、API key、本地运行开关、Telegram 隧道/启动、LLM provider。
2. `WORKFLOW.md`: orchestration policy, tracker states, repository routing, agent command.
   `WORKFLOW.md`：编排策略、tracker 状态、仓库路由、agent 命令。
3. Target repo contracts: `.symphony-repo.yaml` and `.symphony-constitution.md`.
   目标仓库契约：`.symphony-repo.yaml` 与 `.symphony-constitution.md`。

Environment variables intentionally keep the `SYMPHONY_` prefix for compatibility.

环境变量会继续保留 `SYMPHONY_` 前缀，这是兼容契约。

## Local Setup / 本地初始化

```bash
bun run setup:local
```

This installs dependencies and creates `.env` / `WORKFLOW.md` from examples only when missing.

该命令会安装依赖，并且只在文件不存在时从示例创建 `.env` / `WORKFLOW.md`。

Normal startup:

日常启动：

```bash
bun run start:local
```

`start:local` keeps existing config, prepares Telegram proxy/tunnel behavior, starts the service, and prints a Telegram startup summary when possible.

`start:local` 会保留已有配置，准备 Telegram 代理/隧道，启动服务，并在可能时打印 Telegram 启动摘要。

## `.env` Reference / `.env` 参考

### Tracker / Tracker

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `SYMPHONY_TRACKER_KIND` | yes | Currently `linear` only / 当前仅支持 `linear` |
| `SYMPHONY_TRACKER_API_KEY` | yes | Linear API key / Linear API key |
| `SYMPHONY_TRACKER_PROJECT_SLUG` | recommended | Default Linear project slug for bot/runtime issue creation / Bot/runtime 创建 issue 的默认 Linear project slug |

Example / 示例:

```dotenv
SYMPHONY_TRACKER_KIND=linear
SYMPHONY_TRACKER_API_KEY=...
SYMPHONY_TRACKER_PROJECT_SLUG=sample-project
```

### GitHub / GitHub

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Token with access to target repos in `WORKFLOW.md` / 可访问 `WORKFLOW.md` 中目标仓库的 token |
| `GITHUB_OWNER` | optional | Older fallback path only / 旧 fallback 路径使用 |
| `GITHUB_REPO` | optional | Older fallback path only / 旧 fallback 路径使用 |

Prefer `WORKFLOW.md -> repositories.routing` for real routing.

真实路由应优先使用 `WORKFLOW.md -> repositories.routing`。

### Claude Code Runtime / Claude Code Runtime

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Used by bundled Claude Code runtime / 内置 Claude Code runtime 使用 |
| `ANTHROPIC_MODEL` | optional | Older supervisor fallback / 旧 supervisor fallback |
| `ANTHROPIC_BASE_URL` | optional | Older supervisor fallback / 旧 supervisor fallback |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | recommended | Keeps local runtime quieter / 让本地 runtime 更安静 |
| `CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH` | recommended | Avoids broad startup prefetch / 避免启动时做大范围预取 |

Recommended / 推荐:

```dotenv
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1
```

The adapter supplies runtime defaults such as `CLAUDE_CODE_SIMPLE=1`, disabled background tasks, disabled auto memory, and read-only mode for read-only Supervisor sessions. Do not override them unless debugging the embedded runtime.

adapter 会为 runtime 注入默认值，例如 `CLAUDE_CODE_SIMPLE=1`、关闭后台任务、关闭自动记忆，以及在只读 Supervisor 会话中开启 read-only。除非调试内置 runtime，否则不要覆盖这些值。

### Runtime Write Token / Runtime 写权限

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `SYMPHONY_RUNTIME_WRITE_TOKEN` | optional | Protects runtime write actions when exposing the UI/API / 公开 UI/API 时保护 runtime 写操作 |

Blank is convenient for local development, but set it before exposing `/runtime` publicly.

本地开发可以留空，但公开暴露 `/runtime` 前应设置。

### Telegram / Telegram

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `SYMPHONY_TELEGRAM_BOT_TOKEN` | for Telegram | BotFather token / BotFather token |
| `SYMPHONY_TELEGRAM_WEBHOOK_SECRET` | recommended | Secret used by webhook path/header checks / webhook 路径/header 校验 secret |
| `SYMPHONY_TELEGRAM_OPERATOR_IDS` | recommended | Comma-separated user ids allowed to write / 允许写操作的 user id，逗号分隔 |
| `SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID` | optional | Fixed operations chat / 固定 operations chat |
| `SYMPHONY_PUBLIC_BASE_URL` | optional | Public HTTPS base for webhook and Mini App links / webhook 和 Mini App 链接的公网 HTTPS base |
| `SYMPHONY_TELEGRAM_BOOTSTRAP` | optional | Set `off` to disable automatic webhook/tunnel bootstrap / 设置为 `off` 可禁用自动 webhook/tunnel bootstrap |

Recommended local values / 推荐本地值:

```dotenv
SYMPHONY_TELEGRAM_BOT_TOKEN=...
SYMPHONY_TELEGRAM_WEBHOOK_SECRET=...
SYMPHONY_TELEGRAM_OPERATOR_IDS=123456789
```

If `SYMPHONY_PUBLIC_BASE_URL` is empty and Telegram is enabled, `start:local` tries to create a temporary `cloudflared` tunnel before starting the app. Other startup paths can still fall back to in-process webhook/tunnel bootstrap.

如果 `SYMPHONY_PUBLIC_BASE_URL` 留空且启用了 Telegram，`start:local` 会在 app 启动前尝试创建临时 `cloudflared` 隧道。其他启动路径仍可回退到进程内 webhook/tunnel bootstrap。

Tunnel and webhook knobs / 隧道与 webhook 参数:

| Variable | Default | Meaning / 含义 |
| --- | --- | --- |
| `SYMPHONY_TELEGRAM_TUNNEL_COMMAND` | `cloudflared` path | Override tunnel command / 覆盖隧道命令 |
| `SYMPHONY_TELEGRAM_TUNNEL_PROTOCOL` | `http2` | Tunnel protocol / 隧道协议 |
| `SYMPHONY_TELEGRAM_TUNNEL_RETRY_ATTEMPTS` | `3` | start:local tunnel attempts / start:local 隧道尝试次数 |
| `SYMPHONY_TELEGRAM_TUNNEL_RETRY_DELAY_MS` | `1500` | Delay between tunnel attempts / 隧道重试间隔 |
| `SYMPHONY_TELEGRAM_TUNNEL_WATCHDOG_INTERVAL_MS` | `10000` | Watchdog poll interval / watchdog 检查间隔 |
| `SYMPHONY_TELEGRAM_TUNNEL_WATCHDOG_DEGRADED_POLLS` | `2` | Consecutive degraded polls before tunnel recovery / 连续 degraded 次数达到后触发隧道恢复 |
| `SYMPHONY_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS` | `6` | Webhook registration retry attempts / webhook 注册重试次数 |
| `SYMPHONY_TELEGRAM_WEBHOOK_RETRY_DELAY_MS` | `2000` | Webhook retry delay / webhook 重试间隔 |
| `SYMPHONY_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS` | `60` | Startup summary polling attempts / 启动摘要轮询次数 |

Proxy knobs / 代理参数:

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMPHONY_PROXY_MODE` | `auto` detects common local proxies, `off` disables Telegram proxy use / `auto` 自动检测常见本地代理，`off` 禁用 Telegram 代理 |
| `SYMPHONY_PROXY_URL` | Explicit proxy URL / 显式代理 URL |
| `SYMPHONY_TELEGRAM_DISABLE_PROXY` | Low-level disable flag, usually set by `SYMPHONY_PROXY_MODE=off` / 底层禁用开关，通常由 `SYMPHONY_PROXY_MODE=off` 设置 |
| `SYMPHONY_TELEGRAM_CURL_TIMEOUT_SECONDS` | Curl transport timeout / curl 传输超时 |

After startup, Telegram is actually ready only when this endpoint reports a non-empty current `webhook_url`:

启动后，只有当下面端点显示当前非空 `webhook_url` 时，Telegram 才真正可用：

```bash
curl http://localhost:3000/api/v1/bots/manifest
```

### Bot LLM / Bot LLM

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `SYMPHONY_BOT_LLM_PROVIDER` | for richer natural language | `anthropic` or `openai` / `anthropic` 或 `openai` |
| `SYMPHONY_BOT_LLM_MODEL` | for richer natural language | Model name / 模型名 |
| `SYMPHONY_BOT_LLM_API_KEY` | for richer natural language | Provider key / Provider key |
| `SYMPHONY_BOT_LLM_BASE_URL` | optional | Custom endpoint / 自定义 endpoint |
| `SYMPHONY_BOT_LLM_TIMEOUT_MS` | optional | Default `15000` / 默认 `15000` |
| `SYMPHONY_BOT_LLM_HTTP_TRANSPORT` | optional | `fetch`, `curl`, or `auto` / `fetch`、`curl` 或 `auto` |

Use `fetch` for normal operation. `auto` is mainly for transport debugging and can increase worst-case latency.

日常使用 `fetch`。`auto` 主要用于传输调试，最坏延迟可能更高。

### Supervisor Planning And Assistant / Supervisor 计划与助手

Planning defaults to bot LLM settings.

计划模型默认复用 Bot LLM。

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMPHONY_SUPERVISOR_LLM_PROVIDER` | Supervisor planning provider / Supervisor 计划 provider |
| `SYMPHONY_SUPERVISOR_LLM_MODEL` | Supervisor planning model / Supervisor 计划模型 |
| `SYMPHONY_SUPERVISOR_LLM_API_KEY` | Supervisor planning key / Supervisor 计划 key |
| `SYMPHONY_SUPERVISOR_LLM_BASE_URL` | Supervisor planning endpoint / Supervisor 计划 endpoint |
| `SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS` | Default `45000` / 默认 `45000` |

Newer top-level assistant settings fall back in this order:

较新的顶层助手配置按以下顺序回退：

```text
SYMPHONY_SUPERVISOR_AGENT_*
  -> SYMPHONY_SUPERVISOR_CC_*
  -> SYMPHONY_SUPERVISOR_LLM_*
  -> SYMPHONY_BOT_LLM_*
```

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMPHONY_SUPERVISOR_AGENT_PROVIDER` | Top-level Supervisor assistant provider / 顶层 Supervisor 助手 provider |
| `SYMPHONY_SUPERVISOR_AGENT_MODEL` | Top-level Supervisor assistant model / 顶层 Supervisor 助手模型 |
| `SYMPHONY_SUPERVISOR_AGENT_API_KEY` | Top-level Supervisor assistant key / 顶层 Supervisor 助手 key |
| `SYMPHONY_SUPERVISOR_AGENT_BASE_URL` | Top-level Supervisor assistant endpoint / 顶层 Supervisor 助手 endpoint |
| `SYMPHONY_SUPERVISOR_AGENT_TIMEOUT_MS` | Default `45000` / 默认 `45000` |
| `SYMPHONY_SUPERVISOR_CC_PROVIDER` | Older CC advisor compatibility provider / 旧 CC advisor 兼容 provider |
| `SYMPHONY_SUPERVISOR_CC_MODEL` | Older CC advisor compatibility model / 旧 CC advisor 兼容模型 |
| `SYMPHONY_SUPERVISOR_CC_API_KEY` | Older CC advisor compatibility key / 旧 CC advisor 兼容 key |
| `SYMPHONY_SUPERVISOR_CC_BASE_URL` | Older CC advisor compatibility endpoint / 旧 CC advisor 兼容 endpoint |
| `SYMPHONY_SUPERVISOR_CC_TIMEOUT_MS` | Default `45000` / 默认 `45000` |

### Supervisor Claude Runtime And Repo Understanding / Supervisor Claude Runtime 与仓库理解

The Telegram Supervisor can use a top-level Claude Code runtime as the assistant brain. Repository access is read-only in that path. Business actions still go through supervisor-orchestrator tools and confirmation policy.

Telegram Supervisor 可以使用顶层 Claude Code runtime 作为助手大脑。在这条路径中，仓库访问是只读的。业务动作仍然通过 supervisor-orchestrator tools 和确认策略执行。

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMPHONY_SUPERVISOR_CLAUDE_RUNTIME` | Set `off` to disable the Claude runtime front door / 设置为 `off` 可禁用 Claude runtime 前门 |
| `SYMPHONY_SUPERVISOR_CLAUDE_COMMAND` | Runtime command, defaults to `node scripts/claude-adapter.cjs` / Runtime 命令，默认 `node scripts/claude-adapter.cjs` |
| `SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_COMMAND` | Read-only repo understanding command / 只读仓库理解命令 |
| `SYMPHONY_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS` | Default `120000` / 默认 `120000` |
| `SYMPHONY_SUPERVISOR_READONLY_ADVISOR_COMMAND` | Per-turn read-only repo advisor command / 每轮只读仓库顾问命令 |
| `SYMPHONY_SUPERVISOR_READONLY_ADVISOR_TIMEOUT_MS` | Default `120000` / 默认 `120000` |

Defaults use `node scripts/claude-adapter.cjs`, which invokes `claude-code/bin/claude-haha`.

默认命令使用 `node scripts/claude-adapter.cjs`，它会调用 `claude-code/bin/claude-haha`。

### Supervisor Overseer / Supervisor 执行监督

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMPHONY_SUPERVISOR_OVERSEER_PROVIDER` | Dedicated overseer provider / 专用 overseer provider |
| `SYMPHONY_SUPERVISOR_OVERSEER_MODEL` | Dedicated overseer model / 专用 overseer 模型 |
| `SYMPHONY_SUPERVISOR_OVERSEER_API_KEY` | Dedicated overseer key / 专用 overseer key |
| `SYMPHONY_SUPERVISOR_OVERSEER_BASE_URL` | Dedicated overseer endpoint / 专用 overseer endpoint |
| `SYMPHONY_SUPERVISOR_OVERSEER_TIMEOUT_MS` | Default `30000` / 默认 `30000` |

If the overseer LLM fails, deterministic supervision still classifies delivery failures, missing evidence, branch drift, and approval gates.

如果 overseer LLM 失败，确定性监督逻辑仍会分类交付失败、证据缺失、分支漂移和审批门。

### Startup Repair And Cleanup / 启动修复与清理

| Variable | Default | Meaning / 含义 |
| --- | --- | --- |
| `SYMPHONY_SUPERVISOR_JOB_INTERVAL_MS` | `30000` | Supervisor job-loop tick interval / Supervisor job-loop 间隔 |
| `SYMPHONY_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS` | `86400000` | Stale pre-materialization session threshold / 预物化 session 过期阈值 |
| `SYMPHONY_BOT_FOLLOWUP_REPAIR_DELAY_MS` | `5000` | Delay before bot follow-up repair / bot follow-up 修复延迟 |
| `SYMPHONY_STARTUP_CLEANUP_DELAY_MS` | `900000` | Delay before heavier orphan cleanup / 较重 orphan 清理延迟 |
| `SYMPHONY_FIRST_TICK_DELAY_MS` | `10000` | Delay before first orchestrator poll / 第一次 orchestrator poll 延迟 |

These delays keep startup responsive and reduce contention with live verification.

这些延迟能让启动更快响应，并减少和实时验证的资源竞争。

## `WORKFLOW.md` Reference / `WORKFLOW.md` 参考

Start from:

从示例开始：

```bash
bun run setup:local
```

### Repository Routing / 仓库路由

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
      # local_path: ./repos/demo-app
```

Rules:

规则：

- The key must match the Linear `project_slug`.
  key 必须匹配 Linear `project_slug`。
- `github_owner` and `github_repo` are required.
  `github_owner` 和 `github_repo` 必填。
- `local_path` is optional. When omitted, execution and supervisor analysis use the shared source cache cloned from GitHub.
  `local_path` 可选。省略时，执行与 supervisor 分析使用从 GitHub clone 的共享 source cache。
- Missing routes fail closed before workspace creation.
  缺失路由会在创建 workspace 前 fail closed。

### Agent Command / Agent 命令

```yaml
codex:
  command: node ./scripts/claude-adapter.cjs
```

Change this only when you intentionally replace the Claude Code-compatible runner.

只有明确要替换 Claude Code 兼容 runner 时才修改这里。

### Verification Scenarios / 验证场景

```yaml
verification:
  lifecycle:
    projects:
      sample-project:
        title: "Live lifecycle smoke test"
        description: "Make a tiny repository-safe change..."
```

The live verifier uses these templates to create controlled issues.

实时验证器会用这些模板创建受控 issue。

## Target Repo Contracts / 目标仓库契约

Target repositories can add:

目标仓库可以添加：

```text
.symphony-repo.yaml
.symphony-constitution.md
```

`.symphony-repo.yaml` defines setup, dev, test, build, review checks, artifacts, and evidence rules.

`.symphony-repo.yaml` 定义 setup、dev、test、build、review 检查、产物和证据规则。

`.symphony-constitution.md` defines architecture preferences, forbidden directions, stable boundaries, and cleanup triggers.

`.symphony-constitution.md` 定义架构偏好、禁止方向、稳定边界和清理触发条件。

If a repo has no formal harness, symphonyness uses shadow harness inference. Shadow/missing harness status appears in runtime diagnostics but should not dominate Telegram user-facing messages.

如果目标仓库没有 formal harness，symphonyness 会使用 shadow harness inference。shadow/missing harness 状态会显示在 runtime diagnostics 中，但不应主导 Telegram 用户消息。

## Diagnostics Checklist / 诊断清单

Health:

健康检查：

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/overview
curl http://localhost:3000/api/v1/bots/manifest
```

Repair:

修复：

```bash
bun src/cli/index.ts repair all
bun run stop
```

Normal local loop:

本地常用循环：

```bash
bun run setup:local
bun run start:local
PORT=4000 bun run start:local
bun run stop
```

Telegram-first live verification:

Telegram-first 实时验证：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```
