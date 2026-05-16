# SymHarix Claude-Compatible Runtime

**语言：** [English](./README.en.md) | 中文

这个目录包含 SymHarix 内置的 Claude-compatible runtime。它由根目录的 `scripts/claude-adapter.cjs` 调用，不是主要面向用户的 CLI。

大多数用户应在仓库根目录启动 SymHarix：

```bash
bun run start:local
```

## 入口

- `bin/claude-symharix`：首选内部 runtime 入口。
- legacy compatibility 入口：为已有本地环境保留。

adapter 会优先解析 `claude-symharix`，只有首选入口不存在时才回退到 legacy 入口。

## 环境变量

runtime 会继承父级 SymHarix 进程的环境变量。如果 `claude-code/.env` 存在，`bin/claude-symharix` 也会加载它，方便本地调试；生产部署应在 SymHarix 服务层配置密钥。

## 检查

在仓库根目录运行：

```bash
bun run runtime:check
```

直接调试 runtime 时运行：

```bash
claude-code/bin/claude-symharix --help
```
