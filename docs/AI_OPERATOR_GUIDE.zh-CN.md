# AI 操作者指南

**语言：** [English](./AI_OPERATOR_GUIDE.md) | 中文

这份指南面向在本仓库内工作的维护者和 AI agent，重点覆盖 Supervisor、Telegram、Runtime Deck 和交付链路的实时排障。

## 首要原则

必须尊重操作者配置的目标仓库。SymHarix 可以在路由仓库中创建 issue、branch、PR、comment，并修改 tracker 状态。

任何 live test 前先检查：

```bash
rg -n "SYMHARIX_TRACKER_PROJECT_SLUG|repositories:|routing:|github_owner|github_repo" .env WORKFLOW.md
```

期望形态：

```text
Linear project slug: sample-project
GitHub repo: acme/demo-app
```

只在允许自动创建 issue、branch、PR、comment 和清理动作的仓库上运行 live verification。

## 系统边界

SymHarix 是一个带 Telegram-first Supervisor 的可自托管控制平面。

- Telegram 是主要澄清和审批入口。
- Runtime Deck 是诊断和控制界面。
- Linear 和 GitHub 是记录与交付界面。
- Runtime issue detail 与 Mini App history 是查看持久化 agent-run usage、回放摘要、active PR 上下文和文件 diff 的主要位置。
- 多仓库上下文必须显式：Telegram 可以列出已配置 route、切换 chat 默认项目，并通过只读 advisor 读取指定仓库。
- Orchestrator 负责派发、重试、开发/评审交接、交付清理和修复。
- Claude Code 兼容执行链路通过 `scripts/claude-adapter.cjs` 运行。

Supervisor 不是简单的模型调用，也不只是一个 Claude Code 进程。它是持久化 session 状态，加上可选的 LLM 与只读仓库理解路径。

## 安全启动

推荐本地路径：

```bash
bun run setup:local
bun run start:local
```

停止：

```bash
bun run stop
```

只有 `3000` 被占用时才换端口：

```bash
PORT=4000 bun run start:local
PORT=4000 bun run health
```

