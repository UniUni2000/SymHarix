import { describe, expect, test } from 'bun:test';
import {
  compareOpenCodeVersions,
  ensureOpenCodeRuntimeReady,
  getOpenCodeLockPath,
  getPinnedOpenCodeBinary,
  shouldBootstrapOpenCodeRuntime,
} from './openCodeRuntime';

describe('openCodeRuntime', () => {
  test('recognizes only the OpenCode adapter command', () => {
    expect(shouldBootstrapOpenCodeRuntime('node ./scripts/opencode-adapter.cjs')).toBe(true);
    expect(shouldBootstrapOpenCodeRuntime('codex app-server')).toBe(false);
  });

  test('compares semantic versions', () => {
    expect(compareOpenCodeVersions('1.18.10', '1.18.9')).toBe(1);
    expect(compareOpenCodeVersions('v1.18.10', '1.18.10')).toBe(0);
    expect(compareOpenCodeVersions('1.17.18', '1.18.10')).toBe(-1);
  });

  test('uses an explicit compatible binary without installing', () => {
    const result = ensureOpenCodeRuntimeReady({
      projectRoot: process.cwd(),
      codexCommand: 'node scripts/opencode-adapter.cjs',
      env: { SYMHARIX_OPENCODE_BIN: '/custom/opencode' },
      runCommand: (executable) => ({
        status: 0,
        stdout: executable === '/custom/opencode' ? '1.18.10\n' : '',
      }),
    });
    expect(result).toEqual({
      attempted: false,
      installed: false,
      binary: '/custom/opencode',
      version: '1.18.10',
    });
  });

  test('rejects an explicit binary below the compatibility floor', () => {
    expect(() => ensureOpenCodeRuntimeReady({
      projectRoot: process.cwd(),
      codexCommand: 'node scripts/opencode-adapter.cjs',
      env: { SYMHARIX_OPENCODE_BIN: '/old/opencode' },
      runCommand: () => ({ status: 0, stdout: '1.0.0\n' }),
    })).toThrow('older than minimum compatible');
  });

  test('installs the pinned runtime when PATH is compatible but not the tested version', () => {
    const actualRoot = process.cwd();
    const pinned = getPinnedOpenCodeBinary(actualRoot, '1.18.10');
    let installed = false;
    const result = ensureOpenCodeRuntimeReady({
      projectRoot: actualRoot,
      codexCommand: 'node scripts/opencode-adapter.cjs',
      env: {},
      fileExists: (target) =>
        target === getOpenCodeLockPath(actualRoot) ||
        target === `${actualRoot}/scripts/opencode-runtime.cjs` ||
        (installed && target === pinned),
      runCommand: (executable, args) => {
        if (executable === 'node' && args[1] === 'install') {
          installed = true;
          return { status: 0 };
        }
        if (executable === pinned && installed) return { status: 0, stdout: '1.18.10\n' };
        if (executable === 'opencode') return { status: 0, stdout: '1.17.18\n' };
        return { status: 1, stderr: 'missing' };
      },
    });
    expect(result).toMatchObject({
      attempted: true,
      installed: true,
      binary: pinned,
      version: '1.18.10',
    });
  });

  test('reads packaged runtime resources from app root while caching binaries under user data', () => {
    const appRoot = process.cwd();
    const home = '/tmp/symharix-user-data';
    const pinned = getPinnedOpenCodeBinary(home, '1.18.10');
    let installed = false;
    const result = ensureOpenCodeRuntimeReady({
      projectRoot: home,
      codexCommand: 'node scripts/opencode-adapter.cjs',
      env: { SYMHARIX_APP_ROOT: appRoot },
      fileExists: (target) =>
        target === getOpenCodeLockPath(appRoot)
        || target === `${appRoot}/scripts/opencode-runtime.cjs`
        || (installed && target === pinned),
      runCommand: (executable, args) => {
        if (executable === 'node' && args[0] === `${appRoot}/scripts/opencode-runtime.cjs`) {
          installed = true;
          return { status: 0 };
        }
        if (executable === pinned && installed) return { status: 0, stdout: '1.18.10\n' };
        return { status: 1, stderr: 'missing' };
      },
    });

    expect(result.binary).toBe(pinned);
    expect(result.installed).toBe(true);
  });
});
