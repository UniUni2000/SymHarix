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

export function isSupervisorLiveVerifierText(value: string): boolean {
  return /supervisor\s+live\s+e2e|docs\/supervisor-live|supervisor-live-cleanup-approval/i.test(value);
}

function extractSupervisorLiveVerifierPaths(value: string): string[] {
  const matches = value.match(/docs\/supervisor-live[^\s，。；;、"'`)]+\.md/gi) ?? [];
  return [...new Set(matches.map(match => match.replace(/[，。；;、]+$/, '')))];
}

function buildSupervisorLiveVerifierDescription(issue: Issue): string {
  const combinedText = `${issue.title}\n${issue.description || ''}`;
  const markerPaths = extractSupervisorLiveVerifierPaths(combinedText);
  const markerLine = markerPaths.length > 0
    ? markerPaths.join(', ')
    : 'the explicitly requested docs/supervisor-live-*.md marker path';

  return [
    'Bounded supervisor live verifier marker task.',
    `Create or update only: ${markerLine}.`,
    'Do not scan the whole repo, do not inspect unrelated historical supervisor-live files, and do not create child tasks.',
    'Use narrow verification only, then write .symphony/HANDOVER.md and stop for orchestrator post-processing.',
  ].join(' ');
}

function extractOutputLanguageGuidance(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/## Output Language[\s\S]*?(?=\n## |\n$)/);
  return match?.[0]?.trim() || undefined;
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

  if (isSupervisorLiveVerifierText(combinedText)) {
    smallScore += 4;
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
  const liveVerifierFastPath = isSupervisorLiveVerifierText(`${issue.title}\n${issue.description || ''}`);
  const promptTitle = liveVerifierFastPath ? 'Supervisor live verifier marker task' : issue.title;
  const promptDescription = liveVerifierFastPath
    ? buildSupervisorLiveVerifierDescription(issue)
    : issue.description || '(no description)';
  const effectiveGithubContext = liveVerifierFastPath
    ? '## GitHub Context\n- Omitted for bounded live verifier. Use the compact Issue Information and exact requested marker path above.'
    : githubContext;
  const effectiveHarnessGuidance = liveVerifierFastPath ? undefined : harnessGuidance;
  const effectiveSupervisorGuidance = liveVerifierFastPath
    ? extractOutputLanguageGuidance(supervisorGuidance)
    : supervisorGuidance;
  const englishOutput = /original user request is English/i.test(supervisorGuidance || '');
  const testResponsibility = liveVerifierFastPath
    ? 'Do not run full repository test suites. Use narrow file checks for the requested marker path, such as `test -f <path>`, `ls -la <path>`, `git diff --stat`, and `git status`.'
    : judgment.requiresTests
      ? 'Write and run targeted tests for the changed code. Prefer the narrowest relevant command over a broad suite.'
      : 'Run only narrow verification needed for the changed file; avoid broad test suites unless the issue explicitly asks for them.';
  const liveVerifierGuidance = liveVerifierFastPath
    ? `## Supervisor Live Verifier Fast Path
- This is a bounded live E2E verifier task, not a product cleanup project.
- Do not scan the whole repo or inspect unrelated historical live-verifier files.
- Touch only the requested deliverable path(s), usually one \`docs/supervisor-live-*.md\` marker.
- Do not run full repository test suites or broad build commands unless the issue explicitly asks for them.
- Finish in one focused pass after the marker file exists, narrow verification is recorded, and the PR is created.
`
    : '';
  const responsibilities = liveVerifierFastPath
    ? [
        '1. Create or update only the requested supervisor-live marker file',
        `2. ${testResponsibility}`,
        '3. Create `.symphony/HANDOVER.md` with a concise development summary',
        '4. Stop after handover; the orchestrator/state machine owns commit, push, PR creation, and tracker sync',
      ].join('\n')
    : [
        '1. Analyze the issue and implement the required changes',
        `2. ${testResponsibility}`,
        '3. Read repo-local contracts if present: `.symphony-repo.yaml` and `.symphony-constitution.md`',
        '4. Keep `.symphony/change-pack/tasks.md` and `.symphony/change-pack/evidence.json` aligned with the real state of the work',
        '5. Update `.symphony/DEVELOPMENT_LOG.md` after each significant step',
        '6. **When done: create `.symphony/HANDOVER.md` with development summary**',
        '7. Stop after handover; the orchestrator/state machine owns commit, push, PR creation, tracker updates, and final synchronization',
      ].join('\n');
  const liveVerifierImportant = liveVerifierFastPath
    ? `- Do not read or edit unrelated \`.symphony/change-pack/*\` files unless the narrow marker task cannot complete without them.
- Do not read repo-local contracts or historical docs for this bounded verifier; the approved contract is the marker path above.
- Do not glob \`docs/supervisor-live-*.md\`; use the exact requested marker path from Issue Information.`
    : null;

  const prompt = `You are a DEV Agent working on issue ${issue.identifier}.

## Issue Information
- **Title**: ${promptTitle}
- **Description**: ${promptDescription}
- **State**: ${issue.state}
- **Labels**: ${issue.labels.join(', ') || '(none)'}
${issue.branch_name ? `- **Branch**: ${issue.branch_name}` : ''}

${effectiveGithubContext ? `${effectiveGithubContext}\n` : ''}
${effectiveHarnessGuidance ? `${effectiveHarnessGuidance}\n` : ''}
${effectiveSupervisorGuidance ? `${effectiveSupervisorGuidance}\n` : ''}
${liveVerifierGuidance}

## Complexity Assessment
- **Complexity**: ${judgment.complexity.toUpperCase()}
- **Reasoning**: ${judgment.reasoning}
- **Requires Tests**: ${judgment.requiresTests ? 'YES - must write and pass tests' : 'NO - code changes only'}
${judgment.complexity === 'small' ? '- **Execution Style**: Prefer finishing in one focused pass if the change is straightforward.' : ''}

## Your Responsibilities
${responsibilities}

## \`.symphony/HANDOVER.md\` Template (required when completing)
\`\`\`markdown
# Handover: ${issue.identifier}

## ${englishOutput ? 'Development Summary' : '开发摘要'}
{${englishOutput ? 'one-sentence summary of what changed' : '一句话描述做了什么'}}

## ${englishOutput ? 'Change Scope' : '变更范围'}
- ${englishOutput ? 'file list' : '文件列表'}
- ${englishOutput ? 'added/deleted/modified' : '新增/删除/修改'}

## ${englishOutput ? 'Verification' : '测试情况'}
- ${englishOutput ? 'Unit tests' : '单元测试'}: PASS/FAIL/N/A
- ${englishOutput ? 'Integration tests' : '集成测试'}: PASS/FAIL/N/A

## ${englishOutput ? 'Known Issues' : '已知问题'}
{${englishOutput ? 'anything DEV thinks review should focus on' : 'DEV 认为可能有问题的地方，Review 重点关注'}}

## ${englishOutput ? 'Next Steps If Returned' : '下次继续（如需打回）'}
{${englishOutput ? 'leave blank; DEV does not fill this in' : '空，DEV 不填写'}}
\`\`\`

${existingLog ? `## Existing Progress\n${existingLog}\n---\nContinue from where the previous session left off.` : ''}

## Important
${liveVerifierImportant ? `${liveVerifierImportant}\n` : ''}
- GitHub Issue and PR are the source of engineering context. Prefer them over stale tracker text if they conflict.
- The orchestrator/state machine owns commit, push, PR creation, tracker updates, and final synchronization.
- After you stop, the orchestrator will stage and commit product-file changes while excluding \`.symphony/\` and cache artifacts.
- Do not run \`git commit\`.
- Do not run \`git push\`.
- Do not run \`gh pr create\`.
- If you think delivery is ready, write the required \`.symphony/HANDOVER.md\` and stop. Do not retry orchestrator-owned Git/PR commands.
- Do NOT decide if code is ready for review — that is Review's job
- For SMALL issues, avoid unnecessary multi-turn exploration. If the implementation and verification are already complete, finish the turn cleanly.
- If review feedback already exists, address it in the same branch and same worktree unless the context explicitly says otherwise
- If you discover the issue description is unclear, document it in \`.symphony/HANDOVER.md\` "${englishOutput ? 'Known Issues' : '已知问题'}" and continue with your best judgment
- Treat \`.symphony/change-pack/evidence.json\` as a proof-of-work checklist. Do not end the turn while required evidence is still missing.
- Workflow/process artifacts are never product files. Never stage or commit \`DEVELOPMENT_LOG.md\`, \`HANDOVER.md\`, \`REVIEW_REPORT.md\`, anything under \`.symphony/\`, or similar review/dev process notes.
- Do not delete \`.symphony/\` or \`.symphony/state.json\`. Symphony owns that private runtime directory; damaging it can break post-processing even when the product change is correct.
- If you are doing cleanup work, only clean user/product files explicitly in scope. Never use \`.symphony/\` as the final deliverable location.
- When complete: create \`.symphony/HANDOVER.md\`, make sure evidence is current, then stop for orchestrator post-processing.
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
Do not delete \`.symphony/\` or \`.symphony/state.json\`; Symphony owns that private runtime directory.
`;
}
