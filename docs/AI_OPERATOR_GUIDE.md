# AI Operator Guide / AI 操作者指南

This guide is for maintainers and AI agents working inside this repository. It focuses on live Supervisor, Telegram, Runtime Deck, and delivery debugging.

这份指南面向在本仓库内工作的维护者和 AI agent，重点覆盖 Supervisor、Telegram、Runtime Deck 和交付链路的实时排障。

## Prime Directive / 首要原则

Respect the operator's configured target. SymHarix can create issues, branches, PRs, comments, and tracker state transitions in the routed repository.

必须尊重操作者配置的目标仓库。SymHarix 可以在路由仓库中创建 issue、branch、PR、comment，并修改 tracker 状态。

Before any live test, check:

任何 live test 前先检查：

```bash
rg -n "SYMHARIX_TRACKER_PROJECT_SLUG|repositories:|routing:|github_owner|github_repo" .env WORKFLOW.md
```

Expected example:

示例期望：

```text
Linear project slug: sample-project
GitHub repo: acme/demo-app
```

Only run live verification against a repository where automated issues, branches, PRs, comments, and cleanup are allowed.

只在允许自动创建 issue、branch、PR、comment 和清理动作的仓库上运行 live verification。

## What The System Is / 系统边界

SymHarix is a local control plane with a Telegram-first Supervisor.

SymHarix 是一个带 Telegram-first Supervisor 的本地控制平面。

- Telegram is the main clarification and approval surface.
  Telegram 是主要澄清和审批入口。
- Runtime Deck is the local diagnostics and control surface.
  Runtime Deck 是本地诊断和控制界面。
- Linear and GitHub are records and delivery surfaces.
  Linear 和 GitHub 是记录与交付界面。
- Runtime issue detail and Mini App history are the best place to inspect persisted agent-run usage, replay summaries, active PR context, and file diffs.
  Runtime issue detail 与 Mini App history 是查看持久化 agent-run usage、回放摘要、active PR 上下文和文件 diff 的主要位置。
- Multi-repo context is explicit: Telegram can list configured routes, switch the chat default project, and read a named repo through the read-only advisor.
  多仓库上下文必须显式：Telegram 可以列出已配置 route、切换 chat 默认项目，并通过只读 advisor 读取指定仓库。
- Orchestrator owns dispatch, retry, dev/review handoff, delivery cleanup, and repair.
  Orchestrator 负责派发、重试、开发/评审交接、交付清理和修复。
- Claude Code-compatible execution runs through `scripts/claude-adapter.cjs`.
  Claude Code 兼容执行链路通过 `scripts/claude-adapter.cjs` 运行。

The Supervisor is not just a model call and not just a Claude Code process. It is durable session state plus optional LLM and read-only repo-understanding paths.

Supervisor 不是简单的模型调用，也不只是一个 Claude Code 进程。它是持久化 session 状态，加上可选的 LLM 与只读仓库理解路径。

## Safe Startup / 安全启动

Preferred local path:

推荐本地路径：

```bash
bun run setup:local
bun run start:local
```

Stop:

停止：

```bash
bun run stop
```

Use another port only when `3000` is busy:

只有 `3000` 被占用时才换端口：

```bash
PORT=4000 bun run start:local
PORT=4000 bun run health
```

If startup behaves strangely, inspect before changing code:

启动异常时，先诊断再改代码：

```bash
bun run health
curl http://localhost:3000/api/v1/runtime/overview
curl http://localhost:3000/api/v1/bots/manifest
```

For Telegram, verify:

验证 Telegram 时检查：

- `data.transports.telegram.health`
- `data.transports.telegram.webhook_url`
- `data.transports.telegram.public_base_url`
- `data.transports.telegram.mini_app_base_url`
- `data.transports.telegram.webhook_pending_update_count`
- `data.transports.telegram.webhook_last_error_message`

If Telegram replies but the local manifest has an empty webhook URL, another bot process or deployment may be answering with the same token.

如果 Telegram 有回复但本地 manifest 的 webhook URL 为空，可能是另一个 bot 进程或部署正在使用同一个 token 回复。

If the public base URL is a temporary `trycloudflare.com` address, treat HTTP 530, stale webhook URLs, DNS errors, and repeated pending updates as tunnel-layer failures first. Let `start:local` recover the tunnel before changing application code.

如果 public base URL 是临时 `trycloudflare.com` 地址，HTTP 530、旧 webhook URL、DNS 错误和 pending updates 持续增长应先按隧道层故障处理。先让 `start:local` 恢复隧道，再考虑改应用代码。

