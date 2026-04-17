# DEV/REVIEW Prompt 权责边界实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 DEV 和 REVIEW agent 的权责边界定义，包括 HANDOVER.md 交接文件和统一的 Review 反馈格式

**Architecture:** 通过更新 dev-prompt.ts 和 review-prompt.ts，定义清晰的交接文件 HANDOVER.md，并确保 Review 输出格式统一、GitHub/Linear 同步

**Tech Stack:** TypeScript, Shell scripts (after-run.sh, before-run.sh)

---

## 文件结构

```
src/hooks/
  ├── dev-prompt.ts      # DEV agent prompt（修改）
  ├── review-prompt.ts   # REVIEW agent prompt（修改）
  └── handover.ts        # HANDOVER.md 生成逻辑（新建）
```

---

## Task 1: 更新 dev-prompt.ts

**Files:**
- Modify: `src/hooks/dev-prompt.ts:93-131`

- [ ] **Step 1: Read current dev-prompt.ts**

- [ ] **Step 2: Update buildDevPrompt function — 加入 HANDOVER.md 生成要求**

将 `buildDevPrompt` 函数的 prompt 模板替换为：

```typescript
export function buildDevPrompt(issue: Issue, existingLog?: string): string {
  const judgment = judgeComplexity(issue);

  const prompt = `You are a DEV Agent working on issue ${issue.identifier}.

## Issue Information
- **Title**: ${issue.title}
- **Description**: ${issue.description || '(no description)'}
- **State**: ${issue.state}
- **Labels**: ${issue.labels.join(', ') || '(none)'}
${issue.branch_name ? `- **Branch**: ${issue.branch_name}` : ''}

## Complexity Assessment
- **Complexity**: ${judgment.complexity.toUpperCase()}
- **Reasoning**: ${judgment.reasoning}
- **Requires Tests**: ${judgment.requiresTests ? 'YES - must write and pass tests' : 'NO - code changes only'}

## Your Responsibilities
1. Analyze the issue and implement the required changes
2. Write and run tests (required for ${judgment.complexity} complexity)
3. Update DEVELOPMENT_LOG.md after each significant step
4. **When done: create HANDOVER.md with development summary**
5. Commit changes, push, and create PR

## HANDOVER.md Template (required when completing)
\`\`\`markdown
# Handover: ${issue.identifier}

## 开发摘要
{一句话描述做了什么}

## 变更范围
- 文件列表
- 新增/删除/修改

## 测试情况
- 单元测试: PASS/FAIL/N/A
- 集成测试: PASS/FAIL/N/A

## 已知问题
{DEV 认为可能有问题的地方，Review 重点关注}

## 下次继续（如需打回）
{空，DEV 不填写}
\`\`\`

${existingLog ? `## Existing Progress\n${existingLog}\n---\nContinue from where the previous session left off.` : ''}

## Important
- Do NOT decide if code is ready for review — that is Review's job
- Do NOT fix issues pointed out by Review — wait for their feedback
- If you discover the issue description is unclear, document it in HANDOVER.md "已知问题" and continue with your best judgment
- When complete: commit, push, create PR, create HANDOVER.md
`;

  return prompt;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/dev-prompt.ts
git commit -m "feat: update dev-prompt to require HANDOVER.md on completion"
```

---

## Task 2: 更新 review-prompt.ts

**Files:**
- Modify: `src/hooks/review-prompt.ts:45-137`

- [ ] **Step 1: Read current review-prompt.ts**

- [ ] **Step 2: Update buildReviewPrompt function — 加入 HANDOVER.md 读取要求 + 统一反馈格式**

替换 `buildReviewPrompt` 函数的 prompt 模板：

```typescript
export function buildReviewPrompt(
  issue: Issue,
  devLog?: string,
  previousReviews?: ReviewReport[]
): string {
  const historySection = previousReviews && previousReviews.length > 0
    ? previousReviews.map(r =>
        `- Round ${r.round}: ${r.decision} - ${r.summary.slice(0, 100)}`
      ).join('\n')
    : '(no previous reviews)';

  return `You are a CODE REVIEWER for issue ${issue.identifier}.

## Issue Information
- **Title**: ${issue.title}
- **Description**: ${issue.description || '(no description)'}
- **Labels**: ${issue.labels.join(', ') || '(none)'}

