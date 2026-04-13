/**
 * Workflow Watcher - Detects and reloads WORKFLOW.md changes
 * Section 6.2: Dynamic Reload Semantics
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import chokidar from 'chokidar';
import { WorkflowDefinition, ServiceConfig } from '../types';
import { loadWorkflow, parseWorkflowContent, validateWorkflowForDispatch, WorkflowLoadResult } from './loader';
import { buildServiceConfig, validateConfigForDispatch } from '../config/loader';

/**
 * Workflow Watcher options
 */
export interface WorkflowWatcherOptions {
  workflowPath: string;
  onReload: (definition: WorkflowDefinition, config: ServiceConfig) => void;
  onError: (error: Error) => void;
}

/**
 * Workflow Watcher - monitors WORKFLOW.md for changes and reloads
 * Section 6.2: Dynamic Reload Semantics
 */
export class WorkflowWatcher extends EventEmitter {
  private workflowPath: string;
  private onReload: WorkflowWatcherOptions['onReload'];
  private onError: WorkflowWatcherOptions['onError'];
  private watcher: chokidar.FSWatcher | null = null;
  private currentDefinition: WorkflowDefinition | null = null;
  private currentConfig: ServiceConfig | null = null;
  private reloadDebounce: NodeJS.Timeout | null = null;

  constructor(options: WorkflowWatcherOptions) {
    super();
    this.workflowPath = options.workflowPath;
    this.onReload = options.onReload;
    this.onError = options.onError;
  }

  /**
   * Start watching the workflow file
   */
  start(): { success: boolean; definition?: WorkflowDefinition; config?: ServiceConfig; error?: string } {
    // Initial load
    const result = this.loadAndValidate();
    if (!result.success) {
      return result;
    }

    this.currentDefinition = result.definition!;
    this.currentConfig = result.config!;

    // Set up file watcher
    const dir = path.dirname(this.workflowPath);
    const basename = path.basename(this.workflowPath);

    this.watcher = chokidar.watch(path.join(dir, basename), {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500
      }
    });

    this.watcher.on('change', () => {
      this.handleFileChange();
    });

    this.watcher.on('error', (err) => {
      console.error('[workflow-watcher] Watcher error:', err);
    });

    return {
      success: true,
      definition: this.currentDefinition,
      config: this.currentConfig
    };
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadDebounce) {
      clearTimeout(this.reloadDebounce);
      this.reloadDebounce = null;
    }
  }

  /**
   * Handle file change event
   */
  private handleFileChange(): void {
    // Debounce reload to avoid multiple triggers during file write
    if (this.reloadDebounce) {
      clearTimeout(this.reloadDebounce);
    }

    this.reloadDebounce = setTimeout(() => {
      this.reload();
    }, 300);
  }

  /**
   * Reload the workflow file
   * Section 6.2: On change, re-read and re-apply workflow config and prompt template
   */
  private reload(): void {
    console.log('[workflow-watcher] Reloading workflow file...');

    const result = this.loadAndValidate();

    if (!result.success) {
      console.error('[workflow-watcher] Reload failed, keeping last known good configuration');
      if (result.error) {
        this.onError(new Error(result.error));
      }
      return;
    }

    this.currentDefinition = result.definition!;
    this.currentConfig = result.config!;

    console.log('[workflow-watcher] Workflow reloaded successfully');
    this.onReload(this.currentDefinition, this.currentConfig);
    this.emit('reload', this.currentDefinition, this.currentConfig);
  }

  /**
   * Load and validate the workflow file
   */
  private loadAndValidate(): {
    success: boolean;
    definition?: WorkflowDefinition;
    config?: ServiceConfig;
    error?: string;
  } {
    // Load workflow
    const loadResult = loadWorkflow(this.workflowPath);
    if (!loadResult.success) {
      return {
        success: false,
        error: `Failed to load workflow: ${loadResult.errorMessage}`
      };
    }

    const definition = loadResult.definition!;

    // Build service config
    let config: ServiceConfig;
    try {
      config = buildServiceConfig(definition);
    } catch (err) {
      return {
        success: false,
        error: `Failed to build config: ${(err as Error).message}`
      };
    }

    // Validate for dispatch
    const validation = validateWorkflowForDispatch(definition);
    if (!validation.valid) {
      return {
        success: false,
        error: `Workflow validation failed: ${validation.errors.join(', ')}`
      };
    }

    const configValidation = validateConfigForDispatch(config);
    if (!configValidation.valid) {
      return {
        success: false,
        error: `Config validation failed: ${configValidation.errors.join(', ')}`
      };
    }

    return {
      success: true,
      definition,
      config
    };
  }

  /**
   * Get current workflow definition
   */
  getCurrentDefinition(): WorkflowDefinition | null {
    return this.currentDefinition;
  }

  /**
   * Get current service config
   */
  getCurrentConfig(): ServiceConfig | null {
    return this.currentConfig;
  }

  /**
   * Force a reload (e.g., after startup validation)
   */
  forceReload(): void {
    this.reload();
  }
}

/**
 * Create and start a workflow watcher
 */
export function createWorkflowWatcher(
  workflowPath: string,
  onReload: (definition: WorkflowDefinition, config: ServiceConfig) => void,
  onError: (error: Error) => void
): WorkflowWatcher {
  const watcher = new WorkflowWatcher({ workflowPath, onReload, onError });
  watcher.start();
  return watcher;
}
