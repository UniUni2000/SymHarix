# SymHarix 配置指南

**语言：** [English](./CONFIGURATION.md) | 中文

这份文档是启动配置、`.env`、`WORKFLOW.md` 和目标仓库契约的参考。

## 配置层

SymHarix 从三处读取配置：

1. `.env`：密钥、token、Telegram、Runtime Deck 和 LLM 配置。
2. `WORKFLOW.md`：tracker 状态名、仓库路由、agent 命令和验证场景。
3. 目标仓库契约：`.symphony-repo.yaml` 与 `.symphony-constitution.md`。

新的操作者配置请使用 `SYMHARIX_*`。新安装默认使用 `symharix.db`；检测到已有 `symphony.db` 时会自动原地沿用。旧的 `SYMPHONY_*` 名称和 `.symphony-*` 仓库契约仍作为迁移兼容层保留。

## 本地命令

```bash
bun run setup
bun run configure:guide
bun run configure:secure
bun run configure
bun run configure:check
bun run configure:doctor
bun run runtime:smoke
bun run start
bun run stop
bun run health
bash scripts/install-systemd-service.sh
```

完整的密钥获取、格式预检、最小权限和验证流程见[终端配置与验证手册](./TERMINAL_SETUP.zh-CN.md)。`configure:doctor` 只调用只读/鉴权端点，不创建 issue、PR、消息或模型请求；`runtime:smoke` 才会产生一次极少量模型费用。

`start` 是默认 Telegram 本地入口。需要明确使用 Telegram 时可运行 `bun run start:telegram`；只运行飞书时运行 `bun run start:feishu`。每个启动命令都会在子进程环境里隔离另一个聊天入口，所以飞书不需要 Telegram 变量，Telegram 也不需要飞书变量。

更换端口：

```bash
PORT=4000 bun run start
PORT=4000 bun run health
```

在 Linux 服务器上，`bash scripts/install-systemd-service.sh` 会安装并启动 systemd service。需要进程在 SSH 断开和机器重启后继续运行时，使用这个方式。

Service 控制命令：

```bash
sudo systemctl status ${SYMHARIX_SERVICE_NAME:-symharix} --no-pager
sudo journalctl -u ${SYMHARIX_SERVICE_NAME:-symharix} -f
sudo systemctl restart ${SYMHARIX_SERVICE_NAME:-symharix}
sudo systemctl stop ${SYMHARIX_SERVICE_NAME:-symharix}
```

安装时可覆盖：

| 变量 | 含义 |
| --- | --- |
| `SYMHARIX_SERVICE_NAME` | systemd unit 名，默认 `symharix`。 |
| `SYMHARIX_SERVICE_USER` | 运行 service 的 Linux 用户，默认当前用户。 |
| `SYMHARIX_SERVICE_PORT` | 写入 unit 的 HTTP 端口，默认 `3000`。 |
| `SYMHARIX_BUN_BIN` | 显式 Bun 二进制路径。 |

## 启动最小配置

理解启动配置时，可以按职责拆分：

| 模块 | 配置 | 为什么需要 |
| --- | --- | --- |
| Tracker | `SYMHARIX_TRACKER_KIND=linear`, `SYMHARIX_TRACKER_API_KEY`, `SYMHARIX_TRACKER_PROJECT_SLUG` | Linear 提供 work item 状态机，并作为 Telegram/飞书/Runtime 创建 issue 的默认项目来源。 |
| GitHub 访问 | `GITHUB_TOKEN` | token 必须能访问 `WORKFLOW.md -> repositories.routing` 中声明的所有仓库。 |
| Agent runtime | `SYMHARIX_OPENCODE_MODEL` 加 provider key 或 `opencode auth` | OpenCode 使用 `provider/model` ID 执行任务和理解仓库。 |
| 仓库路由 | `WORKFLOW.md -> repositories.routing` | route key 必须匹配 Linear `project_slug`；缺失路由会在创建 workspace 前 fail closed。 |
| Telegram transport | `SYMHARIX_TELEGRAM_BOT_TOKEN`, `SYMHARIX_TELEGRAM_WEBHOOK_SECRET`, `SYMHARIX_TELEGRAM_OPERATOR_IDS` | 仅 `start:telegram` 需要。token 启用 Telegram，secret 保护 webhook 入口，operator ids 限制可写操作。 |
| Feishu transport | `SYMHARIX_FEISHU_APP_ID`, `SYMHARIX_FEISHU_APP_SECRET`, `SYMHARIX_FEISHU_OPERATOR_IDS` | 仅 `start:feishu` 需要。app id/secret 启用飞书长连接，operator ids 限制可写操作。 |
| 公网入口 | `SYMHARIX_PUBLIC_BASE_URL` 或临时 tunnel 模式 | webhook 和 Mini App 生产环境需要稳定、可公网访问的 HTTPS URL。 |
| Runtime 访问 | `SYMHARIX_RUNTIME_VIEWER_TOKEN`, `SYMHARIX_RUNTIME_WRITE_TOKEN`, `SYMHARIX_RUNTIME_SESSION_SECRET` | viewer 只读，operator 可写；配置向导自动生成，并由服务端签发短期 HttpOnly 会话。 |

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

