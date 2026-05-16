# SymHarix 快速开始

**语言：** [English](./QUICKSTART.md) | 中文

这份指南会把一个全新 checkout 配到可运行的 Runtime Deck 和 Telegram-first Supervisor 流程。

## 0. 最短路径

```bash
bun run setup:local
# 编辑 .env 和 WORKFLOW.md
bun run start:local
```

`setup:local` 会安装依赖，并且只在 `.env` / `WORKFLOW.md` 不存在时创建它们。

`start:local` 会重新执行安全初始化检查，在可能时停止同端口旧实例，准备 Telegram 代理配置，在需要时创建临时 `cloudflared` 隧道，启动服务，并且只在当前进程中使用临时隧道地址，不写回 `.env`。

如果已有的 `trycloudflare.com` 地址过期，startup watchdog 会在公网 URL 或 Telegram webhook 退化时尝试换新隧道。

## 1. 安装工具

必需：

- Bun。
- Git，以及目标 GitHub 仓库权限。
- Linear API key。
- 用于内置 Claude Code 兼容 runtime 的 Anthropic API key。

可选：

- `cloudflared`：没有自己的公网 HTTPS 地址，但需要 Telegram webhook 进入本机时使用。
- `sqlite3`：需要直接检查本地诊断数据时使用。

初始化：

```bash
bun run setup:local
```

## 2. 配置仓库路由

SymHarix 通过 `WORKFLOW.md` 把 Linear 项目路由到 GitHub 仓库。

示例：

```text
Linear project slug: sample-project
GitHub repo: acme/web-app

Linear project slug: sample-api
GitHub repo: acme/api-service
```

`WORKFLOW.md`：

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: web-app
      # 可选:
      # local_path: ./repos/web-app
    sample-api:
      github_owner: acme
      github_repo: api-service
```

规则：

- 路由 key 必须匹配 Linear `project_slug`。
- `github_owner` 和 `github_repo` 必填。
- `local_path` 可选。相对路径从当前 SymHarix 仓库解析。
- 缺失路由会在创建 workspace 或派发 agent 前 fail closed。
- `SYMHARIX_TRACKER_PROJECT_SLUG` 选择 Telegram/Runtime 创建新任务时使用的默认 route。

多仓库 workspace 可以继续添加更多 route。Telegram 可以列出已配置仓库、切换当前 chat 的默认项目，并针对指定 route 回答仓库读取问题。

## 3. 填写 `.env`

本地执行最小配置：

```dotenv
SYMHARIX_TRACKER_KIND=linear
SYMHARIX_TRACKER_API_KEY=...
SYMHARIX_TRACKER_PROJECT_SLUG=sample-project
GITHUB_TOKEN=...
ANTHROPIC_API_KEY=...
```

这些值为什么需要：

| 配置 | 怎么选 | 为什么存在 |
| --- | --- | --- |
| `SYMHARIX_TRACKER_KIND` | 使用 `linear`。 | 选择 tracker backend。SymHarix 当前随项目提供的是 Linear tracker。 |
| `SYMHARIX_TRACKER_API_KEY` | 创建一个能访问目标 workspace/project 的 Linear API key。 | 让控制平面读取和更新 work item、状态与项目元数据。 |
| `SYMHARIX_TRACKER_PROJECT_SLUG` | 使用 Telegram/Runtime 创建任务时默认进入的 Linear project slug。 | 给新 issue 提供默认项目，并且必须匹配 `WORKFLOW.md -> repositories.routing`。 |
| `GITHUB_TOKEN` | 使用能访问 `WORKFLOW.md` 中所有目标仓库的 GitHub token。 | 让 SymHarix 读取仓库信息、准备 workspace，并对正确仓库执行交付。 |
| `ANTHROPIC_API_KEY` | 使用内置 Claude Code 兼容 runtime 所需的 API key。 | 驱动 agent 执行和只读仓库理解，除非你显式替换 runtime command。 |

推荐 runtime 默认值：

```dotenv
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1
```

新的环境变量使用 `SYMHARIX_*`。旧的 `SYMPHONY_*` 名称、`.symphony-*` 仓库契约和本地 `symphony.db` 文件仍作为兼容层保留。

## 4. 配置 Telegram

Telegram 最小配置：

```dotenv
SYMHARIX_TELEGRAM_BOT_TOKEN=...
SYMHARIX_TELEGRAM_WEBHOOK_SECRET=...
SYMHARIX_TELEGRAM_OPERATOR_IDS=<your-telegram-user-id>
```

这些值为什么需要：

| 配置 | 怎么选 | 为什么存在 |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_BOT_TOKEN` | 通过 BotFather 创建 bot，并填入 token。留空则禁用 Telegram。 | 启用 Telegram transport 和 webhook bootstrap。 |
| `SYMHARIX_TELEGRAM_WEBHOOK_SECRET` | 使用随机 secret 字符串。 | 让 SymHarix 拒绝不带 Telegram secret header 的 webhook 请求。 |
| `SYMHARIX_TELEGRAM_OPERATOR_IDS` | 填你的 Telegram user id，或逗号分隔的 allowlist。 | 把可写 Telegram 动作限制给可信 operator。 |
| `SYMHARIX_PUBLIC_BASE_URL` | 生产环境使用稳定 HTTPS 域名或 named tunnel URL。本地临时 tunnel 模式可留空。 | 给 Telegram webhook 一个可访问目标，也给 Mini App 按钮一个可打开的 HTTPS URL。 |
| `SYMHARIX_TELEGRAM_BOOTSTRAP` | 留空表示启动时自动注册 webhook；只有自己注册 webhook 时才设为 `off`。 | 控制启动时是否调用 Telegram `setWebhook`。 |

