#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline');

const sourceRoot = path.resolve(__dirname, '..');
const applicationRoot = path.resolve(process.env.SYMHARIX_APP_ROOT || sourceRoot);
const projectRoot = path.resolve(process.env.SYMHARIX_HOME || applicationRoot);
const lockPath = path.join(applicationRoot, 'runtime', 'opencode.lock.json');

function readLock(filePath = lockPath) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (
    value.schema !== 1 ||
    typeof value.repository !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.minimumCompatibleVersion !== 'string' ||
    !value.assets ||
    typeof value.assets !== 'object'
  ) {
    throw new Error(`Invalid OpenCode lock file: ${filePath}`);
  }
  return value;
}

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    throw new Error(`Cannot compare OpenCode versions: "${left}" and "${right}"`);
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function platformKey(platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(normalizedArch)) {
    throw new Error(`Unsupported OpenCode platform: ${platform}-${arch}`);
  }
  return `${platform === 'win32' ? 'windows' : platform}-${normalizedArch}`;
}

function cachedBinaryPath(lock = readLock(), root = projectRoot) {
  const executable = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  return path.join(root, '.runtime-cache', 'opencode', `v${lock.version}`, executable);
}

function binaryVersion(binary) {
  const result = cp.spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) {
    return { ok: false, error: result.error.message, version: null };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
      version: null,
    };
  }
  const version = String(result.stdout || result.stderr || '').trim().split(/\s+/).find(parseVersion) || null;
  return version
    ? { ok: true, error: null, version: version.replace(/^v/, '') }
    : { ok: false, error: 'version output was not semantic', version: null };
}

