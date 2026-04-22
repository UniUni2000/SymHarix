/**
 * Linear Issue Tracker Client
 * Section 11: Issue Tracker Integration Contract
 */


// Using Bun's built-in global fetch (node-fetch has compatibility issues in Bun)
import {
  Issue,
  BlockerRef,
  LinearApiResponse,
  LinearIssue,
  LinearCustomFields,
  LinearIssueExtended,
  ResolvedTrackerProject,
  TrackerError,
} from '../types';

/**
 * Linear tracker client options
 */
export interface LinearClientOptions {
  endpoint: string;
  apiKey: string;
  projectSlugs: string[];
}

export interface CreateLinearIssueInput {
  title: string;
  description?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  stateId?: string | null;
}

interface LinearStateNode {
  id: string;
  name: string;
  type: string;
}

/**
 * Linear API client
 */
export class LinearClient {
  private endpoint: string;
  private apiKey: string;
  private projectSlugs: string[];

  constructor(options: LinearClientOptions) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.projectSlugs = options.projectSlugs;
  }

  /**
   * Build GraphQL headers with authentication
   */
  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': this.apiKey
    };
  }

  /**
   * Execute a GraphQL query
   * Section 11.2: Network timeout 30000ms
   */
  private async graphqlQuery<T>(query: string, variables?: Record<string, unknown>): Promise<{ data?: T; error?: TrackerError; errorMessage?: string }> {
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        const responseBody = await response.text();
        const detail = responseBody.trim().replace(/\s+/g, ' ').slice(0, 500);
        return {
          error: 'linear_api_status',
          errorMessage: detail
            ? `Linear API returned status ${response.status}: ${detail}`
            : `Linear API returned status ${response.status}`
        };
      }

      const result: LinearApiResponse = await response.json() as LinearApiResponse;

      if (result.errors) {
        return {
          error: 'linear_graphql_errors',
          errorMessage: result.errors.map(e => e.message).join(', ')
        };
      }

      return { data: result.data as unknown as T };
    } catch (err) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        return {
          error: 'linear_api_request',
          errorMessage: 'Linear API request timed out'
        };
      }
      return {
        error: 'linear_api_request',
        errorMessage: `Linear API request failed: ${error.message}`
      };
    }
  }

  /**
   * Normalize a Linear issue to the domain Issue model
   * Section 4.1.1 and 11.3: Normalization Rules
   */
  private normalizeIssue(linearIssue: LinearIssue): Issue {
    // Labels normalized to lowercase
    const labels = linearIssue.labels.nodes.map(l => l.name.toLowerCase());

    // Blockers derived from relations where relation type is "blocks"
    const blocked_by: BlockerRef[] = linearIssue.relations.nodes
      .filter(r => r.type === 'blocks')
      .map(r => ({
        id: r.relatedIssue.id,
        identifier: r.relatedIssue.identifier,
        state: r.relatedIssue.state.name
      }));

    // Priority - integer only (non-integers become null)
    let priority: number | null = null;
    if (typeof linearIssue.priority === 'number' && Number.isInteger(linearIssue.priority)) {
      priority = linearIssue.priority;
    }

    return {
      id: linearIssue.id,
      identifier: linearIssue.identifier,
      title: linearIssue.title,
      description: linearIssue.description,
      priority,
      state: linearIssue.state.name,
      project_slug: linearIssue.project?.slugId || null,
      project_name: linearIssue.project?.name || null,
      branch_name: linearIssue.branchName,
      url: linearIssue.url,
      labels,
      blocked_by,
      created_at: linearIssue.createdAt ? new Date(linearIssue.createdAt) : null,
      updated_at: linearIssue.updatedAt ? new Date(linearIssue.updatedAt) : null
    };
  }

  private async resolveDefaultTeamId(): Promise<{ teamId: string | null; error?: string }> {
    const query = `
      query GetDefaultTeam {
        teams(first: 1) {
          nodes {
            id
          }
        }
      }
    `;

    const result = await this.graphqlQuery<{ teams: { nodes: Array<{ id: string }> } }>(query);
    if (result.error) {
      return {
        teamId: null,
        error: result.errorMessage || 'Failed to resolve a default Linear team',
      };
    }

    const teamId = result.data?.teams?.nodes?.[0]?.id ?? null;
    if (!teamId) {
      return {
        teamId: null,
        error: 'No writable Linear team was available for issue creation',
      };
    }

    return { teamId };
  }

  private pickPreferredCreateState(states: LinearStateNode[]): string | null {
    const normalizedStates = states.filter((state) => state.id && state.name && state.type);
    const todo = normalizedStates.find((state) => state.name.toLowerCase() === 'todo');
    if (todo) {
      return todo.id;
    }

    const nonBacklogUnstarted = normalizedStates.find(
      (state) => state.type === 'unstarted' && state.name.toLowerCase() !== 'backlog',
    );
    if (nonBacklogUnstarted) {
      return nonBacklogUnstarted.id;
    }

    return null;
  }

  private async resolvePreferredCreateStateId(projectId: string | null): Promise<string | null> {
    const normalizedProjectId = projectId?.trim() || null;
    if (!normalizedProjectId) {
      return null;
    }

    const query = `
      query GetProjectStatesForCreate($projectId: String!) {
        project(id: $projectId) {
          id
          teams {
            nodes {
              id
              states {
                nodes {
                  id
                  name
                  type
                }
              }
            }
          }
        }
      }
    `;

    const result = await this.graphqlQuery<{
      project: {
        id: string;
        teams?: {
          nodes: Array<{
            id: string;
            states: {
              nodes: LinearStateNode[];
            };
          }>;
        };
      } | null;
    }>(query, { projectId: normalizedProjectId });

    if (result.error || !result.data?.project) {
      return null;
    }

    const states = (result.data.project.teams?.nodes || []).flatMap((team) => team.states?.nodes || []);
    return this.pickPreferredCreateState(states);
  }

  /**
   * Fetch candidate issues in active states for the configured project
   * Section 11.1: Required Operations #1
   * Section 11.2: Pagination required, page size default 50
   */
  async fetchCandidateIssues(activeStates: string[]): Promise<{ issues: Issue[]; error?: TrackerError; errorMessage?: string }> {
    // Section 11.2: Empty active_states should return empty without API call
    if (activeStates.length === 0) {
      return { issues: [] };
    }

    const allIssues: Issue[] = [];
    let hasNextPage = true;
    let endCursor: string | null = null;

    while (hasNextPage) {
      // Use different queries depending on whether we have project filter
      const hasProjectFilter = this.projectSlugs.length > 0;

      const query = hasProjectFilter
        ? `query GetIssues($projectSlugs: [String!], $states: [String!], $first: Int, $after: String) { issues(filter: { project: { slugId: { in: $projectSlugs } }, state: { name: { in: $states } } }, first: $first, after: $after) { nodes { id identifier title description priority state { id name type } project { id name slugId } labels { nodes { name } } relations { nodes { type relatedIssue { id identifier state { name type } } } } createdAt updatedAt branchName url } pageInfo { hasNextPage endCursor } } }`
        : `query GetIssues($states: [String!], $first: Int, $after: String) { issues(filter: { state: { name: { in: $states } } }, first: $first, after: $after) { nodes { id identifier title description priority state { id name type } project { id name slugId } labels { nodes { name } } relations { nodes { type relatedIssue { id identifier state { name type } } } } createdAt updatedAt branchName url } pageInfo { hasNextPage endCursor } } }`;

      const variables: Record<string, unknown> = hasProjectFilter
        ? { projectSlugs: this.projectSlugs, states: activeStates, first: 50, after: endCursor }
        : { states: activeStates, first: 50, after: endCursor };

      const result = await this.graphqlQuery<{ issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(query, variables);

      if (result.error) {
        return { issues: [], error: result.error, errorMessage: result.errorMessage };
      }

      const issuesData = result.data?.issues;
      if (!issuesData) {
        return {
          issues: [],
          error: 'linear_unknown_payload',
          errorMessage: 'Linear API returned unexpected response structure'
        };
      }

      for (const issue of issuesData.nodes) {
        allIssues.push(this.normalizeIssue(issue));
      }

      hasNextPage = issuesData.pageInfo.hasNextPage;
      endCursor = issuesData.pageInfo.endCursor;

      // Section 11.2: Pagination integrity - missing end_cursor is an error
      if (hasNextPage && !endCursor) {
        return {
          issues: allIssues,
          error: 'linear_missing_end_cursor',
          errorMessage: 'Pagination indicated more results but no endCursor was provided'
        };
      }
    }

    return { issues: allIssues };
  }

  /**
   * Fetch issues by state names
   * Section 11.1: Required Operations #2
   * Used for startup terminal cleanup
   */
  async fetchIssuesByStates(stateNames: string[]): Promise<{ issues: Issue[]; error?: TrackerError; errorMessage?: string }> {
    // Empty state list returns empty without API call
    if (stateNames.length === 0) {
      return { issues: [] };
    }

    const allIssues: Issue[] = [];
    let hasNextPage = true;
    let endCursor: string | null = null;

    while (hasNextPage) {
      // Use different queries depending on whether we have project filter
      const hasProjectFilter = this.projectSlugs.length > 0;

      const query = hasProjectFilter
        ? `query GetIssues($projectSlugs: [String!], $states: [String!], $first: Int, $after: String) { issues(filter: { project: { slugId: { in: $projectSlugs } }, state: { name: { in: $states } } }, first: $first, after: $after) { nodes { id identifier title description priority state { id name type } project { id name slugId } labels { nodes { name } } relations { nodes { type relatedIssue { id identifier state { name type } } } } createdAt updatedAt branchName url } pageInfo { hasNextPage endCursor } } }`
        : `query GetIssues($states: [String!], $first: Int, $after: String) { issues(filter: { state: { name: { in: $states } } }, first: $first, after: $after) { nodes { id identifier title description priority state { id name type } project { id name slugId } labels { nodes { name } } relations { nodes { type relatedIssue { id identifier state { name type } } } } createdAt updatedAt branchName url } pageInfo { hasNextPage endCursor } } }`;

      const variables: Record<string, unknown> = hasProjectFilter
        ? { projectSlugs: this.projectSlugs, states: stateNames, first: 50, after: endCursor }
        : { states: stateNames, first: 50, after: endCursor };

      const result = await this.graphqlQuery<{ issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(query, variables);

      if (result.error) {
        return { issues: [], error: result.error, errorMessage: result.errorMessage };
      }

      const issuesData = result.data?.issues;
      if (!issuesData) {
        return {
          issues: [],
          error: 'linear_unknown_payload',
          errorMessage: 'Linear API returned unexpected response structure'
        };
      }

      for (const issue of issuesData.nodes) {
        allIssues.push(this.normalizeIssue(issue));
      }

      hasNextPage = issuesData.pageInfo.hasNextPage;
      endCursor = issuesData.pageInfo.endCursor;

      if (hasNextPage && !endCursor) {
        return {
          issues: allIssues,
          error: 'linear_missing_end_cursor',
          errorMessage: 'Pagination indicated more results but no endCursor was provided'
        };
      }
    }

    return { issues: allIssues };
  }

  /**
   * Fetch issue states by IDs
   * Section 11.1: Required Operations #3
   * Used for active-run reconciliation
   * Section 11.2: Uses GraphQL ID typing [ID!]
   */
  async fetchIssueStatesByIds(issueIds: string[]): Promise<{ issues: Issue[]; error?: TrackerError; errorMessage?: string }> {
    // Empty ID list returns empty without API call
    if (issueIds.length === 0) {
      return { issues: [] };
    }

    const allIssues: Issue[] = [];

    // Linear has a limit on ID filters, so we batch if needed
    const batchSize = 50;
    for (let i = 0; i < issueIds.length; i += batchSize) {
      const batchIds = issueIds.slice(i, i + batchSize);

      const query = `
        query GetIssuesByIds($ids: [ID!]) {
          issues(filter: { id: { in: $ids } }) {
            nodes {
              id
              identifier
              title
              description
              priority
              state {
                id
                name
                type
              }
              project {
                id
                name
                slugId
              }
              labels {
                nodes {
                  name
                }
              }
              relations {
                nodes {
                  type
                  relatedIssue {
                    id
                    identifier
                    state {
                      name
                      type
                    }
                  }
                }
              }
              createdAt
              updatedAt
              branchName
              url
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const variables = { ids: batchIds };

      const result = await this.graphqlQuery<{ issues: { nodes: LinearIssue[] } }>(query, variables);

      if (result.error) {
        return { issues: [], error: result.error, errorMessage: result.errorMessage };
      }

      const issuesData = result.data?.issues;
      if (!issuesData) {
        return {
          issues: [],
          error: 'linear_unknown_payload',
          errorMessage: 'Linear API returned unexpected response structure'
        };
      }

      for (const issue of issuesData.nodes) {
        allIssues.push(this.normalizeIssue(issue));
      }
    }

    return { issues: allIssues };
  }

  /**
   * Fetch a single issue by ID
   */
  async fetchIssueById(issueId: string): Promise<{ issue: Issue | null; error?: TrackerError; errorMessage?: string }> {
    const query = `
      query GetIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          priority
          state {
            id
            name
            type
          }
          project {
            id
            name
            slugId
          }
          labels {
            nodes {
              name
            }
          }
          relations {
            nodes {
              type
              relatedIssue {
                id
                identifier
                state {
                  name
                  type
                }
              }
            }
          }
          createdAt
          updatedAt
          branchName
          url
        }
      }
    `;

    const variables = { id: issueId };

    const result = await this.graphqlQuery<{ issue: LinearIssue | null }>(query, variables);

    if (result.error) {
      return { issue: null, error: result.error, errorMessage: result.errorMessage };
    }

    const issueData = result.data?.issue;
    if (!issueData) {
      return { issue: null };
    }

    return { issue: this.normalizeIssue(issueData) };
  }

  /**
   * Get custom fields for an issue
   */
  async getIssueCustomFields(issueId: string): Promise<LinearCustomFields> {
    const query = `
      query GetIssueCustomFields($id: String!) {
        issue(id: $id) {
          id
          identifier
          customFields {
            nodes {
              name
              value
            }
          }
        }
      }
    `;

    const result = await this.graphqlQuery<{ issue: LinearIssueExtended }>(query, { id: issueId });

    if (result.error || !result.data?.issue) {
      return {};
    }

    const fields: LinearCustomFields = {};
    const nodes = result.data.issue.customFields?.nodes || [];

    for (const node of nodes) {
      switch (node.name.toLowerCase()) {
        case 'dev_attempts':
          fields.dev_attempts = typeof node.value === 'number' ? node.value : parseInt(String(node.value)) || 0;
          break;
        case 'review_round':
          fields.review_round = typeof node.value === 'number' ? node.value : parseInt(String(node.value)) || 0;
          break;
        case 'complexity':
          if (['small', 'medium', 'large'].includes(String(node.value).toLowerCase())) {
            fields.complexity = String(node.value).toLowerCase() as 'small' | 'medium' | 'large';
          }
          break;
        case 'last_review_decision':
          {
            const normalized = String(node.value).toLowerCase();
            const normalizedDecision = {
              approve: 'approve',
              minor: 'approve_minor',
              approve_minor: 'approve_minor',
              major: 'request_changes',
              request_changes: 'request_changes',
              tests: 'request_tests',
              request_tests: 'request_tests',
              reject: 'reject',
              merge_blocked: 'merge_blocked',
            }[normalized];
            if (normalizedDecision) {
              fields.last_review_decision = normalizedDecision;
            }
          }
          break;
      }
    }

    return fields;
  }

  /**
   * Update custom fields on a Linear issue
   * Note: This requires Linear Enterprise API or specific field setup
   * This is a best-effort implementation
   */
  async updateIssueCustomFields(
    issueId: string,
    fields: LinearCustomFields
  ): Promise<{ success: boolean; error?: string }> {
    // Linear's custom field update API requires field ID mapping
    // For now, log the intent and return success
    // In production, this would need proper field ID lookups

    const updates: string[] = [];
    if (fields.dev_attempts !== undefined) {
      updates.push(`dev_attempts=${fields.dev_attempts}`);
    }
    if (fields.review_round !== undefined) {
      updates.push(`review_round=${fields.review_round}`);
    }
    if (fields.complexity !== undefined) {
      updates.push(`complexity=${fields.complexity}`);
    }
    if (fields.last_review_decision !== undefined) {
      updates.push(`last_review_decision=${fields.last_review_decision}`);
    }

    console.log(`[linear-client] Custom fields update for ${issueId}: ${updates.join(', ')}`);

    // For now, custom fields in Linear require Enterprise API
    // We'll rely on local database for tracking and comment for user visibility
    return { success: true };
  }

  /**
   * Post a comment to a Linear issue
   */
  async postComment(issueId: string, body: string): Promise<{ success: boolean; error?: string }> {
    const mutation = `
      mutation CommentCreate($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `;

    const result = await this.graphqlQuery<{ commentCreate: { success: boolean } }>(
      mutation,
      { issueId, body }
    );

    if (result.error) {
      return { success: false, error: result.errorMessage };
    }

    return { success: result.data?.commentCreate?.success || false };
  }

  async listProjects(): Promise<{
    projects: ResolvedTrackerProject[];
    error?: TrackerError;
    errorMessage?: string;
  }> {
    const query = `
      query ListProjects {
        projects(first: 100) {
          nodes {
            id
            name
            slugId
          }
        }
      }
    `;

    const result = await this.graphqlQuery<{
      projects: {
        nodes: Array<{
          id: string;
          name: string;
          slugId: string;
        }>;
      };
    }>(query);

    if (result.error) {
      return {
        projects: [],
        error: result.error,
        errorMessage: result.errorMessage,
      };
    }

    const nodes = result.data?.projects?.nodes;
    if (!Array.isArray(nodes)) {
      return {
        projects: [],
        error: 'linear_unknown_payload',
        errorMessage: 'Linear API returned unexpected project list payload',
      };
    }

    return {
      projects: nodes
        .filter((node) => node.id && node.slugId && node.name)
        .map((node) => ({
          project_id: node.id,
          project_slug: node.slugId,
          project_name: node.name,
        })),
    };
  }

  async findProjectBySlug(projectSlug: string): Promise<{
    project: ResolvedTrackerProject | null;
    error?: TrackerError;
    errorMessage?: string;
  }> {
    const normalizedSlug = projectSlug.trim();
    if (!normalizedSlug) {
      return {
        project: null,
        error: 'linear_project_not_found',
        errorMessage: 'Project slug is required',
      };
    }

    const result = await this.listProjects();
    if (result.error) {
      return {
        project: null,
        error: result.error,
        errorMessage: result.errorMessage,
      };
    }

    const project =
      result.projects.find((candidate) => candidate.project_slug === normalizedSlug) ?? null;

    return {
      project,
      ...(project
        ? {}
        : {
            error: 'linear_project_not_found' as const,
            errorMessage: `Linear project "${normalizedSlug}" was not found`,
          }),
    };
  }

  async createIssue(
    input: CreateLinearIssueInput,
  ): Promise<{ success: boolean; issue?: Issue; error?: string }> {
    const title = input.title.trim();
    if (!title) {
      return { success: false, error: 'Issue title is required' };
    }

    let teamId = input.teamId?.trim() || null;
    if (!teamId) {
      const resolved = await this.resolveDefaultTeamId();
      if (!resolved.teamId) {
        return { success: false, error: resolved.error || 'Failed to resolve a Linear team' };
      }
      teamId = resolved.teamId;
    }

    const resolvedStateId =
      input.stateId?.trim() || await this.resolvePreferredCreateStateId(input.projectId?.trim() || null);

    const mutation = `
      mutation CreateIssue(
        $title: String!,
        $description: String,
        $teamId: String!,
        $projectId: String,
        $stateId: String
      ) {
        issueCreate(
          input: {
            title: $title,
            description: $description,
            teamId: $teamId,
            projectId: $projectId,
            stateId: $stateId
          }
        ) {
          success
          issue {
            id
            identifier
            title
            description
            priority
            state {
              id
              name
              type
            }
            project {
              id
              name
              slugId
            }
            labels {
              nodes {
                name
              }
            }
            relations {
              nodes {
                type
                relatedIssue {
                  id
                  identifier
                  state {
                    name
                    type
                  }
                }
              }
            }
            createdAt
            updatedAt
            branchName
            url
          }
        }
      }
    `;

    const result = await this.graphqlQuery<{
      issueCreate: {
        success: boolean;
        issue: LinearIssue | null;
      };
    }>(mutation, {
      title,
      description: input.description?.trim() || null,
      teamId,
      projectId: input.projectId?.trim() || null,
      stateId: resolvedStateId,
    });

    if (result.error) {
      return {
        success: false,
        error: result.errorMessage || 'Linear issue creation failed',
      };
    }

    const created = result.data?.issueCreate;
    if (!created?.success || !created.issue) {
      return {
        success: false,
        error: 'Linear issue creation returned no issue payload',
      };
    }

    return {
      success: true,
      issue: this.normalizeIssue(created.issue),
    };
  }

  /**
   * Update an issue's state (e.g., to Done)
   */
  async updateIssueState(issueId: string, stateName: string): Promise<{ success: boolean; error?: string }> {
    // First, find the project slug ID for this issue
    const stateQuery = `
      query GetIssueProject($issueId: String!) {
        issue(id: $issueId) {
          id
          project {
            slugId
            teams {
              nodes {
                id
                states {
                  nodes {
                    id
                    name
                    type
                  }
                }
              }
            }
          }
        }
      }
    `;

    const issueResult = await this.graphqlQuery<{
      issue: {
        id: string;
        project: {
          slugId: string;
          teams?: {
            nodes: Array<{
              id: string;
              states: {
                nodes: Array<{ id: string; name: string; type: string }>;
              };
            }>;
          };
        } | null;
      } | null;
    }>(
      stateQuery,
      { issueId }
    );

    if (issueResult.error || !issueResult.data?.issue) {
      return { success: false, error: issueResult.errorMessage || 'Issue not found' };
    }

    const projectSlugId = issueResult.data.issue.project?.slugId;
    if (!projectSlugId) {
      return { success: false, error: 'Issue has no associated project' };
    }

    const teams = issueResult.data.issue.project?.teams?.nodes || [];
    const targetState = teams
      .flatMap(team => team.states.nodes)
      .find(state => state.name.toLowerCase() === stateName.toLowerCase());

    if (!targetState) {
      return { success: false, error: `State "${stateName}" not found in project team states` };
    }

    // Update the issue state
    const mutation = `
      mutation UpdateIssueState($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
        }
      }
    `;

    const updateResult = await this.graphqlQuery<{ issueUpdate: { success: boolean } }>(
      mutation,
      { issueId, stateId: targetState.id }
    );

    if (updateResult.error) {
      return { success: false, error: updateResult.errorMessage };
    }

    return { success: updateResult.data?.issueUpdate?.success || false };
  }
}
