import { existsSync } from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface EmbeddedClaudeRuntimeBootstrapResult {
  attempted: boolean;
  installed: boolean;
  runtimeRoot: string | null;
}

interface EmbeddedClaudeRuntimeCommandResult {
  status: number | null;
  error?: Error | null;
  stderr?: string | null;
  stdout?: string | null;
}

interface EnsureEmbeddedClaudeRuntimeReadyOptions {
  projectRoot: string;
  codexCommand: string;
  fileExists?: (targetPath: string) => boolean;
  installRuntime?: (runtimeRoot: string) => EmbeddedClaudeRuntimeCommandResult;
  verifyRuntime?: (runtimeRoot: string) => EmbeddedClaudeRuntimeCommandResult;
  log?: (message: string) => void;
}

export function shouldBootstrapEmbeddedClaudeRuntime(codexCommand: string): boolean {
  return codexCommand.includes('claude-adapter.cjs');
}

export function getEmbeddedClaudeRuntimeRoot(projectRoot: string): string {
  return path.join(projectRoot, 'claude-code');
}

export function hasEmbeddedClaudeRuntimeDependencies(
  projectRoot: string,
  fileExists: (targetPath: string) => boolean = existsSync,
): boolean {
  const runtimeRoot = getEmbeddedClaudeRuntimeRoot(projectRoot);
  return fileExists(path.join(runtimeRoot, 'node_modules', 'lodash-es', 'sumBy.js'));
}

export function ensureEmbeddedClaudeRuntimeReady(
  options: EnsureEmbeddedClaudeRuntimeReadyOptions,
): EmbeddedClaudeRuntimeBootstrapResult {
  if (!shouldBootstrapEmbeddedClaudeRuntime(options.codexCommand)) {
    return {
      attempted: false,
      installed: false,
      runtimeRoot: null,
    };
  }

  const fileExists = options.fileExists ?? existsSync;
  const runtimeRoot = getEmbeddedClaudeRuntimeRoot(options.projectRoot);
  const packageJsonPath = path.join(runtimeRoot, 'package.json');
  if (!fileExists(packageJsonPath)) {
    return {
      attempted: false,
      installed: false,
      runtimeRoot: null,
    };
  }

  if (hasEmbeddedClaudeRuntimeDependencies(options.projectRoot, fileExists)) {
    verifyEmbeddedClaudeRuntime(runtimeRoot, options.verifyRuntime);
    return {
      attempted: false,
      installed: false,
      runtimeRoot,
    };
  }

  options.log?.(`[symphony] Bootstrapping embedded Claude runtime in ${runtimeRoot}`);
  const installRuntime = options.installRuntime ?? ((cwd: string) => spawnSync('bun', ['install'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  }));
  const result = installRuntime(runtimeRoot);
  if (result.error) {
    throw new Error(`Failed to bootstrap embedded Claude runtime: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Embedded Claude runtime bootstrap failed with exit code ${result.status ?? 'unknown'}`);
  }

  verifyEmbeddedClaudeRuntime(runtimeRoot, options.verifyRuntime);

  return {
    attempted: true,
    installed: true,
    runtimeRoot,
  };
}

function verifyEmbeddedClaudeRuntime(
  runtimeRoot: string,
  verifyRuntime?: (runtimeRoot: string) => EmbeddedClaudeRuntimeCommandResult,
): void {
  const runVerification = verifyRuntime ?? ((cwd: string) => spawnSync(
    path.join(cwd, 'bin', 'claude-haha'),
    ['--help'],
    {
      cwd,
      env: process.env,
      encoding: 'utf8',
    },
  ));

  const result = runVerification(runtimeRoot);
  if (result.error) {
    throw new Error(`Embedded Claude runtime verification failed: ${result.error.message}`);
  }
  if (result.status === 0) {
    return;
  }

  const stderr = result.stderr?.trim() || result.stdout?.trim() || '';
  const detail = stderr.split('\n').find((line) => line.trim()) ?? `exit code ${result.status ?? 'unknown'}`;
  throw new Error(`Embedded Claude runtime is not runnable: ${detail}`);
}
