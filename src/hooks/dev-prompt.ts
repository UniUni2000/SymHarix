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
After analyzing the issue, I determined:
- **Complexity**: ${judgment.complexity.toUpperCase()}
- **Reasoning**: ${judgment.reasoning}
- **Requires Tests**: ${judgment.requiresTests ? 'YES - must write and pass tests' : 'NO - code changes only'}

## Your Task
1. First, ${existingLog ? 'read the existing DEVELOPMENT_LOG.md to understand previous progress' : 'create DEVELOPMENT_LOG.md to track your progress'}
2. Implement the required changes
3. ${judgment.requiresTests ? 'Write tests that pass (required for this complexity level)' : 'Commit your changes'}
4. Update DEVELOPMENT_LOG.md after each significant step

${existingLog ? `## Existing Progress\n${existingLog}\n---\nContinue from where the previous session left off.` : ''}

## Workflow
- After each significant change, update DEVELOPMENT_LOG.md
- When done: commit, push, create PR, and the after-run hook will handle Linear state
- Do NOT modify .mcp.json or ISSUE_CONTEXT.md

## Important
- Be thorough but efficient
- Write meaningful commit messages
- If blocked, document what you tried in DEVELOPMENT_LOG.md
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