# Orchestrator Python Scripts 对齐实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 Orchestrator 直接调用 `python3 ./scripts/cli.py` 命令，替代原有的 executeHook 间接调用 hooks 机制

**Architecture:** Orchestrator 保持 TypeScript，通过 subprocess 调用 Python cli.py。状态管理由 Python StateStore 处理，Orchestrator 通过解析 stdout 中的 SYMPHONY_STATS 获取执行结果。

**Tech Stack:** TypeScript, Python 3, subprocess, StateStore

---

## 文件变更概览

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `src/orchestrator/index.ts` | 修改 | runAgentAttempt() 改为调用 cli.py |
| `src/workspace/manager.ts` | 修改 | 移除 before_run/after_run 调用，仅保留 after_create |
| `WORKFLOW.md` | 修改 | 移除 before_run/after_run hooks 配置 |
| `scripts/cli.py` | 修改 | 确保 SYMPHONY_STATS 输出格式正确 |

---

## Task 1: 确认 cli.py SYMPHONY_STATS 输出格式

**Files:**
- Modify: `scripts/cli.py`

- [ ] **Step 1: 检查 cli.py 现有输出格式**

检查 `scripts/cli.py` 中 `dev` 和 `review` 命令是否输出 SYMPHONY_STATS。

```python
# 在 dev() 函数末尾添加（如果缺失）
import json
click.echo(f"SYMPHONY_STATS:{json.dumps({
    'linear_api_calls': linear_api_calls,
    'github_api_calls': github_api_calls,
    'final_state': 'In Review'
})}")
```

- [ ] **Step 2: 验证 review 命令同样输出 SYMPHONY_STATS**

检查 `scripts/hooks/review.py` 或 `scripts/cli.py review` 命令是否有类似输出。

- [ ] **Step 3: 提交变更**

```bash
git add scripts/cli.py
git commit -m "feat(cli): ensure SYMPHONY_STATS output in dev/review commands"
```

---

## Task 2: 修改 WorkspaceManager - 简化 executeHook

**Files:**
- Modify: `src/workspace/manager.ts:161-257` (executeHook 方法)

- [ ] **Step 1: 查看 executeHook 当前实现**

确认 executeHook 只在 after_create 时被调用。

- [ ] **Step 2: 修改 executeHook - 添加 hookName 白名单**

```typescript
private async executeHook(hookName: string, script: string, workspacePath: string, envOverrides: Record<string, string> = {}): Promise<{ success: boolean; output?: string; error?: string }> {
  // 只允许 after_create hook
  const allowedHooks = ['after_create'];
  if (!allowedHooks.includes(hookName)) {
    console.log(`[executeHook] Skipping disallowed hook: ${hookName}`);
    return { success: true, output: '' };
  }
  // ... 原有逻辑
}
```

- [ ] **Step 3: 移除 beforeRun 和 afterRun 中的 hook 调用**

定位 `beforeRun()` 方法（约545行），移除 `this.executeHook('before_run', ...)` 调用。

定位 `afterRun()` 方法（约571行），移除 `this.executeHook('after_run', ...)` 调用。

- [ ] **Step 4: 提交变更**

```bash
git add src/workspace/manager.ts
git commit -m "refactor(workspace-manager): simplify hooks, only allow after_create"
```

---

## Task 3: 修改 Orchestrator - 直接调用 cli.py

**Files:**
- Modify: `src/orchestrator/index.ts` (runAgentAttempt 方法，约550-824行)

- [ ] **Step 1: 添加 cli.py 调用辅助方法**

在 Orchestrator 类中添加:

```typescript
/**
 * Run a cli.py command and parse SYMPHONY_STATS from output
 */
private async runCliCommand(
  command: 'dispatch' | 'dev' | 'review',
  issueId: string,
  workspacePath: string
): Promise<{ success: boolean; stats?: CliStats; error?: string }> {
  const projectRoot = this.config.projectRoot;
  const cmd = ['python3', './scripts/cli.py', command, issueId];

  console.log(`[orchestrator] Running: ${cmd.join(' ')}`);

  return new Promise((resolve) => {
    const child = cp.spawn(cmd[0], cmd.slice(1), {
      cwd: workspacePath,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', d => stdout += d.toString());
    child.stderr?.on('data', d => stderr += d.toString());

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ success: false, error: 'Command timed out' });
    }, this.hooks.timeout_ms);

    child.on('close', code => {
      clearTimeout(timeout);
      const output = (stdout + stderr).trim();

      if (code !== 0) {
        resolve({ success: false, error: `Command failed with code ${code}: ${output}` });
        return;
      }

      // Parse SYMPHONY_STATS
      const statsMatch = output.match(/SYMPHONY_STATS:(\{.*\})/);
      let stats: CliStats | undefined;
      if (statsMatch) {
        try {
          stats = JSON.parse(statsMatch[1]);
        } catch {}
      }

      resolve({ success: true, stats, error: undefined });
    });

    child.on('error', err => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });
  });
}
```

