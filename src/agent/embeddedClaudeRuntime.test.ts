import { describe, expect, test } from 'bun:test';
import {
  ensureEmbeddedClaudeRuntimeReady,
  getEmbeddedClaudeRuntimeRoot,
  hasEmbeddedClaudeRuntimeDependencies,
  shouldBootstrapEmbeddedClaudeRuntime,
} from './embeddedClaudeRuntime';

describe('embeddedClaudeRuntime', () => {
  test('recognizes when the local claude adapter requires embedded runtime bootstrap', () => {
    expect(shouldBootstrapEmbeddedClaudeRuntime('node ./scripts/claude-adapter.cjs')).toBe(true);
    expect(shouldBootstrapEmbeddedClaudeRuntime('codex app-server')).toBe(false);
  });

  test('detects embedded runtime dependencies from the nested claude-code install marker', () => {
    const projectRoot = '/repo';
    expect(
      hasEmbeddedClaudeRuntimeDependencies(projectRoot, (targetPath) =>
        targetPath === `${getEmbeddedClaudeRuntimeRoot(projectRoot)}/node_modules/lodash-es/sumBy.js`,
      ),
    ).toBe(true);
    expect(
      hasEmbeddedClaudeRuntimeDependencies(projectRoot, () => false),
    ).toBe(false);
  });

  test('bootstraps embedded claude-code dependencies when the local runtime is selected and deps are missing', () => {
    const calls: string[] = [];
    const result = ensureEmbeddedClaudeRuntimeReady({
      projectRoot: '/repo',
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      fileExists: (targetPath) =>
        targetPath === '/repo/claude-code/package.json',
      installRuntime: (runtimeRoot) => {
        calls.push(runtimeRoot);
        return { status: 0 };
      },
      verifyRuntime: () => ({ status: 0 }),
    });

    expect(calls).toEqual(['/repo/claude-code']);
    expect(result).toEqual({
      attempted: true,
      installed: true,
      runtimeRoot: '/repo/claude-code',
    });
  });

  test('skips bootstrap when embedded deps are already present', () => {
    const calls: string[] = [];
    const result = ensureEmbeddedClaudeRuntimeReady({
      projectRoot: '/repo',
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      fileExists: (targetPath) =>
        targetPath === '/repo/claude-code/package.json'
        || targetPath === '/repo/claude-code/node_modules/lodash-es/sumBy.js',
      installRuntime: (runtimeRoot) => {
        calls.push(runtimeRoot);
        return { status: 0 };
      },
      verifyRuntime: () => ({ status: 0 }),
    });

    expect(calls).toEqual([]);
    expect(result).toEqual({
      attempted: false,
      installed: false,
      runtimeRoot: '/repo/claude-code',
    });
  });

  test('throws a clear error when embedded runtime bootstrap fails', () => {
    expect(() => ensureEmbeddedClaudeRuntimeReady({
      projectRoot: '/repo',
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      fileExists: (targetPath) =>
        targetPath === '/repo/claude-code/package.json',
      installRuntime: () => ({ status: 1 }),
      verifyRuntime: () => ({ status: 0 }),
    })).toThrow('Embedded Claude runtime bootstrap failed with exit code 1');
  });

  test('throws a clear error when the embedded runtime still cannot boot after dependencies exist', () => {
    expect(() => ensureEmbeddedClaudeRuntimeReady({
      projectRoot: '/repo',
      codexCommand: 'node ./scripts/claude-adapter.cjs',
      fileExists: (targetPath) =>
        targetPath === '/repo/claude-code/package.json'
        || targetPath === '/repo/claude-code/node_modules/lodash-es/sumBy.js',
      verifyRuntime: () => ({
        status: 1,
        stderr: "error: Cannot find module 'src/utils/hooks/hookEvents.js'",
      }),
    })).toThrow("Embedded Claude runtime is not runnable: error: Cannot find module 'src/utils/hooks/hookEvents.js'");
  });
});
