# OpenCode runtime 与三角色架构

SymHarix 的代码执行底座使用开源项目
[`anomalyco/opencode`](https://github.com/anomalyco/opencode)。仓库不再保存 Claude Code
兼容 runtime 源码。

## 运行链路

```text
确定性 Orchestrator
  ├─ Plan：只读分析
  ├─ Dev：工作区实现与测试
  └─ Review：独立复核，只可写 .symphony/REVIEW_REPORT.md
         ↓
  AgentRunner JSON-RPC contract
         ↓
  scripts/opencode-adapter.cjs
         ↓
  opencode run --pure --format json
```

三角色仍是合适的主流结构。这里的“升级”不是增加更多常驻 agent，而是把三者改成受
Orchestrator 管理的角色会话：

- Plan、Dev、Review 使用独立 session 和权限边界。
- Dev 不能 `git push`、merge、调用 `gh` 或改变外部 tracker；交付由状态机负责。
- Review 不能改产品代码，只能运行只读检查、测试并生成标准评审报告。
- 测试、artifact、commit/PR、状态流转属于确定性 quality gate，不依赖模型自报完成。
- 专家 agent 只应按任务临时调用，不应变成更多长期互相聊天的 peer agent。

## 安装与校验

```bash
bun run runtime:install
bun run runtime:check
```

`runtime/opencode.lock.json` 锁定测试版本和 GitHub Release SHA-256。安装器把二进制放在
被 Git 忽略的 `.runtime-cache/`，不会把第三方二进制提交进仓库。

如需查看某个 provider 的可用模型：

```bash
bun run runtime:models -- deepseek
bun run runtime:models -- openai
```

配置使用 OpenCode 原生的 `provider/model` 格式：

```dotenv
SYMHARIX_OPENCODE_MODEL=deepseek/deepseek-chat
SYMHARIX_OPENCODE_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
```

也可以先执行 `opencode auth login`，然后配置：

```dotenv
SYMHARIX_OPENCODE_MODEL=deepseek/deepseek-chat
SYMHARIX_OPENCODE_USE_AUTH=1
```

三角色默认复用同一模型。需要成本或能力分层时，可分别覆盖：

```dotenv
SYMHARIX_OPENCODE_PLAN_MODEL=openai/gpt-5.1-mini
SYMHARIX_OPENCODE_DEV_MODEL=deepseek/deepseek-chat
SYMHARIX_OPENCODE_REVIEW_MODEL=anthropic/claude-sonnet-4-5
```

## 真实连通测试

配置 provider 后运行：

```bash
bun run runtime:smoke
```

该测试会经过真实 adapter 和一次极小的模型调用，验证只读策略、事件解析、文本回传与
turn completion。它不会编辑文件。

## 后续升级 OpenCode

不要直接把生产 runtime 指向 `latest`。使用升级门：

```bash
bun run runtime:upgrade -- 1.18.11
# 或检查 GitHub 最新正式 release：
bun run runtime:upgrade -- latest
```

升级程序会：

1. 从 GitHub Release API 获取四个平台的官方 SHA-256；
2. 暂时更新 lock 并安装候选版本；
3. 运行 adapter contract tests；
4. 运行完整、进程隔离的 `bun run test`；
5. 任一环节失败时恢复原 lock。

成功后仍需人工查看 OpenCode release notes 和 lock diff，再提交变更。这样以后可以持续
升级 OpenCode，但升级是经过兼容性门禁的显式变更，而不是运行时自动漂移。

升级器会优先使用 `GITHUB_TOKEN` / `GH_TOKEN`；匿名 API 达到限额时会自动复用已登录的
`gh`。两者都没有时只需执行一次 `gh auth login`。