function resolveBinary(lock = readLock(), options = {}) {
  const candidates = [
    options.explicitBinary || process.env.SYMHARIX_OPENCODE_BIN || process.env.SYMPHONY_OPENCODE_BIN,
    cachedBinaryPath(lock, options.projectRoot || projectRoot),
    'opencode',
  ].filter(Boolean);

  for (const binary of candidates) {
    const result = binaryVersion(binary);
    if (result.ok) {
      return { binary, ...result };
    }
  }
  return { binary: null, ok: false, error: 'OpenCode executable was not found', version: null };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatTimeoutDuration(value) {
  const milliseconds = Math.max(1, Number(value) || 1);
  if (milliseconds < 60_000) return `${Math.max(1, Math.ceil(milliseconds / 1000))} 秒`;
  const minutes = milliseconds / 60_000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} 分钟`;
}

function formatDownloadProgress(received, total, elapsedMs, transferred = received) {
  const elapsedSeconds = Math.max(0.001, elapsedMs / 1000);
  const speed = transferred / elapsedSeconds;
  const percent = total && total > 0
    ? `${Math.min(100, (received / total) * 100).toFixed(1)}% `
    : '';
  const amount = total && total > 0
    ? `${formatBytes(received)} / ${formatBytes(total)}`
    : formatBytes(received);
  return `${percent}${amount} · ${formatBytes(speed)}/s · ${Math.round(elapsedSeconds)}s`;
}

function download(url, destination, redirects = 5, options = {}) {
  return new Promise((resolve, reject) => {
    const progress = options.progress !== false;
    const progressStream = options.progressStream || process.stderr;
    const stallTimeoutMs = positiveInteger(
      options.stallTimeoutMs || process.env.SYMHARIX_OPENCODE_DOWNLOAD_STALL_TIMEOUT_MS,
      30_000,
    );
    const totalTimeoutMs = positiveInteger(
      options.totalTimeoutMs || process.env.SYMHARIX_OPENCODE_DOWNLOAD_TIMEOUT_MS,
      300_000,
    );
    let output = null;
    let responseStream = null;
    let request = null;
    let settled = false;
    let stallTimer = null;
    let totalTimer = null;
    const existingSize = options.resume && fs.existsSync(destination)
      ? fs.statSync(destination).size
      : 0;
    let received = existingSize;
    let transferred = 0;
    let total = null;
    let lastRenderedAt = 0;
    const startedAt = Date.now();

    const render = (force = false) => {
      if (!progress || received === 0) return;
      const now = Date.now();
      const interval = progressStream.isTTY ? 200 : 5_000;
      if (!force && now - lastRenderedAt < interval) return;
      lastRenderedAt = now;
      const line = `  ${formatDownloadProgress(received, total, now - startedAt, transferred)}`;
      progressStream.write(progressStream.isTTY ? `\r\u001b[2K${line}` : `${line}\n`);
      if (force && progressStream.isTTY) progressStream.write('\n');
    };
    const clearTimers = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (totalTimer) clearTimeout(totalTimer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      render(true);
      request?.destroy();
      responseStream?.destroy();
      const finish = () => {
        if (!options.preservePartial) {
          try { fs.rmSync(destination, { force: true }); } catch {}
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      if (output && !output.closed) {
        output.once('close', finish);
        output.destroy();
      } else {
        finish();
      }
    };
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => fail(new Error(
        `OpenCode 下载连续 ${formatTimeoutDuration(stallTimeoutMs)}没有收到数据，已停止本次下载。`,
      )), stallTimeoutMs);
    };

    request = https.get(url, {
      headers: {
        'User-Agent': 'SymHarix-OpenCode-Installer',
        Accept: 'application/octet-stream',
        ...(existingSize > 0 ? { Range: `bytes=${existingSize}-` } : {}),
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
          reject(new Error('Too many redirects while downloading OpenCode'));
          return;
        }
        settled = true;
        clearTimers();
        resolve(download(
          new URL(response.headers.location, url).toString(),
          destination,
          redirects - 1,
          options,
        ));
        return;
      }
      if (response.statusCode !== 200) {
        if (response.statusCode === 416 && existingSize > 0) {
          response.resume();
          settled = true;
          clearTimers();
          resolve();
          return;
        }
        if (response.statusCode === 206 && existingSize > 0) {
          // Valid partial-content response; continue below in append mode.
        } else {
          response.resume();
          fail(new Error(`OpenCode download failed with HTTP ${response.statusCode || 'unknown'}`));
          return;
        }
      }
      const appending = response.statusCode === 206 && existingSize > 0;
      if (!appending && existingSize > 0) {
        received = 0;
      }
      const contentRange = String(response.headers['content-range'] || '');
      const rangeTotal = Number(contentRange.match(/\/(\d+)$/)?.[1]) || null;
      const contentLength = Number(response.headers['content-length']) || null;
      total = rangeTotal || (contentLength ? received + contentLength : null);
      output = fs.createWriteStream(destination, {
        mode: 0o600,
        flags: appending ? 'a' : 'w',
      });
      if (appending && progress) {
        progressStream.write(`  继续上次下载：已保留 ${formatBytes(existingSize)}\n`);
      }
      responseStream = response;
      response.on('data', (chunk) => {
        received += chunk.length;
        transferred += chunk.length;
        resetStallTimer();
        render(false);
      });
      response.pipe(output);
      output.on('finish', () => output.close(() => {
        if (settled) return;
        settled = true;
        clearTimers();
        render(true);
        resolve();
      }));
      output.on('error', fail);
      response.on('error', fail);
      resetStallTimer();
    });
    totalTimer = setTimeout(() => fail(new Error(
      `OpenCode 下载超过 ${formatTimeoutDuration(totalTimeoutMs)}，已停止本次下载。`,
    )), totalTimeoutMs);
    request.setTimeout(stallTimeoutMs, () => request.destroy(new Error(
      `OpenCode 下载连接连续 ${formatTimeoutDuration(stallTimeoutMs)}无响应。`,
    )));
    request.on('error', fail);
  });
}

function parseDownloadRecoveryChoice(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'r', 'retry', '重试'].includes(normalized)) return 'retry';
  if (['2', 's', 'skip', '稍后'].includes(normalized)) return 'skip';
  return null;
}

async function promptDownloadRecovery(error, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY || !output.isTTY) return 'fail';
  output.write(`\nOpenCode 下载未完成：${error instanceof Error ? error.message : String(error)}\n`);
  output.write('  1. 重试下载\n  2. 暂时跳过（稍后运行 symharix runtime install）\n');
  const lineReader = readline.createInterface({ input, output });
  try {
    while (true) {
      const selected = parseDownloadRecoveryChoice(await new Promise((resolve) => {
        lineReader.question('选择: ', resolve);
      }));
      if (selected) return selected;
      output.write('请输入 1 或 2。\n');
    }
  } finally {
    lineReader.close();
  }
}

async function installWithRecovery(options = {}) {
  const install = options.install || installPinned;
  const chooseRecovery = options.chooseRecovery || promptDownloadRecovery;
  while (true) {
    try {
      return await install(options.installOptions || {});
    } catch (error) {
      const action = await chooseRecovery(error);
      if (action === 'retry') {
        console.log('正在重新下载 OpenCode...');
        continue;
      }
      if (action === 'skip') {
        console.log('已暂时跳过 OpenCode 下载；配置已经保留，稍后运行 symharix runtime install 即可重试。');
        return null;
      }
      throw error;
    }
  }
}

function sha256(filePath) {
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(filePath));
  return digest.digest('hex');
}

function extractArchive(archivePath, destination, archiveName) {
  fs.mkdirSync(destination, { recursive: true });
  const spec = archiveName.endsWith('.zip')
    ? process.platform === 'win32'
      ? {
          command: 'powershell.exe',
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
            archivePath,
            destination,
          ],
        }
      : { command: 'unzip', args: ['-q', '-o', archivePath, '-d', destination] }
    : { command: 'tar', args: ['-xzf', archivePath, '-C', destination] };
  const result = cp.spawnSync(spec.command, spec.args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Failed to extract OpenCode: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
}

async function installPinned(options = {}) {
  const lock = options.lock || readLock();
  const key = platformKey(options.platform || process.platform, options.arch || process.arch);
  const asset = lock.assets[key];
  if (!asset) throw new Error(`OpenCode lock has no asset for ${key}`);

  const target = cachedBinaryPath(lock, options.projectRoot || projectRoot);
  const installed = binaryVersion(target);
  if (!options.force && installed.ok && installed.version === lock.version) {
    return { binary: target, version: installed.version, installed: false };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symharix-opencode-'));
  try {
    const runtimeRoot = options.projectRoot || projectRoot;
    const partialRoot = path.join(runtimeRoot, '.runtime-cache', 'downloads', `v${lock.version}`);
    const archivePath = options.download
      ? path.join(tempRoot, asset.archive)
      : path.join(partialRoot, `${asset.archive}.partial`);
    if (!options.download) fs.mkdirSync(partialRoot, { recursive: true });
    const url = `https://github.com/${lock.repository}/releases/download/v${lock.version}/${asset.archive}`;
    process.stdout.write(`正在下载 OpenCode v${lock.version}（${key}）...\n`);
    if (options.download === undefined) {
      console.log('  下载中会显示大小、百分比和速度；连续 30 秒无数据或总计超过 5 分钟会停止并提示重试。');
      if (fs.existsSync(archivePath) && fs.statSync(archivePath).size > 0) {
        console.log(`  检测到 ${formatBytes(fs.statSync(archivePath).size)} 未完成下载，将尝试从断点继续。`);
      }
    }
    await (options.download || download)(url, archivePath, 5, {
      ...options.downloadOptions,
      ...(!options.download ? { preservePartial: true, resume: true } : {}),
    });
    const actualDigest = sha256(archivePath);
    if (actualDigest !== asset.sha256) {
      fs.rmSync(archivePath, { force: true });
      throw new Error(`OpenCode checksum mismatch: expected ${asset.sha256}, got ${actualDigest}`);
    }

    const extractRoot = path.join(tempRoot, 'extract');
    (options.extract || extractArchive)(archivePath, extractRoot, asset.archive);
    const executable = (options.platform || process.platform) === 'win32' ? 'opencode.exe' : 'opencode';
    const extracted = [
      path.join(extractRoot, executable),
      path.join(extractRoot, 'bin', executable),
    ].find((candidate) => fs.existsSync(candidate));
    if (!extracted) throw new Error(`OpenCode archive ${asset.archive} did not contain an opencode binary`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(extracted, target);
    fs.chmodSync(target, 0o755);
    const verified = binaryVersion(target);
    if (!verified.ok || verified.version !== lock.version) {
      throw new Error(`Installed OpenCode verification failed: ${verified.error || verified.version}`);
    }
    fs.rmSync(archivePath, { force: true });
    return { binary: target, version: verified.version, installed: true };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function checkRuntime(options = {}) {
  const lock = options.lock || readLock();
  const resolved = resolveBinary(lock, options);
  if (!resolved.ok || !resolved.binary || !resolved.version) {
    throw new Error(resolved.error || 'OpenCode is unavailable');
  }
  if (compareVersions(resolved.version, lock.minimumCompatibleVersion) < 0) {
    throw new Error(
      `OpenCode ${resolved.version} is older than the minimum compatible version ${lock.minimumCompatibleVersion}`,
    );
  }
  if (options.strict && resolved.version !== lock.version) {
    throw new Error(`OpenCode ${resolved.version} is compatible but the tested version is ${lock.version}`);
  }
  return {
    binary: resolved.binary,
    version: resolved.version,
    testedVersion: lock.version,
    exact: resolved.version === lock.version,
  };
}

function buildPassthroughArgs(command, argv) {
  if (command === 'models') {
    return ['models', ...(argv[1] ? [argv[1]] : [])];
  }
  if (command === 'auth') {
    return ['auth', ...argv.slice(1)];
  }
  throw new Error(`Unsupported OpenCode passthrough command: ${command}`);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'check';
  if (command === 'install') {
    const result = await installWithRecovery({
      installOptions: { force: argv.includes('--force') },
    });
    if (!result) return;
    console.log(`${result.installed ? 'Installed' : 'Using'} OpenCode ${result.version}: ${result.binary}`);
    return;
  }
  if (command === 'check') {
    const result = checkRuntime({ strict: argv.includes('--strict') });
    console.log(
      `OpenCode ${result.version} (${result.exact ? 'tested' : `compatible; tested ${result.testedVersion}`}): ${result.binary}`,
    );
    return;
  }
  if (command === 'models') {
    const result = checkRuntime();
    const child = cp.spawnSync(result.binary, buildPassthroughArgs(command, argv), {
      stdio: 'inherit',
      env: process.env,
    });
    process.exitCode = child.status ?? 1;
    return;
  }
  if (command === 'auth') {
    const result = checkRuntime();
    const child = cp.spawnSync(result.binary, buildPassthroughArgs(command, argv), {
      stdio: 'inherit',
      env: process.env,
    });
    process.exitCode = child.status ?? 1;
    return;
  }
  if (command === 'path') {
    console.log(checkRuntime().binary);
    return;
  }
  throw new Error(`Unknown OpenCode runtime command: ${command}`);
}

module.exports = {
  binaryVersion,
  buildPassthroughArgs,
  cachedBinaryPath,
  checkRuntime,
  compareVersions,
  download,
  formatBytes,
  formatDownloadProgress,
  formatTimeoutDuration,
  installPinned,
  installWithRecovery,
  main,
  parseVersion,
  parseDownloadRecoveryChoice,
  platformKey,
  readLock,
  resolveBinary,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`OpenCode runtime error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
