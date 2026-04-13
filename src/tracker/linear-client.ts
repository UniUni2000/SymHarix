/**
 * Linear Issue Tracker Client
 * Section 11: Issue Tracker Integration Contract
 */


// Using Bun's built-in global fetch (node-fetch has compatibility issues in Bun)
import { Issue, BlockerRef, LinearApiResponse, LinearIssue, TrackerError } from '../types';

/**
 * Linear tracker client options
 */
export interface LinearClientOptions {
  endpoint: string;
  apiKey: string;
  projectSlugs: string[];
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
        return {
          error: 'linear_api_status',
          errorMessage: `Linear API returned status ${response.status}`
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
      branch_name: linearIssue.branchName,
      url: linearIssue.url,
      labels,
      blocked_by,
      created_at: linearIssue.createdAt ? new Date(linearIssue.createdAt) : null,
      updated_at: linearIssue.updatedAt ? new Date(linearIssue.updatedAt) : null
    };
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
      const query = `
        query GetIssues($projectSlugs: [String!], $states: [String!], $first: Int, $after: String) {
          issues(
            filter: {
              project: { slugId: { in: $projectSlugs } }
              state: { name: { in: $states } }
            }
            first: $first
            after: $after
          ) {
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

      const variables: Record<string, unknown> = {
        projectSlugs: this.projectSlugs,
        states: activeStates,
        first: 50,
        after: endCursor
      };

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
      const query = `
        query GetIssues($projectSlugs: [String!], $states: [String!], $first: Int, $after: String) {
          issues(
            filter: {
              project: { slugId: { in: $projectSlugs } }
              state: { name: { in: $states } }
            }
            first: $first
            after: $after
          ) {
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

      const variables: Record<string, unknown> = {
        projectSlugs: this.projectSlugs,
        states: stateNames,
        first: 50,
        after: endCursor
      };

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
      query GetIssue($id: ID!) {
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
}
