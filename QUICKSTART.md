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

最关键的是本地 `WORKFLOW.md`；仓库只提交模板 [WORKFLOW.md.example](/Users/example/projects/symharix/WORKFLOW.md.example)。`codex.command` 当前默认走：

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
- `SYMPHONY_BOT_LLM_PROVIDER`
- `SYMPHONY_BOT_LLM_MODEL`
- `SYMPHONY_BOT_LLM_API_KEY`
- `SYMPHONY_BOT_LLM_BASE_URL`
- `SYMPHONY_DISCORD_BOT_TOKEN`
- `SYMPHONY_DISCORD_PUBLIC_KEY`
- `SYMPHONY_DISCORD_OPERATOR_IDS`

Phase 4 之后的几个实用点：

- 网页/API 可以用 token 进入 operator 模式，否则默认 read-only
- bot `watch` 支持 `default` / `verbose` / `failures` / `status`，并会在重启后自动恢复
- `status` 和运行态详情会显示 digest 摘要与历史回放（包含 agent/review/sync 轨迹）
- Telegram / Discord 的自然语言默认走专用 bot LLM；如果没配好或后端异常，会透明降级到本地 parser，并提示当前是“简化理解模式”

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
