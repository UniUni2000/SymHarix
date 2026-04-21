/**
 * Config Layer - Typed configuration with defaults and environment resolution
 * Section 6: Configuration Specification
 */

import { ServiceConfig, WorkflowDefinition } from '../types';
import * as os from 'os';
import * as path from 'path';

/**
 * Default configuration values
 * Section 5.3 and 6.4
 */
const DEFAULTS: Partial<ServiceConfig> = {
  // Tracker defaults (for linear)
  trackerEndpoint: 'https://api.linear.app/graphql',
  activeStates: ['Todo', 'In Progress', 'In Review'],
  terminalStates: ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],

  // Polling
  pollIntervalMs: 30000,

  // Workspace
  workspaceRoot: '/tmp/symphony_workspaces',

  // Hooks
  hooks: {
    after_create: null,
    before_run: null,
    after_run: null,
    before_remove: null,
    timeout_ms: 60000
  },

  // Agent
  maxConcurrentAgents: 10,
  maxRetryBackoffMs: 300000,  // 5 minutes
  maxTurns: 20,

  // Codex
  codexCommand: 'codex app-server',
  codexTurnTimeoutMs: 3600000,  // 1 hour
  codexReadTimeoutMs: 5000,
  codexStallTimeoutMs: 300000,  // 5 minutes
};

/**
 * Resolve environment variable references in config values
 * Section 6.1: $VAR_NAME expansion
 */
function resolveEnvRef(value: string): string {
  if (!value.startsWith('$')) {
    return value;
  }

  const envVarName = value.slice(1);
  const envValue = process.env[envVarName];

  // If $VAR resolves to empty string or undefined, treat as missing
  if (!envValue) {
    return '';
  }

  return envValue;
}

/**
 * Expand home directory (~) in path values
 * Section 6.1: Path expansion
 */
function expandHome(dirPath: string): string {
  if (!dirPath.startsWith('~')) {
    return dirPath;
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) {
    // Can't expand, return as-is
    return dirPath;
  }

  return path.join(home, dirPath.slice(1));
}

/**
 * Normalize a path value:
 * - Expand ~
 * - Apply $VAR resolution for path-like values
 * - Expand to absolute path if contains path separators
 * Section 6.1
 */
function normalizePath(value: string | undefined, defaultValue: string): string {
  if (!value) {
    return defaultValue;
  }

  // Resolve env refs first
  let resolved = resolveEnvRef(value);
  if (!resolved) {
    return defaultValue;
  }

  // Expand home
  resolved = expandHome(resolved);

  // Convert to absolute path if it looks like a path
  if (resolved.includes('/') || resolved.includes('\\')) {
    resolved = path.resolve(resolved);
  }

  return resolved;
}

/**
 * Parse a number from config value (number or string)
 */
function parseNumber(value: unknown, defaultValue: number): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

/**
 * Parse string array from config
 */
function parseStringArray(value: unknown, defaultValue: string[]): string[] {
  if (!value) {
    return defaultValue;
  }
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string');
  }
  return defaultValue;
}

/**
 * Parse max_concurrent_agents_by_state map
 * Section 5.3.5: Map of state_name -> positive integer
 * Invalid entries (non-positive or non-numeric) are ignored
 */
function parseAgentByStateMap(value: unknown): Map<string, number> {
  const result = new Map<string, number>();

  if (!value || typeof value !== 'object') {
    return result;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    // Normalize state name to lowercase for lookup
    const stateName = key.toLowerCase();

    if (typeof val === 'number' && val > 0) {
      result.set(stateName, val);
    } else if (typeof val === 'string') {
      const parsed = parseInt(val, 10);
      if (parsed > 0) {
        result.set(stateName, parsed);
      }
    }
    // Invalid entries (non-positive or non-numeric) are ignored
  }

  return result;
}

/**
 * Resolve API key from config (handles $VAR references)
 */
function resolveApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    return '';
  }

  const resolved = resolveEnvRef(apiKey);
  return resolved;
}

/**
 * Build typed ServiceConfig from workflow definition
 * Applies defaults, env resolution, and validation
 */
