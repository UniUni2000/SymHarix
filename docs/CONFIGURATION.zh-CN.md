# SymHarix 配置指南

**语言：** [English](./CONFIGURATION.md) | 中文

这份文档是启动配置、`.env`、`WORKFLOW.md` 和目标仓库契约的参考。

## 配置层

SymHarix 从三处读取配置：

1. `.env`：密钥、token、Telegram、Runtime Deck 和 LLM 配置。
2. `WORKFLOW.md`：tracker 状态名、仓库路由、agent 命令和验证场景。
3. 目标仓库契约：`.symphony-repo.yaml` 与 `.symphony-constitution.md`。

新的操作者配置请使用 `SYMHARIX_*`。旧的 `SYMPHONY_*` 名称、`.symphony-*` 仓库契约和本地 `symphony.db` 文件仍作为兼容层保留。

## 本地命令

```bash
bun run setup:local
bun run start:local
bun run stop
bun run health
```

`start:local` 是推荐的本地入口。它会保留已有文件，准备 Telegram 代理/隧道行为，启动服务，并在可能时打印 Telegram 启动摘要。

更换端口：

```bash
PORT=4000 bun run start:local
PORT=4000 bun run health
```

## 启动最小配置

理解启动配置时，可以按职责拆分：

| 模块 | 配置 | 为什么需要 |
| --- | --- | --- |
| Tracker | `SYMHARIX_TRACKER_KIND=linear`, `SYMHARIX_TRACKER_API_KEY`, `SYMHARIX_TRACKER_PROJECT_SLUG` | Linear 提供 work item 状态机，并作为 Telegram/Runtime 创建 issue 的默认项目来源。 |
| GitHub 访问 | `GITHUB_TOKEN` | token 必须能访问 `WORKFLOW.md -> repositories.routing` 中声明的所有仓库。 |
| Agent runtime | `ANTHROPIC_API_KEY` | 内置 Claude Code 兼容 runtime 默认用它执行任务和理解仓库，除非替换 runner。 |
| 仓库路由 | `WORKFLOW.md -> repositories.routing` | route key 必须匹配 Linear `project_slug`；缺失路由会在创建 workspace 前 fail closed。 |
| Telegram transport | `SYMHARIX_TELEGRAM_BOT_TOKEN`, `SYMHARIX_TELEGRAM_WEBHOOK_SECRET`, `SYMHARIX_TELEGRAM_OPERATOR_IDS` | token 启用 Telegram，secret 保护 webhook 入口，operator ids 限制可写操作。 |
| 公网入口 | `SYMHARIX_PUBLIC_BASE_URL` 或临时 tunnel 模式 | webhook 和 Mini App 生产环境需要稳定、可公网访问的 HTTPS URL。 |
| Runtime 写操作 | `SYMHARIX_RUNTIME_WRITE_TOKEN` | 本地可选；公开暴露 Runtime Deck/API 写操作前建议设置。 |

## `.env` 参考

### Tracker

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `SYMHARIX_TRACKER_KIND` | 必填 | 当前仅支持 `linear`。 |
| `SYMHARIX_TRACKER_API_KEY` | 必填 | Linear API key。 |
| `SYMHARIX_TRACKER_PROJECT_SLUG` | 推荐 | Telegram/Runtime 创建 issue 的默认 project slug。必须匹配 `WORKFLOW.md -> repositories.routing`。 |
| `LINEAR_API_KEY` | 兼容 | Python hook 兼容项；优先使用 `SYMHARIX_TRACKER_API_KEY`。 |

### GitHub

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 必填 | 需要能访问 `WORKFLOW.md` 中的目标仓库。 |
| `GITHUB_OWNER` | 可选 | 旧 fallback 路径使用。真实路由优先使用 `WORKFLOW.md -> repositories.routing`。 |
| `GITHUB_REPO` | 可选 | 旧 fallback 路径使用。真实路由优先使用 `WORKFLOW.md -> repositories.routing`。 |

### Claude Code 兼容 Runtime

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | 必填 | 内置 runtime 使用。 |
| `ANTHROPIC_MODEL` | 可选 | 旧 fallback 路径。 |
| `ANTHROPIC_BASE_URL` | 可选 | 旧 fallback 路径。 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 推荐 | 让本地 runtime 更安静。 |
| `CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH` | 推荐 | 避免启动时做大范围预取。 |
| `SYMHARIX_ADAPTER_DEBUG` | 调试 | agent I/O 诊断。 |

adapter 会为 runtime 注入默认值，例如 simple 模式、关闭后台任务、关闭自动记忆，以及在只读 Supervisor 会话中开启 read-only。

