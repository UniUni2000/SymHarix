# SymHarix Configuration Guide / 配置指南

This guide is the reference for `.env`, `WORKFLOW.md`, and target-repo contracts.

这份文档是 `.env`、`WORKFLOW.md` 和目标仓库契约的配置参考。

## Configuration Layers / 配置层

SymHarix reads three layers:

SymHarix 读取三层配置：

1. `.env`: secrets, tokens, Telegram, Runtime, and LLM settings.
   `.env`：密钥、token、Telegram、Runtime 和 LLM 配置。
2. `WORKFLOW.md`: tracker states, repository routing, agent command, verification scenarios.
   `WORKFLOW.md`：tracker 状态、仓库路由、agent 命令、验证场景。
3. Target repo contracts: `.symphony-repo.yaml` and `.symphony-constitution.md`.
   目标仓库契约：`.symphony-repo.yaml` 与 `.symphony-constitution.md`。

Use `SYMHARIX_*` for new environment variables. Legacy `SYMPHONY_*` names, `.symphony-*` repository contracts, and the local `symphony.db` file remain supported for compatibility.

新环境变量请使用 `SYMHARIX_*`。旧的 `SYMPHONY_*` 名称、`.symphony-*` 仓库契约和本地 `symphony.db` 文件仍会为了兼容继续支持。

## Local Commands / 本地命令

```bash
bun run setup:local
bun run start:local
bun run stop
bun run health
```

`start:local` is the preferred local entrypoint. It keeps existing files, prepares Telegram proxy/tunnel behavior, starts the service, and prints a Telegram startup summary when possible.

`start:local` 是推荐的本地启动入口。它会保留已有文件，准备 Telegram 代理/隧道，启动服务，并在可能时打印 Telegram 启动摘要。

Use another port with `PORT=4000 bun run start:local`. The underlying wrapper also accepts `--port` when run directly.

可以用 `PORT=4000 bun run start:local` 更换端口。底层 wrapper 直接运行时也接受 `--port`。

## `.env` Reference / `.env` 参考

### Tracker / Tracker

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `SYMHARIX_TRACKER_KIND` | yes | Currently `linear` only / 当前仅支持 `linear` |
| `SYMHARIX_TRACKER_API_KEY` | yes | Linear API key / Linear API key |
| `SYMHARIX_TRACKER_PROJECT_SLUG` | recommended | Default project slug for Telegram/Runtime issue creation / Telegram/Runtime 创建 issue 的默认 project slug |
| `LINEAR_API_KEY` | legacy | Python hook compatibility; prefer `SYMHARIX_TRACKER_API_KEY` / Python hook 兼容；优先用 `SYMHARIX_TRACKER_API_KEY` |

### GitHub / GitHub

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Token with access to target repos in `WORKFLOW.md` / 可访问 `WORKFLOW.md` 中目标仓库的 token |
| `GITHUB_OWNER` | optional | Older fallback path only / 旧 fallback 路径使用 |
| `GITHUB_REPO` | optional | Older fallback path only / 旧 fallback 路径使用 |

Prefer `WORKFLOW.md -> repositories.routing` for real routing.

真实路由应优先使用 `WORKFLOW.md -> repositories.routing`。

### Claude Code-Compatible Runtime / Claude Code 兼容 Runtime

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Used by the bundled runtime / 内置 runtime 使用 |
| `ANTHROPIC_MODEL` | optional | Older fallback path / 旧 fallback 路径 |
| `ANTHROPIC_BASE_URL` | optional | Older fallback path / 旧 fallback 路径 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | recommended | Keeps local runtime quieter / 让本地 runtime 更安静 |
| `CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH` | recommended | Avoids broad startup prefetch / 避免启动时做大范围预取 |
| `SYMHARIX_ADAPTER_DEBUG` | debugging | Agent I/O diagnostics / agent I/O 诊断 |

The adapter supplies runtime defaults such as simple mode, disabled background tasks, disabled auto memory, and read-only mode for read-only Supervisor sessions.

adapter 会为 runtime 注入默认值，例如 simple 模式、关闭后台任务、关闭自动记忆，以及在只读 Supervisor 会话中开启 read-only。