## Live E2E Rules / Live E2E 规则

For Telegram-first Supervisor behavior, use attach mode:

验证 Telegram-first Supervisor 行为时，使用 attach mode：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

The verifier must enter through Telegram webhook/session logic. Creating issues directly through Runtime API does not validate Telegram-first behavior.

验证器必须进入 Telegram webhook/session 逻辑。直接通过 Runtime API 创建 issue 不能验证 Telegram-first 行为。

Expected live flow:

预期 live flow：

1. Telegram request arrives.
   Telegram 请求进入。
2. Bot quickly ACKs.
   Bot 快速 ACK。
3. Supervisor creates or resumes one root session for the chat.
   Supervisor 为 chat 创建或恢复一个 root session。
4. Plan Card or direct answer appears.
   出现 Plan Card 或直接回复。
5. Approval materializes work when needed.
   需要审批时，批准后才物化任务。
6. Root issue remains the user-facing thread.
   root issue 保持为面向用户的主线程。
7. Child issues run sequentially when a split plan is approved.
   拆分计划获批后，child issues 顺序执行。
8. Telegram receives high-signal updates only.
   Telegram 只收到高信号更新。

## Failure Classification / 失败分类

When something breaks, classify the layer before patching:

出现问题时，先分层定位，再写补丁：

- Process/lease: stale local service, occupied port, primary lease conflict.
  进程/租约：旧本地服务、端口占用、primary lease 冲突。
- Webhook ingress: Telegram did not reach local service.
  Webhook 入口：Telegram 没有进入本地服务。
- Telegram transport: callback ACK, card edit, sendPhoto/sendMessage, Mini App URL.
  Telegram 传输：callback ACK、卡片编辑、sendPhoto/sendMessage、Mini App URL。
- Supervisor session: stale active session, missing approval, wrong repo context.
  Supervisor session：旧 active session、审批缺失、仓库上下文错误。
- Orchestrator: issue materialization, dispatch, retry, governance.
  Orchestrator：issue 物化、派发、重试、治理。
- Dev agent: adapter startup, workspace path, Anthropic key, branch drift.
  Dev agent：adapter 启动、workspace path、Anthropic key、分支漂移。
- Delivery: PR, tracker transition, issue close, cleanup.
  交付：PR、tracker 状态流转、issue close、清理。
- Delivery blocker: proof is satisfied, but merge or final delivery failed, commonly `delivery_code=merge_blocked`.
  交付阻塞：证据已满足，但 merge 或最终交付失败，常见为 `delivery_code=merge_blocked`。

## Common Checks / 常用检查

### Telegram Button Appears Dead / Telegram 按钮像是没反应

Check:

检查：

- `/api/v1/bots/manifest`
- webhook diagnostics
- tunnel/public URL reachability
- stale `trycloudflare.com` public base URL
- callback audit logs
- `bot_transport_events`

Classify:

分类：

- webhook did not arrive / webhook 没到
- callback parsed but ACK failed / callback 解析成功但 ACK 失败
- ACK succeeded but async execution failed / ACK 成功但异步执行失败
- execution succeeded but card edit failed / 执行成功但卡片编辑失败

### Duplicate Telegram Messages / Telegram 重复消息

Inspect:

检查：

```bash
sqlite3 symphony.db "select source, action, result, message_id, material_key, created_at from bot_transport_events order by id desc limit 30;"
sqlite3 symphony.db "select * from bot_followup_delivery_states order by updated_at desc limit 20;"
sqlite3 symphony.db "select * from bot_followup_message_states order by updated_at desc limit 20;"
```

Prefer fixing persisted material-key or delivery-state logic over adding another in-memory guard.

优先修复持久化的 material-key 或 delivery-state 逻辑，不要只叠加新的内存 guard。

### Supervisor Session Blocks New Work / Supervisor Session 阻塞新任务

Inspect:

检查：

```bash
sqlite3 symphony.db "select id, state, transport, conversation_id, repo_ref, root_issue_id, updated_at from supervisor_sessions order by updated_at desc limit 20;"
```

The user-facing UX should offer clear choices:

面向用户的 UX 应给出明确选择：

- continue current thread / 继续当前线程
- cancel current thread / 取消当前线程
- new thread / 新开线程

### Supervisor Answers Feel Shallow / Supervisor 回答浅

Check repo understanding:

检查仓库理解缓存：

```bash
sqlite3 symphony.db "select repo_ref, local_path, commit_sha, status, summary, error, updated_at from supervisor_repo_understandings order by updated_at desc limit 20;"
```

