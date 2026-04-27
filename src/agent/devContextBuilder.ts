import type { DevAgentContext } from '../github/contextService';

const MAX_DEV_CONTEXT_LENGTH = 5000;

function truncate(value: string, maxLength: number = 1200): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trim()}\n...`;
}

function truncateContext(markdown: string): string {
  if (markdown.length <= MAX_DEV_CONTEXT_LENGTH) {
    return markdown;
  }

  return `${markdown.slice(0, MAX_DEV_CONTEXT_LENGTH - 80).trim()}\n...\n[GitHub context truncated for first-turn budget]`;
}

export function summarizeDevContext(context: DevAgentContext): string {
  const parts: string[] = [];

  if (context.github_issue) {
    parts.push(`GitHub issue #${context.github_issue.number}`);
  }
  if (context.active_pr) {
    parts.push(`PR #${context.active_pr.number}`);
  }
  if (context.latest_review) {
    parts.push(`latest review=${context.latest_review.decision}`);
  }
  if (context.unresolved_review_threads.length > 0) {
    parts.push(`${context.unresolved_review_threads.length} unresolved review thread(s)`);
  }

  return parts.join(', ') || 'GitHub issue context only';
}

export function buildDevAgentContextMarkdown(context: DevAgentContext): string {
  const lines: string[] = ['## GitHub Context'];

  if (context.github_issue) {
    lines.push(`- GitHub Issue: #${context.github_issue.number} ${truncate(context.github_issue.title, 180)}`);
    lines.push(`- GitHub Issue URL: ${context.github_issue.url}`);
    if (context.github_issue.body) {
      lines.push('');
      lines.push('### GitHub Issue Body');
      lines.push(truncate(context.github_issue.body, 700));
    }
  } else {
    lines.push('- GitHub Issue: (not mapped yet)');
  }

  if (context.active_pr) {
    lines.push('');
    lines.push('### Active Pull Request');
    lines.push(`- PR: #${context.active_pr.number} ${truncate(context.active_pr.title, 180)}`);
    lines.push(`- State: ${context.active_pr.state}`);
    lines.push(`- Branch: ${context.active_pr.head_branch} -> ${context.active_pr.base_branch}`);
    lines.push(`- Review State: ${context.active_pr.review_state}`);
    if (context.active_pr.combined_status) {
      lines.push(`- Checks: ${context.active_pr.combined_status.state}`);
    }
  } else {
    lines.push('');
    lines.push('### Active Pull Request');
    lines.push('- No PR yet. You are expected to create or update the issue PR when development is complete.');
  }

  if (context.latest_review) {
    lines.push('');
    lines.push('### Latest Review Summary');
    lines.push(`- Decision: ${context.latest_review.decision}`);
    lines.push(truncate(context.latest_review.summary_md, 500));
  }

  if (context.unresolved_review_threads.length > 0) {
    lines.push('');
    lines.push('### Unresolved Review Threads');
    for (const thread of context.unresolved_review_threads.slice(0, 5)) {
      const latestComment = thread.comments[thread.comments.length - 1];
      lines.push(
        `- ${thread.path || '(unknown file)'}:${thread.line || '?'} - ${truncate(latestComment?.body || '(no comment)', 160)}`
      );
    }
    if (context.unresolved_review_threads.length > 5) {
      lines.push(`- ... ${context.unresolved_review_threads.length - 5} more unresolved thread(s) omitted`);
    }
  }

  if (context.issue_comments.length > 0) {
    lines.push('');
    lines.push('### GitHub Issue Notes');
    for (const comment of context.issue_comments.slice(-2)) {
      lines.push(`- ${comment.author || 'unknown'}: ${truncate(comment.body, 160)}`);
    }
  }

  return truncateContext(lines.join('\n'));
}