### Runtime Deck / Runtime Deck

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `PORT` | optional | One-off local HTTP port override / 临时覆盖本地 HTTP 端口 |
| `SYMHARIX_RUNTIME_WRITE_TOKEN` | optional | Protects Runtime Deck/API write actions / 保护 Runtime Deck/API 写操作 |

Blank is convenient for local development. Set it before exposing `/runtime` publicly.

本地开发可以留空。公开暴露 `/runtime` 前应设置。

Runtime issue detail restores token usage from persisted agent runs, so completed issues can still show usage after the live orchestrator snapshot is gone. Mini App history also tries workspace diffs, merge commits, and active PR heads before falling back to compact history text.

Runtime issue detail 会从持久化 agent runs 恢复 token 使用量，所以 live orchestrator snapshot 消失后，已完成 issue 仍能显示 usage。Mini App history 也会优先尝试 workspace diff、merge commit 和 active PR head，然后再 fallback 到压缩历史文本。

### Telegram / Telegram

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_BOT_TOKEN` | for Telegram | BotFather token / BotFather token |
| `SYMHARIX_TELEGRAM_WEBHOOK_SECRET` | recommended | Webhook path/header secret / webhook 路径/header secret |
| `SYMHARIX_TELEGRAM_OPERATOR_IDS` | recommended | Comma-separated user ids allowed to write / 允许写操作的 user id，逗号分隔 |
| `SYMHARIX_TELEGRAM_OPERATIONS_CHAT_ID` | optional | Fixed operations chat / 固定 operations chat |
| `SYMHARIX_PUBLIC_BASE_URL` | optional | Public HTTPS base for webhook and Mini App links / webhook 和 Mini App 链接的公网 HTTPS base |
| `SYMHARIX_TELEGRAM_BOOTSTRAP` | optional | Set `off` to disable automatic webhook bootstrap / 设置为 `off` 可禁用自动 webhook bootstrap |

If `SYMHARIX_PUBLIC_BASE_URL` is empty and Telegram is enabled, `start:local` tries to create a temporary `cloudflared` tunnel before starting the app.

如果 `SYMHARIX_PUBLIC_BASE_URL` 留空且启用了 Telegram，`start:local` 会在 app 启动前尝试创建临时 `cloudflared` 隧道。

For temporary `trycloudflare.com` URLs, `start:local` also runs a watchdog that checks the public URL and Telegram manifest. If the tunnel becomes stale or unreachable, it provisions a fresh tunnel and restarts the local service process.

对于临时 `trycloudflare.com` URL，`start:local` 还会运行 watchdog 检查公网 URL 和 Telegram manifest。如果隧道过期或不可达，它会创建新隧道并重启本地 service process。

Tunnel and webhook knobs:

隧道与 webhook 参数：

| Variable | Default | Meaning / 含义 |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_TUNNEL_COMMAND` | auto | Override tunnel command / 覆盖隧道命令 |
| `SYMHARIX_TELEGRAM_TUNNEL_PROTOCOL` | `http2` | Tunnel protocol / 隧道协议 |
| `SYMHARIX_TELEGRAM_TUNNEL_RETRY_ATTEMPTS` | `3` | Tunnel attempts / 隧道尝试次数 |
| `SYMHARIX_TELEGRAM_TUNNEL_RETRY_DELAY_MS` | `1500` | Delay between tunnel attempts / 隧道重试间隔 |
| `SYMHARIX_TELEGRAM_TUNNEL_WATCHDOG_INTERVAL_MS` | `10000` | Watchdog poll interval / watchdog 检查间隔 |
| `SYMHARIX_TELEGRAM_TUNNEL_WATCHDOG_DEGRADED_POLLS` | `2` | Degraded polls before recovery / 触发恢复前的 degraded 次数 |
| `SYMHARIX_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS` | `6` | Webhook registration attempts / webhook 注册尝试次数 |
| `SYMHARIX_TELEGRAM_WEBHOOK_RETRY_DELAY_MS` | `2000` | Webhook retry delay / webhook 重试间隔 |
| `SYMHARIX_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS` | `60` | Startup summary polling attempts / 启动摘要轮询次数 |