### Runtime Deck

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `PORT` | 可选 | 临时覆盖本地 HTTP 端口。 |
| `SYMHARIX_RUNTIME_WRITE_TOKEN` | 可选 | 保护 Runtime Deck/API 写操作。 |

本地开发时 `SYMHARIX_RUNTIME_WRITE_TOKEN` 可以留空。公开暴露 `/runtime` 前应设置。

Runtime issue detail 会从持久化 agent runs 恢复 token 使用量，所以 live orchestrator snapshot 消失后，已完成 issue 仍能显示 usage。Mini App history 也会优先尝试 workspace diff、merge commit 和 active PR head，然后再 fallback 到压缩历史文本。

### Telegram

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_BOT_TOKEN` | 使用 Telegram 时必填 | BotFather token。留空则禁用 Telegram。 |
| `SYMHARIX_TELEGRAM_WEBHOOK_SECRET` | 推荐 | webhook path/header secret。 |
| `SYMHARIX_TELEGRAM_OPERATOR_IDS` | 推荐 | 允许执行写操作的 user id，逗号分隔。 |
| `SYMHARIX_TELEGRAM_OPERATIONS_CHAT_ID` | 可选 | 固定 operations chat。 |
| `SYMHARIX_PUBLIC_BASE_URL` | 可选 | webhook 和 Mini App 链接使用的公网 HTTPS base。 |
| `SYMHARIX_TELEGRAM_BOOTSTRAP` | 可选 | 设置为 `off` 可禁用自动 webhook bootstrap。 |

SymHarix 不要求公网 IP，但 Telegram webhook 和 Mini App 功能需要一个稳定、可公网访问的 HTTPS URL。生产环境建议使用域名 + HTTPS 反向代理，或 named Cloudflare Tunnel。快速的 `trycloudflare.com` 隧道适合本地开发和 demo，不适合作为 24/7 生产入口。

常见部署形态：

| 部署方式 | 结果 |
| --- | --- |
| 有公网 IP、域名、TLS，并反代到 SymHarix 的服务器 | 设置 `SYMHARIX_PUBLIC_BASE_URL=https://your-domain.example`；不需要临时 Cloudflare 隧道。 |
| 没有公网 IP，但有稳定公网 tunnel 或 load balancer | 只要 HTTPS URL 能被 Telegram 和用户访问，就可以工作。 |
| 服务器只能主动访问 Telegram | 不足以支撑当前 webhook 模式；需要另做 polling/getUpdates transport。 |
| 本地开发且没有稳定公网 URL | 留空 `SYMHARIX_PUBLIC_BASE_URL`，让 `start:local` 尝试临时 `cloudflared` 隧道。 |

如果 `SYMHARIX_PUBLIC_BASE_URL` 留空且启用了 Telegram，`start:local` 会在 app 启动前尝试创建临时 `cloudflared` 隧道。对于临时 `trycloudflare.com` URL，`start:local` 还会运行 watchdog 检查公网 URL 和 Telegram manifest。如果隧道过期或不可达，它会创建新隧道并重启本地 service process。

隧道与 webhook 参数：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_TUNNEL_COMMAND` | auto | 覆盖隧道命令。 |
| `SYMHARIX_TELEGRAM_TUNNEL_PROTOCOL` | `http2` | 隧道协议。 |
| `SYMHARIX_TELEGRAM_TUNNEL_RETRY_ATTEMPTS` | `3` | 隧道尝试次数。 |
| `SYMHARIX_TELEGRAM_TUNNEL_RETRY_DELAY_MS` | `1500` | 隧道重试间隔。 |
| `SYMHARIX_TELEGRAM_TUNNEL_WATCHDOG_INTERVAL_MS` | `10000` | watchdog 检查间隔。 |
| `SYMHARIX_TELEGRAM_TUNNEL_WATCHDOG_DEGRADED_POLLS` | `2` | 触发恢复前的 degraded 次数。 |
| `SYMHARIX_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS` | `6` | webhook 注册尝试次数。 |
| `SYMHARIX_TELEGRAM_WEBHOOK_RETRY_DELAY_MS` | `2000` | webhook 重试间隔。 |
| `SYMHARIX_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS` | `60` | 启动摘要轮询次数。 |

消息与网络参数：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_TEXT_ACK_DELAY_MS` | `3000` | 轻量文本 ACK 延迟。 |
| `SYMHARIX_TELEGRAM_TEXT_COALESCE_DELAY_MS` | 留空 | 可选文本合并延迟。 |
| `SYMHARIX_PROXY_MODE` | `auto` | 自动检测常见本地代理；`off` 禁用 Telegram 代理。 |
| `SYMHARIX_PROXY_URL` | 留空 | 显式代理 URL。 |
| `SYMHARIX_TELEGRAM_DISABLE_PROXY` | 留空 | 底层禁用开关。 |
| `SYMHARIX_TELEGRAM_CURL_TIMEOUT_SECONDS` | 留空 | curl 传输超时。 |

