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

  // Large indicators
  const largeIndicators = [
    'refactor', 'architecture', 'redesign', 'rebuild',
    'new feature', 'new module', 'migration', 'breaking',
    'performance', 'optimization', 'security'
  ];

  // Small indicators
  const smallIndicators = [
    'fix', 'bug', 'typo', 'doc', 'readme', 'comment',
    'small', 'trivial', 'simple'
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

/**
 * Build continuation prompt for resuming DEV work
 */
export function buildDevContinuationPrompt(issue: Issue, logContent: string): string {
  const judgment = judgeComplexity(issue);

  return `Continue working on issue ${issue.identifier}.

## Current Progress (from DEVELOPMENT_LOG.md)
${logContent}

## Complexity: ${judgment.complexity.toUpperCase()}
${judgment.requiresTests ? '## Tests Required: YES' : ''}

Continue from "下次继续" section. Update DEVELOPMENT_LOG.md as you make progress.
`;
}