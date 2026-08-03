#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import {
  resolveSymHarixApplicationRoot,
  resolveSymHarixHome,
} from '../config/installationPaths';

export type RuntimeAccessRole = 'viewer' | 'operator';

export function parseRuntimeAccessArgs(args: string[]): {
  action: 'copy';
  role: RuntimeAccessRole;
} {
  const [action = 'copy', requestedRole = 'viewer', ...extra] = args;
  if (action !== 'copy' || extra.length > 0 || !['viewer', 'operator'].includes(requestedRole)) {
    throw new Error('用法：bun run runtime:access -- copy viewer|operator');
  }
  return { action: 'copy', role: requestedRole as RuntimeAccessRole };
}

export function resolveRuntimeAccessToken(
  env: Record<string, string | undefined>,
  role: RuntimeAccessRole,
): string | null {
  const suffix = role === 'viewer' ? 'RUNTIME_VIEWER_TOKEN' : 'RUNTIME_WRITE_TOKEN';
  return env[`SYMHARIX_${suffix}`]?.trim()
    || env[`SYMPHONY_${suffix}`]?.trim()
    || null;
}

type SpawnClipboard = typeof spawnSync;

export function copySecretToClipboard(
  secret: string,
  platform = process.platform,
  spawnClipboard: SpawnClipboard = spawnSync,
): { ok: boolean; command: string | null } {
  const candidates = platform === 'darwin'
    ? [{ command: 'pbcopy', args: [] }]
    : platform === 'win32'
      ? [{ command: 'clip.exe', args: [] }]
      : [
          { command: 'wl-copy', args: [] },
          { command: 'xclip', args: ['-selection', 'clipboard'] },
          { command: 'xsel', args: ['--clipboard', '--input'] },
        ];

  for (const candidate of candidates) {
    const result = spawnClipboard(candidate.command, candidate.args, {
      input: secret,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    if (!result.error && result.status === 0) {
      return { ok: true, command: candidate.command };
    }
  }
  return { ok: false, command: null };
}

export function copyConfiguredRuntimeAccessToken(options: {
  envPath: string;
  role: RuntimeAccessRole;
  platform?: NodeJS.Platform;
  spawnClipboard?: SpawnClipboard;
}): void {
  if (!fs.existsSync(options.envPath)) {
    throw new Error(`没有找到本地配置文件：${options.envPath}。请先运行 bun run configure。`);
  }
  const env = dotenv.parse(fs.readFileSync(options.envPath, 'utf8'));
  const token = resolveRuntimeAccessToken(env, options.role);
  if (!token) {
    throw new Error(
      `${options.role === 'viewer' ? 'viewer' : 'operator'} token 尚未配置；请运行 bun run configure -- security。`,
    );
  }
  const copied = copySecretToClipboard(
    token,
    options.platform ?? process.platform,
    options.spawnClipboard ?? spawnSync,
  );
  if (!copied.ok) {
    throw new Error('未找到系统剪贴板工具（macOS: pbcopy；Linux: wl-copy/xclip/xsel；Windows: clip.exe）。');
  }
}

async function main(): Promise<void> {
  const sourceRoot = path.resolve(__dirname, '../..');
  const applicationRoot = resolveSymHarixApplicationRoot(sourceRoot);
  const home = resolveSymHarixHome(applicationRoot);
  const command = parseRuntimeAccessArgs(process.argv.slice(2));
  copyConfiguredRuntimeAccessToken({
    envPath: path.join(home, '.env'),
    role: command.role,
  });
  console.log(
    `${command.role === 'viewer' ? 'Viewer' : 'Operator'} token 已安全复制到剪贴板（终端未回显）。请粘贴到 Runtime 登录页。`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`Runtime token 复制失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