### OpenCode Runtime

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `SYMHARIX_OPENCODE_MODEL` | 必填 | 所有角色默认使用的 `provider/model`。 |
| `SYMHARIX_OPENCODE_PLAN_MODEL` | 可选 | Plan 角色模型覆盖。 |
| `SYMHARIX_OPENCODE_DEV_MODEL` | 可选 | Dev 角色模型覆盖。 |
| `SYMHARIX_OPENCODE_REVIEW_MODEL` | 可选 | Review 角色模型覆盖。 |
| `SYMHARIX_OPENCODE_USE_AUTH` | 可选 | 设置 `1` 复用 `opencode auth login` 凭据。 |
| `SYMHARIX_ADAPTER_DEBUG` | 调试 | agent I/O 诊断。 |

adapter 会注入按角色隔离的权限，并关闭 runtime 自动升级与外部插件，保证可复现。

公开发布或部署全新 checkout 前，应验证锁定的 runtime：

```bash
bash scripts/check-runtime.sh
```

### Runtime Deck

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `PORT` | 可选 | 临时覆盖本地 HTTP 端口。 |
| `SYMHARIX_RUNTIME_VIEWER_TOKEN` | 推荐 | 只读访问 Runtime API、SSE、详细健康信息、Deck 和 Mini App；配置向导自动生成。 |
| `SYMHARIX_RUNTIME_WRITE_TOKEN` | 写操作必填 | operator 凭据；包含读取权限，并允许创建、停止、重试及审批操作。配置向导自动生成。 |
| `SYMHARIX_RUNTIME_SESSION_SECRET` | 必填 | 签发浏览器短期会话 Cookie；配置向导自动生成，不应与 token 相同。 |
| `SYMHARIX_RUNTIME_SESSION_TTL_MINUTES` | 可选 | 浏览器会话有效期，默认 `15` 分钟。 |
| `SYMHARIX_MAX_TURN_OUTPUT_TOKENS` | 可选 | 下沉到 OpenCode/provider 的单次模型输出上限，默认 `16000`。 |
| `SYMHARIX_MAX_TURN_STEPS` | 可选 | OpenCode 单轮最多 agentic iterations，默认 `12`。 |
| `SYMHARIX_TURN_RESERVE_TOKENS` | 可选 | 单轮所有工具步骤的累计 token 硬上限，同时也是每次模型调用前的原子预占额度；默认 `200000`，包含 cache read。触顶后任务暂停且不自动重试。 |
| `SYMHARIX_MAX_TASK_TOKENS` | 可选 | 单任务 token 硬上限，默认 `500000`。 |
| `SYMHARIX_MAX_REPO_DAILY_TOKENS` | 可选 | 单仓库 UTC 每日 token 硬上限，默认 `2000000`。 |
| `SYMHARIX_MAX_DAILY_TOKENS` | 可选 | 所有仓库 UTC 每日 token 硬上限，默认 `5000000`。 |
| `SYMHARIX_MAX_TASK_USD` | 可选 | 单任务美元硬上限，默认 `$25`；配置价格后生效。 |
| `SYMHARIX_MAX_REPO_DAILY_USD` | 可选 | 单仓库 UTC 每日美元硬上限，默认 `$100`；配置价格后生效。 |
| `SYMHARIX_MAX_DAILY_USD` | 可选 | 所有仓库 UTC 每日美元硬上限，默认 `$250`；配置价格后生效。 |
| `SYMHARIX_COST_OVERRIDE_MINUTES` | 可选 | operator 超额审批有效期，默认 `60` 分钟。 |
| `SYMHARIX_COST_INPUT_USD_PER_MILLION` | 可选 | 每百万 input token 的保守计价上限。多模型时填写最高单价。 |
| `SYMHARIX_COST_OUTPUT_USD_PER_MILLION` | 可选 | 每百万 output token 的保守计价上限。多模型时填写最高单价。 |
| `SYMHARIX_COST_CACHE_READ_USD_PER_MILLION` | 可选 | cache-read input 价格；未设置时按 input 价格估算。 |

