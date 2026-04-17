/**
 * Review Agent Prompt Templates
 * Handles code review with structured feedback
 */

import type { Issue } from '../types';

/**
 * Review decision types
 */
export type ReviewDecision =
  | 'APPROVE'           // Can merge, code is correct and well-written
  | 'APPROVE_MINOR'     // Can merge now, minor suggestions only
  | 'REQUEST_CHANGES'   // Need changes before approval
  | 'REQUEST_TESTS'     // Must add tests before approval
  | 'REJECT';           // Completely wrong approach

/**
 * Structured review report
 */
export interface ReviewReport {
  issue_id: string;
  round: number;
  decision: ReviewDecision;
  codeQuality: {
    logicCorrect: boolean;
    namingGood: boolean;
    performanceOk: boolean;
    securityOk: boolean;
  };
  mustFix: string[];
  suggestions: string[];
  testStatus?: {
    hasTests: boolean;
    testsPass: boolean;
    coverage?: string;
  };
  testRequirements?: string;  // For REQUEST_TESTS decision
  summary: string;
}

/**
 * Build Review Agent prompt
 */
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

/**
 * Parse review decision from report content
 */
export function parseReviewDecision(reportContent: string): ReviewDecision {
  const lines = reportContent.split('\n');
  for (const line of lines) {
    // Support both English "## Review Decision" and Chinese "## 评审结果:"
    if (line.startsWith('## 评审结果:') || line.startsWith('## Review Decision')) {
      const decision = line.split(':')[1].trim().toUpperCase().replace(' ', '_');
      if (decision === 'APPROVE') return 'APPROVE';
      if (decision === 'APPROVE_MINOR') return 'APPROVE_MINOR';
      if (decision === 'REQUEST_CHANGES') return 'REQUEST_CHANGES';
      if (decision === 'REQUEST_TESTS') return 'REQUEST_TESTS';
      if (decision === 'REJECT') return 'REJECT';
    }
  }
  return 'APPROVE'; // default to approve if can't parse
}

/**
 * Format Linear comment from review report
 */
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
  comment += `### Summary\n${report.summary}\n\n`;

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