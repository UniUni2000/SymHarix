/**
 * Review Agent Prompt Templates
 * Handles code review with structured feedback
 */

import type { Issue } from '../types';

/**
 * Review decision types
 */
export type ReviewDecision =
  | 'approve'           // Can merge
  | 'approve_minor'     // Can merge, minor suggestions
  | 'request_changes_minor'  // Need small changes
  | 'request_changes_major' // Need significant changes
  | 'request_tests'         // Need tests
  | 'reject';               // Completely unacceptable

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
  testRequirements?: string;  // For request_tests decision
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
        `- Round ${r.round}: ${r.decision.toUpperCase()} - ${r.summary.slice(0, 100)}`
      ).join('\n')
    : '(no previous reviews)';

  return `You are a CODE REVIEWER for issue ${issue.identifier}.

## Issue Information
- **Title**: ${issue.title}
- **Description**: ${issue.description || '(no description)'}
- **Labels**: ${issue.labels.join(', ') || '(none)'}

## Development Context (from DEVELOPMENT_LOG.md)
${devLog || '(no development log found)'}

## Previous Review Rounds
${historySection}

## Your Review Process
1. First read DEVELOPMENT_LOG.md to understand what was done
2. Review the PR/Diff: examine changed files carefully
3. Run tests if available: \`npm test\` or \`bun test\`
4. Assess code quality: logic, naming, performance, security
5. Generate a structured review report

## Review Decision Options
Choose ONE of these:

| Decision | When to Use |
|----------|-------------|
| APPROVE | Code is correct, well-written, tests pass (if required) |
| APPROVE_MINOR | Can merge now, small suggestions (naming, comments) |
| REQUEST_CHANGES_MINOR | Need small changes (typos, formatting, minor logic) |
| REQUEST_CHANGES_MAJOR | Need significant changes (architecture, logic bugs) |
| REQUEST_TESTS | Must add tests before approval |
| REJECT | Completely wrong approach, start over |

## Test Requirements (if complexity=large or medium)
- Check if tests exist and pass
- If tests missing: REQUEST_TESTS with specific requirements
- If tests fail: REQUEST_CHANGES with failure details

## Output Format
Generate your review report in Markdown format and save to REVIEW_REPORT.md:

\`\`\`markdown
# Review Report: ${issue.identifier}

## 基本信息
- **Issue**: ${issue.identifier}
- **Review Round**: ${(previousReviews?.length || 0) + 1}
- **Reviewer**: Symphony Review Agent
- **时间**: \${new Date().toISOString()}

## 评审结果: [APPROVE | APPROVE_MINOR | REQUEST_CHANGES_MINOR | REQUEST_CHANGES_MAJOR | REQUEST_TESTS | REJECT]

## 代码质量
- ✅/❌ 逻辑正确
- ✅/❌ 命名规范
- ✅/❌ 性能考虑
- ✅/❌ 安全性

## 具体意见

### 必须修复
1. [list must-fix items]

### 建议改进
1. [list suggestions]

### 测试情况
- 有测试: YES/NO
- 测试通过: YES/NO

## 总结
[2-3 sentence summary of the review]

## 下次继续（如需打回）
[If requesting changes, explain what DEV should do next]
\`\`\`

## After Your Review
- Write the report to REVIEW_REPORT.md in the workspace
- The after-run hook will post a comment to the Linear issue
- The orchestrator will update Linear state based on your decision
`;
}

/**
 * Parse review decision from report content
 */
export function parseReviewDecision(reportContent: string): ReviewDecision {
  const lines = reportContent.split('\n');
  for (const line of lines) {
    if (line.startsWith('## 评审结果:')) {
      const decision = line.split(':')[1].trim().toLowerCase().replace('_', '');
      if (decision.includes('approve') && !decision.includes('minor')) return 'approve';
      if (decision.includes('approve') && decision.includes('minor')) return 'approve_minor';
      if (decision.includes('request_changes') && decision.includes('minor')) return 'request_changes_minor';
      if (decision.includes('request_changes') && decision.includes('major')) return 'request_changes_major';
      if (decision.includes('request_tests')) return 'request_tests';
      if (decision.includes('reject')) return 'reject';
    }
  }
  return 'approve'; // default to approve if can't parse
}

/**
 * Format Linear comment from review report
 */
export function formatLinearComment(report: ReviewReport): string {
  const emoji: Record<ReviewDecision, string> = {
    approve: '✅',
    approve_minor: '👍',
    request_changes_minor: '⚠️',
    request_changes_major: '🔴',
    request_tests: '🧪',
    reject: '🚫'
  };

  const labels: Record<ReviewDecision, string> = {
    approve: 'APPROVED',
    approve_minor: 'APPROVED (Minor Suggestions)',
    request_changes_minor: 'Changes Requested (Minor)',
    request_changes_major: 'Changes Requested (Major)',
    request_tests: 'Tests Required',
    reject: 'REJECTED'
  };

  let comment = `## Code Review ${emoji[report.decision]} **${labels[report.decision]}**\n\n`;
  comment += `**Round ${report.round}** | Review Agent\n\n`;
  comment += `### Summary\n${report.summary}\n\n`;

  if (report.mustFix.length > 0) {
    comment += `### Must Fix\n`;
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