Runtime 的 API、SSE、详细 health/readiness、Deck、Mini App、work-items 与 Bot manifest 默认全部要求读取身份。浏览器只在登录时提交一次 viewer/operator token，服务端将其换成短期 `HttpOnly + SameSite=Lax` Cookie；token 不写入 `localStorage`。使用 Cookie 的写操作还必须携带同源请求与 CSRF 标记。`/api/v1/health/live` 保持公开，供进程或容器存活探针使用。没有任何 viewer/operator token 时服务 fail closed，并拒绝监听到非 loopback 地址。

不需要打开 `.env` 或让 token 出现在终端历史中。源码仓库运行 `bun run runtime:access -- copy viewer`，安装包运行 `symharix access copy viewer`，即可将只读 token 直接写入系统剪贴板；需要执行停止、重试和审批时，将 `viewer` 改为 `operator`。命令只输出复制结果，不回显 token。

脚本或外部监控可直接使用请求头，无需 Cookie：

```bash
curl -H "Authorization: Bearer $SYMHARIX_RUNTIME_VIEWER_TOKEN" \
  http://127.0.0.1:3000/api/v1/runtime/overview
```
未配置 input/output 价格时，token 硬上限仍然生效，但美元预算显示“not configured”且不参与拦截，不会用虚构单价估算。每次与任务关联的编码或 Supervisor 模型调用会先在 SQLite 中原子预占额度，避免并发任务共同冲破日预算；超额任务进入 `cost_budget_exceeded`，可由 Runtime operator 在 Runtime Deck、Telegram/飞书 issue 卡片或 `/budget ISSUE-ID` 中限时放行。单轮累计上限触发时使用 `turn_token_ceiling_reached` 暂停，不会自动重复同一轮；先运行 `bun run configure -- budget` 调整后，再显式 retry。独立的聊天分类请求不归入仓库预算，因此 provider 账户自身的消费封顶仍应作为最后一道独立保护。

Runtime issue detail 会从持久化 agent runs 恢复 token 使用量，所以 live orchestrator snapshot 消失后，已完成 issue 仍能显示 usage。Mini App history 也会优先尝试 workspace diff、merge commit 和 active PR head，然后再 fallback 到压缩历史文本。

### 聊天入口选择

Telegram 和飞书都是同一套 Supervisor runtime 之上的可选产品入口。至少配置其中一个：

| 目标 | 需要配置的聊天变量 | 启动命令 |
| --- | --- | --- |
| 只用 Telegram | 配置 Telegram 变量；飞书留空 | `bun run start:telegram` 或 `bun run start` |
| 只用飞书 | 配置飞书变量；Telegram 留空 | `bun run start:feishu` |
| 两组变量都写在 `.env` | 两组都配置 | 用具体的 surface 启动命令选择本次进程入口 |

`start:feishu` 只会在启动出来的子进程环境里清空 Telegram token、webhook、operator、operations chat 和 bootstrap 配置，不会改写 `.env`。主动 follow-up 也会按来源隔离：飞书来源 issue 只通知飞书收件人，Telegram 来源 issue 只通知 Telegram 收件人。