Webhook 选择：

- 如果有自己的公网 HTTPS 地址，设置 `SYMHARIX_PUBLIC_BASE_URL=https://...`。
- 如果没有，留空并安装 `cloudflared`；`start:local` 会尝试临时隧道。
- 如果你自己管理 Telegram webhook 注册，设置 `SYMHARIX_TELEGRAM_BOOTSTRAP=off`。

SymHarix 不要求公网 IP，但 Telegram webhook 和 Mini App 功能需要一个稳定、可公网访问的 HTTPS URL。生产环境建议使用域名 + HTTPS 反向代理，或 named Cloudflare Tunnel。快速的 `trycloudflare.com` 隧道适合本地开发和 demo，不适合作为 24/7 生产入口。

常用本地参数：

```dotenv
SYMHARIX_PROXY_MODE=auto
SYMHARIX_TELEGRAM_TUNNEL_PROTOCOL=http2
SYMHARIX_TELEGRAM_WEBHOOK_RETRY_ATTEMPTS=6
SYMHARIX_TELEGRAM_STARTUP_SUMMARY_ATTEMPTS=60
```

## 5. 配置 LLM

为了获得更好的 Telegram 自然语言体验：

```dotenv
SYMHARIX_BOT_LLM_PROVIDER=anthropic
SYMHARIX_BOT_LLM_MODEL=claude-3-5-sonnet-latest
SYMHARIX_BOT_LLM_API_KEY=...
SYMHARIX_BOT_LLM_HTTP_TRANSPORT=fetch
```

Supervisor 计划默认复用 Bot LLM。只有需要单独模型时才覆盖：

```dotenv
SYMHARIX_SUPERVISOR_LLM_PROVIDER=
SYMHARIX_SUPERVISOR_LLM_MODEL=
SYMHARIX_SUPERVISOR_LLM_API_KEY=
SYMHARIX_SUPERVISOR_LLM_TIMEOUT_MS=45000
```

只读仓库理解默认使用内置 adapter：

```dotenv
SYMHARIX_SUPERVISOR_TOOL_ROUTER_TIMEOUT_MS=12000
SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND=
SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND=
```

命令留空时使用 `node scripts/claude-adapter.cjs`。tool-router timeout 上限为 `60000` ms。

## 6. 启动

