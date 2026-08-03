const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const root = path.resolve(__dirname, '..');

describe('download installers and release workflow', () => {
  test('POSIX installer verifies the archive before activating a version', () => {
    const source = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
    expect(source).toContain('checksum mismatch');
    expect(source).toContain('current-version');
    expect(source.indexOf("[ \"$ACTUAL\" = \"$EXPECTED\" ]"))
      .toBeLessThan(source.indexOf('current-version'));
    expect(source).toContain('.venv/bin/python3');
    expect(source).toContain('INSTALLED_REQUIREMENTS_DIGEST');
    expect(source).toContain("grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+");
    expect(source).toContain('ln -s "$DESTINATION/bin/symharix"');
    expect(source).not.toContain('sudo ');
  });

  test('PowerShell installer uses SHA-256 and a per-user version directory', () => {
    const source = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');
    expect(source).toContain('Get-FileHash -Algorithm SHA256');
    expect(source).toContain("Join-Path $InstallRoot 'versions'");
    expect(source).toContain("Scripts\\python.exe");
    expect(source).toContain('$InstalledRequirementsDigest');
    expect(source).toContain("'^\\d+\\.\\d+\\.\\d+");
    expect(source).not.toContain('Start-Process powershell -Verb RunAs');
  });

  test('release workflow packages every promised native target before publishing', () => {
    const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'));
    const matrix = workflow.jobs.package.strategy.matrix.include;
    expect(matrix.map((item) => `${item.asset_platform}-${item.arch}`)).toEqual([
      'darwin-x64',
      'darwin-arm64',
      'linux-x64',
      'linux-arm64',
      'windows-x64',
      'windows-arm64',
    ]);
    expect(workflow.jobs.publish.needs).toBe('package');
    expect(workflow.jobs.package.steps.find((step) => step.name === 'Stage release package').env.SYMHARIX_RELEASE_VERSION)
      .not.toBe('${{ github.ref_name }}');
  });
});
