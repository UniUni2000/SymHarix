import { describe, expect, test } from 'bun:test';
import type { Issue } from '../types';
import { buildDevPrompt } from './dev-prompt';
import { buildReviewPrompt } from './review-prompt';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'INT-124',
    title: '创建 docs/supervisor-live-cleanup-approval-smoke.md，写一句 approval verified',
    description: 'supervisor live E2E root-only verifier marker; 不要扫描全仓，不要创建 child queue。',
    priority: null,
    state: 'Todo',
    project_slug: 'test2',
    project_name: 'test2',
    branch_name: 'feature/int-124',
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

describe('agent prompts', () => {
  test('tells dev agents to verify supervisor live marker tasks narrowly instead of running broad suites', () => {
    const prompt = buildDevPrompt(issue());

    expect(prompt).toContain('Supervisor Live Verifier Fast Path');
    expect(prompt).toContain('Do not scan the whole repo');
    expect(prompt).toContain('Do not run full repository test suites');
    expect(prompt).toContain('Symphony post-processing owns commit, push, and PR creation');
    expect(prompt).not.toContain('Read repo-local contracts if present');
    expect(prompt).not.toContain('Keep `.symphony/change-pack/tasks.md`');
    expect(prompt).not.toContain('Write and run tests (required for small complexity)');
    expect(prompt).not.toContain('Commit product changes, push, and create PR');
  });

  test('keeps git delivery out of the dev agent prompt', () => {
    const prompt = buildDevPrompt(issue({
      title: 'Add a README smoke line',
      description: 'Append one sentence to README.md.',
    }));

    expect(prompt).toContain('Do not run `git add`, `git commit`, `git push`, `gh pr`');
    expect(prompt).toContain('Symphony post-processing will commit product changes, push, and create the PR');
    expect(prompt).toContain('When complete: create `.symphony/HANDOVER.md`');
    expect(prompt).not.toContain('Commit changes, push, and create PR');
    expect(prompt).not.toContain('When complete: commit, push, create PR');
  });

  test('compacts supervisor live verifier issue and injected context before the first dev turn', () => {
    const prompt = buildDevPrompt(
      issue({
        title: '请验证破坏性清理审批：这是一条 root-only 单，不要拆分，不要创建 child queue，不要创建子任务。不要扫描全仓。',
        description: '批准后只创建这个可提交的验证标记文件：docs/supervisor-live-cleanup-approval-case.md。'.repeat(20),
      }),
      undefined,
      [
        '## GitHub Context',
        '### GitHub Issue Body',
        'very large github body '.repeat(200),
        '### GitHub Issue Notes',
        'old noisy note '.repeat(200),
      ].join('\n'),
      '## Repository Harness Contract\n- Required Verification Commands: bun test, bun run build',
      '## Supervisor-Approved Plan\n## Supervisor Session Memory\n- user_message: '.concat('large session event '.repeat(200)),
    );

    expect(prompt).toContain('Supervisor live verifier marker task');
    expect(prompt).toContain('docs/supervisor-live-cleanup-approval-case.md');
    expect(prompt).not.toContain('GitHub Issue Body');
    expect(prompt).not.toContain('GitHub Issue Notes');
    expect(prompt).not.toContain('Required Verification Commands: bun test');
    expect(prompt).not.toContain('Supervisor Session Memory');
    expect(prompt.length).toBeLessThan(7000);
  });

  test('tells review agents to review supervisor live marker tasks with narrow file checks', () => {
    const prompt = buildReviewPrompt(issue(), 'Created the marker file.');

    expect(prompt).toContain('Supervisor Live Verifier Review Fast Path');
    expect(prompt).toContain('review only the requested marker file');
    expect(prompt).toContain('Do not run full repository test suites');
  });

  test('tells review agents to write the canonical report with the Write tool', () => {
    const prompt = buildReviewPrompt(issue(), 'Created the marker file.');

    expect(prompt).toContain('Review Report Write Protocol');
    expect(prompt).toContain('native Write tool');
    expect(prompt).toContain('exact relative path `.symphony/REVIEW_REPORT.md`');
    expect(prompt).toContain('Do not use Bash heredocs');
    expect(prompt).toContain('read back `.symphony/REVIEW_REPORT.md`');
  });
});
