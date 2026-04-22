import { describe, expect, it } from 'bun:test';
import * as path from 'path';
import type { Issue, WorkflowDefinition } from '../types';
import {
  RepositoryRoutingError,
  RepositoryRoutingService,
  parseRepositoryRouteConfigMap,
} from './repositoryRouting';

function makeWorkflow(config: Record<string, unknown>): WorkflowDefinition {
  return {
    config,
    prompt_template: 'Prompt',
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'INT-1',
    title: 'Route this issue',
    description: null,
    priority: 1,
    state: 'Todo',
    project_slug: 'repo-a',
    project_name: 'Repo A',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-04-21T00:00:00Z'),
    updated_at: new Date('2026-04-21T00:00:00Z'),
    ...overrides,
  };
}

describe('RepositoryRoutingService', () => {
  it('parses project_slug keyed routes and resolves relative local paths against the project root', () => {
    const projectRoot = '/tmp/symphony-project';
    const workflow = makeWorkflow({
      repositories: {
        routing: {
          'repo-a': {
            github_owner: 'acme',
            github_repo: 'repo-a',
            local_path: './repos/repo-a',
          },
          'backend-core': {
            github_owner: 'acme-platform',
            github_repo: 'backend',
          },
        },
      },
    });

    const routes = parseRepositoryRouteConfigMap(workflow, projectRoot);
    const service = new RepositoryRoutingService(routes);

    expect(routes['repo-a']).toEqual({
      github_owner: 'acme',
      github_repo: 'repo-a',
      local_path: path.resolve(projectRoot, 'repos/repo-a'),
      require_repo_harness: false,
    });
    expect(routes['backend-core']).toEqual({
      github_owner: 'acme-platform',
      github_repo: 'backend',
      local_path: null,
      require_repo_harness: false,
    });

    const resolved = service.resolveIssue(makeIssue());
    expect(resolved).toEqual({
      project_slug: 'repo-a',
      project_name: 'Repo A',
      github_owner: 'acme',
      github_repo: 'repo-a',
      github_repo_full: 'acme/repo-a',
      local_path: path.resolve(projectRoot, 'repos/repo-a'),
      cache_key: 'acme__repo-a',
      require_repo_harness: false,
    });
  });

  it('reuses the same cache key when multiple Linear projects point at the same GitHub repository', () => {
    const service = new RepositoryRoutingService({
      'repo-a': {
        github_owner: 'acme',
        github_repo: 'shared-repo',
        local_path: null,
      },
      'repo-b': {
        github_owner: 'acme',
        github_repo: 'shared-repo',
        local_path: null,
      },
    });

    const first = service.resolveIssue(makeIssue({ project_slug: 'repo-a', project_name: 'Repo A' }));
    const second = service.resolveIssue(makeIssue({
      id: 'issue-2',
      identifier: 'INT-2',
      project_slug: 'repo-b',
      project_name: 'Repo B',
    }));

    expect(first.cache_key).toBe('acme__shared-repo');
    expect(second.cache_key).toBe('acme__shared-repo');
  });

  it('fails with a stable error when the issue has no project_slug', () => {
    const service = new RepositoryRoutingService({
      'repo-a': {
        github_owner: 'acme',
        github_repo: 'repo-a',
        local_path: null,
      },
    });

    expect(() => service.resolveIssue(makeIssue({ project_slug: null, project_name: 'Repo A' }))).toThrow(
      new RepositoryRoutingError(
        'missing_tracker_project_slug',
        'Cannot route INT-1 because it is missing Linear project_slug.',
      ),
    );
  });

  it('fails closed with a stable error when project_slug is not configured', () => {
    const service = new RepositoryRoutingService({
      'repo-a': {
        github_owner: 'acme',
        github_repo: 'repo-a',
        local_path: null,
      },
    });

    expect(() => service.resolveIssue(makeIssue({ project_slug: 'repo-b', project_name: 'Repo B' }))).toThrow(
      new RepositoryRoutingError(
        'missing_repository_route',
        'Cannot route INT-1 because project_slug "repo-b" (Repo B) is not configured in repositories.routing.',
      ),
    );
  });

  it('rejects malformed repository routes during config parsing', () => {
    const workflow = makeWorkflow({
      repositories: {
        routing: {
          'repo-a': {
            github_owner: 'acme',
          },
        },
      },
    });

    expect(() => parseRepositoryRouteConfigMap(workflow, '/tmp/symphony-project')).toThrow(
      new RepositoryRoutingError(
        'invalid_repository_route_config',
        'Invalid repositories.routing entry for "repo-a": github_repo is required.',
      ),
    );
  });
});
