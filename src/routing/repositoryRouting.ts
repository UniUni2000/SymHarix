import * as path from 'path';
import type {
  Issue,
  RepositoryRouteConfig,
  ResolvedRepositoryRoute,
  TrackerError,
  WorkflowDefinition,
} from '../types';
import { sanitizeWorkspaceKey } from '../workspace/shared';

export type RepositoryRoutingErrorCode =
  | TrackerError
  | 'invalid_repository_route_config';

export class RepositoryRoutingError extends Error {
  readonly code: RepositoryRoutingErrorCode;

  constructor(code: RepositoryRoutingErrorCode, message: string) {
    super(message);
    this.name = 'RepositoryRoutingError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  routeKey: string,
  fieldName: keyof RepositoryRouteConfig,
  value: unknown,
): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  throw new RepositoryRoutingError(
    'invalid_repository_route_config',
    `Invalid repositories.routing entry for "${routeKey}": ${fieldName} is required.`,
  );
}

function resolveOptionalLocalPath(projectRoot: string, routeKey: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new RepositoryRoutingError(
      'invalid_repository_route_config',
      `Invalid repositories.routing entry for "${routeKey}": local_path must be a string when provided.`,
    );
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(projectRoot, trimmed);
}

function resolveRequireRepoHarness(routeKey: string, value: unknown): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  throw new RepositoryRoutingError(
    'invalid_repository_route_config',
    `Invalid repositories.routing entry for "${routeKey}": require_repo_harness must be a boolean when provided.`,
  );
}

export function parseRepositoryRouteConfigMap(
  workflow: WorkflowDefinition,
  projectRoot: string,
): Record<string, RepositoryRouteConfig> {
  const repositories = isRecord(workflow.config.repositories)
    ? workflow.config.repositories
    : null;
  const routing = repositories && isRecord(repositories.routing)
    ? repositories.routing
    : null;

  if (!routing) {
    return {};
  }

  const parsed: Record<string, RepositoryRouteConfig> = {};
  for (const [projectSlug, rawEntry] of Object.entries(routing)) {
    if (!isRecord(rawEntry)) {
      throw new RepositoryRoutingError(
        'invalid_repository_route_config',
        `Invalid repositories.routing entry for "${projectSlug}": route must be an object.`,
      );
    }

    parsed[projectSlug] = {
      github_owner: requireNonEmptyString(projectSlug, 'github_owner', rawEntry.github_owner),
      github_repo: requireNonEmptyString(projectSlug, 'github_repo', rawEntry.github_repo),
      local_path: resolveOptionalLocalPath(projectRoot, projectSlug, rawEntry.local_path),
      require_repo_harness: resolveRequireRepoHarness(projectSlug, rawEntry.require_repo_harness),
    };
  }

  return parsed;
}

function buildCacheKey(githubOwner: string, githubRepo: string): string {
  return [
    sanitizeWorkspaceKey(githubOwner.toLowerCase()),
    sanitizeWorkspaceKey(githubRepo.toLowerCase()),
  ].join('__');
}

export class RepositoryRoutingService {
  constructor(
    private readonly routes: Record<string, RepositoryRouteConfig>,
  ) {}

  resolveIssue(issue: Issue): ResolvedRepositoryRoute {
    if (!issue.project_slug) {
      throw new RepositoryRoutingError(
        'missing_tracker_project_slug',
        `Cannot route ${issue.identifier} because it is missing Linear project_slug.`,
      );
    }

    const route = this.routes[issue.project_slug];
    if (!route) {
      const projectName = issue.project_name ? ` (${issue.project_name})` : '';
      throw new RepositoryRoutingError(
        'missing_repository_route',
        `Cannot route ${issue.identifier} because project_slug "${issue.project_slug}"${projectName} is not configured in repositories.routing.`,
      );
    }

    return {
      project_slug: issue.project_slug,
      project_name: issue.project_name,
      github_owner: route.github_owner,
      github_repo: route.github_repo,
      github_repo_full: `${route.github_owner}/${route.github_repo}`,
      local_path: route.local_path,
      cache_key: buildCacheKey(route.github_owner, route.github_repo),
      require_repo_harness: Boolean(route.require_repo_harness),
    };
  }
}
