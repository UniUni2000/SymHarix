# ✨ SymHarix — Telegram-First AI Supervisor

<p align="center">
  <img src="./assets/readme/logo.gif" alt="SymHarix logo animation" width="920">
</p>

<p align="center">
  <a href="#快速开始"><img src="https://img.shields.io/badge/Quick_Start-Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Quick Start"></a>
  <a href="#telegram-与飞书-supervisor"><img src="https://img.shields.io/badge/Telegram_%2F_Feishu-bot-229ED9?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram 与飞书 bot"></a>
  <a href="#核心链路"><img src="https://img.shields.io/badge/Runtime-Deck-6D5DFC?style=for-the-badge" alt="Runtime Deck"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <strong>语言：</strong> <a href="./README.md">English</a> | 中文
</p>

<p align="center">
  <img src="./assets/readme/concept-flow.png" alt="SymHarix Telegram-first supervised coding control plane conceptual flow" width="920">
</p>

<p align="center">
  <em>Conceptual flow illustration; actual Telegram, Runtime Deck, and Mini App screens may differ.</em>
</p>

## 演示视频

查看完整演示：[SymHarix demo video](https://youtu.be/1dCix6hFUY0)。

视频展示从 Telegram 需求输入到 Plan Card 审批、运行进展、Mini App 查看、Harness review 证据，以及最终 verified GitHub pull request 的完整闭环。

可自托管、Telegram 优先的 coding agent 监督控制平面。

## SymHarix 是什么

SymHarix 是一个可部署在本机或服务器上的代码执行控制平面。用户可以通过 Telegram Bot 或飞书机器人提需求，Supervisor 负责澄清、推荐计划或展示 Plan Card；用户批准后，任务会按配置路由到 GitHub 仓库，并通过内置 Claude-compatible runtime 执行。

Telegram 是默认本地入口；飞书可以作为独立的长连接入口，方便不便访问 Telegram 的团队单独使用。Runtime Deck 是诊断和控制界面。Linear 与 GitHub 负责保存任务、分支、PR、review 证据和交付状态。

## 使用导览

SymHarix 对新手友好：它会从 Telegram 或飞书需求开始引导用户创建 issue，通过预览卡展示项目整体进度，并允许用户随时追问当前进展或遇到的问题。

<p align="center">
  <img src="./assets/readme/guided-tour-telegram.gif" alt="SymHarix 在 Telegram 中引导用户创建 issue 并查看进展" width="820">
</p>

当 issue 较复杂时，SymHarix 会引导用户将主 issue 拆分为多个子 issue。用户确认后，它会按优先级依次执行这些子任务，直到项目完成。

<p align="center">
  <img src="./assets/readme/guided-tour-supervision.gif" alt="SymHarix 引导拆分复杂 issue 并按优先级执行子 issue" width="820">
</p>

为了让进展细节更直观，Mini App 可以查看 Status Overview、代码 diff、当前阶段详情，以及实时更新的 token 消耗。

<p align="center">
  <img src="./assets/readme/guided-tour-miniapp.gif" alt="SymHarix Mini App 展示状态概览、代码 diff 和 token 消耗" width="820">
</p>

SymHarix 的 reviewer 会先审核 dev agent 写好的代码，审核通过后才进入 delivery。用户可以在 branch 详情页查看 review 状态和证据。

<p align="center">
  <img src="./assets/readme/guided-tour-review.gif" alt="SymHarix 在 GitHub branch 详情页展示 reviewer 审核情况" width="820">
</p>

## 快速开始

```bash
bun run setup
# 编辑 .env 和 WORKFLOW.md
bun run start
```

`bun run start` 是 Telegram 入口的别名。只运行飞书入口时使用：

```bash
bun run start:feishu
```

打开 Runtime Deck：

```text
http://localhost:3000/runtime
```

只有端口冲突时才换端口：

```bash
PORT=4000 bun run start
```

停止本地服务：

```bash
bun run stop
```

检查内置 runtime：

```bash
bash scripts/check-runtime.sh
```

在 Linux 服务器上，安装 systemd service 后 SSH 断开也会继续运行：

```bash
bash scripts/install-systemd-service.sh
sudo journalctl -u symharix -f
```

## 核心链路

```text
Telegram 或飞书 / Runtime Deck / Linear issue
  -> Supervisor session, repo routing, Plan Card, approval
  -> Issue-scoped run in Runtime history
  -> Workspace checkout + feature branch
  -> AgentRunner -> scripts/claude-adapter.cjs
  -> bundled Claude-compatible runtime
  -> Code changes + tests + evidence
  -> GitHub branch -> pull request -> review
  -> Merge or delivery blocker
  -> Linear state + Runtime Deck + Mini App updated
```

主要行为：

- Telegram 或飞书负责对话、澄清、切换仓库、Plan Card、审批和简洁的生命周期更新。
- Runtime Deck 展示 issue 状态、时间线、token 使用量、近期 agent 进展、交付阻塞和安全写操作。
- Mini App issue 页面会展示当前阶段、active PR、回放历史，并在 workspace 或 PR head 可用时展示文件 diff。
- 用户批准后，任务会变成一个 issue-scoped coding run：SymHarix 准备 workspace、创建或跟踪 feature branch、保存验证证据、创建或跟踪 GitHub PR，并持续展示 review 与 merge 状态。
- 仓库路由必须显式配置，并且缺失时 fail closed。Linear `project_slug` 必须映射到 `WORKFLOW.md` 中的 GitHub 仓库。
- Agent 执行链路通过 `scripts/claude-adapter.cjs` 运行，并由它启动内置 Claude-compatible runtime；只读仓库理解默认也使用这个 adapter，除非显式覆盖。

## 配置

SymHarix 读取三层配置：

1. `.env`：密钥、API key、聊天入口、Runtime Deck 和 LLM 配置。
2. `WORKFLOW.md`：tracker 状态、仓库路由、agent 命令和验证场景。
3. 目标仓库契约：`.symphony-repo.yaml` 与 `.symphony-constitution.md`。

新的环境变量使用 `SYMHARIX_*`。旧的 `SYMPHONY_*` 变量、`.symphony-*` 契约和本地 `symphony.db` 文件仍作为兼容层保留。

本地运行最小 `.env`：

```dotenv
SYMHARIX_TRACKER_KIND=linear
SYMHARIX_TRACKER_API_KEY=...
SYMHARIX_TRACKER_PROJECT_SLUG=sample-project
GITHUB_TOKEN=...
ANTHROPIC_API_KEY=...
```

至少选择一个聊天入口：

- Telegram：配置 Telegram 变量，运行 `bun run start:telegram` 或 `bun run start`。
- 飞书：配置飞书变量，运行 `bun run start:feishu`。
- 二者可以同时存在于 `.env`，但本地启动命令会隔离自己的入口。`start:feishu` 不需要 Telegram 变量；`start:telegram` 也不需要飞书变量。

Telegram 最小 `.env`：

```dotenv
SYMHARIX_TELEGRAM_BOT_TOKEN=...
SYMHARIX_TELEGRAM_WEBHOOK_SECRET=...
SYMHARIX_TELEGRAM_OPERATOR_IDS=123456789
```

飞书最小 `.env`：

```dotenv
SYMHARIX_FEISHU_APP_ID=cli_xxx
SYMHARIX_FEISHU_APP_SECRET=...
SYMHARIX_FEISHU_OPERATOR_IDS=ou_xxx
```

为了保证完整的 SymHarix 机器人流程，飞书应用需要开启这些权限：

| 权限 | 用途 |
| --- | --- |
| `im:message.group_at_msg.include_bot:readonly` | 获取群组中其他机器人和用户 @ 当前机器人的消息。 |
| `im:message.group_at_msg:readonly` | 获取群组中用户 @ 机器人的消息。 |
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息。 |
| `im:message:send_as_bot` | 以应用/机器人身份发送消息。 |
| `im:message:update` | 更新已发送消息或卡片，用于 Plan Card 和运行卡片刷新。 |
| `im:resource` | 获取与上传图片或文件资源，用于卡片图片等内容。 |

本地飞书长连接启动：

```bash
bun run start:feishu
```

飞书长连接收消息不要求公网 IP，也不需要 webhook URL。若手机端飞书需要打开运行视图，请使用稳定公网入口 `SYMHARIX_PUBLIC_BASE_URL=https://your-domain.example`，或在本地开发时设置 `SYMHARIX_FEISHU_RUNTIME_OPEN_MODE=applink_web_url`，让 `start:feishu` 自动创建只用于 Mini App/runtime 链接的临时 `trycloudflare.com` tunnel。Telegram webhook 和 Mini App 功能仍然需要稳定、可公网访问的 HTTPS URL。生产环境建议使用域名 + HTTPS 反向代理，或 named Cloudflare Tunnel；快速 `trycloudflare.com` 隧道适合本地开发和 demo，不适合作为 24/7 生产入口。

仓库路由示例：

```yaml
repositories:
  routing:
    sample-project:
      github_owner: acme
      github_repo: demo-app
```

路由 key 必须匹配 Linear `project_slug`。缺失路由会在创建 workspace 前阻止 dispatch。

## Telegram 与飞书 Supervisor

Telegram 与飞书共用同一套 Supervisor 逻辑。飞书使用开放平台长连接模式：启用机器人能力后，在「事件与回调」里把事件和回调都设为长连接，并添加 `im.message.receive_v1` 与 `card.action.trigger`，即可复刻 Telegram 的对话、Plan Card、按钮审批、运行卡片与 follow-up。

两个 transport 会按来源隔离。飞书来源的 issue 只会向飞书来源会话和飞书 operations chat 推送 follow-up；Telegram 来源的 issue 只走 Telegram。这样即使 Telegram 未配置或不可达，飞书入口也能独立使用。

典型 Telegram/飞书交互：

1. 用户发送自然语言需求。
2. Supervisor 直接回答、追问细节、切换仓库上下文、读取已路由仓库，或展示 Plan Card。
3. 高风险或范围较大的写操作等待审批。
4. 用户批准后，任务被物化并交给 Orchestrator 执行。
5. Telegram/飞书编辑当前生命周期卡片，而不是发送重复消息。

低风险控制动作，例如列出仓库、展示卡片、watch issue、stop、retry、设置默认项目，会走 Supervisor 工具。create、close、supersede、split、rewrite、override 等高风险动作受确认策略约束。

## 健康检查与验证

```bash
bun run health
```

常用本地端点：

```text
http://localhost:3000/api/v1/runtime/manifest
http://localhost:3000/api/v1/bots/manifest
http://localhost:3000/api/v1/runtime/overview
```

验证 Telegram 时以 `/api/v1/bots/manifest` 为准：检查 `health`、`webhook_url`、`public_base_url`、`mini_app_base_url`、pending updates 和最后一次 webhook 错误。

验证交付时以 Runtime issue detail 为准。例如 `delivery_code=merge_blocked` 表示 review 证据已通过，但最终 merge 或交付动作仍需要处理。

Telegram-first 实时验证：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

本地开发检查：

```bash
bun run test
bun run build
git diff --check
```

## 文档

- [QUICKSTART.zh-CN.md](./QUICKSTART.zh-CN.md)：本地配置和第一次 Telegram 测试。
- [docs/CONFIGURATION.zh-CN.md](./docs/CONFIGURATION.zh-CN.md)：`.env`、`WORKFLOW.md` 与目标仓库契约参考。
- [docs/AI_OPERATOR_GUIDE.zh-CN.md](./docs/AI_OPERATOR_GUIDE.zh-CN.md)：维护者与 AI agent 的实时排障规则。
