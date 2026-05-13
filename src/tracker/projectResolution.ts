import type {
  RepositoryRouteConfig,
  ResolvedRepositoryRoute,
  ResolvedTrackerProject,
} from '../types';
import { sanitizeWorkspaceKey } from '../workspace/shared';
import { LinearClient } from './linear-client';

function buildCacheKey(githubOwner: string, githubRepo: string): string {
  return [
    sanitizeWorkspaceKey(githubOwner.toLowerCase()),
    sanitizeWorkspaceKey(githubRepo.toLowerCase()),
  ].join('__');
}

function toResolvedRoute(
  projectSlug: string,
  projectName: string | null,
  route: RepositoryRouteConfig,
): ResolvedRepositoryRoute {
  return {
    project_slug: projectSlug,
    project_name: projectName,
    github_owner: route.github_owner,
    github_repo: route.github_repo,
    github_repo_full: `${route.github_owner}/${route.github_repo}`,
    local_path: route.local_path,
    cache_key: buildCacheKey(route.github_owner, route.github_repo),
    require_repo_harness: Boolean(route.require_repo_harness),
  };
}

export interface TrackerProjectResolutionResult {
  project: ResolvedTrackerProject | null;
  route: ResolvedRepositoryRoute | null;
  error?: string;
}

export type RepositoryRouteReferenceKind =
  | 'project_slug'
  | 'github_repo_full'
  | 'github_repo_name';

export interface RepositoryRouteReferenceMatch {
  route: ResolvedRepositoryRoute;
  matched_by: RepositoryRouteReferenceKind;
}

export function resolveRepositoryRouteReference(
  routes: readonly ResolvedRepositoryRoute[],
  reference: string | null | undefined,
): RepositoryRouteReferenceMatch | null {
  const normalized = reference?.trim();
  if (!normalized) {
    return null;
  }

  const lower = normalized.toLowerCase();
  const bySlug = routes.find((route) =>
    route.project_slug === normalized || route.project_slug.toLowerCase() === lower
  );
  if (bySlug) {
    return { route: bySlug, matched_by: 'project_slug' };
  }

  const byRepoFull = routes.find((route) => route.github_repo_full.toLowerCase() === lower);
  if (byRepoFull) {
    return { route: byRepoFull, matched_by: 'github_repo_full' };
  }

  const repoName = lower.includes('/') ? lower.split('/').filter(Boolean).at(-1) ?? lower : lower;
  const byRepoName = routes.filter((route) => route.github_repo.toLowerCase() === repoName);
  if (byRepoName.length === 1) {
    return { route: byRepoName[0]!, matched_by: 'github_repo_name' };
  }

  return null;
}

export class TrackerProjectResolutionService {
  constructor(
    private readonly tracker: Pick<LinearClient, 'listProjects' | 'findProjectBySlug'>,
    private readonly routes: Record<string, RepositoryRouteConfig>,
  ) {}

  listConfiguredProjectSlugs(): string[] {
    return Object.keys(this.routes).sort();
  }

  listConfiguredRoutes(): ResolvedRepositoryRoute[] {
    return Object.entries(this.routes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectSlug, route]) => toResolvedRoute(projectSlug, null, route));
  }

  resolveConfiguredRouteReference(
    reference: string | null | undefined,
  ): RepositoryRouteReferenceMatch | null {
    return resolveRepositoryRouteReference(this.listConfiguredRoutes(), reference);
  }

  async resolveProjectSlug(projectSlug: string): Promise<TrackerProjectResolutionResult> {
    const normalizedSlug = projectSlug.trim();
    if (!normalizedSlug) {
      return {
        project: null,
        route: null,
        error: 'Project slug is required.',
      };
    }

    const route = this.routes[normalizedSlug];
    if (!route) {
      const configured = this.listConfiguredProjectSlugs();
      return {
        project: null,
        route: null,
        error: configured.length > 0
          ? `Project slug "${normalizedSlug}" is not configured in repositories.routing. Available projects: ${configured.join(', ')}.`
          : `Project slug "${normalizedSlug}" is not configured in repositories.routing.`,
      };
    }

    const resolved = await this.tracker.findProjectBySlug(normalizedSlug);
    if (resolved.error || !resolved.project) {
      return {
        project: null,
        route: toResolvedRoute(normalizedSlug, null, route),
        error:
          resolved.errorMessage ||
          `Linear project "${normalizedSlug}" could not be resolved.`,
      };
    }

    return {
      project: resolved.project,
      route: toResolvedRoute(normalizedSlug, resolved.project.project_name, route),
    };
  }

  async listConfiguredProjects(): Promise<ResolvedTrackerProject[]> {
    const configured = new Set(this.listConfiguredProjectSlugs());
    if (configured.size === 0) {
      return [];
    }

    const result = await this.tracker.listProjects();
    if (result.error) {
      return [];
    }

    return result.projects.filter((project) => configured.has(project.project_slug));
  }
}