启动异常时，先诊断再改代码：

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/overview
curl http://localhost:3000/api/v1/bots/manifest
```

验证 Telegram 时检查：

- `data.transports.telegram.health`
- `data.transports.telegram.webhook_url`
- `data.transports.telegram.public_base_url`
- `data.transports.telegram.mini_app_base_url`
- `data.transports.telegram.webhook_pending_update_count`
- `data.transports.telegram.webhook_last_error_message`

如果 Telegram 有回复但本地 manifest 的 webhook URL 为空，可能是另一个 bot 进程或部署正在使用同一个 token 回复。

如果 public base URL 是临时 `trycloudflare.com` 地址，HTTP 530、旧 webhook URL、DNS 错误和 pending updates 持续增长应先按隧道层故障处理。先让 `start:local` 恢复隧道，再考虑改应用代码。

## Live E2E 规则

验证 Telegram-first Supervisor 行为时，使用 attach mode：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

验证器必须进入 Telegram webhook/session 逻辑。直接通过 Runtime API 创建 issue 不能验证 Telegram-first 行为。

预期 live flow：

1. Telegram 请求进入。
2. Bot 快速 ACK。
3. Supervisor 为 chat 创建或恢复一个 root session。
4. 出现 Plan Card 或直接回复。
5. 需要审批时，批准后才物化任务。
6. root issue 保持为面向用户的主线程。
7. 拆分计划获批后，child issues 顺序执行。
8. Telegram 只收到高信号更新。

## 失败分类

出现问题时，先分层定位，再写补丁：

- 进程/租约：旧本地服务、端口占用、primary lease 冲突。
- Webhook 入口：Telegram 没有进入本地服务。
- Telegram 传输：callback ACK、卡片编辑、sendPhoto/sendMessage、Mini App URL。
- Supervisor session：旧 active session、审批缺失、仓库上下文错误。
- Orchestrator：issue 物化、派发、重试、治理。
- Dev agent：adapter 启动、workspace path、Anthropic key、分支漂移。
- 交付：PR、tracker 状态流转、issue close、清理。
- 交付阻塞：证据已满足，但 merge 或最终交付失败，常见为 `delivery_code=merge_blocked`。

## 常用检查

### Telegram 按钮像是没反应

检查：

- `/api/v1/bots/manifest`
- webhook diagnostics
- tunnel/public URL reachability
- stale `trycloudflare.com` public base URL
- callback audit logs
- `bot_transport_events`

分类：

- webhook 没到
- callback 解析成功但 ACK 失败
- ACK 成功但异步执行失败
- 执行成功但卡片编辑失败

### Telegram 重复消息

检查：

```bash
sqlite3 symphony.db "select source, action, result, message_id, material_key, created_at from bot_transport_events order by id desc limit 30;"
sqlite3 symphony.db "select * from bot_followup_delivery_states order by updated_at desc limit 20;"
sqlite3 symphony.db "select * from bot_followup_message_states order by updated_at desc limit 20;"
```

优先修复持久化的 material-key 或 delivery-state 逻辑，不要只叠加新的内存 guard。

### Supervisor Session 阻塞新任务

检查：

```bash
sqlite3 symphony.db "select id, state, transport, conversation_id, repo_ref, root_issue_id, updated_at from supervisor_sessions order by updated_at desc limit 20;"
```

面向用户的 UX 应给出明确选择：

- 继续当前线程
- 取消当前线程
- 新开线程

### Supervisor 回答浅

检查仓库理解：

```bash
sqlite3 symphony.db "select repo_ref, local_path, commit_sha, status, summary, error, updated_at from supervisor_repo_understandings order by id desc limit 20;"
```

如果缺失或失败，检查：

- chat 默认项目
- `WORKFLOW.md -> repositories.routing`
- 路由 local path 或 source cache
- `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND`
- `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND`
- 在本 checkout 中运行 `claude-code/bin/claude-haha --help`
- 仓库路径可读且 Git `HEAD` 有效

仓库理解是只读的。它应改善对话和建议，但不能在 Plan Card 获批前创建 issue 或编辑代码。

### Telegram 里仓库不对

改代码前先检查 route 配置和 chat 偏好：

```bash
rg -n "repositories:|routing:|github_owner|github_repo|SYMHARIX_TRACKER_PROJECT_SLUG" WORKFLOW.md .env
```

在 Telegram 中询问可用仓库或显式切换：

- `有哪些仓库？`
- `切到 sample-project`
- `切到 acme/demo-app`
- `test2 仓库主要做什么？`

resolver 接受 project slug、完整 `owner/repo` 或 repo name。缺失 route 时系统应 fail closed，而不是猜测。

### Dev Agent 立即失败

真实 runner 路径：

```text
Orchestrator -> AgentRunner -> scripts/claude-adapter.cjs -> claude-code/bin/claude-haha
```

检查：

- `WORKFLOW.md` 中的 `agent_runner.command`，或 legacy `codex.command`
- `ANTHROPIC_API_KEY`
- local workspace path
- branch/source-of-truth mismatch
- compact dev context size
- Claude process startup stderr

### PR 或 Issue 没关闭

不要把代码证据成功等同于交付完成。

检查：

- `delivery_code`
- `delivery_summary`
- active PR number
- PR head branch
- GitHub issue mapping
- tracker state conflict recovery
- orphan repair logs

如果 `delivery_code=merge_blocked`，把它当成交付阻塞，而不是 review 证据失败。打开 active PR，检查 merge 失败原因，解决后再 retry 或 supersede。

## 修复命令

运行状态混乱时先停止：

```bash
bun run stop
```

修复本地 bot/GitHub 残留：

```bash
bun src/cli/index.ts repair all
```

如果 live verification 污染了测试仓库，要有意识地清理：

- 关闭 open PR 和 issue
- 删除非 main 分支
- 删除该 repo 的本地 workspace
- 取消对应 Linear 测试 issue
- 取消或归档该 repo 的本地 Supervisor sessions/jobs

不要对错误仓库运行破坏性清理。

## 声称完成前

运行：

```bash
bun run test
bun run build
git diff --check
```

Telegram/Supervisor 行为还需要运行或安排：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

如果 live verification 失败，按证据总结：

- 准确的 issue/session/message id
- 第一个失败状态转换
- 观察到的日志或 DB 行
- delivery code 和 summary
- 失败层级
