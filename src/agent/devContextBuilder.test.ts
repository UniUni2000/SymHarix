import { describe, expect, test } from 'bun:test';
import { buildDevAgentContextMarkdown } from './devContextBuilder';
import type { DevAgentContext } from '../github/contextService';

function context(overrides: Partial<DevAgentContext> = {}): DevAgentContext {
  return {
    work_item: {} as DevAgentContext['work_item'],
    github_issue: {
      number: 126,
      url: 'https://github.com/acme/repo/issues/126',
      title: 'A'.repeat(1000),
      body: 'issue body '.repeat(1000),
      labels: ['test'],
      state: 'open',
    },
    issue_comments: Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      body: `comment ${index} `.repeat(500),
      author: 'symphony-bot',
      created_at: '2026-04-27T00:00:00Z',
      updated_at: '2026-04-27T00:00:00Z',
      url: `https://github.com/acme/repo/issues/126#issuecomment-${index}`,
    })),
    active_pr: {
      number: 84,
      url: 'https://github.com/acme/repo/pull/84',
      title: 'PR title '.repeat(200),
      body: 'PR body',
      state: 'open',
      draft: false,
      head_branch: 'feature/int-126',
      head_sha: 'abc123',
      base_branch: 'main',
      mergeable: true,
      mergeable_state: 'clean',
      review_state: 'changes_requested',
      reviews: [],
      review_comments: [],
      review_threads: [],
      combined_status: { state: 'pending', statuses: [] },
    },
    unresolved_review_threads: Array.from({ length: 12 }, (_, index) => ({
      thread_key: `thread-${index}`,
      path: `src/file-${index}.ts`,
      line: 10 + index,
      resolved: false,
      comments: [{
        id: index + 1,
        body: `review thread ${index} `.repeat(500),
        path: `src/file-${index}.ts`,
        line: 10 + index,
        in_reply_to_id: null,
        author: 'reviewer',
        created_at: '2026-04-27T00:00:00Z',
        updated_at: '2026-04-27T00:00:00Z',
        url: `https://github.com/acme/repo/pull/84#discussion_r${index}`,
      }],
    })),
    latest_review: {
      id: 'review-1',
      work_item_id: 'wi-1',
      pr_number: 84,
      review_round: 1,
      decision: 'REQUEST_CHANGES',
      summary_md: 'review summary '.repeat(500),
      requested_changes_md: null,
      merge_block_reason: null,
      created_at: new Date('2026-04-27T00:00:00Z'),
    },
    recent_agent_runs: [],
    ...overrides,
  };
}

describe('buildDevAgentContextMarkdown', () => {
  test('keeps GitHub context compact enough for a first dev turn', () => {
    const markdown = buildDevAgentContextMarkdown(context());

    expect(markdown.length).toBeLessThanOrEqual(5000);
    expect(markdown).toContain('GitHub Issue: #126');
    expect(markdown).toContain('PR: #84');
    expect(markdown).toContain('Unresolved Review Threads');
    expect(markdown).not.toContain('thread 11');
    expect(markdown).not.toContain('comment 0 comment 0 comment 0 comment 0 comment 0');
  });
});