## Your Responsibilities
1. **First: Read HANDOVER.md** — This is DEV's summary of what was done
2. Review the PR/Diff: examine changed files carefully
3. Run tests if available: \`npm test\` or \`bun test\`
4. Assess code quality: logic, naming, performance, security
5. **Give feedback in "现状+期望" format** — Do NOT give solutions

## Feedback Format (MUST follow)
For each issue found:
**现状**: {现在的行为}
**期望**: {期望的行为}
**文件**: {文件:行号}

## Review Decision Options

| Decision | When to Use |
|----------|-------------|
| APPROVE | Code is correct, well-written, tests pass |
| APPROVE_MINOR | Can merge now, minor suggestions only |
| REQUEST_CHANGES | Need changes before approval |
| REQUEST_TESTS | Must add tests before approval |
| REJECT | Completely wrong approach |

## Development Context (from DEVELOPMENT_LOG.md)
${devLog || '(no development log found)'}

## Previous Review Rounds
${historySection}

## After Your Review
1. Write the report to REVIEW_REPORT.md in the workspace (do NOT commit it)
2. Post feedback as a comment on the GitHub Issue
3. Sync feedback to Linear issue
4. The orchestrator will update Linear state based on your decision
`;
}
```

- [ ] **Step 3: Update parseReviewDecision — 确保能解析新的格式**

当前 `parseReviewDecision` 函数已经能解析 `## 评审结果:` 格式，无需修改。

- [ ] **Step 4: Update formatLinearComment — 加入更详细的反馈格式**

替换 `formatLinearComment` 函数：

```typescript
export function formatLinearComment(report: ReviewReport): string {
  const emoji: Record<ReviewDecision, string> = {
    APPROVE: '✅',
    APPROVE_MINOR: '👍',
    REQUEST_CHANGES: '⚠️',
    REQUEST_TESTS: '🧪',
    REJECT: '🚫'
  };

  const labels: Record<ReviewDecision, string> = {
    APPROVE: 'APPROVED',
    APPROVE_MINOR: 'APPROVED (Minor Suggestions)',
    REQUEST_CHANGES: 'Changes Requested',
    REQUEST_TESTS: 'Tests Required',
    REJECT: 'REJECTED'
  };

  let comment = `## Code Review ${emoji[report.decision]} **${labels[report.decision]}**\n\n`;
  comment += `**Round ${report.round}** | Review Agent\n\n`;

  if (report.mustFix.length > 0) {
    comment += `### Must Fix (现状 → 期望)\n`;
    report.mustFix.forEach(item => {
      comment += `- ${item}\n`;
    });
    comment += '\n';
  }

  if (report.suggestions.length > 0) {
    comment += `### Suggestions\n`;
    report.suggestions.forEach(item => {
      comment += `- ${item}\n`;
    });
    comment += '\n';
  }

  if (report.testStatus) {
    comment += `### Tests\n`;
    comment += `- Has Tests: ${report.testStatus.hasTests ? '✅' : '❌'}\n`;
    comment += `- Tests Pass: ${report.testStatus.testsPass ? '✅' : '❌'}\n`;
  }

  if (report.testRequirements) {
    comment += `\n### Test Requirements\n${report.testRequirements}\n`;
  }

  comment += `\n---\n*Automated review by Symphony Agent*\n`;

  return comment;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/hooks/review-prompt.ts
git commit -m "feat: update review-prompt with HANDOVER.md requirement and 现状+期望 format"
```

---

## Task 3: 新建 handover.ts

**Files:**
- Create: `src/hooks/handover.ts`

- [ ] **Step 1: Create handover.ts with HANDOVER.md generation logic**

```typescript
/**
 * HANDOVER.md Generation
 * DEV Agent creates this when completing development
 */

import type { Issue } from '../types';

export interface HandoverData {
  issueId: string;
  summary: string;
  changedFiles: string[];
  testStatus: {
    unitTests: 'PASS' | 'FAIL' | 'N/A';
    integrationTests: 'PASS' | 'FAIL' | 'N/A';
    coverage?: string;
  };
  knownIssues: string[];
}

export interface ParsedHandover {
  summary: string;
  changedFiles: string[];
  testStatus: {
    unitTests: string;
    integrationTests: string;
    coverage?: string;
  };
  knownIssues: string[];
}

/**
 * Build HANDOVER.md content from data
 */
export function buildHandoverContent(issue: Issue, data: HandoverData): string {
  const timestamp = new Date().toISOString();

  return `# Handover: ${issue.identifier}

## 开发摘要
${data.summary}

## 变更范围
${data.changedFiles.map(f => `- ${f}`).join('\n')}

## 测试情况
- 单元测试: ${data.testStatus.unitTests}
- 集成测试: ${data.testStatus.integrationTests}
${data.testStatus.coverage ? `- 测试覆盖: ${data.testStatus.coverage}` : ''}

## 已知问题
${data.knownIssues.length > 0 ? data.knownIssues.map(i => `- ${i}`).join('\n') : '(无)'}

## 下次继续（如需打回）
${'(由 Review 填写)'}

---
Generated: ${timestamp}
`;
}

/**
 * Parse existing HANDOVER.md to extract data
 */
