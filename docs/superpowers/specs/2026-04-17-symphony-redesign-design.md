# Symphony Agent Platform 重构设计

**日期**: 2026-04-17
**版本**: v1.0

---

## 1. 目标

将 Symphony 打造成一个 **robust、高效、易用** 的 AI Coding Agent 平台，实现：

- **省 token**：减少不必要的 API 调用
- **省时间**：快速完成简单 issue，减少 bug
- **可追溯**：完整的 DEV/Review 循环记录
- **职责清晰**：DEV 只开发，Review 只审稿，像学术审稿一样有结构

---

## 2. 整体流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Linear Issue                                 │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Orchestrator: 拉取 issue                                             │
│  - activeStates: ['Todo', 'In Progress', 'In Review', 'Cancelled'] │
└─────────────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
              Cancelled               Todo / In Progress
                    │                       │
                    ▼                       ▼
┌───────────────────────┐    ┌─────────────────────────────────────┐
│ 立即清理:               │    │ DEV Agent 开发                       │
│ - 停止所有 Agent       │    │ 1. 读取 DEVELOPMENT_LOG.md（如有）  │
│ - 删除 workspace       │    │ 2. 分析 issue，判断复杂度            │
│ - 标记完成             │    │ 3. 决策：小issue=改完即可/大=需测试 │
└───────────────────────┘    │ 4. 开发 + 写 DEVELOPMENT_LOG.md       │
                              │ 5. 提交 PR                           │
                              └─────────────────────────────────────┘
                                                        │
                                                        ▼
                              ┌─────────────────────────────────────┐
                              │ Linear 状态: In Review               │
                              │ 更新 customFields:                    │
                              │ - dev_attempts++                      │
                              │ - complexity = AI判断结果             │
                              └─────────────────────────────────────┘
                                                        │
                                                        ▼
                              ┌─────────────────────────────────────┐
                              │ Review Agent 审稿                    │
                              │ 1. 查看代码 diff                     │
                              │ 2. 决定结果:                         │
                              │   - Approve                          │
                              │   - Approve with Minor Issues        │
                              │   - Request Changes (Minor/Major)    │
                              │   - Request Tests                    │
                              │   - Reject                           │
                              │ 3. 写结构化 Review Report            │
                              │ 4. 发 Linear 评论通知用户             │
                              └─────────────────────────────────────┘
                                                        │
                    ┌───────────────┬───────────────┬───────────────┐
                    ▼               ▼               ▼               ▼
               Approve        Request          Request         Reject
              → Merge         Changes          Tests
                    │               │               │
                    ▼               ▼               ▼
              Done          In Progress     In Progress
              (自动)         DEV 修改        DEV 加测试
                                         (带具体要求)

```

---

## 3. 状态机设计

### Linear 状态（保持现有）

| 状态 | 含义 |
|------|------|
| `Todo` | 新 issue，等待开发 |
| `In Progress` | DEV Agent 开发中 |
| `In Review` | PR 已创建，等待审稿 |
| `Done` | 完成（已 merge） |
| `Cancelled` | 用户取消（最高优先级） |

### Linear 自定义字段（通过 API 读写）

| 字段 | 类型 | 含义 |
|------|------|------|
| `dev_attempts` | 数字 | DEV 尝试次数 |
| `review_round` | 数字 | 当前 review 轮次 |
| `complexity` | 单选 | `small` / `medium` / `large` |
| `last_review_decision` | 单选 | `approve` / `minor` / `major` / `tests` / `reject` |

### 状态转换规则

```
Todo → In Progress: DEV Agent 开始开发
In Progress → In Review: DEV 完成（提交 PR）
In Review → In Progress: Review Request Changes / Tests / Merge Conflict
In Review → Done: Review Approve + Merge 成功
Any → Cancelled: 用户取消 → 立即清理
```

---

## 4. 文件设计

### 4.1 DEVELOPMENT_LOG.md（workspace 内）

由 DEV Agent 维护，用于进度恢复：

```markdown
# Development Log: INT-10

## 基本信息
- **Issue**: INT-10
- **状态**: In Progress
- **开始时间**: 2026-04-17T10:00:00Z
- **复杂度**: medium

## 进度追踪

### 已完成
- [x] 分析需求：用户需要一个 hello world 函数
- [x] 实现 helloWorld() 在 src/index.ts
- [x] 单元测试（medium 复杂度触发）

### 待办
- [ ] 集成测试
- [ ] 更新 README

### 已尝试但失败
- [x] 最初尝试用 Python 实现 → 决策：改用 TypeScript

## Review 历史
- Round 1: Request Tests（需要加单元测试）
- Round 2: Approved ✓

