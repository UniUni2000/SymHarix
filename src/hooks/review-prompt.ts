/**
 * Review Agent Prompt Templates
 * Handles code review with structured feedback
 */

import type { Issue } from '../types';
import { isSupervisorLiveVerifierText } from './dev-prompt';

/**
 * Review decision types
 */
export type ReviewDecision =
  | 'APPROVE'           // Can merge, code is correct and well-written
  | 'APPROVE_MINOR'     // Can merge now, minor suggestions only
  | 'REQUEST_CHANGES'   // Need changes before approval
  | 'REQUEST_TESTS'     // Must add tests before approval
  | 'REJECT';           // Completely wrong approach

export interface ParsedCanonicalReviewReport {
  decision: ReviewDecision;
  summary: string;
  content: string;
}

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
  previousReviews?: ReviewReport[],
  githubContext?: string,
  harnessGuidance?: string,
  supervisorGuidance?: string,
): string {
  const liveVerifierFastPath = isSupervisorLiveVerifierText(`${issue.title}\n${issue.description || ''}`);
  const englishOutput = /original user request is English/i.test(supervisorGuidance || '');
  const historySection = previousReviews && previousReviews.length > 0
    ? previousReviews.map(r =>
        `- Round ${r.round}: ${r.decision} - ${r.summary.slice(0, 100)}`
      ).join('\n')
    : '(no previous reviews)';
  const reviewVerification = liveVerifierFastPath
    ? 'For supervisor live verifier marker tasks, review only the requested marker file, git diff/stat, and PR metadata. Do not run full repository test suites or broad build commands.'
    : 'Run the narrowest relevant tests for the changed code; for Python code prefer the affected `pytest` target.';
  const liveVerifierGuidance = liveVerifierFastPath
    ? `## Supervisor Live Verifier Review Fast Path
- This is a bounded verification marker review, not a full product review.
- review only the requested marker file, the commit diff, and the PR metadata.
- Do not run full repository test suites or broad build commands unless the issue explicitly asks for them.
- If the marker path and content satisfy the approved plan, write the canonical review report in the same turn.
`
    : '';

  return `You are a CODE REVIEWER for issue ${issue.identifier}.

## Issue Information
- **Title**: ${issue.title}
- **Description**: ${issue.description || '(no description)'}
- **Labels**: ${issue.labels.join(', ') || '(none)'}

${githubContext || ''}
${harnessGuidance ? `\n${harnessGuidance}` : ''}
${supervisorGuidance ? `\n${supervisorGuidance}` : ''}
${liveVerifierGuidance}

## Your Responsibilities
1. **First: Read \`.symphony/HANDOVER.md\`** — This is DEV's summary of what was done
2. Read repo-local contracts if present: \`.symphony-repo.yaml\`, \`.symphony-constitution.md\`, and \`.symphony/change-pack/*\`
3. Inspect the local worktree diff directly with git and file reads; do not rely only on prior reports
4. ${reviewVerification}
5. Assess code quality: logic, naming, performance, security
6. **Give feedback in "${englishOutput ? 'Current+Expected' : '现状+期望'}" format** — Do NOT give solutions
7. Put the final decision in \`.symphony/REVIEW_REPORT.md\` so the orchestrator and review executor can act on it
8. For straightforward small diffs, prefer completing the review in a single focused pass and writing the report in the same turn
9. Treat the review as incomplete until \`.symphony/REVIEW_REPORT.md\` exists with the final decision line and review summary section

## Required Decision Line
Include one exact machine-readable line near the top of \`.symphony/REVIEW_REPORT.md\`:
- \`## Review Decision: APPROVE\`
- \`## Review Decision: APPROVE_MINOR\`
- \`## Review Decision: REQUEST_CHANGES\`
- \`## Review Decision: REQUEST_TESTS\`
- \`## Review Decision: REJECT\`

Also include a non-empty canonical summary section:
- \`## Review Summary\`

Do not rely on only prose headings like “最终决定”; only the exact decision line above plus \`## Review Summary\` count as a valid review artifact.

## Safe Report Write Pattern
Use the Write/Edit tool when available. If you use Bash, use this exact shape from the workspace root:
\`\`\`bash
cat > .symphony/REVIEW_REPORT.md <<'EOF'
## Review Decision: APPROVE

## Review Summary
...
EOF
\`\`\`
Do not run a bare path like \`.symphony/REVIEW_REPORT.md <<'EOF'\` or \`INT-123/.symphony/REVIEW_REPORT.md <<'EOF'\`; the shell treats that path as a command and fails.
Do not commit \`.symphony/REVIEW_REPORT.md\`.

## Feedback Format (MUST follow)
For each issue found:
**${englishOutput ? 'Current' : '现状'}**: {${englishOutput ? 'current behavior' : '现在的行为'}}
**${englishOutput ? 'Expected' : '期望'}**: {${englishOutput ? 'expected behavior' : '期望的行为'}}
**${englishOutput ? 'File' : '文件'}**: {${englishOutput ? 'file:line' : '文件:行号'}}

## Review Decision Options

| Decision | When to Use |
|----------|-------------|
| APPROVE | Code is correct, well-written, tests pass |
| APPROVE_MINOR | Can merge now, minor suggestions only |
| REQUEST_CHANGES | Need changes before approval |
| REQUEST_TESTS | Must add tests before approval |
| REJECT | Completely wrong approach |

## Development Context (from \`.symphony/DEVELOPMENT_LOG.md\`)
${devLog || '(no development log found)'}

## Previous Review Rounds
${historySection}

## After Your Review
1. Overwrite \`.symphony/REVIEW_REPORT.md\` from scratch in the workspace (do NOT append to stale content and do NOT commit it)
2. The orchestrator will sync the final summary back to GitHub / Linear
3. The review executor will merge only if your final decision is APPROVE or APPROVE_MINOR
4. Do not commit files under \`.symphony/\`
5. If you need notes while reviewing, keep them transient and still end the same turn with the final \`.symphony/REVIEW_REPORT.md\`
6. Keep \`.symphony/change-pack/evidence.json\` aligned with the final review state
7. Do not stop the turn until the final \`.symphony/REVIEW_REPORT.md\` has been written
`;
}

/**
 * Parse a canonical review report from report content
 */
export function parseCanonicalReviewReport(reportContent: string): ParsedCanonicalReviewReport | null {
  const content = reportContent.trim();
  if (!content) {
    return null;
  }

  const decisionMatch = content.match(/^## Review Decision:\s*(APPROVE|APPROVE_MINOR|REQUEST_CHANGES|REQUEST_TESTS|REJECT)\s*$/m);
  if (!decisionMatch?.[1]) {
    return null;
  }

  const summaryHeading = /^## Review Summary\s*$/m;
  const summaryMatch = summaryHeading.exec(content);
  if (!summaryMatch) {
    return null;
  }

  const summaryStart = summaryMatch.index + summaryMatch[0].length;
  const remaining = content.slice(summaryStart).replace(/^\s+/, '');
  const nextHeadingMatch = remaining.match(/^##\s+/m);
  const summary = (nextHeadingMatch ? remaining.slice(0, nextHeadingMatch.index) : remaining).trim();
  if (!summary) {
    return null;
  }

  return {
    decision: decisionMatch[1] as ReviewDecision,
    summary,
    content,
  };
}

export function parseReviewDecision(reportContent: string): ReviewDecision | null {
  return parseCanonicalReviewReport(reportContent)?.decision ?? null;
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

  comment += `\n---\n*Automated review by SymHarix Agent*\n`;

  return comment;
}