If missing or failed, verify:

如果缺失或失败，检查：

- chat default project / chat 默认项目
- `WORKFLOW.md -> repositories.routing` / `WORKFLOW.md -> repositories.routing`
- route local path or source cache / 路由 local path 或 source cache
- `SYMHARIX_SUPERVISOR_REPO_UNDERSTANDING_COMMAND` / `SYMHARIX_SUPERVISOR_READONLY_ADVISOR_COMMAND`
- `claude-code/bin/claude-haha --help` from this checkout / 在本 checkout 中运行 `claude-code/bin/claude-haha --help`
- readable repository path and valid Git `HEAD` / 仓库路径可读且 Git `HEAD` 有效

Repo understanding is read-only. It should improve conversation and recommendations, but must not create issues or edit code before a Plan Card is approved.

仓库理解是只读的。它应改善对话和建议，但不能在 Plan Card 获批前创建 issue 或编辑代码。

### Wrong Repository In Telegram / Telegram 里仓库不对

Check configured routes and chat preference before changing code:

改代码前先检查 route 配置和 chat 偏好：

```bash
rg -n "repositories:|routing:|github_owner|github_repo|SYMHARIX_TRACKER_PROJECT_SLUG" WORKFLOW.md .env
```

In Telegram, ask for available repositories or switch explicitly:

在 Telegram 中询问可用仓库或显式切换：

- `有哪些仓库？`
- `切到 sample-project`
- `切到 acme/demo-app`
- `test2 仓库主要做什么？`

The resolver accepts project slug, full `owner/repo`, or repo name. If a route is missing, the system should fail closed instead of guessing.

resolver 接受 project slug、完整 `owner/repo` 或 repo name。缺失 route 时系统应 fail closed，而不是猜测。

### Dev Agent Fails Immediately / Dev Agent 立即失败

True runner path:

真实 runner 路径：

```text
Orchestrator -> AgentRunner -> scripts/claude-adapter.cjs -> claude-code/bin/claude-haha
```

Check:

检查：

- `codex.command` in `WORKFLOW.md`
- `ANTHROPIC_API_KEY`
- local workspace path
- branch/source-of-truth mismatch
- compact dev context size
- Claude process startup stderr

### PR Or Issue Does Not Close / PR 或 Issue 没关闭

Do not assume code evidence means delivery completed.

不要把代码证据成功等同于交付完成。

Check:

检查：

- `delivery_code`
- `delivery_summary`
- active PR number
- PR head branch
- GitHub issue mapping
- tracker state conflict recovery
- orphan repair logs

If `delivery_code=merge_blocked`, treat it as a delivery blocker, not as failed review proof. Open the active PR, inspect the merge failure, then retry or supersede after the blocker is resolved.

如果 `delivery_code=merge_blocked`，把它当成交付阻塞，而不是 review 证据失败。打开 active PR，检查 merge 失败原因，解决后再 retry 或 supersede。

## Repair Commands / 修复命令

Stop first when a run is confused:

运行状态混乱时先停止：

```bash
bun run stop
```

Repair local bot/GitHub residue:

修复本地 bot/GitHub 残留：

```bash
bun src/cli/index.ts repair all
```

If a test repo was polluted by live verification, clean it deliberately:

如果 live verification 污染了测试仓库，要有意识地清理：

- close open PRs and issues / 关闭 open PR 和 issue
- delete non-main branches / 删除非 main 分支
- remove local workspaces for that repo / 删除该 repo 的本地 workspace
- cancel corresponding Linear test issues / 取消对应 Linear 测试 issue
- cancel or archive local Supervisor sessions/jobs for that repo / 取消或归档本地 Supervisor sessions/jobs

Never run destructive cleanup against the wrong repository.

不要对错误仓库运行破坏性清理。

## Before Claiming Success / 声称完成前

Run:

运行：

```bash
bun run test
bun run build
git diff --check
```

For Telegram/Supervisor behavior, also run or schedule:

Telegram/Supervisor 行为还需要运行或安排：

```bash
bun --env-file=.env run src/cli/index.ts verify-live-supervisor \
  --project-slug sample-project \
  --server-url http://localhost:3000 \
  --telegram-chat-id <chat-id> \
  --matrix
```

If live verification fails, summarize by evidence:

如果 live verification 失败，按证据总结：

- exact issue/session/message ids / 准确的 issue/session/message id
- first failing transition / 第一个失败状态转换
- observed logs or DB rows / 观察到的日志或 DB 行
- delivery code and summary / delivery code 和 summary
- failing layer / 失败层级
