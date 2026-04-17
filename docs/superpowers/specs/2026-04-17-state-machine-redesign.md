# Symphony 状态机重新设计

**日期**: 2026-04-17
**状态**: 已确认

## 概述

重新设计 Symphony 的 issue 流转机制，采用**本地状态机 + Linear 双检**模式，解决 PR 合并后状态不同步导致的无限循环问题。

## 设计原则

1. **本地状态机 + Linear 双检**: 维护本地状态文件，每次操作前从 Linear API 验证
2. **文件系统 + JSON**: 状态存储在 `.symphony/` 目录，透明易调试
3. **状态机 + 回退机制**: 支持任意状态回退，记录转换历史
4. **同步阻塞式**: 每步操作等待完成后再进行下一步
5. **梯度重试 + 状态回退**: 临时故障自动恢复，持久失败回退状态

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Linear (Single Source of Truth)         │
└─────────────────────────────────────────────────────────────┘
                              │ ▲
                    poll/refresh │ │ webhooks (future)
                              ▼ │
┌─────────────────────────────────────────────────────────────┐
│              Local State Machine (File System)              │
│                                                              │
│  workspaces/{hash}/{issue_id}/.symphony/                    │
│  ├── state.json        # 当前状态 + 转换历史                 │
│  ├── context.json      # issue 元数据                        │
│  └── events.log       # 事件审计日志                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Python CLI + Library                     │
│                                                              │
│  scripts/cli.py              # 统一入口                      │
│  scripts/lib/                                                  │
│  │   ├── state_machine.py    # 状态机核心                     │
│  │   ├── state_store.py      # 文件系统状态存储               │
│  │   ├── linear_client.py   # Linear API                     │
│  │   ├── github_client.py   # GitHub API                     │
│  │   └── retry.py           # 梯度重试                       │
│  scripts/hooks/                                               │
│      ├── dev.py              # DEV 阶段钩子                   │
│      ├── review.py           # REVIEW 阶段钩子                │
│      └── merge.py            # 合并钩子                       │
└─────────────────────────────────────────────────────────────┘
```

## CLI 命令

```bash
scripts/cli.py dispatch <issue_id>   # 分发新 issue（创建 state.json）
scripts/cli.py dev <issue_id>        # 开发阶段
scripts/cli.py review <issue_id>     # 评审 + 合并
scripts/cli.py status <issue_id>     # 查看当前状态
scripts/cli.py cancel <issue_id>     # 取消 issue
scripts/cli.py retry <issue_id>      # 重试错误状态
scripts/cli.py sync <issue_id>       # 强制从 Linear 同步状态
scripts/cli.py history <issue_id>    # 查看转换历史
scripts/cli.py clean <issue_id>      # 清理 workspace
```

## 目录结构

```
workspaces/
└── {hash}/                           # workspace 根目录
    └── {issue_id}/                    # issue 工作目录（如 INT-23）
        ├── hello.py                   # 开发者文件
        ├── .symphony/                 # Symphony 状态目录（与开发文件隔离）
        │   ├── state.json            # 当前状态
        │   ├── context.json          # issue 元数据
        │   └── events.log            # 事件审计日志
        ├── .git/                     # Git worktree
        └── ...
