const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const { releaseAssetName, shouldInclude } = require('./build-release.cjs');

describe('release package builder', () => {
  test('uses stable GitHub Release asset names for every supported platform', () => {
    expect(releaseAssetName('darwin', 'arm64')).toBe('symharix-darwin-arm64.tar.gz');
    expect(releaseAssetName('linux', 'x64')).toBe('symharix-linux-x64.tar.gz');
    expect(releaseAssetName('win32', 'x64')).toBe('symharix-windows-x64.zip');
  });

  test('excludes secrets, mutable workflow data, caches, and tests', () => {
    expect(shouldInclude('.env')).toBe(false);
    expect(shouldInclude('.env.example')).toBe(true);
    expect(shouldInclude('WORKFLOW.md')).toBe(false);
    expect(shouldInclude('src/cli/configure.test.ts')).toBe(false);
    expect(shouldInclude('scripts/__pycache__/cli.pyc')).toBe(false);
    expect(shouldInclude('src/cli/configure.ts')).toBe(true);
  });

  test('POSIX launcher resolves a per-user installer symlink to the real package', () => {
    const launcher = fs.readFileSync(path.join(__dirname, 'release', 'symharix'), 'utf8');
    expect(launcher).toContain('while [ -L "$SYMHARIX_LAUNCHER" ]');
    expect(launcher).toContain('readlink "$SYMHARIX_LAUNCHER"');
    expect(launcher).toContain('"$SYMHARIX_PACKAGE_ROOT/bin/bun" --no-env-file run');
  });

  test('release launchers do not absorb a caller working directory .env', () => {
    const posix = fs.readFileSync(path.join(__dirname, 'release', 'symharix'), 'utf8');
    const windows = fs.readFileSync(path.join(__dirname, 'release', 'symharix.cmd'), 'utf8');

    expect(posix).toContain('--no-env-file');
    expect(windows).toContain('--no-env-file');
  });

  test('release matrix validates Linux arm64 using the runner uname value', () => {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('uname_arch: aarch64');
    expect(workflow).toContain('test "$(uname -m)" = "${{ matrix.uname_arch }}"');
  });
});
