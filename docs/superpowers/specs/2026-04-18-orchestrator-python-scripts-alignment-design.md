# Orchestrator 与 Python Scripts 对齐设计

**日期**: 2026-04-18
**状态**: Approved
**目标**: 重构 Orchestrator 直接调用 Python cli.py，而非通过 executeHook 间接调用底层 hooks

---

## 背景

当前架构中，Orchestrator 通过 `WorkspaceManager.executeHook()` 间接调用 Python hooks（before_run, after_run）。这种间接调用增加了复杂度，且状态管理分散在多个层面。

## 目标

Orchestrator 保持 TypeScript，但直接调用 `python3 ./scripts/cli.py` 命令，实现更清晰的调用路径。

## 架构变化

### Before
```
Orchestrator (TS) → WorkspaceManager.executeHook() → hooks/before_run.py
Orchestrator (TS) → WorkspaceManager.executeHook() → hooks/after_run.py
                    ↓
              executeHook 根据扩展名选择解释器
```

### After
```
Orchestrator (TS) → subprocess.run(['python3', './scripts/cli.py', 'dev', issue_id])
Orchestrator (TS) → subprocess.run(['python3', './scripts/cli.py', 'review', issue_id])
```

## 具体改动

### 1. Orchestrator.runAgentAttempt() 重构

**Before**: 调用 before_run hook，执行 agent，然后调用 after_run hook

**After**:
- `before_run` → `python3 ./scripts/cli.py dispatch <issue_id>` (初始化状态)
- `dev` phase → `python3 ./scripts/cli.py dev <issue_id>`
- `review` phase → `python3 ./scripts/cli.py review <issue_id>`
- 解析 stdout 中的 SYMPHONY_STATS 获取执行结果

### 2. WorkspaceManager 简化

- 移除 executeHook 方法中对 before_run, after_run 的调用
- 仅保留 after_create hook 调用（用于 workspace 创建后的初始化）
- 其他生命周期 hooks 由 cli.py 内部处理

### 3. 环境变量传递

保持现有机制：
- SYMPHONY_ISSUE_IDENTIFIER
- SYMPHONY_ISSUE_STATE
- SYMPHONY_GITHUB_OWNER
- SYMPHONY_GITHUB_REPO
- SYMPHONY_PROJECT_ROOT

### 4. 状态同步

- StateStore 继续由 Python cli.py 管理
- Orchestrator 通过解析 cli.py stdout 中的 SYMPHONY_STATS JSON 获取状态
- SYMPHONY_STATS 格式:
  ```json
  {
    "linear_api_calls": 0,
    "github_api_calls": 0,
    "final_state": "In Review",
    "review_decision": "APPROVED"
  }
  ```

### 5. cli.py 命令接口

| 命令 | 功能 | 输出 |
|------|------|------|
| `dispatch <issue_id>` | 初始化状态 | SYMPHONY_STATS |
| `dev <issue_id>` | 执行开发阶段 | SYMPHONY_STATS |
| `review <issue_id>` | 执行 review 阶段 | SYMPHONY_STATS |
| `status <issue_id>` | 查询状态 | JSON 状态 |
| `clean <issue_id>` | 清理 workspace | - |

## 实施步骤

1. 修改 `Orchestrator.runAgentAttempt()` 直接调用 cli.py
2. 简化 `WorkspaceManager`，移除 before_run/after_run 调用
3. 更新 WORKFLOW.md 配置（移除 before_run/after_run hooks）
4. 测试验证

## 风险与缓解

- **风险**: cli.py 执行失败导致状态不一致
- **缓解**: 解析 stdout 中的错误信息，完善重试逻辑