export function buildServiceConfig(workflow: WorkflowDefinition): ServiceConfig {
  const { config } = workflow;

  // Tracker config
  const tracker = (config.tracker as Record<string, unknown>) || {};
  const trackerKind = (tracker.kind as string) || 'linear';
  const trackerEndpoint = (tracker.endpoint as string) || DEFAULTS.trackerEndpoint!;
  const trackerApiKey = resolveApiKey(tracker.api_key as string);
  
  const githubOwner = process.env.GITHUB_OWNER || '';
  const githubToken = process.env.GITHUB_TOKEN || '';

  // Polling config
  const polling = (config.polling as Record<string, unknown>) || {};
  const pollIntervalMs = parseNumber(polling.interval_ms, DEFAULTS.pollIntervalMs!);

  // Workspace config
  const workspace = (config.workspace as Record<string, unknown>) || {};
  const workspaceRoot = normalizePath(
    workspace.root as string,
    path.join(os.tmpdir(), 'symphony_workspaces')
  );

  // Hooks config
  const hooksConfig = (config.hooks as Record<string, unknown>) || {};
  const hooksTimeout = parseNumber(hooksConfig.timeout_ms, DEFAULTS.hooks!.timeout_ms);
  const hooks = {
    after_create: (hooksConfig.after_create as string) || null,
    before_run: (hooksConfig.before_run as string) || null,
    after_run: (hooksConfig.after_run as string) || null,
    before_remove: (hooksConfig.before_remove as string) || null,
    timeout_ms: hooksTimeout > 0 ? hooksTimeout : DEFAULTS.hooks!.timeout_ms
  };

  if (hooks.before_run || hooks.after_run) {
    console.warn('[config] hooks.before_run and hooks.after_run are deprecated and ignored by the orchestrator');
  }

  // Agent config
  const agent = (config.agent as Record<string, unknown>) || {};
  const maxConcurrentAgents = parseNumber(agent.max_concurrent_agents, DEFAULTS.maxConcurrentAgents!);
  const maxRetryBackoffMs = parseNumber(agent.max_retry_backoff_ms, DEFAULTS.maxRetryBackoffMs!);
  const maxConcurrentAgentsByState = parseAgentByStateMap(agent.max_concurrent_agents_by_state);
  const maxTurns = parseNumber(agent.max_turns, DEFAULTS.maxTurns!);

  // Codex config
  const codex = (config.codex as Record<string, unknown>) || {};
  const codexCommand = (codex.command as string) || DEFAULTS.codexCommand!;
  const codexApprovalPolicy = (codex.approval_policy as string) || null;
  const codexThreadSandbox = (codex.thread_sandbox as string) || null;
  const codexTurnSandboxPolicy = (codex.turn_sandbox_policy as string) || null;
  const codexTurnTimeoutMs = parseNumber(codex.turn_timeout_ms, DEFAULTS.codexTurnTimeoutMs!);
  const codexReadTimeoutMs = parseNumber(codex.read_timeout_ms, DEFAULTS.codexReadTimeoutMs!);
  const codexStallTimeoutMs = parseNumber(codex.stall_timeout_ms, DEFAULTS.codexStallTimeoutMs!);

  // Server config (extension)
  const server = (config.server as Record<string, unknown>) || {};
  const serverPort = server.port !== undefined
    ? parseNumber(server.port, 0)
    : null;

  // Dev Policy config
  const devPolicyConfig = (config.dev_policy as Record<string, unknown>) || {};
  const maxDevAttempts = parseNumber(devPolicyConfig.max_dev_attempts, 3);

  // Review Policy config
  const reviewPolicyConfig = (config.review_policy as Record<string, unknown>) || {};
  const notifyLinearOnReview = reviewPolicyConfig.notify_linear_on_review !== false;

  return {
    trackerKind,
    trackerEndpoint,
    trackerApiKey,
    githubOwner,
    githubToken,
    activeStates: parseStringArray(tracker.active_states, DEFAULTS.activeStates!),
    terminalStates: parseStringArray(tracker.terminal_states, DEFAULTS.terminalStates!),
    pollIntervalMs,
    workspaceRoot,
    projectRoot: process.cwd(),
    hooks,
    maxConcurrentAgents,
    maxRetryBackoffMs,
    maxConcurrentAgentsByState,
    maxTurns,
    codexCommand,
    codexApprovalPolicy,
    codexThreadSandbox,
    codexTurnSandboxPolicy,
    codexTurnTimeoutMs,
    codexReadTimeoutMs,
    codexStallTimeoutMs,
    devPolicy: {
      maxDevAttempts
    },
    reviewPolicy: {
      notifyLinearOnReview
    },
    serverPort: serverPort !== null && serverPort > 0 ? serverPort : null
  };
}

/**
 * Validate config for dispatch preflight
 * Section 6.3: Dispatch Preflight Validation
 */
export function validateConfigForDispatch(cfg: ServiceConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // tracker.kind is required and must be supported
  if (!cfg.trackerKind) {
    errors.push('Missing required "tracker.kind" configuration');
  } else if (cfg.trackerKind !== 'linear') {
    errors.push(`Unsupported tracker kind: "${cfg.trackerKind}". Only "linear" is supported.`);
  }

  // tracker.api_key is required after $ resolution
  if (!cfg.trackerApiKey) {
    errors.push('Missing required "tracker.api_key" (or environment variable not set)');
  }

  // githubOwner is required for GitHub integration
  if (!cfg.githubOwner) {
    errors.push('Missing required "GITHUB_OWNER" environment variable');
  }

  // codex.command is required
  if (!cfg.codexCommand) {
    errors.push('Missing required "codex.command" configuration');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
