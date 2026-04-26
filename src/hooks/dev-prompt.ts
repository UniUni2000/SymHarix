/**
 * DEV Agent Prompt Templates
 * Handles complexity judgment and development guidance
 */

import type { Issue } from '../types';

/**
 * Complexity judgment result
 */
export interface ComplexityJudgment {
  complexity: 'small' | 'medium' | 'large';
  reasoning: string;
  requiresTests: boolean;
  estimatedFiles: number;
}

/**
 * Judge issue complexity based on description and context
 */
export function judgeComplexity(issue: Issue): ComplexityJudgment {
  const title = issue.title.toLowerCase();
  const description = (issue.description || '').toLowerCase();
  const labels = issue.labels.map(l => l.toLowerCase());
  const combinedText = `${title} ${description}`;

  // Large indicators
  const largeIndicators = [
    'refactor', 'architecture', 'redesign', 'rebuild',
    'new feature', 'new module', 'migration', 'breaking',
    'performance', 'optimization', 'security'
  ];

  // Small indicators
  const smallIndicators = [
    'fix', 'bug', 'typo', 'doc', 'readme', 'comment',
    'small', 'trivial', 'simple', 'hello world', 'script', 'single file'
  ];

  const singleFilePatterns = [
    /写一个.*(python|py|rust|js|ts|shell|bash).*(文件|脚本)/i,
    /写一个.*(python|py|rust|js|ts|shell|bash).*(程序|工具)/i,
    /创建一个.*(python|py|rust|js|ts|shell|bash).*(文件|脚本)/i,
    /创建一个.*(python|py|rust|js|ts|shell|bash).*(程序|工具)/i,
    /新增一个.*(python|py|rust|js|ts|shell|bash).*(文件|脚本)/i,
    /新增一个.*(python|py|rust|js|ts|shell|bash).*(程序|工具)/i,
    /(保存|存到|输出到).*(txt|md|markdown|json|csv)/i,
    /(collect|save|write).*(txt|md|markdown|json|csv)/i,
    /\b(create|write|add|implement)\b.*\b(file|script)\b/i,
    /\b(create|write|add|implement)\b.*\b(program|utility|tool)\b/i,
    /\bhello world\b/i,
  ];

  // Count indicators
  let largeScore = 0;
  let smallScore = 0;

  for (const indicator of largeIndicators) {
    if (title.includes(indicator) || description.includes(indicator)) {
      largeScore += 2;
    }
  }

  for (const indicator of smallIndicators) {
    if (title.includes(indicator) || description.includes(indicator)) {
      smallScore += 1;
    }
  }

  // Labels override
  if (labels.some(l => l.includes('large') || l.includes('complex'))) {
    largeScore += 3;
  }
  if (labels.some(l => l.includes('small') || l.includes('easy'))) {
    smallScore += 2;
  }

  if (singleFilePatterns.some(pattern => pattern.test(combinedText))) {
    smallScore += 3;
  }

  // Determine complexity
  let complexity: 'small' | 'medium' | 'large';
  let requiresTests: boolean;

  if (largeScore > smallScore) {
    complexity = 'large';
    requiresTests = true;
  } else if (smallScore > largeScore && smallScore >= 2) {
    complexity = 'small';
    requiresTests = false;
  } else {
    complexity = 'medium';
    requiresTests = true; // medium defaults to requiring tests
  }

  const reasoning = `large_score=${largeScore}, small_score=${smallScore}, determined_by=${
    largeScore > smallScore ? 'large_indicators' : smallScore > largeScore ? 'small_indicators' : 'default_medium'
  }`;

  return {
    complexity,
    reasoning,
    requiresTests,
    estimatedFiles: largeScore > smallScore ? 5 : (smallScore > largeScore ? 1 : 2)
  };
}

/**
 * Build DEV agent prompt with complexity judgment
 */
export function buildDevPrompt(
  issue: Issue,
  existingLog?: string,
  githubContext?: string,
  harnessGuidance?: string,
  supervisorGuidance?: string,
): string {
  const judgment = judgeComplexity(issue);

  const prompt = `You are a DEV Agent working on issue ${issue.identifier}.

## Issue Information
- **Title**: ${issue.title}
- **Description**: ${issue.description || '(no description)'}
- **State**: ${issue.state}
- **Labels**: ${issue.labels.join(', ') || '(none)'}
${issue.branch_name ? `- **Branch**: ${issue.branch_name}` : ''}

${githubContext ? `${githubContext}\n` : ''}
${harnessGuidance ? `${harnessGuidance}\n` : ''}
${supervisorGuidance ? `${supervisorGuidance}\n` : ''}

## Complexity Assessment
- **Complexity**: ${judgment.complexity.toUpperCase()}
- **Reasoning**: ${judgment.reasoning}
- **Requires Tests**: ${judgment.requiresTests ? 'YES - must write and pass tests' : 'NO - code changes only'}
${judgment.complexity === 'small' ? '- **Execution Style**: Prefer finishing in one focused pass if the change is straightforward.' : ''}

## Your Responsibilities
1. Analyze the issue and implement the required changes
2. Write and run tests (required for ${judgment.complexity} complexity)
3. Read repo-local contracts if present: \`.symphony-repo.yaml\` and \`.symphony-constitution.md\`
4. Keep \`.symphony/change-pack/tasks.md\` and \`.symphony/change-pack/evidence.json\` aligned with the real state of the work
5. Update \`.symphony/DEVELOPMENT_LOG.md\` after each significant step
6. **When done: create \`.symphony/HANDOVER.md\` with development summary**
7. Commit changes, push, and create PR

## \`.symphony/HANDOVER.md\` Template (required when completing)
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
- GitHub Issue and PR are the source of engineering context. Prefer them over stale tracker text if they conflict.
- Do NOT decide if code is ready for review — that is Review's job
- For SMALL issues, avoid unnecessary multi-turn exploration. If the implementation and verification are already complete, finish the turn cleanly.
- If review feedback already exists, address it in the same branch and same worktree unless the context explicitly says otherwise
- If you discover the issue description is unclear, document it in \`.symphony/HANDOVER.md\` "已知问题" and continue with your best judgment
- Treat \`.symphony/change-pack/evidence.json\` as a proof-of-work checklist. Do not end the turn while required evidence is still missing.
- Workflow/process artifacts are never product files. Never stage or commit \`DEVELOPMENT_LOG.md\`, \`HANDOVER.md\`, \`REVIEW_REPORT.md\`, anything under \`.symphony/\`, or similar review/dev process notes.
- When complete: commit, push, create PR, create \`.symphony/HANDOVER.md\`
`;

  return prompt;
}

/**
 * Build continuation prompt for resuming DEV work
 */
export function buildDevContinuationPrompt(issue: Issue, logContent: string): string {
  const judgment = judgeComplexity(issue);

  return `Continue working on issue ${issue.identifier}.

## Current Progress (from \`.symphony/DEVELOPMENT_LOG.md\`)
${logContent}

## Complexity: ${judgment.complexity.toUpperCase()}
${judgment.requiresTests ? '## Tests Required: YES' : ''}

Continue from "下次继续" section. Update \`.symphony/DEVELOPMENT_LOG.md\` as you make progress.
`;
}
