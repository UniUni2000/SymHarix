#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

const TOP_LEVEL_FILES = [
  '.env.example',
  'WORKFLOW.md.example',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'bun.lock',
];
const TOP_LEVEL_DIRECTORIES = [
  'assets/logo',
  'docs',
  'node_modules',
  'runtime',
  'scripts/hooks',
  'scripts/lib',
  'src',
];
const RUNTIME_SCRIPTS = [
  'scripts/cli.py',
  'scripts/opencode-adapter.cjs',
  'scripts/opencode-live-smoke.cjs',
  'scripts/opencode-runtime.cjs',
  'scripts/requirements.txt',
];

function shouldInclude(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  return !(
    /(^|\/)\.env(?:\.|$)/.test(normalized) && normalized !== '.env.example'
  ) && !/(^|\/)WORKFLOW\.md$/.test(normalized)
    && !/(^|\/)__pycache__(\/|$)/.test(normalized)
    && !/\.py[co]$/.test(normalized)
    && !/\.test\.(?:js|ts)$/.test(normalized)
    && !/(^|\/)\.DS_Store$/.test(normalized);
}

function releaseAssetName(platform, arch) {
  const normalizedPlatform = platform === 'win32' ? 'windows' : platform;
  const extension = normalizedPlatform === 'windows' ? 'zip' : 'tar.gz';
  return `symharix-${normalizedPlatform}-${arch}.${extension}`;
}

function copyTree(source, destination, root = source) {
  const relative = path.relative(root, source);
  if (relative && !shouldInclude(relative)) return;
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(destination, entry), root);
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (stat.mode & 0o111) fs.chmodSync(destination, 0o755);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || !argv[index + 1]) throw new Error(`Invalid argument: ${key}`);
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function buildRelease(options) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!['darwin', 'linux', 'win32', 'windows'].includes(platform)) {
    throw new Error(`Unsupported release platform: ${platform}`);
  }
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported release architecture: ${arch}`);
  const outputRoot = path.resolve(options.output || path.join(projectRoot, 'build', 'release-stage'));
  const packageRoot = path.join(outputRoot, 'SymHarix');
  if (outputRoot === projectRoot || outputRoot === path.parse(outputRoot).root) {
    throw new Error(`Unsafe release output directory: ${outputRoot}`);
  }
  const bunSource = path.resolve(options.bun || process.execPath);
  if (!fs.existsSync(bunSource)) throw new Error(`Bun executable not found: ${bunSource}`);
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) {
    throw new Error('node_modules is missing; run bun install --production before packaging.');
  }

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(packageRoot, { recursive: true });
  for (const relative of [...TOP_LEVEL_FILES, ...TOP_LEVEL_DIRECTORIES, ...RUNTIME_SCRIPTS]) {
    const source = path.join(projectRoot, relative);
    if (!fs.existsSync(source)) throw new Error(`Required release input is missing: ${relative}`);
    copyTree(source, path.join(packageRoot, relative));
  }

  const windows = platform === 'win32' || platform === 'windows';
  const bunName = windows ? 'bun.exe' : 'bun';
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.copyFileSync(bunSource, path.join(packageRoot, 'bin', bunName));
  if (!windows) fs.chmodSync(path.join(packageRoot, 'bin', bunName), 0o755);

  const launchers = windows
    ? [['scripts/release/symharix.cmd', 'bin/symharix.cmd'], ['scripts/release/node.cmd', 'bin/node.cmd']]
    : [['scripts/release/symharix', 'bin/symharix'], ['scripts/release/node', 'bin/node']];
  for (const [source, destination] of launchers) {
    fs.copyFileSync(path.join(projectRoot, source), path.join(packageRoot, destination));
    if (!windows) fs.chmodSync(path.join(packageRoot, destination), 0o755);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = String(options.version || process.env.SYMHARIX_RELEASE_VERSION || packageJson.version)
    .replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  fs.writeFileSync(path.join(packageRoot, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(packageRoot, 'release-manifest.json'), `${JSON.stringify({
    schema: 1,
    name: 'SymHarix',
    version,
    platform: platform === 'win32' ? 'windows' : platform,
    arch,
    asset: releaseAssetName(platform, arch),
  }, null, 2)}\n`);

  const forbidden = [];
  const inspect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(packageRoot, target);
      if (!shouldInclude(relative)) forbidden.push(relative);
      if (entry.isDirectory()) inspect(target);
    }
  };
  inspect(packageRoot);
  if (forbidden.length > 0) {
    throw new Error(`Forbidden release files were staged: ${forbidden.join(', ')}`);
  }
  return { packageRoot, outputRoot, version, asset: releaseAssetName(platform, arch) };
}

if (require.main === module) {
  try {
    const result = buildRelease(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Release build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  buildRelease,
  releaseAssetName,
  shouldInclude,
};