```

## 状态定义

### 状态列表

| 状态 | 类型 | 说明 |
|------|------|------|
| TODO | 初始 | Issue 已分发，等待开始 |
| IN_PROGRESS | 活跃 | 开发中 |
| IN_REVIEW | 活跃 | 评审中 |
| DONE | 终态 | 完成 |
| CANCELLED | 终态 | 取消 |
| ERROR | 中间 | 错误，需人工介入 |

### 状态转换规则

| 当前状态 | 可转换到 | 触发条件 |
|---------|---------|---------|
| TODO | IN_PROGRESS | dispatch |
| IN_PROGRESS | IN_REVIEW | pr_created |
| IN_PROGRESS | IN_PROGRESS | retry_after_error |
| IN_PROGRESS | CANCELLED | manual_cancel |
| IN_REVIEW | DONE | pr_merged |
| IN_REVIEW | IN_PROGRESS | review_rejected |
| IN_REVIEW | IN_REVIEW | retry_after_error |
| DONE | - | 终态 |
| CANCELLED | - | 终态 |
| ERROR | IN_PROGRESS | manual_retry |

### 状态转换图

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                                                              │
                    ▼                                                              │
  ┌─────────┐    ┌─────────────┐    ┌───────────┐    ┌──────┐    ┌───────────┐  │
  │  TODO   │───▶│ IN_PROGRESS │───▶│ IN_REVIEW │───▶│ DONE │    │ CANCELLED │  │
  └─────────┘    └─────────────┘    └───────────┘    └──────┘    └───────────┘  │
       │              │                   │                                        │
       │              │                   │                                        │
       │              │                   │ review_rejected                        │
       │              │                   ▼                                        │
       │              │            ┌─────────────┐                                 │
       │              │            │ IN_PROGRESS │◀────────────────────────────────┤
       │              │            └─────────────┘                                 │
       │              │                   │                                        │
       │              │                   │ error (梯度重试失败)                    │
       │              ▼                   ▼                                        │
       │         ┌─────────┐        ┌──────────┐                                  │
       └────────▶│CANCELLED│        │   ERROR  │                                  │
                └─────────┘        └──────────┘                                  │
                                        │                                        │
                                        │ manual_retry                           │
                                        ▼                                        │
                                   ┌─────────────┐                              │
                                   │ IN_PROGRESS │──────────────────────────────┘
                                   └─────────────┘
```

## 文件格式

### .symphony/state.json

```json
{
  "version": 1,
  "issue_id": "INT-23",
  "current_state": "IN_REVIEW",
  "previous_state": "IN_PROGRESS",
  "transition_history": [
    {"from": "TODO", "to": "IN_PROGRESS", "trigger": "dispatch", "timestamp": "2026-04-17T10:00:00Z", "actor": "system"},
    {"from": "IN_PROGRESS", "to": "IN_REVIEW", "trigger": "pr_created", "timestamp": "2026-04-17T10:05:00Z", "actor": "dev-hook"}
  ],
  "metadata": {
    "linear_issue_id": "uuid-xxx",
    "linear_state": "In Review",
    "pr_url": "https://github.com/...",
    "pr_number": 42,
    "pr_merged": false,
    "branch": "int-23",
    "github_repo": "owner/repo"
  },
  "error": null,
  "retry_count": 0
}
```

### .symphony/context.json

```json
{
  "title": "写一个 hello world Python 脚本",
  "description": "...",
  "created_at": "2026-04-17T09:00:00Z",
  "updated_at": "2026-04-17T10:05:00Z"
}
```

### .symphony/events.log（追加只写）

```
2026-04-17T10:00:00Z state_changed {"from": "TODO", "to": "IN_PROGRESS", "trigger": "dispatch"}
2026-04-17T10:05:00Z pr_created {"pr_url": "https://github.com/...", "pr_number": 42}
2026-04-17T10:05:01Z state_changed {"from": "IN_PROGRESS", "to": "IN_REVIEW", "trigger": "pr_created"}
```

## 核心流程

### 1. Dispatch（分发）

1. 从 Linear API 获取 issue 信息
2. 验证 Linear 状态是否为 `active_states` 之一
3. 创建 workspace 和 `.symphony/` 目录
4. 创建 `state.json`（状态=TODO）和 `context.json`
5. 记录事件

### 2. DEV 阶段

1. 读取 `state.json`，验证当前状态
2. 从 Linear API 验证状态（双检）
3. 更新状态为 `IN_PROGRESS`
4. 启动 Claude Code agent 执行开发
5. 开发完成后：
   - 检查 PR 是否存在（查 GitHub API）
   - 不存在则创建 PR
   - 更新 `metadata.pr_url` 和 `metadata.pr_number`
