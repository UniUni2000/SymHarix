const { describe, expect, test } = require('bun:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const {
  buildPassthroughArgs,
  compareVersions,
  download,
  formatDownloadProgress,
  formatTimeoutDuration,
  installWithRecovery,
  parseVersion,
  parseDownloadRecoveryChoice,
  platformKey,
} = require('./opencode-runtime.cjs');

describe('opencode-runtime lock helpers', () => {
  test('parses and compares semantic versions', () => {
    expect(parseVersion('v1.18.10')).toEqual([1, 18, 10]);
    expect(parseVersion('latest')).toBeNull();
    expect(compareVersions('1.18.10', '1.17.18')).toBe(1);
    expect(compareVersions('1.18.10', 'v1.18.10')).toBe(0);
  });

  test('maps supported release assets and rejects unsupported platforms', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('linux', 'x64')).toBe('linux-x64');
    expect(platformKey('win32', 'x64')).toBe('windows-x64');
    expect(platformKey('win32', 'arm64')).toBe('windows-arm64');
    expect(() => platformKey('freebsd', 'x64')).toThrow('Unsupported OpenCode platform');
  });

  test('forwards only explicit model and auth subcommands to the pinned runtime', () => {
    expect(buildPassthroughArgs('models', ['models', 'deepseek'])).toEqual(['models', 'deepseek']);
    expect(buildPassthroughArgs('auth', ['auth', 'login'])).toEqual(['auth', 'login']);
    expect(buildPassthroughArgs('auth', ['auth', 'list'])).toEqual(['auth', 'list']);
    expect(() => buildPassthroughArgs('run', ['run'])).toThrow('Unsupported OpenCode passthrough');
  });

  test('formats visible progress with percent, size, speed, and elapsed time', () => {
    expect(formatDownloadProgress(5 * 1024 * 1024, 20 * 1024 * 1024, 2_000)).toBe(
      '25.0% 5.0 MiB / 20.0 MiB · 2.5 MiB/s · 2s',
    );
    expect(formatDownloadProgress(1024, null, 1_000)).toBe('1.0 KiB · 1.0 KiB/s · 1s');
    expect(formatDownloadProgress(5 * 1024, 20 * 1024, 2_000, 1024)).toBe(
      '25.0% 5.0 KiB / 20.0 KiB · 512 B/s · 2s',
    );
    expect(formatTimeoutDuration(20)).toBe('1 秒');
    expect(formatTimeoutDuration(300_000)).toBe('5 分钟');
  });

  test('accepts numeric retry/skip choices and rejects accidental input', () => {
    expect(parseDownloadRecoveryChoice('1')).toBe('retry');
    expect(parseDownloadRecoveryChoice('重试')).toBe('retry');
    expect(parseDownloadRecoveryChoice('2')).toBe('skip');
    expect(parseDownloadRecoveryChoice('anything')).toBeNull();
  });

  test('retries a failed install only after an explicit retry choice', async () => {
    let attempts = 0;
    const result = await installWithRecovery({
      install: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('stalled');
        return { binary: '/tmp/opencode', version: '1.18.10', installed: true };
      },
      chooseRecovery: async () => 'retry',
    });
    expect(attempts).toBe(2);
    expect(result?.version).toBe('1.18.10');
  });

  test('keeps configuration usable when the operator chooses to download later', async () => {
    const result = await installWithRecovery({
      install: async () => { throw new Error('slow network'); },
      chooseRecovery: async () => 'skip',
    });
    expect(result).toBeNull();
  });

  test('aborts a connected download that stops producing data', async () => {
    const originalGet = https.get;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symharix-download-stall-'));
    https.get = (_url, _options, callback) => {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = (error) => request.emit('error', error);
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { 'content-length': '1024' };
        callback(response);
      });
      return request;
    };
    try {
      await expect(download(
        'https://example.invalid/opencode.tar.gz',
        path.join(tempRoot, 'partial.tar.gz'),
        0,
        { progress: false, stallTimeoutMs: 20, totalTimeoutMs: 1_000 },
      )).rejects.toThrow('连续 1 秒没有收到数据');
      expect(fs.existsSync(path.join(tempRoot, 'partial.tar.gz'))).toBe(false);
    } finally {
      https.get = originalGet;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('reports final progress when the response has a content length', async () => {
    const originalGet = https.get;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symharix-download-progress-'));
    const output = [];
    https.get = (_url, _options, callback) => {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = (error) => request.emit('error', error);
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { 'content-length': '4' };
        callback(response);
        response.end(Buffer.from('test'));
      });
      return request;
    };
    try {
      await download(
        'https://example.invalid/opencode.tar.gz',
        path.join(tempRoot, 'complete.tar.gz'),
        0,
        {
          stallTimeoutMs: 1_000,
          totalTimeoutMs: 2_000,
          progressStream: { isTTY: false, write: (value) => output.push(String(value)) },
        },
      );
      expect(fs.readFileSync(path.join(tempRoot, 'complete.tar.gz'), 'utf8')).toBe('test');
      expect(output.join('')).toContain('100.0%');
      expect(output.join('')).toContain('4 B / 4 B');
    } finally {
      https.get = originalGet;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('resumes a preserved partial archive with an HTTP Range request', async () => {
    const originalGet = https.get;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symharix-download-resume-'));
    const destination = path.join(tempRoot, 'partial.tar.gz');
    fs.writeFileSync(destination, 'test');
    let requestedRange = null;
    https.get = (_url, options, callback) => {
      requestedRange = options.headers.Range || null;
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = (error) => request.emit('error', error);
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 206;
        response.headers = {
          'content-length': '4',
          'content-range': 'bytes 4-7/8',
        };
        callback(response);
        response.end(Buffer.from('more'));
      });
      return request;
    };
    try {
      await download(
        'https://example.invalid/opencode.tar.gz',
        destination,
        0,
        { progress: false, resume: true, preservePartial: true },
      );
      expect(requestedRange).toBe('bytes=4-');
      expect(fs.readFileSync(destination, 'utf8')).toBe('testmore');
    } finally {
      https.get = originalGet;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('keeps received bytes on timeout when resumable mode is enabled', async () => {
    const originalGet = https.get;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symharix-download-preserve-'));
    const destination = path.join(tempRoot, 'partial.tar.gz');
    https.get = (_url, _options, callback) => {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = (error) => request.emit('error', error);
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { 'content-length': '1024' };
        callback(response);
        response.write(Buffer.from('keep-me'));
      });
      return request;
    };
    try {
      await expect(download(
        'https://example.invalid/opencode.tar.gz',
        destination,
        0,
        {
          progress: false,
          preservePartial: true,
          resume: true,
          stallTimeoutMs: 20,
          totalTimeoutMs: 1_000,
        },
      )).rejects.toThrow('没有收到数据');
      expect(fs.readFileSync(destination, 'utf8')).toBe('keep-me');
    } finally {
      https.get = originalGet;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