## 下次继续
从「集成测试」开始，先运行 `bun test` 查看现有测试结构。
```

### 4.2 REVIEW_REPORT.md（workspace 内，数据库同步备份）

由 Review Agent 生成，结构化输出：

```markdown
# Review Report: INT-10

## 基本信息
- **Issue**: INT-10
- **Review Round**: 2
- **Reviewer**: Symphony Review Agent
- **时间**: 2026-04-17T11:00:00Z

## 评审结果: ✅ APPROVE

## 代码质量
- ✅ 逻辑正确
- ✅ 命名规范
- ⚠️ 注释略少（Minor Issue）

## 具体意见

### 必须修复（无）

### 建议改进
- 建议在 `helloWorld()` 前加 JSDoc 注释
- 建议在 README 添加使用说明

### 测试情况
- ✅ 单元测试通过
- ✅ 覆盖率达标（>80%）

## Linear 评论
已自动同步到 Linear Issue。
```

### 4.3 Review 结果类型

| 结果 | 说明 | Linear 更新 | 后续动作 |
|------|------|-------------|----------|
| **Approve** | 可以合并 | `last_review_decision: approve` | 自动 merge |
| **Approve with Minor Issues** | 可合并，有小问题 | `last_review_decision: minor` | Merge + 评论建议 |
| **Request Changes (Minor)** | 需要小改 | `last_review_decision: minor` | 打回 DEV |
| **Request Changes (Major)** | 需要大改/重写 | `last_review_decision: major` | 打回 DEV |
| **Request Tests** | 需要加测试 | `last_review_decision: tests` | 打回 DEV，说明要求 |
| **Reject** | 完全不符合 | `last_review_decision: reject` | 标记失败，需人工 |

---

## 5. DEV Agent 设计

### 5.1 第一次启动流程

```
1. 读取 DEVELOPMENT_LOG.md（如存在）
   → 有记录：从「下次继续」位置开始
   → 无记录：全新开始

2. 分析 issue，判断复杂度
   → 小 (small): 改完即可，不强制测试
   → 中 (medium): 改完 + 建议测试
   → 大 (large): 必须写测试 + 测试通过

3. 把决策写入 DEVELOPMENT_LOG.md

4. 开始开发
   - 每次重要修改后更新 DEVELOPMENT_LOG.md
   - 记录已完成、待办、失败尝试

5. 完成后
   - git add（排除 *.symphony-meta）
   - git commit
   - git push
   - 创建 PR
   - 更新 Linear: In Review + dev_attempts++
```

### 5.2 DEV Agent 工具

通过增强的 Adapter，DEV Agent 可以使用 claude-haha 的全部内置工具：

- **FileEditTool** — 智能编辑（比 Read/Write 更强）
- **BashTool** — 执行命令、运行测试
- **GlobTool / GrepTool** — 代码搜索
- **WebFetchTool** — 查文档、API
- **MCPTool** — 额外 MCP（如 GitHub）
- **TaskTool** — 创建子任务
- 等等...

不再局限于只有 Bash/Glob/Read。

### 5.3 复杂度判断标准

DEV Agent 第一次启动时分析：

- **代码改动范围**：文件数、代码行数
- **问题类型**：新功能 > Bug Fix > 重构 > 文档
- **依赖关系**：是否涉及核心模块、API 变更
- **测试需求**：是否需要数据库、集成测试

判断结果写入 `complexity` 字段和 `DEVELOPMENT_LOG.md`。

---

## 6. Review Agent 设计

### 6.1 启动流程

```
1. 读取 DEVELOPMENT_LOG.md（了解 DEV 的进度和决策）
2. 读取 REVIEW_REPORT.md（如有，了解历史）
3. 查看 PR diff + 运行测试
4. 生成结构化 Review Report
5. 决定结果（见 4.3）
6. 写 Linear 评论（用户可见）
7. 保存 Review Report 到数据库（系统追溯）
8. 更新 Linear 状态 + customFields
```

### 6.2 Review Agent 权限

- ✅ 查看代码、diff、Git 历史
- ✅ 运行测试、CI
- ✅ 写 Review Report
- ✅ 发 Linear 评论
- ❌ 不能改生产代码
- ⚠️ 可以写测试文件（通过 Request Tests 指令让 DEV 执行）

### 6.3 Review Agent 工具

与 DEV Agent 相同（全套工具），但只用于查看和验证，不用于修改。

---

## 7. 错误处理和恢复

### 7.1 崩溃恢复策略（混合）

| 崩溃次数 | 策略 |
|----------|------|
| 第 1 次 | 重试同 Agent 实例 |
| 第 2 次 | 换 Agent + 从 DEVELOPMENT_LOG.md 恢复 |
| 第 3 次 | 标记失败，通知用户（人工介入） |

### 7.2 Cancelled 处理（最高优先级）

当 issue 变为 `Cancelled`：
```
1. 立即停止该 issue 的所有 Agent
2. 删除 worktree workspace
3. 从 running/retrying/completed 中移除
4. 不重试，不通知
```

### 7.3 超时处理

- **DEV 超时**：更新日志 + 重新调度（计入 dev_attempts）
- **Review 超时**：记录超时 + 重新调度（review_round++）

---

## 8. Adapter 增强设计

### 8.1 当前问题

当前 `claude-adapter.cjs` 只暴露了 3 个工具（Bash/Glob/Read），claude-haha 的全部能力被浪费。

### 8.2 增强方案

让 adapter 正确转发工具调用：

```javascript
// 工具转发逻辑
if (toolName === 'Bash') { /* 执行 bash */ }
else if (toolName === 'Glob') { /* 执行 glob */ }
else if (toolName === 'Read') { /* 执行文件读取 */ }
else if (toolName === 'FileEdit') { /* 执行文件编辑 */ }
else if (toolName === 'MCPTool') { /* 转发 MCP 调用 */ }
else if (toolName === 'WebFetch') { /* 执行 web fetch */ }
// ... 更多工具