Message and network knobs:

消息与网络参数：

| Variable | Default | Meaning / 含义 |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_TEXT_ACK_DELAY_MS` | `3000` | Delay before lightweight text ACK / 轻量文本 ACK 延迟 |
| `SYMHARIX_TELEGRAM_TEXT_COALESCE_DELAY_MS` | blank | Optional text coalescing delay / 可选文本合并延迟 |
| `SYMHARIX_PROXY_MODE` | `auto` | Auto-detect common local proxies; `off` disables Telegram proxy use / 自动检测常见本地代理；`off` 禁用 Telegram 代理 |
| `SYMHARIX_PROXY_URL` | blank | Explicit proxy URL / 显式代理 URL |
| `SYMHARIX_TELEGRAM_DISABLE_PROXY` | blank | Low-level disable flag / 底层禁用开关 |
| `SYMHARIX_TELEGRAM_CURL_TIMEOUT_SECONDS` | blank | Curl transport timeout / curl 传输超时 |

After startup, Telegram is actually ready only when:

启动后，Telegram 真实可用的判断标准：

```bash
curl http://localhost:3000/api/v1/bots/manifest
```

Check `health`, `webhook_url`, `public_base_url`, `mini_app_base_url`, pending update count, and last webhook error.

检查 `health`、`webhook_url`、`public_base_url`、`mini_app_base_url`、pending update count 和最后一次 webhook error。

### Bot LLM / Bot LLM

| Variable | Required | Meaning / 含义 |
| --- | --- | --- |
| `SYMHARIX_BOT_LLM_PROVIDER` | for richer NL | `anthropic` or `openai` / `anthropic` 或 `openai` |
| `SYMHARIX_BOT_LLM_MODEL` | for richer NL | Model name / 模型名 |
| `SYMHARIX_BOT_LLM_API_KEY` | for richer NL | Provider key / Provider key |
| `SYMHARIX_BOT_LLM_BASE_URL` | optional | Custom endpoint / 自定义 endpoint |
| `SYMHARIX_BOT_LLM_TIMEOUT_MS` | optional | Default `15000` / 默认 `15000` |
| `SYMHARIX_BOT_LLM_HTTP_TRANSPORT` | optional | `fetch`, `curl`, or `auto` / `fetch`、`curl` 或 `auto` |

Use `fetch` for normal operation. `auto` is mainly for transport debugging.

日常使用 `fetch`。`auto` 主要用于传输调试。

### Supervisor LLMs / Supervisor LLM

Planning defaults to bot LLM settings.

计划模型默认复用 Bot LLM。

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMHARIX_SUPERVISOR_LLM_PROVIDER` | Supervisor planning provider / Supervisor 计划 provider |
| `SYMHARIX_SUPERVISOR_LLM_MODEL` | Supervisor planning model / Supervisor 计划模型 |
| `SYMHARIX_SUPERVISOR_LLM_API_KEY` | Supervisor planning key / Supervisor 计划 key |
| `SYMHARIX_SUPERVISOR_LLM_BASE_URL` | Supervisor planning endpoint / Supervisor 计划 endpoint |
| `SYMHARIX_SUPERVISOR_LLM_TIMEOUT_MS` | Default `45000` / 默认 `45000` |

Top-level assistant fallback order:

顶层助手回退顺序：

