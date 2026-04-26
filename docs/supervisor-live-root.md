# Supervisor Live Root 机制

**日期**: 2026-04-26
**状态**: Active
**用途**: 记录 Supervisor root + child queue 机制的运行行为和验证方式

## 1. 什么是 Supervisor Live Root

Supervisor Live Root 是 Supervisor 执行平面中的一种执行模式（`materialization_mode: root_with_split_queue`），用于处理多目标或需要顺序执行的复杂任务。

当一个计划包含多个需要顺序执行的子任务时，Supervisor 会：
1. 创建一个 **root issue** 作为治理线程，负责跟踪整体计划的进度
2. 将计划拆分为多个 **child issues**，形成一个 **child queue**
3. **只放行当前 child**，其余 child 保持在排队状态
4. 当前 child 完成后，root 自动推进到队列中的下一个 child

## 2. 核心概念

### 2.1 Root Issue

- 作为整条计划线程的主控 issue
- 持有 `governance_root_issue_id` 指向自己
- 维护 `governance_child_queue` 和 `governance_current_child` 状态
- `governance_thread_state` 反映整体执行状态：
  - `waiting_on_child`: 等待当前 child 完成
  - `child_failed`: 当前 child 执行失败
  - `blocked` / `confirming`: 需要用户决策

### 2.2 Child Issue

- 通过 `governance_root_issue_id` 关联到 root issue
- 每个 child 有独立的 `queue_state`：
  - `current`: 当前正在执行
  - `queued`: 等待执行
  - `completed`: 已完成
- 只有标记为 `current` 的 child 会被放行执行

### 2.3 Child Queue

- 由 root issue 的 `governance_child_queue` 字段维护
- 是一个有序列表，严格按顺序执行
- 不允许并发执行，只有前一个 child 完成后才放行下一个

## 3. 执行流程

```
User 创建多目标请求
        │
        ▼
Supervisor 规划 → materialization_mode = root_with_split_queue
        │
        ▼
创建 Root Issue（治理线程）
        │
        ▼
splitGovernance() 拆分出 Child Queue
        │
        ▼
┌───────────────────────────────────────┐
│  Root State: waiting_on_child         │
│  Current Child: CHILD-1 (current)     │
│  Queue: [CHILD-1:current, CHILD-2, CHILD-3]
└───────────────────────────────────────┘
        │
        ▼
执行 CHILD-1
        │
   ┌────┴────┐
   │ 完成?   │
   └────┬────┘
    Yes │ No
        ▼       ▼
   完成标记   失败处理
        │       │
        ▼       ▼
   Root 推进   Root 进入
   到 CHILD-2  child_failed
        │       │
        └───────┘
        │
        ▼
   所有 Child 完成?
        │
       Yes
        ▼
   Root 进入 completed
```

## 4. 状态映射

### 4.1 Root Issue 状态

| `orchestrator_state` | `governance_thread_state` | 含义 |
|---------------------|--------------------------|------|
| `executing` | `waiting_on_child` | 等待当前 child 完成 |
| `executing` | `child_failed` | 当前 child 执行失败 |
| `executing` | `blocked` / `confirming` | 需要用户决策 |
| `completed` | - | 所有子任务完成 |

### 4.2 Child Issue 状态

| `queue_state` | 含义 |
|--------------|------|
| `current` | 当前执行中的 child |
| `queued` | 排队等待的 child |
| `completed` | 已完成的 child |

## 5. 关键行为规则

1. **顺序执行**: Child queue 严格顺序执行，不允许并发
2. **只放行当前**: 只有 `queue_state = current` 的 child 会被调度执行
3. **失败传播**: Child 失败时，root 进入 `child_failed` 状态，等待用户决策
4. **自动推进**: Child 成功完成后，root 自动将下一个 child 设为 `current`
5. **完结条件**: 所有 child 都 `completed` 后，root 进入 `completed` 状态

## 6. Supervisor Session 与 Root 的关系

Supervisor Session 记录：
- `root_session_id`: 关联的 session ID
- `root_issue_id`: 关联的 root issue ID
- `current_child_issue_id`: 当前正在执行的 child issue ID

当 root 或 child 有里程碑事件时，Supervisor Session 会收到同步更新：
- `child_completed`: 子任务完成
- `child_failed`: 子任务失败
- `completed`: 整条计划线程完成

## 7. 验证方式

### 7.1 检查 Root Issue 状态

```bash
# 查看 root issue 的治理状态
# 应该看到 governance_thread_state = waiting_on_child
# governance_current_child 应指向当前执行的 child
```

### 7.2 检查 Child Queue

```bash
# 查看 root issue 的 governance_child_queue
# 应该看到类似：[CHILD-1:current, CHILD-2:queued, CHILD-3:queued]
```

### 7.3 检查只放行当前 Child

```bash
# 验证只有 queue_state = current 的 child 被调度
# 其他 child 应该保持 queued 状态
```

### 7.4 端到端验证命令

```bash
# 运行相关测试
bun test src/agent/supervisor.test.ts

# 验证构建
bun run build
```

## 8. 代码位置

- Root + Child Queue 逻辑: `src/supervisor/sessionService.ts`
- 治理拆分: `src/runtime/hub.ts` (splitGovernance)
- 状态推导: `src/supervisor/sessionService.ts` (deriveSupervisorMilestone)
- 执行监督: `src/supervisor/executionOverseer.ts`

## 9. 已知限制

- 仓库近期有 Supervisor 达到最大轮次限制的债务信号，执行时需注意控制
- Child 执行失败后，需要用户显式决策才能继续或取消