```bash
bun run start:local
```

打开：

```text
http://localhost:3000/runtime
```

只在需要时更换本地端口：

```bash
PORT=4000 bun run start:local
PORT=4000 bun run health
```

如果设置了 `SYMHARIX_RUNTIME_WRITE_TOKEN`，使用 Runtime Deck 写操作前需要在 token 输入框填写同一个 token。

健康检查：

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/manifest
curl http://localhost:3000/api/v1/bots/manifest
```

只有当 `/api/v1/bots/manifest` 显示 Telegram transport healthy，并且 `webhook_url` 非空且指向当前 public base URL 时，Telegram 才真正接到本地服务。

## 7. 使用 Telegram

给 Bot 发普通请求：

```text
帮我看一下这个仓库还有哪些文档和代码不一致
```

预期行为：

1. Telegram 收到轻量确认。
2. Supervisor 为这个 chat 创建或恢复一个 active session。
3. Supervisor 直接回答、追问细节，或展示 Plan Card。
4. 高风险或范围较大的任务会等待批准。
5. 批准后，SymHarix 创建任务，并通过 Orchestrator 执行。
6. 正常生命周期更新会编辑已有卡片，而不是重复发送新消息。

常用文本操作：

- `现在是什么单子？`
- `有哪些仓库？`
- `切到 test2 仓库`
- `test2 仓库主要做什么？`
- `批准并开始`
- `改一下计划：...`
- `取消当前线程`
- `新开线程：...`
- `重新把这个单子启动下`

## 8. 验证

先启动服务，再运行 Telegram attach-mode 验证：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

矩阵会覆盖 simple、governed split 和 destructive-cleanup 审批流程。

只有明确要绕过 Telegram 验证 runtime/orchestrator 路径时，才使用：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-lifecycle --project-slug sample-project
```

## 9. 停止与修复

```bash
bun run stop
```

修复持久化的 Bot/GitHub 状态：

```bash
bun src/cli/index.ts repair all
```

启动修复默认值：

```dotenv
SYMHARIX_BOT_FOLLOWUP_REPAIR_DELAY_MS=5000
SYMHARIX_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS=86400000
SYMHARIX_STARTUP_CLEANUP_DELAY_MS=900000
SYMHARIX_FIRST_TICK_DELAY_MS=10000
```

## 10. 排障

Telegram 消息没有进入本地服务：

- 检查 `bun run health`。
- 查看 `/api/v1/bots/manifest`。
- 确认 `webhook_url` 指向当前隧道或公网 URL。
- 如果 Telegram 有回复但本地 manifest 没有 webhook，可能是另一个部署正在使用同一个 bot token。

Bot 提示模型不可用：

- 检查 `SYMHARIX_BOT_LLM_*` 和 `SYMHARIX_SUPERVISOR_*`。
- 除非在调试网络传输，否则保持 `SYMHARIX_BOT_LLM_HTTP_TRANSPORT=fetch`。

Issue 已创建但 agent 没跑：

- 确认 `WORKFLOW.md -> repositories.routing` 包含 Linear project slug。
- 确认 `agent_runner.command` 是 `node ./scripts/claude-adapter.cjs`。
- 确认 service process 能读取 `ANTHROPIC_API_KEY`。
- 在 Runtime issue detail 中检查 `delivery_code`、`delivery_summary` 和 supervisor directive。

Review 通过但交付阻塞：

- 在 Runtime issue detail 中检查 `delivery_code=merge_blocked`。
- 从 Runtime Deck 或 Mini App 打开 active PR，并在 PR 里处理 merge blocker。
- blocker 修复后，重试该 issue，或由操作者决定关闭/替换。

Telegram 消息过多：

- 确认该 issue 只有一个 active Supervisor root session。
- 运行 `bun src/cli/index.ts repair all`。
- 查看 SQLite 中的 `bot_transport_events`、`bot_followup_delivery_states` 和 `bot_followup_message_states`。

## 11. 开发检查

```bash
bun run test
bun run build
git diff --check
```