```text
SYMHARIX_SUPERVISOR_AGENT_*
  -> SYMHARIX_SUPERVISOR_CC_*
  -> SYMHARIX_SUPERVISOR_LLM_*
  -> SYMHARIX_BOT_LLM_*
```

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMHARIX_SUPERVISOR_AGENT_PROVIDER` | Top-level Supervisor assistant provider / 顶层 Supervisor 助手 provider |
| `SYMHARIX_SUPERVISOR_AGENT_MODEL` | Top-level Supervisor assistant model / 顶层 Supervisor 助手模型 |
| `SYMHARIX_SUPERVISOR_AGENT_API_KEY` | Top-level Supervisor assistant key / 顶层 Supervisor 助手 key |
| `SYMHARIX_SUPERVISOR_AGENT_BASE_URL` | Top-level Supervisor assistant endpoint / 顶层 Supervisor 助手 endpoint |
| `SYMHARIX_SUPERVISOR_AGENT_TIMEOUT_MS` | Default `45000` / 默认 `45000` |
| `SYMHARIX_SUPERVISOR_CC_*` | Compatibility layer for the older CC advisor / 旧 CC advisor 兼容层 |

### Supervisor Claude Runtime And Repo Understanding / Supervisor Claude Runtime 与仓库理解

The Telegram Supervisor can use a top-level Claude Code-compatible runtime as the assistant brain. Repository access in repo-understanding paths is read-only. Business actions still go through supervisor/orchestrator tools and confirmation policy.

Telegram Supervisor 可以使用顶层 Claude Code 兼容 runtime 作为助手大脑。仓库理解路径中的仓库访问是只读的。业务动作仍然通过 supervisor/orchestrator tools 和确认策略执行。

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMHARIX_SUPERVISOR_CLAUDE_RUNTIME` | Set `off` only when intentionally disabling the Claude runtime front door / 只有明确禁用 Claude runtime 前门时才设置为 `off` |
| `SYMHARIX_SUPERVISOR_CLAUDE_COMMAND` | Runtime command, default `node scripts/claude-adapter.cjs` / Runtime 命令，默认 `node scripts/claude-adapter.cjs` |
| `SYMHARIX_SUPERVISOR_TOOL_ROUTER_TIMEOUT_MS` | Supervisor tool-router model timeout, default `12000`, max `60000` / Supervisor tool-router 模型超时，默认 `12000`，上限 `60000` |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND` | Read-only repo understanding command / 只读仓库理解命令 |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS` | Default `120000` / 默认 `120000` |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND` | Per-turn read-only repo advisor command / 每轮只读仓库顾问命令 |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_TIMEOUT_MS` | Default `120000` / 默认 `120000` |

Blank command values use `node scripts/claude-adapter.cjs`, which invokes `claude-code/bin/claude-haha`.

命令留空时使用 `node scripts/claude-adapter.cjs`，它会调用 `claude-code/bin/claude-haha`。

Internal Supervisor MCP bridge variables such as `SYMHARIX_SUPERVISOR_CONTEXT_*` and `SYMHARIX_SUPERVISOR_ORCHESTRATOR_*` are generated by the runtime. Do not set them in `.env` unless debugging the bridge directly; legacy `SYMPHONY_*` bridge names are still accepted internally.

内部 Supervisor MCP bridge 变量（如 `SYMHARIX_SUPERVISOR_CONTEXT_*` 和 `SYMHARIX_SUPERVISOR_ORCHESTRATOR_*`）由 runtime 自动生成。除非直接调试 bridge，否则不要写进 `.env`；内部仍接受 legacy `SYMPHONY_*` bridge 名称。

