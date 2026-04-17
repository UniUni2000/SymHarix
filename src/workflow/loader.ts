/**
 * Workflow Loader - Loads and parses WORKFLOW.md files
 * Section 5: Workflow Specification
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { WorkflowDefinition, WorkflowError } from '../types';

/**
 * Result of workflow loading operation
 */
export interface WorkflowLoadResult {
  success: boolean;
  definition?: WorkflowDefinition;
  error?: WorkflowError;
  errorMessage?: string;
}

/**
 * Load and parse a WORKFLOW.md file
 *
 * Section 5.2: File Format
 * - If file starts with `---`, parse lines until next `---` as YAML front matter
 * - Remaining lines become prompt body
 * - If front matter absent, treat entire file as prompt body with empty config map
 * - YAML front matter must decode to a map/object; non-map YAML is an error
 * - Prompt body is trimmed before use
 */
export function loadWorkflow(filePath: string): WorkflowLoadResult {
  // Section 5.1: File Discovery
  // If file cannot be read, return missing_workflow_file error
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      return {
        success: false,
        error: 'missing_workflow_file',
        errorMessage: `Workflow file not found: ${filePath}`
      };
    }
    return {
      success: false,
      error: 'workflow_parse_error',
      errorMessage: `Failed to read workflow file: ${nodeErr.message}`
    };
  }

  return parseWorkflowContent(content, filePath);
}

/**
 * Parse workflow content string
 */
export function parseWorkflowContent(content: string, filePath: string = 'WORKFLOW.md'): WorkflowLoadResult {
  const lines = content.split('\n');
  let config: Record<string, unknown> = {};
  let promptBody: string = content;

  // Check if file starts with YAML front matter
  if (lines[0]?.trim() === '---') {
    // Find closing ---
    let endIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        endIndex = i;
        break;
      }
    }

    if (endIndex === -1) {
      return {
        success: false,
        error: 'workflow_parse_error',
        errorMessage: 'Workflow file has opening --- but no closing ---'
      };
    }

    // Extract YAML front matter (lines between the --- markers)
    const yamlLines = lines.slice(1, endIndex);
    const yamlContent = yamlLines.join('\n');

    // Parse YAML
    try {
      const parsed = yaml.parse(yamlContent);

      // Section 5.2: Front matter must decode to a map/object
      if (parsed === null || parsed === undefined) {
        return {
          success: false,
          error: 'workflow_front_matter_not_a_map',
          errorMessage: 'YAML front matter parsed to null/undefined'
        };
      }

      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          success: false,
          error: 'workflow_front_matter_not_a_map',
          errorMessage: 'YAML front matter must be a map/object, got ' + (Array.isArray(parsed) ? 'array' : typeof parsed)
        };
      }

      config = parsed as Record<string, unknown>;
    } catch (yamlErr) {
      const err = yamlErr as Error;
      return {
        success: false,
        error: 'workflow_parse_error',
        errorMessage: `YAML parse error: ${err.message}`
      };
    }

    // Extract prompt body (everything after the closing ---)
    const bodyLines = lines.slice(endIndex + 1);
    promptBody = bodyLines.join('\n').trim();
  } else {
    // No front matter - entire file is prompt body
    promptBody = content.trim();
    config = {};
  }

  return {
    success: true,
    definition: {
      config,
      prompt_template: promptBody
    }
  };
}

/**
 * Resolve workflow file path based on precedence rules
 * Section 5.1: File Discovery and Path Resolution
 * 1. Explicit application/runtime setting
 * 2. Default: WORKFLOW.md in current process working directory
 */
export function resolveWorkflowPath(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return path.join(process.cwd(), 'WORKFLOW.md');
}

/**
 * Validate that a workflow definition has required fields for dispatch
 * Section 6.3: Dispatch Preflight Validation
 */
export function validateWorkflowForDispatch(definition: WorkflowDefinition): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const { config } = definition;

  // tracker.kind is required
  if (!config.tracker || typeof config.tracker !== 'object') {
    errors.push('Missing required "tracker" configuration');
  } else {
    const tracker = config.tracker as Record<string, unknown>;

    // tracker.kind is required and must be supported
    if (!tracker.kind) {
      errors.push('Missing required "tracker.kind" configuration');
    } else if (tracker.kind !== 'linear') {
      errors.push(`Unsupported tracker kind: "${tracker.kind}". Currently only "linear" is supported.`);
    }
  }

  // Check for API key (may be via $VAR)
  if (config.tracker && typeof config.tracker === 'object') {
    const tracker = config.tracker as Record<string, unknown>;
    const apiKey = tracker.api_key as string | undefined;

    if (!apiKey) {
      errors.push('Missing required "tracker.api_key" configuration');
    } else if (apiKey.startsWith('$')) {
      // It's a $VAR reference - check if env var exists
      const envVarName = apiKey.slice(1);
      const envValue = process.env[envVarName];
      if (!envValue) {
        errors.push(`Environment variable "${envVarName}" (referenced by tracker.api_key) is not set or empty`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
