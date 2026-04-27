# Symphony 快速开始

## 当前保留的最小主链

```text
local WORKFLOW.md
  -> CLI
  -> Orchestrator
  -> Runtime Hub
  -> Runtime API / SSE / Web UI
  -> Telegram / Discord thin adapters
  -> Workspace Manager
  -> Claude adapter
  -> claude-code runtime
  -> Python hooks
```

项目里已经移除了旧的 `task/event` 控制层和旧 dashboard 主链，当前保留的是 `V1` 控制面主链，以及建立在同一 control plane 上的最小运行态网页和 Telegram/Discord 薄适配。

## 运行

```bash
bun install
bun run start -- --port 3000
```

开发模式：

```bash
bun run dev
```

停止所有本地 Symphony 后台进程：

```bash
bun run start -- --kill
```

等价 CLI 命令：

```bash
bun src/cli/index.ts --kill
```

## 必要配置

1. 准备 `.env`
2. 从 `WORKFLOW.md.example` 复制出本地 `WORKFLOW.md`
3. 配好 `Linear` / `GitHub` / Claude 运行所需变量
4. 如需聊天端接入，再补 Telegram / Discord 可选变量

```bash
cp WORKFLOW.md.example WORKFLOW.md
```

`WORKFLOW.md` 里需要显式配置 `repositories.routing`，用 Linear `project_slug` 路由到目标仓库：

```yaml
repositories:
  routing:
    repo-a:
      github_owner: acme
      github_repo: repo-a
      local_path: ./repos/repo-a
```

注意：

- `project_slug` 是正式命中键，不再使用 `project_name` 猜 repo
- 未命中路由时，issue 会保留在 Linear，但 Symphony 不会创建 workspace / GitHub issue / agent session
- 多个 Linear project 指向同一个 GitHub repo 时，会共享同一个 `source` cache

最关键的是本地 `WORKFLOW.md`；仓库只提交模板 [WORKFLOW.md.example](/Users/liupenghui/Documents/code/agent/test-cc/WORKFLOW.md.example)。`codex.command` 当前默认走：

```yaml
codex:
  command: node ./scripts/claude-adapter.cjs
```

而 `scripts/claude-adapter.cjs` 会继续调用仓库里的 `claude-code` runtime。

启动后常用入口：

- 运行态网页：`http://localhost:3000/runtime`
- Runtime manifest：`http://localhost:3000/api/v1/runtime/manifest`
- Runtime overview：`http://localhost:3000/api/v1/runtime/overview`
- Runtime history replay：`http://localhost:3000/api/v1/runtime/issues/<ISSUE-ID>/history`
- Bot manifest：`http://localhost:3000/api/v1/bots/manifest`