启动后，Telegram 真实可用的判断标准：

```bash
curl http://localhost:3000/api/v1/bots/manifest
```

检查 `health`、`webhook_url`、`public_base_url`、`mini_app_base_url`、pending update count 和最后一次 webhook error。

### Bot LLM

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `SYMHARIX_BOT_LLM_PROVIDER` | 需要更强自然语言时 | `anthropic` 或 `openai`。 |
| `SYMHARIX_BOT_LLM_MODEL` | 需要更强自然语言时 | 模型名。 |
| `SYMHARIX_BOT_LLM_API_KEY` | 需要更强自然语言时 | provider key。 |
| `SYMHARIX_BOT_LLM_BASE_URL` | 可选 | 自定义 endpoint。 |
| `SYMHARIX_BOT_LLM_TIMEOUT_MS` | 可选 | 默认 `15000`。 |
| `SYMHARIX_BOT_LLM_HTTP_TRANSPORT` | 可选 | `fetch`、`curl` 或 `auto`。日常使用 `fetch`。 |

### Supervisor LLM

计划模型默认复用 Bot LLM 设置。

顶层助手回退顺序：

```text
SYMHARIX_SUPERVISOR_AGENT_*
  -> SYMHARIX_SUPERVISOR_CC_*
  -> SYMHARIX_SUPERVISOR_LLM_*
  -> SYMHARIX_BOT_LLM_*
```

| 变量 | 含义 |
| --- | --- |
| `SYMHARIX_SUPERVISOR_LLM_PROVIDER` | Supervisor planning provider。 |
| `SYMHARIX_SUPERVISOR_LLM_MODEL` | Supervisor planning model。 |
| `SYMHARIX_SUPERVISOR_LLM_API_KEY` | Supervisor planning key。 |
| `SYMHARIX_SUPERVISOR_LLM_BASE_URL` | Supervisor planning endpoint。 |
| `SYMHARIX_SUPERVISOR_LLM_TIMEOUT_MS` | 默认 `45000`。 |
| `SYMHARIX_SUPERVISOR_AGENT_PROVIDER` | 顶层 Supervisor assistant provider。 |
| `SYMHARIX_SUPERVISOR_AGENT_MODEL` | 顶层 Supervisor assistant model。 |
| `SYMHARIX_SUPERVISOR_AGENT_API_KEY` | 顶层 Supervisor assistant key。 |
| `SYMHARIX_SUPERVISOR_AGENT_BASE_URL` | 顶层 Supervisor assistant endpoint。 |
| `SYMHARIX_SUPERVISOR_AGENT_TIMEOUT_MS` | 默认 `45000`。 |
| `SYMHARIX_SUPERVISOR_CC_*` | 旧 CC advisor 兼容层。 |

### Supervisor Claude Runtime 与仓库理解

Telegram Supervisor 可以使用顶层 Claude Code 兼容 runtime 作为助手大脑。仓库理解路径中的仓库访问是只读的。业务动作仍然通过 supervisor/orchestrator tools 和确认策略执行。

| 变量 | 含义 |
| --- | --- |
| `SYMHARIX_SUPERVISOR_CLAUDE_RUNTIME` | 只有明确禁用 Claude runtime 前门时才设置为 `off`。 |
| `SYMHARIX_SUPERVISOR_CLAUDE_COMMAND` | Runtime 命令，默认 `node scripts/claude-adapter.cjs`。 |
| `SYMHARIX_SUPERVISOR_TOOL_ROUTER_TIMEOUT_MS` | Supervisor tool-router 模型超时，默认 `12000`，上限 `60000`。 |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND` | 只读仓库理解命令。 |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS` | 默认 `120000`。 |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND` | 每轮只读仓库顾问命令。 |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_TIMEOUT_MS` | 默认 `120000`。 |

命令留空时使用 `node scripts/claude-adapter.cjs`，它会调用 `claude-code/bin/claude-haha`。

内部 Supervisor MCP bridge 变量（如 `SYMHARIX_SUPERVISOR_CONTEXT_*` 和 `SYMHARIX_SUPERVISOR_ORCHESTRATOR_*`）由 runtime 自动生成。除非直接调试 bridge，否则不要写进 `.env`；内部仍接受 legacy `SYMPHONY_*` bridge 名称。

### Supervisor 执行监督