export function parseHandover(content: string): ParsedHandover | null {
  try {
    const lines = content.split('\n');
    let section = '';
    const result: ParsedHandover = {
      summary: '',
      changedFiles: [],
      testStatus: { unitTests: 'N/A', integrationTests: 'N/A' },
      knownIssues: []
    };

    for (const line of lines) {
      if (line.startsWith('## ')) {
        section = line.replace('## ', '').trim();
      } else if (section === '开发摘要' && line.trim()) {
        result.summary = line.replace(/^- /, '').trim();
      } else if (section === '变更范围' && line.trim().startsWith('- ')) {
        result.changedFiles.push(line.replace(/^- /, '').trim());
      } else if (section === '测试情况') {
        if (line.includes('单元测试:')) {
          result.testStatus.unitTests = line.split(':')[1].trim();
        } else if (line.includes('集成测试:')) {
          result.testStatus.integrationTests = line.split(':')[1].trim();
        } else if (line.includes('测试覆盖:')) {
          result.testStatus.coverage = line.split(':')[1].trim();
        }
      } else if (section === '已知问题' && line.trim().startsWith('- ')) {
        result.knownIssues.push(line.replace(/^- /, '').trim());
      }
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Update "下次继续（如需打回）" section in existing HANDOVER.md
 */
export function updateHandoverNextSteps(content: string, nextSteps: string): string {
  const lines = content.split('\n');
  let inNextSection = false;
  const updatedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## 下次继续（如需打回）')) {
      inNextSection = true;
      updatedLines.push(line);
    } else if (inNextSection && line.startsWith('## ')) {
      inNextSection = false;
      updatedLines.push(line);
    } else if (inNextSection && !line.trim()) {
      // Skip empty lines in this section
      continue;
    } else if (inNextSection) {
      // Replace content in this section
      if (!updatedLines.includes(nextSteps)) {
        updatedLines.push(nextSteps);
      }
    } else {
      updatedLines.push(line);
    }
  }

  return updatedLines.join('\n');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/handover.ts
git commit -m "feat: add HANDOVER.md generation logic"
```

---

## Task 4: 更新 orchestrator/index.ts — 状态流转逻辑

**Files:**
- Modify: `src/orchestrator/index.ts`

- [ ] **Step 1: Read current orchestrator/index.ts (if not already in context)**

- [ ] **Step 2: Import new handover module**

在文件顶部的 import 部分添加：

```typescript
import { buildDevPrompt, buildDevContinuationPrompt } from '../hooks/dev-prompt';
import { buildReviewPrompt } from '../hooks/review-prompt';
import { parseHandover, updateHandoverNextSteps } from '../hooks/handover';
```

- [ ] **Step 3: 在 runAgentAttempt 中，当 Review 完成时处理 HANDOVER.md 更新**

找到 `afterRun` hook 执行后的逻辑，添加：

```typescript
// After review completion, update HANDOVER.md if REQUEST_CHANGES
if (isReview && hookResult.success && hookResult.output) {
  const statsMatch = hookResult.output.match(/SYMPHONY_STATS:(\{.*\})/);
  if (statsMatch) {
    try {
      const stats = JSON.parse(statsMatch[1]);
      const reviewDecision = stats.review_decision || '';
      
      if (reviewDecision === 'REQUEST_CHANGES' && stats.feedback) {
        // Read existing HANDOVER.md and update "下次继续" section
        const handoverPath = path.join(workspace.path, 'HANDOVER.md');
        try {
          const fs = await import('fs/promises');
          const handoverContent = await fs.readFile(handoverPath, 'utf-8');
          const updatedHandover = updateHandoverNextSteps(handoverContent, stats.feedback);
          await fs.writeFile(handoverPath, updatedHandover, 'utf-8');
          console.log('[orchestrator] Updated HANDOVER.md with review feedback');
        } catch (err) {
          console.warn('[orchestrator] Failed to update HANDOVER.md:', err);
        }
      }
    } catch {}
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/index.ts
git commit -m "feat: handle HANDOVER.md update after REVIEW with REQUEST_CHANGES"
```

---

## Task 5: 验证实现

- [ ] **Step 1: TypeScript 编译检查**

```bash
cd /Users/example/projects/symharix
npx tsc --noEmit
```

Expected: 无 TypeScript 错误（除了 test 文件中已存在的类型问题）

- [ ] **Step 2: 确认所有文件存在**

```bash
ls -la src/hooks/handover.ts
ls -la src/hooks/dev-prompt.ts
ls -la src/hooks/review-prompt.ts
```

---

## Spec 覆盖检查

- [x] DEV prompt 要求创建 HANDOVER.md
- [x] REVIEW prompt 要求先读 HANDOVER.md
- [x] Review 反馈格式为"现状+期望"
- [x] HANDOVER.md 生成逻辑独立为 handover.ts
- [x] orchestrator 在 REQUEST_CHANGES 时更新 HANDOVER.md
