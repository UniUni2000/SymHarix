# DEV/REVIEW Agent 权责边界与交接规范设计

> **Status:** Approved

## 目标

定义 DEV Agent 和 REVIEW Agent 的权责边界，通过交接文件链实现清晰、无缝的协作循环。

## 核心原则

1. **权责清晰** — DEV 和 REVIEW 的边界明确，不会重复做同一件事
2. **交接顺畅** — DEV → Review → DEV(修复) → Review 的循环不出错
3. **可追踪** — 每次交接都在 Linear 和 GitHub 有记录

## 角色定义

### DEV Agent 职责

- 分析 issue → 制定方案 → 实现代码 → 写测试 → 更新 DEVELOPMENT_LOG.md
- 完成后创建 HANDOVER.md（开发摘要）
- **不负责**：
  - 判断代码是否可以通过 Review
  - 自行决定如何修复 Review 指出的问题

### REVIEW Agent 职责

- 读取 HANDOVER.md + 代码变更
- 给出"现状描述 + 期望行为"的问题反馈
- **不负责**：
  - 写代码修复问题
  - 直接给出解决方案

## 交接文件

### HANDOVER.md（DEV 完成时创建）

```markdown
# Handover: {issue_id}

## 开发摘要
{一句话描述做了什么}

## 变更范围
- 文件列表
- 新增/删除/修改

## 测试情况
- 单元测试: PASS/FAIL/N/A
- 集成测试: PASS/FAIL/N/A
- 测试覆盖: xx%

## 已知问题
{DEV 认为可能有问题的地方，Review 重点关注}

## 下次继续（如需打回）
{空，DEV 不填写}
```

### REVIEW_REPORT.md（Review 完成时创建，不提交）

```markdown
# Review Report: {issue_id}

## 基本信息
- **Issue**: {issue_id}
- **Review Round**: {n}
- **Reviewer**: Symphony Review Agent
- **时间**: {timestamp}

## 评审结果: [APPROVE | APPROVE_MINOR | REQUEST_CHANGES | REQUEST_TESTS | REJECT]

## 代码质量
- ✅/❌ 逻辑正确
- ✅/❌ 命名规范
- ✅/❌ 性能考虑
- ✅/❌ 安全性

## 问题反馈

### 必须修复
{每条格式：}
**现状**: {现在的行为}
**期望**: {期望的行为}
**文件**: {文件:行号}

### 建议改进
{建议列表}

## 测试情况
- 有测试: YES/NO
- 测试通过: YES/NO

## 总结
{2-3 句总结}

## 下次继续（如需打回）
{如果 REQUEST_CHANGES，说明 DEV 接下来要做什么}
```

## Review 反馈粒度

Review 给出反馈时：
- **必须包含**：问题描述 + 期望行为（不包含根因分析和解决方案）
- **禁止**：直接给出代码修复方案

示例：
```
**现状**: 函数没有对空数组做处理，导致后续空指针异常
**期望**: 输入空数组时应该返回空结果或抛出明确异常
**文件**: src/utils/parser.ts:45
```

## 状态流转与外部同步

| Review Decision | Linear 状态 | GitHub | 其他动作 |
|----------------|------------|--------|---------|
| APPROVE | Done | 合并 PR | post 完成 comment |
| APPROVE_MINOR | Done | 合并 PR | post 完成 comment |
| REQUEST_CHANGES | In Progress | Issue comment（问题反馈） | 更新 HANDOVER.md 的"下次继续" |
| REQUEST_TESTS | In Progress | Issue comment | 要求补测试 |
| REJECT | Cancelled | 关闭 Issue | 无需合并 |

## 追踪链条

```
Linear Issue ←→ GitHub Issue ←→ Workspace
     ↓                ↓
  状态变更         评论同步
     ↓                ↓
DEVELOPMENT_LOG.md ←→ HANDOVER.md ←→ REVIEW_REPORT.md
                    交接文件链
```

每一步都在 Linear 和 GitHub 有记录，可追踪。

## 文件修改清单

### 新建文件

- `src/hooks/handover.ts` — HANDOVER.md 生成逻辑

### 修改文件

- `src/hooks/dev-prompt.ts` — 更新 DEV prompt，加入 HANDOVER.md 生成要求
- `src/hooks/review-prompt.ts` — 更新 REVIEW prompt，明确反馈格式和 GitHub/Linear 同步
- `src/orchestrator/index.ts` — 根据 Review decision 触发不同行为

## 实现顺序

1. 修改 `dev-prompt.ts` — DEV prompt 加入 HANDOVER.md 生成要求
2. 修改 `review-prompt.ts` — REVIEW prompt 明确反馈格式
3. 新建 `handover.ts` — HANDOVER.md 生成逻辑
4. 修改 `orchestrator/index.ts` — 状态流转逻辑