内部 live lifecycle 验证命令：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-lifecycle --project-slug 1d3a3f95809d
bun --env-file=.env run src/cli/index.ts verify-live-supervisor --project-slug 1d3a3f95809d
```

这条命令会自动创建一张新的验证 issue，并真实校验：

- `Todo -> Dev -> PR -> Review -> Merge -> Done`
- worktree cleanup
- 本地/远程 branch cleanup
- runtime session / worker / retry cleanup

可选 bot 环境变量：

- `SYMPHONY_RUNTIME_WRITE_TOKEN`
- `SYMPHONY_TELEGRAM_BOT_TOKEN`
- `SYMPHONY_TELEGRAM_WEBHOOK_SECRET`
- `SYMPHONY_TELEGRAM_OPERATOR_IDS`
- `SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID`
- `SYMPHONY_BOT_LLM_PROVIDER`
- `SYMPHONY_BOT_LLM_MODEL`
- `SYMPHONY_BOT_LLM_API_KEY`
- `SYMPHONY_BOT_LLM_BASE_URL`
- `SYMPHONY_BOT_LLM_TIMEOUT_MS`
- `SYMPHONY_BOT_LLM_HTTP_TRANSPORT`
- `SYMPHONY_SUPERVISOR_LLM_PROVIDER`
- `SYMPHONY_SUPERVISOR_LLM_MODEL`
- `SYMPHONY_SUPERVISOR_LLM_API_KEY`
- `SYMPHONY_SUPERVISOR_LLM_BASE_URL`
- `SYMPHONY_SUPERVISOR_LLM_TIMEOUT_MS`
- `SYMPHONY_SUPERVISOR_OVERSEER_PROVIDER`
- `SYMPHONY_SUPERVISOR_OVERSEER_MODEL`
- `SYMPHONY_SUPERVISOR_OVERSEER_API_KEY`
- `SYMPHONY_SUPERVISOR_OVERSEER_BASE_URL`
- `SYMPHONY_SUPERVISOR_OVERSEER_TIMEOUT_MS`
- `SYMPHONY_SUPERVISOR_JOB_INTERVAL_MS`
- `SYMPHONY_DISCORD_BOT_TOKEN`
- `SYMPHONY_DISCORD_PUBLIC_KEY`
- `SYMPHONY_DISCORD_OPERATOR_IDS`

Bot LLM 的运行参数统一放在 `.env`。建议本地 Telegram 使用 `SYMPHONY_BOT_LLM_TIMEOUT_MS=15000` 和 `SYMPHONY_BOT_LLM_HTTP_TRANSPORT=fetch`；`auto` 会启用 curl 到 fetch 的客户端 fallback，排障有用，但最坏情况下会拉长等待时间。

Supervisor planning brain 默认复用 `SYMPHONY_BOT_LLM_*` 的 provider/model/key/base URL，但使用自己的超时预算，默认 `45000ms`；需要单独模型或超时时再设置 `SYMPHONY_SUPERVISOR_LLM_*`。它失败时会自动回落到本地计划规则。

Supervisor execution overseer 默认复用 `SYMPHONY_SUPERVISOR_LLM_*`，再回退到 `SYMPHONY_BOT_LLM_*`；需要独立模型或更短超时时再设置 `SYMPHONY_SUPERVISOR_OVERSEER_*`。它只生成监督判断和下一轮 dev 指令，模型失败或输出不安全时会自动回落到本地 overseer。

Supervisor job loop 会自动恢复活跃 session、重放 root issue 状态，并把监督判断写入长期记忆；这些记忆会进入后续 dev/review prompt。需要真机验证这条链路时，使用 `verify-live-supervisor --server-url <url> --telegram-chat-id <id>`，它会从 Telegram webhook/session 入口验证 Plan Card、批准、建单和执行链。需要补全矩阵时加 `--matrix`，会顺序跑 `simple`、`governed-split`、`destructive-cleanup`。

启动后 bot follow-up repair 会默认延迟 `5000ms` 在后台运行，避免历史 Telegram/card/session 清理阻塞冷启动；terminal workspace / GitHub orphan cleanup 默认延迟 `900000ms`，避免和 live E2E / dev / review 主链抢资源。需要调整时统一在 `.env` 设置 `SYMPHONY_BOT_FOLLOWUP_REPAIR_DELAY_MS` / `SYMPHONY_SUPERVISOR_SESSION_REPAIR_MAX_AGE_MS` / `SYMPHONY_STARTUP_CLEANUP_DELAY_MS`。

Phase 4 之后的几个实用点：

- 网页/API 可以用 token 进入 operator 模式，否则默认 read-only
- bot `watch` 支持 `default` / `verbose` / `failures` / `status`，并会在重启后自动恢复
- `status` 和运行态详情会显示 digest 摘要与历史回放（包含 agent/review/sync 轨迹）
- Telegram / Discord 的自然语言默认走专用 bot LLM；如果没配好或后端异常，会透明降级到本地 parser，并提示当前是“简化理解模式”

Telegram 额外说明：

- 只要配置了 `SYMPHONY_TELEGRAM_BOT_TOKEN`，`bun run start -- --port 3000` 就会在启动时自动初始化 Telegram webhook
- 如果你已经有公网地址，设置 `SYMPHONY_PUBLIC_BASE_URL=https://your-host`
- 如果没给公网地址，系统会尝试自动调用 `cloudflared` 建一条临时 tunnel，默认使用更稳的 `--protocol http2`；也可以通过 `SYMPHONY_TELEGRAM_TUNNEL_COMMAND` / `SYMPHONY_TELEGRAM_TUNNEL_PROTOCOL` 覆盖
- 如果想关闭自动 Telegram bootstrap，设置 `SYMPHONY_TELEGRAM_BOOTSTRAP=off`
- 如果本机没有 `cloudflared`，也没给 `SYMPHONY_PUBLIC_BASE_URL`，服务仍会启动，但 Telegram inbound 不会接通
- `SYMPHONY_TELEGRAM_OPERATIONS_CHAT_ID` 用来指定固定运维会话；不配置时，只有已经绑定到 issue 的来源会话或手工 watch 会收到主动 follow-up

一键修复 bot/GitHub 遗留：

```bash
bun src/cli/index.ts repair all
```

它会同时：

- 修复 stale Telegram follow-up / card / pending action
- 按 terminal issue 扫描并关闭 orphan GitHub issue / PR

bot 命令例子：

- `watch INT-1`
- `watch verbose INT-1`
- `watch failures INT-1`
- `watch status INT-1`

## 常用命令

```bash
bun run build
bun run test
```
