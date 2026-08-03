const { describe, expect, test } = require('bun:test');
const { buildLockFromRelease } = require('./upgrade-opencode.cjs');

const names = [
  'opencode-darwin-arm64.zip',
  'opencode-darwin-x64.zip',
  'opencode-linux-arm64.tar.gz',
  'opencode-linux-x64.tar.gz',
  'opencode-windows-arm64.zip',
  'opencode-windows-x64.zip',
];

describe('upgrade-opencode lock generation', () => {
  test('accepts only a complete release with GitHub SHA-256 digests', () => {
    const lock = buildLockFromRelease(
      { repository: 'anomalyco/opencode', minimumCompatibleVersion: '1.17.18' },
      {
        tag_name: 'v1.18.11',
        assets: names.map((name, index) => ({
          name,
          digest: `sha256:${String(index + 1).repeat(64)}`,
        })),
      },
    );
    expect(lock.version).toBe('1.18.11');
    expect(lock.assets['darwin-arm64'].archive).toBe('opencode-darwin-arm64.zip');
    expect(lock.assets['windows-x64'].archive).toBe('opencode-windows-x64.zip');
    expect(lock.minimumCompatibleVersion).toBe('1.17.18');
  });

  test('rejects a release missing a required platform asset', () => {
    expect(() => buildLockFromRelease(
      { repository: 'anomalyco/opencode', minimumCompatibleVersion: '1.17.18' },
      { tag_name: 'v1.18.11', assets: [] },
    )).toThrow('missing a SHA-256 digest');
  });
});