### Supervisor Overseer / Supervisor 执行监督

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMHARIX_SUPERVISOR_OVERSEER_PROVIDER` | Dedicated overseer provider / 专用 overseer provider |
| `SYMHARIX_SUPERVISOR_OVERSEER_MODEL` | Dedicated overseer model / 专用 overseer 模型 |
| `SYMHARIX_SUPERVISOR_OVERSEER_API_KEY` | Dedicated overseer key / 专用 overseer key |
| `SYMHARIX_SUPERVISOR_OVERSEER_BASE_URL` | Dedicated overseer endpoint / 专用 overseer endpoint |
| `SYMHARIX_SUPERVISOR_OVERSEER_TIMEOUT_MS` | Default `30000` / 默认 `30000` |

If the overseer LLM fails, deterministic supervision still classifies delivery failures, missing evidence, branch drift, and approval gates.

如果 overseer LLM 失败，确定性监督逻辑仍会分类交付失败、证据缺失、分支漂移和审批门。

### Startup Repair And Cleanup / 启动修复与清理

| Variable | Default | Meaning / 含义 |
| --- | --- | --- |
| `SYMHARIX_SUPERVISOR_JOB_INTERVAL_MS` | `30000` | Supervisor job-loop tick interval / Supervisor job-loop 间隔 |
| `SYMHARIX_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS` | `86400000` | Stale pre-materialization session threshold / 预物化 session 过期阈值 |
| `SYMHARIX_BOT_FOLLOWUP_REPAIR_DELAY_MS` | `5000` | Delay before bot follow-up repair / bot follow-up 修复延迟 |
| `SYMHARIX_STARTUP_CLEANUP_DELAY_MS` | `900000` | Delay before heavier orphan cleanup / 较重 orphan 清理延迟 |
| `SYMHARIX_FIRST_TICK_DELAY_MS` | `10000` | Delay before first orchestrator poll / 第一次 orchestrator poll 延迟 |

These delays keep startup responsive and reduce contention with live verification.

这些延迟能让启动更快响应，并减少和实时验证的资源竞争。

### Standalone Hook Compatibility / 独立 Hook 兼容

| Variable | Meaning / 含义 |
| --- | --- |
| `WORKSPACE_ROOT` | Manual `scripts/cli.py` runs only / 仅手动运行 `scripts/cli.py` 时使用 |
| `SYMHARIX_WORKSPACE_ROOT` | Manual `scripts/cli.py` runs only / 仅手动运行 `scripts/cli.py` 时使用 |
| `SYMHARIX_AUTO_MERGE_NO_REVIEWS` | Auto-merge PR even without review; default false / 无 review 时也自动 merge；默认 false |
| `SYMPHONY_EFFECTIVE_HARNESS_JSON` | Internal legacy hook protocol; isolated review-hook debugging only / 内部 legacy hook 协议；仅用于隔离调试 review hook |

### Discord / Discord

| Variable | Meaning / 含义 |
| --- | --- |
| `SYMHARIX_DISCORD_BOT_TOKEN` | Discord token; blank disables Discord / Discord token；留空禁用 Discord |
| `SYMHARIX_DISCORD_PUBLIC_KEY` | Discord public key / Discord public key |
| `SYMHARIX_DISCORD_OPERATOR_IDS` | Comma-separated operator ids / operator id，逗号分隔 |

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
- `local_path` is optional. When omitted, execution and supervisor analysis use a shared source cache cloned from GitHub.
  `local_path` 可选。省略时，执行与 supervisor 分析使用从 GitHub clone 的共享 source cache。
- Missing routes fail closed before workspace creation.
  缺失路由会在创建 workspace 前 fail closed。
- Telegram can resolve a route by project slug, full `owner/repo`, or repo name for repository switching and read-only repo questions.
  Telegram 可以用 project slug、完整 `owner/repo` 或 repo name 解析 route，用于切换仓库和只读仓库问答。

### Agent Command / Agent 命令

```yaml
codex:
  command: node ./scripts/claude-adapter.cjs
```

Change this only when intentionally replacing the Claude Code-compatible runner.

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

Live verifiers use these templates to create controlled test issues.

实时验证器会用这些模板创建受控测试 issue。

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

If a repo has no formal harness, SymHarix uses shadow harness inference. Shadow or missing harness status appears in runtime diagnostics, but should not dominate Telegram user-facing messages.

如果目标仓库没有 formal harness，SymHarix 会使用 shadow harness inference。shadow/missing harness 状态会显示在 runtime diagnostics 中，但不应主导 Telegram 用户消息。

## Diagnostics Checklist / 诊断清单

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/overview
curl http://localhost:3000/api/v1/bots/manifest
bun src/cli/index.ts repair all
```

When using a non-default port, pass the same `PORT` to health checks:

使用非默认端口时，健康检查也要带同一个 `PORT`：

```bash
PORT=4000 bun run health
curl http://localhost:4000/api/v1/bots/manifest
```

Delivery blockers:

交付阻塞：

- `delivery_code=merge_blocked` means review proof passed, but the PR merge or final delivery action failed.
  `delivery_code=merge_blocked` 表示 review 证据已通过，但 PR merge 或最终交付动作失败。
- Runtime Deck and Mini App issue previews surface the active stage, active PR, delivery summary, and blocker code.
  Runtime Deck 与 Mini App issue 预览会显示当前阶段、active PR、delivery summary 和 blocker code。

Telegram-first live verification:

Telegram-first 实时验证：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```