需要添加 CliStats 接口:

```typescript
interface CliStats {
  linear_api_calls?: number;
  github_api_calls?: number;
  final_state?: string;
  review_decision?: string;
  feedback?: string;
}
```

- [ ] **Step 2: 修改 runAgentAttempt - 替换 hook 调用为 cli.py 调用**

在 runAgentAttempt 方法中（约572-577行），找到:

```typescript
// Step 2: Run before_run hook
const beforeRunResult = await this.workspaceManager.beforeRun(workspace.path, issue);
if (!beforeRunResult.success) {
  result.error = `before_run hook failed: ${beforeRunResult.error}`;
  return result;
}
```

替换为:

```typescript
// Step 2: Initialize state via dispatch command
const dispatchResult = await this.runCliCommand('dispatch', issue.identifier, workspace.path);
if (!dispatchResult.success) {
  result.error = `dispatch failed: ${dispatchResult.error}`;
  return result;
}
```

在约703-744行，找到 after_run hook 调用:

```typescript
// Run after_run hook and parse API call statistics
console.log(`[orchestrator] Running after_run hook for ${issue.identifier}...`);
const hookResult = await this.workspaceManager.afterRun(workspace.path, issue);
```

替换为:

```typescript
// Run appropriate CLI command based on state
const cliCommand = isReview ? 'review' : 'dev';
const cliResult = await this.runCliCommand(cliCommand, issue.identifier, workspace.path);
console.log(`[orchestrator] CLI ${cliCommand} result: success=${cliResult.success}`);
```

替换整个 after_run 解析逻辑（约706-744行）:

```typescript
if (cliResult.success && cliResult.stats) {
  result.linear_api_calls = cliResult.stats.linear_api_calls || 0;
  result.github_api_calls = cliResult.stats.github_api_calls || 0;

  const finalState = cliResult.stats.final_state || '';
  const isTerminalState = ['done', 'canceled', 'duplicate'].some(
    s => finalState.toLowerCase() === s
  );

  if (isTerminalState) {
    this.state.completed.add(issue.id);
  }
} else if (!cliResult.success) {
  console.warn(`[orchestrator] CLI ${cliCommand} failed: ${cliResult.error}`);
}
```

- [ ] **Step 3: 更新 buildReviewPrompt 调用处的逻辑**

约683-688行的 continuation prompt 逻辑保持不变，但确保在 cli 调用失败时不会导致 sessionActive = false。

- [ ] **Step 4: 提交变更**

```bash
git add src/orchestrator/index.ts
git commit -m "refactor(orchestrator): call cli.py directly instead of hooks"
```

---

## Task 4: 更新 WORKFLOW.md 配置

**Files:**
- Modify: `WORKFLOW.md`

- [ ] **Step 1: 移除 before_run 和 after_run hooks 配置**

找到:
```yaml
hooks:
  before_run: ./scripts/hooks/before_run.py
  after_run: ./scripts/hooks/after_run.py
  timeout_ms: 300000
```

替换为:
```yaml
hooks:
  after_create: ./scripts/hooks/after_run.py  # 复用 after_run 作为 after_create
  timeout_ms: 300000
```

或者简化为:
```yaml
hooks:
  timeout_ms: 300000
```

- [ ] **Step 2: 提交变更**

```bash
git add WORKFLOW.md
git commit -m "chore: remove before_run/after_run hooks from WORKFLOW.md"
```

---

## Task 5: 验证和测试

**Files:**
- Test: 手动测试 orchestrator 流程

- [ ] **Step 1: 检查 TypeScript 编译**

```bash
cd /Users/example/projects/symharix
npx tsc --noEmit
```

确认无编译错误。

- [ ] **Step 2: 测试 cli.py 命令**

```bash
cd /Users/example/projects/symharix
python3 ./scripts/cli.py --help
python3 ./scripts/cli.py dispatch --help  # 如果支持
```

- [ ] **Step 3: 验证 SYMPHONY_STATS 格式**

```bash
python3 -c "
import json
stats = {'linear_api_calls': 1, 'github_api_calls': 2, 'final_state': 'In Review'}
print(f'SYMPHONY_STATS:{json.dumps(stats)}')
"
```

确认输出格式可被正则匹配。

---

## 实施检查清单

- [ ] Task 1: cli.py SYMPHONY_STATS 输出
- [ ] Task 2: WorkspaceManager 简化
- [ ] Task 3: Orchestrator 直接调用 cli.py
- [ ] Task 4: WORKFLOW.md 更新
- [ ] Task 5: 验证测试

---

## 风险与回滚

**风险**: cli.py 执行失败导致状态不一致
**缓解**: Orchestrator 解析 stdout 中的错误信息，完善重试逻辑

**回滚方案**: `git revert <commit>` 恢复到 Task 1 之前的状态
