# Symphony 快速开始

## 当前保留的最小主链

```text
WORKFLOW.md
  -> CLI
  -> Orchestrator
  -> Workspace Manager
  -> Claude adapter
  -> claude-code runtime
  -> Python hooks
```

项目里已经移除了旧的 `Telegram`、`Web Dashboard`、旧 `task/event` 控制层，当前只保留 `V1` 控制面主链。

## 运行

```bash
bun install
bun run start
```

开发模式：

```bash
bun run dev
```

## 必要配置

1. 准备 `.env`
2. 准备 `WORKFLOW.md`
3. 配好 `Linear` / `GitHub` / Claude 运行所需变量

最关键的是 [WORKFLOW.md](/Users/liupenghui/Documents/code/agent/test-cc/WORKFLOW.md) 里的 `codex.command`，当前默认走：

```yaml
codex:
  command: node ./scripts/claude-adapter.cjs
```

而 `scripts/claude-adapter.cjs` 会继续调用仓库里的 `claude-code` runtime。

## 常用命令

```bash
bun run build
bun run test
```