### Telegram

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `SYMHARIX_TELEGRAM_BOT_TOKEN` | 使用 Telegram 时必填 | BotFather token。留空则禁用 Telegram。 |
| `SYMHARIX_TELEGRAM_WEBHOOK_SECRET` | 推荐 | webhook path/header secret。 |
| `SYMHARIX_TELEGRAM_OPERATOR_IDS` | 写操作必填 | 允许执行写操作的 user id，逗号分隔；留空时只读。 |
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
| 本地开发且没有稳定公网 URL | 留空 `SYMHARIX_PUBLIC_BASE_URL`，让 `start` 尝试临时 `cloudflared` 隧道。 |

如果 `SYMHARIX_PUBLIC_BASE_URL` 留空且启用了 Telegram，`start` 会在 app 启动前尝试创建临时 `cloudflared` 隧道。对于临时 `trycloudflare.com` URL，`start` 还会运行 watchdog 检查公网 URL 和 Telegram manifest。如果隧道过期或不可达，它会创建新隧道并重启本地 service process。

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

### 飞书

| 变量 | 是否需要 | 含义 |
| --- | --- | --- |
| `SYMHARIX_FEISHU_APP_ID` | 使用飞书时必填 | 飞书自建应用 App ID。留空则禁用飞书。 |
| `SYMHARIX_FEISHU_APP_SECRET` | 使用飞书时必填 | 飞书自建应用 App Secret，用于获取 `tenant_access_token`。 |
| `SYMHARIX_FEISHU_OPERATOR_IDS` | 写操作必填 | 允许执行写操作的 `open_id`、`user_id` 或 `union_id`，逗号分隔；留空时只读。 |
| `SYMHARIX_FEISHU_OPERATIONS_CHAT_ID` | 可选 | 固定 operations chat。可从飞书消息事件里的 `chat_id` 获取。 |
| `SYMHARIX_FEISHU_API_BASE_URL` | 可选 | OpenAPI base，默认 `https://open.feishu.cn/open-apis`。 |
| `SYMHARIX_PUBLIC_BASE_URL` | 可选 | 只有当飞书卡片需要打开 Mini App/runtime 网页链接时才需要公网 HTTPS base；长连接收事件不需要。 |
| `SYMHARIX_FEISHU_RUNTIME_OPEN_MODE` | 可选 | 运行视图按钮打开方式。保持默认 `applink_web_url`，让飞书在客户端内部打开运行视图。 |
| `SYMHARIX_FEISHU_RUNTIME_TUNNEL` | 可选 | `auto` 会在 `applink_web_url` 且未配置公网 base 时为运行视图创建临时 tunnel，方便手机端飞书打开；`off` 禁用，`on` 强制启用。 |
| `SYMHARIX_FEISHU_TUNNEL_PROTOCOL` | 可选 | 运行视图 tunnel 协议。飞书默认使用 `auto`，避免继承 Telegram 的 `http2` 设置；网络挑剔时可尝试 `http2` 或 `quic`。 |
| `SYMHARIX_FEISHU_TUNNEL_TIMEOUT_MS` / `SYMHARIX_FEISHU_TUNNEL_RETRY_ATTEMPTS` / `SYMHARIX_FEISHU_TUNNEL_RETRY_DELAY_MS` | 可选 | 创建飞书临时 runtime tunnel 的超时和重试参数。默认 `45000ms`、`3` 次、`1500ms`。 |
| `SYMHARIX_FEISHU_TUNNEL_READY_ATTEMPTS` / `SYMHARIX_FEISHU_TUNNEL_READY_DELAY_MS` | 可选 | 发布临时 tunnel 到卡片前，等待 Cloudflare 不再返回 530 的次数和间隔。默认 `60` 次、每次 `1000ms`。 |
| `SYMHARIX_FEISHU_RUNTIME_APPLINK_MODE` | 可选 | AppLink 打开形态，默认 `window`；如需侧边栏可尝试 `sidebar`。 |
| `SYMHARIX_FEISHU_RUNTIME_APPLINK_WIDTH` / `SYMHARIX_FEISHU_RUNTIME_APPLINK_HEIGHT` | 可选 | 飞书桌面端独立窗口宽高。 |
| `SYMHARIX_FEISHU_RUNTIME_APPLINK_TEMPLATE` | 可选 | 自定义 AppLink 模板。支持 `{appId}`、`{url}`、`{path}`、`{encodedUrl}`、`{encodedPath}`。 |

