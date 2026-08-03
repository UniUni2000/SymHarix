#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { installPinned } = require('./opencode-runtime.cjs');

const projectRoot = path.resolve(__dirname, '..');
const lockPath = path.join(projectRoot, 'runtime', 'opencode.lock.json');
const requiredAssets = [
  'opencode-darwin-arm64.zip',
  'opencode-darwin-x64.zip',
  'opencode-linux-arm64.tar.gz',
  'opencode-linux-x64.tar.gz',
  'opencode-windows-arm64.zip',
  'opencode-windows-x64.zip',
];

function requestJson(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const request = https.get(url, {
      headers: {
        'User-Agent': 'SymHarix-OpenCode-Upgrader',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        if (redirects <= 0) {
          reject(new Error('Too many GitHub API redirects'));
          return;
        }
        resolve(requestJson(new URL(response.headers.location, url).toString(), redirects - 1));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`GitHub release lookup failed with HTTP ${response.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error('GitHub release lookup timed out')));
    request.on('error', reject);
  });
}

async function requestGitHubRelease(url) {
  try {
    return await requestJson(url);
  } catch (apiError) {
    const endpoint = new URL(url).pathname.replace(/^\/+/, '');
    const result = cp.spawnSync('gh', ['api', endpoint], {
      cwd: projectRoot,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!result.error && result.status === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch (parseError) {
        throw new Error(
          `GitHub CLI returned invalid release JSON: ${
            parseError instanceof Error ? parseError.message : String(parseError)
          }`,
        );
      }
    }
    throw new Error(
      `${
        apiError instanceof Error ? apiError.message : String(apiError)
      }. Configure GITHUB_TOKEN/GH_TOKEN or run "gh auth login".`,
    );
  }
}

function buildLockFromRelease(current, release) {
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Release has an invalid semantic version: ${release.tag_name || 'missing'}`);
  }
  const byName = new Map((release.assets || []).map((asset) => [asset.name, asset]));
  const assets = {};
  for (const archive of requiredAssets) {
    const asset = byName.get(archive);
    const digest = typeof asset?.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : '';
    if (!asset || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Release v${version} is missing a SHA-256 digest for ${archive}`);
    }
    const platform = archive
      .replace(/^opencode-/, '')
      .replace(/\.tar\.gz$|\.zip$/g, '');
    assets[platform] = { archive, sha256: digest };
  }
  return {
    schema: 1,
    repository: current.repository,
    version,
    minimumCompatibleVersion: current.minimumCompatibleVersion,
    assets,
  };
}

function run(command, args) {
  const result = cp.spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const requested = String(argv[0] || 'latest').replace(/^v/, '');
  const currentText = fs.readFileSync(lockPath, 'utf8');
  const current = JSON.parse(currentText);
  const endpoint = requested === 'latest'
    ? `https://api.github.com/repos/${current.repository}/releases/latest`
    : `https://api.github.com/repos/${current.repository}/releases/tags/v${requested}`;
  const release = await requestGitHubRelease(endpoint);
  const next = buildLockFromRelease(current, release);
  if (next.version === current.version && !argv.includes('--force')) {
    console.log(`OpenCode v${next.version} is already the tested version.`);
    return;
  }

  console.log(`Upgrade candidate: OpenCode v${current.version} -> v${next.version}`);
  fs.writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`);
  try {
    await installPinned({ lock: next, force: true });
    run('bun', ['test', './scripts/opencode-adapter.test.js', './scripts/opencode-runtime.test.js', './src/agent/openCodeRuntime.test.ts']);
    run('bun', ['run', 'test']);
    console.log(`OpenCode v${next.version} passed the runtime contract and full regression suite.`);
    console.log('Review runtime/opencode.lock.json, then commit it with the related compatibility changes.');
  } catch (error) {
    fs.writeFileSync(lockPath, currentText);
    throw new Error(
      `OpenCode v${next.version} failed validation; restored v${current.version} lock. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

module.exports = {
  buildLockFromRelease,
  main,
  requestGitHubRelease,
  requestJson,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