// 对于未知工具，记录警告但返回合理结果，不崩溃
else {
  return `Tool ${toolName} executed (unsupported by adapter)`
}
```

### 8.3 Session 恢复

claude-haha 已有 `-c`（continue from last session）参数，adapter 已使用。

需要确保 `DEVELOPMENT_LOG.md` 写入后，session 能感知上下文。

---

## 9. 数据库设计（symphony.db）

### 9.1 表结构

```sql
-- Issue 追踪表
CREATE TABLE issue_tracking (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  state TEXT NOT NULL,
  complexity TEXT,
  dev_attempts INTEGER DEFAULT 0,
  review_round INTEGER DEFAULT 0,
  last_review_decision TEXT,
  created_at DATETIME,
  updated_at DATETIME
);

-- Review 历史表
CREATE TABLE review_history (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  decision TEXT NOT NULL,
  report_md TEXT NOT NULL,
  reviewer_comment TEXT,
  created_at DATETIME,
  FOREIGN KEY (issue_id) REFERENCES issue_tracking(id)
);

-- 操作日志表
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  action TEXT NOT NULL,
  agent_type TEXT,
  details TEXT,
  created_at DATETIME
);
```

### 9.2 与 Linear 的同步

- 每次状态变更时，从 Linear 读取最新字段值
- 更新数据库记录
- 不把数据库作为唯一数据源（Linear 是主源）

---

## 10. WORKFLOW.md 配置增强

```yaml
active_states:
  - Todo
  - In Progress
  - In Review
  - Cancelled
terminal_states:
  - Done
  - Cancelled

# 新增配置
issue_tracking:
  enabled: true
  custom_fields:
    dev_attempts: dev_attempts
    review_round: review_round
    complexity: complexity
    last_review_decision: last_review_decision

dev_policy:
  complexity_ai_judge: true  # AI 自动判断复杂度
  require_test_for_large: true
  max_dev_attempts: 3

review_policy:
  auto_merge_on_approve: true
  notify_linear_on_review: true
```

---

## 11. 实现优先级

### Phase 1: 核心重构（必须先做）
1. ✅ 增强 claude-adapter.cjs（暴露全部工具）
2. ✅ DEV Agent 的 DEVELOPMENT_LOG.md 机制
3. ✅ DEV Agent 复杂度判断
4. ✅ Linear API 操作 customFields

### Phase 2: Review 机制
5. ✅ Review Agent 结构化 Report
6. ✅ Review 结果类型 + Linear 评论
7. ✅ Review 结果持久化（数据库）

### Phase 3: 健壮性
8. ✅ 崩溃恢复策略
9. ✅ Cancelled 立即清理
10. ✅ 超时处理

### Phase 4: 优化
11. ✅ 分层验收（小 issue 快，大 issue 严）
12. ✅ Token 优化（减少不必要调用）
13. ✅ 状态机可视化/日志

---

## 12. 待确认问题

- [x] Review 历史持久化方式 — A（数据库）+ Linear 评论
- [x] 进度恢复机制 — DEVELOPMENT_LOG.md
- [x] DEV Agent MCP 工具 — 利用 claude-haha 全套内置工具
- [x] DEV 完成标准 — AI 自动判断复杂度，分层验收
- [x] Review 评审结果 — 多级结果 + 严重程度
- [x] Review 能否指定测试要求 — 可以
- [x] Review Agent 操作权限 — 只能看 + 提建议
- [x] Cancelled 处理 — 立即清理
- [x] 崩溃恢复策略 — 混合（3 次重试策略）
- [x] 状态机设计 — 保持现有 Linear 状态 + 新增 customFields

---

**设计完成，等待用户批准后进入实现阶段。**