本地飞书测试使用 `bun run start:feishu`。飞书长连接收消息不需要公网 webhook URL、Verification Token 或 Encrypt Key。运行视图按钮默认使用 `applink_web_url`；当 `SYMHARIX_PUBLIC_BASE_URL` 为空时，启动器会尝试创建临时 `trycloudflare.com` runtime tunnel，并只把它用于「Open Runtime View」这类 Mini App 页面链接；飞书事件仍然走长连接。

如果手机端飞书需要远程打开运行视图，至少满足其一：

| 方式 | 配置 |
| --- | --- |
| 稳定公网入口 | `SYMHARIX_PUBLIC_BASE_URL=https://your-domain.example` |
| 本地开发临时入口 | `SYMHARIX_FEISHU_RUNTIME_OPEN_MODE=applink_web_url`，`SYMHARIX_FEISHU_RUNTIME_TUNNEL=auto` 或 `on` |

第一次获取 operator id 时，可以先把 `SYMHARIX_FEISHU_OPERATOR_IDS` 留空，以只读模式启动后给机器人发送 `/whoami`（别名 `/id`、`/me`）。机器人回复会显示 detected user id；将它填回 `.env` 后重启。收到的值通常就是发送者的 `open_id`（`ou_...`）。

飞书权限至少需要：

| 权限 | 用途 |
| --- | --- |
| `im:message.group_at_msg.include_bot:readonly` | 获取群组中其他机器人和用户 @ 当前机器人的消息。 |
| `im:message.group_at_msg:readonly` | 获取群组中用户 @ 机器人的消息。 |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的单聊消息。 |
| `im:message:send_as_bot` | 以应用/机器人身份发送消息。 |
| `im:message:update` | 编辑已发送的卡片或消息，用于 Plan Card/运行卡片原地更新。 |
| `im:resource` | 获取与上传图片或文件资源，用于卡片图片等内容。 |

权限变更后需要重新发布应用，并重启 SymHarix 以刷新 tenant access token。

当前飞书适配层复刻 Telegram 的核心 supervisor 能力：自然语言下达任务、slash 命令、仓库切换、Plan Card/运行卡片、按钮审批/重试/停止、主动 follow-up 和固定 operations chat。需要在飞书应用中开启机器人能力，把事件和回调都设为长连接，并添加 `im.message.receive_v1` 与 `card.action.trigger`。

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

### Supervisor OpenCode Runtime 与仓库理解

Telegram Supervisor 可以使用开源 OpenCode runtime 作为助手大脑。仓库理解路径中的仓库访问是只读的。业务动作仍然通过 supervisor/orchestrator tools 和确认策略执行。

| 变量 | 含义 |
| --- | --- |
| `SYMHARIX_SUPERVISOR_OPENCODE_RUNTIME` | 只有明确禁用 OpenCode runtime 前门时才设置为 `off`。 |
| `SYMHARIX_SUPERVISOR_OPENCODE_COMMAND` | Runtime 命令，默认 `node scripts/opencode-adapter.cjs`。 |
| `SYMHARIX_SUPERVISOR_TOOL_ROUTER_TIMEOUT_MS` | Supervisor tool-router 模型超时，默认 `12000`，上限 `60000`。 |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND` | 只读仓库理解命令。 |
| `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_TIMEOUT_MS` | 默认 `120000`。 |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND` | 每轮只读仓库顾问命令。 |
| `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_TIMEOUT_MS` | 默认 `120000`。 |

命令留空时使用 `node scripts/opencode-adapter.cjs`，它会调用 `runtime/opencode.lock.json` 中锁定并校验 checksum 的版本。旧的 `SYMHARIX_SUPERVISOR_CLAUDE_*` 名称暂时作为配置别名保留。

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
bun run setup
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
  command: node ./scripts/opencode-adapter.cjs
```

只有明确要替换 OpenCode adapter 时才修改这里。旧 workflow 可能仍使用 `codex.command`；它会作为 legacy alias 继续被接受。

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