6. 调用 Linear API 更新状态为 "In Review"
7. 等待 Linear API 确认状态已更新
8. 更新状态为 `IN_REVIEW`

### 3. REVIEW 阶段（评审 + 合并）

1. 读取 `state.json`，验证当前状态
2. 从 Linear API 验证状态（双检）
3. 查询 GitHub PR 状态：
   - `merged = true` → 合并已完成
   - `merged = false, state = approved` → 执行合并
   - `merged = false, state = changes_requested` → 回退到 IN_PROGRESS
   - `merged = false, state = pending` → 等待或标记 pending
4. 合并成功后：
   - 更新 `metadata.pr_merged = true`
   - 更新 Linear 状态为 "Done"
   - 等待 Linear 确认
   - 更新状态为 `DONE`
   - 自动调用 `clean` 清理 workspace

### 4. 错误处理与重试

**梯度重试策略**:
- 第 1 次重试: 等待 1 秒
- 第 2 次重试: 等待 5 秒
- 第 3 次重试: 等待 30 秒

**重试失败后的回退流程**:
1. 3 次重试全部失败
2. 状态回退到 `previous_state`
3. 记录错误信息到 `error` 字段
4. 状态变为 `ERROR`
5. 等待人工介入（`retry` 命令）

### 5. Linear 双检机制

每次状态转换前执行：

1. 从 Linear API 获取 issue 当前状态
2. 与本地 `state.json` 中的 `metadata.linear_state` 对比
3. 如果不一致：
   - 以 Linear API 为准
   - 更新本地 `metadata.linear_state`
   - 记录事件
4. 继续执行预期操作

### 6. 自动清理

- REVIEW 阶段完成且 PR 合并后
- 自动调用 `clean` 命令
- 删除整个 workspace 目录（包括 `.symphony/`）
- **注意**：此操作不可逆，清理前确保所有需要保留的信息已记录

## 关键设计要点

1. **状态目录独立**
   - `.symphony/` 与开发文件完全隔离
   - 不会污染 worktree
   - 清理时只需删除整个 workspace

2. **合并后自动清理**
   - REVIEW 阶段完成，PR 合并后
   - 自动调用 `clean` 命令
   - 删除整个 workspace 目录

3. **Linear 双检**
   - 每次操作前从 Linear API 获取最新状态
   - 与 state.json 对比
   - 不一致时以 Linear 为准并同步

4. **事件日志只追加**
   - 每次转换追加一条记录
   - 便于审计和问题排查
   - 不压缩、不轮转（文件小）

5. **错误梯度重试**
   - 1s → 5s → 30s
   - 3 次全失败 → ERROR 状态
   - 记录错误信息，可 manual_retry

## 技术实现

### 目录结构

```
scripts/
├── cli.py                  # CLI 入口
├── lib/                    # 共享库
│   ├── __init__.py
│   ├── state_machine.py    # 状态机核心
│   ├── state_store.py      # 文件系统状态存储
│   ├── linear_client.py    # Linear API 客户端
│   ├── github_client.py    # GitHub API 客户端
│   └── retry.py            # 梯度重试
└── hooks/                  # 钩子实现
    ├── __init__.py
    ├── dev.py              # DEV 阶段
    ├── review.py           # REVIEW 阶段（评审 + 合并）
    └── merge.py            # 合并逻辑
```

### Python 版本

- Python 3.8+
- 使用标准库 `json`, `pathlib`, `logging`
- 第三方库: `requests` (HTTP 请求)

## 迁移计划

1. **第一阶段**: 实现 `scripts/lib/` 共享库
2. **第二阶段**: 实现 `scripts/cli.py` 和所有子命令
3. **第三阶段**: 实现 `scripts/hooks/` 钩子
4. **第四阶段**: 废弃 `scripts/*.sh`，切换到 Python
5. **第五阶段**: 简化 `src/orchestrator/index.ts`，委托给 Python CLI

## 待解决问题

无
