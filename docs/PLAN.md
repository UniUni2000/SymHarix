# Telegram-First Memoryful Supervisor Plane v1

## Summary
把 Symphony 从“Telegram 建单 + orchestrator 执行”升级成“Telegram-first Product Supervisor”：用户通过 Telegram 提出模糊功能需求，Supervisor 负责追问、补全计划、批准后物化 root/child queue，并在执行期像人类协作者一样持续观察 Claude Code dev agent 的输出，决定下一轮指令、是否暂停问用户、是否完成。

第一阶段只接管 **Telegram 新需求**；Linear/GitHub 继续作为记录和交付系统。目标是先打通一条用户可感知的完整闭环，而不是一次性接管所有历史 issue。

## Key Changes
### 1. Supervisor 角色与边界
- Supervisor 不是 Claude Code 实例，也不是裸 LLM；它是 `LLM Agent Brain + Deterministic Control Shell`。
- LLM Brain 负责理解意图、追问、计划、执行判断、里程碑总结、完成报告。
- Control Shell 负责 session 状态机、权限、审批、root/child lineage、质量门槛、Telegram 去重、审计和失败降级。
- Supervisor 可以指挥 dev agent，但不能直接偷偷改代码；代码修改仍由 Claude Code dev agent 在 orchestrator 管理下完成。

### 2. Telegram Product Session
- 同一 Telegram chat 同时只允许一个 active root supervisor session。
- 小单：生成精简计划，默认自动执行或轻确认。
- 模糊单：只追问关键问题，追问到“够执行”为止，不把 Telegram 变成表单。
- 中大单/高风险单：生成 Plan Card，等待用户批准。
- 用户批准后才物化 Linear/GitHub 执行记录。
- 用户焦点始终留在 root session；child issue 不主动抢 Telegram 焦点。
- 汇报节奏为“高信号 + Supervisor 判断的重要节点”，避免重演 Telegram 刷屏。

### 3. Plan Card 与物化
- Plan Card 固定表达：用户目标、本次范围、暂不处理、完成算什么、风险/待确认点、推荐执行方式、备选方案。
- 大计划批准后物化为 `root issue + 顺序 child queue`。
- 只放行当前 child；后续 child queued，当前 child 完成后自动接力。
- 第一阶段只强制 Telegram-origin session 使用这套物化模型；非 Telegram issue 继续走现有逻辑。

### 4. Supervisor Context Pack
- 新增 `SupervisorContextBuilder`，每次决策只给高信号上下文，而不是塞全仓库/全日志。
- Context Pack 包含：用户意图与澄清、Plan Card、repo intelligence、execution state、last turn summary、diff/evidence summary、decision history tail。
- Repo intelligence 第一阶段接入 `.symphony-repo.yaml`、`.symphony-constitution.md`、shadow harness、repo snapshot summary、最近相关 issue/PR/failure 摘要。
- Dev agent turn 通过 `TurnSummary` 压缩：本轮目标、改了什么、跑了什么、成功/失败、缺失证据、可疑点、原始 transcript 引用。

### 5. Execution Supervisor Loop
- 新增 `SupervisorBrain` 接口：`assessIntake`、`draftPlan`、`revisePlan`、`reviewDevTurn`、`decideNextInstruction`、`summarizeMilestone`。
- Orchestrator 在每个 dev turn 结束后收集 `TurnSummary + DiffEvidenceSummary`，调用 Supervisor Brain。
- Supervisor 返回结构化决定：`continue_with_prompt`、`request_more_context`、`ask_user`、`mark_child_complete`、`mark_plan_complete`、`mark_failed`。
- `continue_with_prompt` 成为下一轮 Claude Code dev agent 指令。
- `ask_user` 会把 session 切到 `awaiting_user_decision` 并通过 Telegram 发卡。
- 第一阶段只对 Telegram-origin session 启用；其他 issue 保持旧 supervisor/orchestrator 行为。

### 6. Supervisor Verified Completion
- 完成不等于 dev agent 自称完成，也不只等于 PR 创建。
- 完成报告必须包含：原目标、实际实现、主要改动、验证证据、PR/merge/no-op closure 状态、剩余风险、Supervisor verdict。
- 如果 evidence 不足，Supervisor 必须继续驱动 dev agent 补测试、补证据或修实现。
- 如果 delivery failed，Supervisor 分类为可自动恢复、需要用户决策、非 retryable 失败，并给用户清晰说明。

## Public Interfaces / Types
- 新增内部接口：`SupervisorBrain`、`SupervisorContextBuilder`、`SupervisorContextPack`、`TurnSummary`、`DiffEvidenceSummary`、`SupervisorNextInstruction`、`SupervisorVerifiedCompletionReport`。
- 扩展 `SupervisorSessionRecord` 使用现有状态机语义：`drafting | clarifying | plan_ready | awaiting_user_approval | materialized | executing | awaiting_user_decision | completed | failed | cancelled`。
- 扩展 runtime/bot projection：以 supervisor root session 为主语义，展示 plan state、current child、child queue、delivery state、next recommended action、completion verdict。
- Telegram callback 继续使用 supervisor session action，不新增 slash command。
- Linear/GitHub 不成为澄清/审批入口，只保存 root/child issue、PR、review、merge 和审计记录。

## Test Plan
- Telegram 模糊需求会进入 clarifying，并逐步生成 Plan Card。
- Telegram 小单会生成精简计划并自动进入执行。
- Telegram 中大/高风险需求在用户批准前不会物化 Linear issue。
- Plan Card 批准后创建 root + child queue，只 current child dispatch。
- Dev turn 结束后，Supervisor Brain 收到 context pack 并返回下一轮指令。
- evidence 不足时不会完成，而是生成继续开发 prompt。
- scope 明显变化时进入 `awaiting_user_decision`，Telegram 请求重新批准。
- child 完成后自动接力下一 child，Telegram 只围绕 root session 汇报。
- 完成报告包含实现、验证、delivery、风险和 supervisor verdict。
- 非 Telegram issue 不受第一阶段新闭环影响。
- 服务重启后 active supervisor session、root issue、current child、last decision 可以恢复。

## Assumptions
- 人类用户的第一阶段角色是产品所有者：负责目标、体验、边界和关键审批，不负责盯日志和每轮 prompt。
- Supervisor 默认可自动吸收小幅实现优化；改变范围、承诺、风险或架构边界时必须请求用户批准。
- 第一阶段优先做 Telegram 新需求闭环，不迁移历史 issue，不强制接管所有 Linear issue。
- Supervisor 不直接写代码；它通过 orchestrator 指挥 Claude Code dev agent。
- 惊喜感来自三处：计划补全、执行中主动发现重要机会、最终高质量完成报告。