| 变量 | 含义 |
| --- | --- |
| `SYMHARIX_SUPERVISOR_OVERSEER_PROVIDER` | 专用 overseer provider。 |
| `SYMHARIX_SUPERVISOR_OVERSEER_MODEL` | 专用 overseer model。 |
| `SYMHARIX_SUPERVISOR_OVERSEER_API_KEY` | 专用 overseer key。 |
| `SYMHARIX_SUPERVISOR_OVERSEER_BASE_URL` | 专用 overseer endpoint。 |
| `SYMHARIX_SUPERVISOR_OVERSEER_TIMEOUT_MS` | 默认 `30000`。 |

如果 overseer LLM 失败，确定性监督逻辑仍会分类交付失败、证据缺失、分支漂移和审批门。

### 启动修复与清理

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SYMHARIX_SUPERVISOR_JOB_INTERVAL_MS` | `30000` | Supervisor job-loop 间隔。 |
| `SYMHARIX_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS` | `86400000` | 预物化 session 过期阈值。 |
| `SYMHARIX_BOT_FOLLOWUP_REPAIR_DELAY_MS` | `5000` | bot follow-up 修复延迟。 |
| `SYMHARIX_STARTUP_CLEANUP_DELAY_MS` | `900000` | 较重 orphan 清理延迟。 |
| `SYMHARIX_FIRST_TICK_DELAY_MS` | `10000` | 第一次 orchestrator poll 延迟。 |

这些延迟能让启动更快响应，并减少和实时验证的资源竞争。

### 独立 Hook 兼容

| 变量 | 含义 |
| --- | --- |
| `WORKSPACE_ROOT` | 仅手动运行 `scripts/cli.py` 时使用。 |
| `SYMHARIX_WORKSPACE_ROOT` | 仅手动运行 `scripts/cli.py` 时使用。 |
| `SYMHARIX_AUTO_MERGE_NO_REVIEWS` | 无 review 时也自动 merge；默认 false。 |
| `SYMPHONY_EFFECTIVE_HARNESS_JSON` | 内部 legacy hook 协议；仅用于隔离调试 review hook。 |

### Discord

| 变量 | 含义 |
| --- | --- |
| `SYMHARIX_DISCORD_BOT_TOKEN` | Discord token；留空禁用 Discord。 |
| `SYMHARIX_DISCORD_PUBLIC_KEY` | Discord public key。 |
| `SYMHARIX_DISCORD_OPERATOR_IDS` | operator id，逗号分隔。 |

## `WORKFLOW.md` 参考

从示例开始：

```bash
bun run setup:local
```

### 仓库路由

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: web-app
      # local_path: ./repos/web-app
    sample-api:
      github_owner: acme
      github_repo: api-service
    sample-docs:
      github_owner: acme
      github_repo: docs-site
```

规则：

- key 必须匹配 Linear `project_slug`。
- `github_owner` 和 `github_repo` 必填。
- `local_path` 可选。省略时，执行与 supervisor 分析使用从 GitHub clone 的共享 source cache。
- 缺失路由会在创建 workspace 前 fail closed。
- Telegram 可以用 project slug、完整 `owner/repo` 或 repo name 解析 route，用于切换仓库和只读仓库问答。
- `SYMHARIX_TRACKER_PROJECT_SLUG` 选择 Telegram/Runtime 创建新任务时使用的默认 route。

### Agent 命令

```yaml
agent_runner:
  command: node ./scripts/claude-adapter.cjs
```

只有明确要替换 Claude Code 兼容 runner 时才修改这里。旧 workflow 可能仍使用 `codex.command`；它会作为 legacy alias 继续被接受。

### 验证场景

```yaml
verification:
  lifecycle:
    projects:
      sample-project:
        title: "Live lifecycle smoke test"
        description: "Make a tiny repository-safe change..."
```

实时验证器会用这些模板创建受控测试 issue。

## 目标仓库契约

目标仓库可以添加：

```text
.symphony-repo.yaml
.symphony-constitution.md
```

`.symphony-repo.yaml` 定义 setup、dev、test、build、review 检查、产物和证据规则。

`.symphony-constitution.md` 定义架构偏好、禁止方向、稳定边界和清理触发条件。

如果目标仓库没有 formal harness，SymHarix 会使用 shadow harness inference。shadow/missing harness 状态会显示在 runtime diagnostics 中，但不应主导 Telegram 用户消息。

## 诊断清单

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/overview
curl http://localhost:3000/api/v1/bots/manifest
bun src/cli/index.ts repair all
```

使用非默认端口时，健康检查也要带同一个 `PORT`：

```bash
PORT=4000 bun run health
curl http://localhost:4000/api/v1/bots/manifest
```

交付阻塞：

- `delivery_code=merge_blocked` 表示 review 证据已通过，但 PR merge 或最终交付动作失败。
- Runtime Deck 与 Mini App issue 预览会显示当前阶段、active PR、delivery summary 和 blocker code。

Telegram-first 实时验证：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```
