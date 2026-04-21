import type { ReviewAgentContext } from '../github/contextService';

function truncate(value: string, maxLength: number = 1400): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trim()}\n...`;
}

export function summarizeReviewContext(context: ReviewAgentContext): string {
  const parts: string[] = [];

  if (context.github_issue) {
    parts.push(`GitHub issue #${context.github_issue.number}`);
  }
  if (context.active_pr) {
    parts.push(`PR #${context.active_pr.number}`);
    parts.push(`review_state=${context.active_pr.review_state}`);
  }
  if (context.latest_dev_run) {
    parts.push(`latest dev run=${context.latest_dev_run.run_status}`);
  }

  return parts.join(', ') || 'PR review context only';
}

export function buildReviewAgentContextMarkdown(context: ReviewAgentContext): string {
  const lines: string[] = ['## GitHub Review Context'];

  if (context.github_issue) {
    lines.push(`- GitHub Issue: #${context.github_issue.number} ${context.github_issue.title}`);
    lines.push(`- GitHub Issue URL: ${context.github_issue.url}`);
    if (context.github_issue.body) {
      lines.push('');
      lines.push('### GitHub Issue Body');
      lines.push(truncate(context.github_issue.body));
    }
  }

  if (context.active_pr) {
    lines.push('');
    lines.push('### Pull Request');
    lines.push(`- PR: #${context.active_pr.number} ${context.active_pr.title}`);
    lines.push(`- URL: ${context.active_pr.url}`);
    lines.push(`- Branch: ${context.active_pr.head_branch} -> ${context.active_pr.base_branch}`);
    lines.push(`- Review State: ${context.active_pr.review_state}`);
    lines.push(`- Mergeable: ${context.active_pr.mergeable === null ? 'unknown' : String(context.active_pr.mergeable)}`);
    if (context.active_pr.mergeable_state) {
      lines.push(`- Mergeable State: ${context.active_pr.mergeable_state}`);
    }
    if (context.active_pr.combined_status) {
      lines.push(`- Checks: ${context.active_pr.combined_status.state}`);
    }
  } else {
    lines.push('');
    lines.push('### Pull Request');
    lines.push('- No active PR was found. Review should explain that development has not produced a PR yet.');
  }

  if (context.previous_reviews.length > 0) {
    lines.push('');
    lines.push('### Previous Review Rounds');
    for (const review of context.previous_reviews.slice(-5)) {
      lines.push(`- Round ${review.review_round}: ${review.decision} - ${truncate(review.summary_md, 180)}`);
    }
  }

  if (context.latest_dev_run?.output_summary) {
    lines.push('');
    lines.push('### Latest Dev Summary');
    lines.push(truncate(context.latest_dev_run.output_summary));
  }

  if (context.active_pr?.review_threads.length) {
    lines.push('');
    lines.push('### Existing Review Threads');
    for (const thread of context.active_pr.review_threads.slice(0, 10)) {
      const latestComment = thread.comments[thread.comments.length - 1];
      lines.push(`- ${thread.path || '(unknown file)'}:${thread.line || '?'} - ${truncate(latestComment?.body || '(no comment)', 200)}`);
    }
  }

  return lines.join('\n');
}
