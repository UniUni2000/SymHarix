import { describe, expect, test } from 'bun:test';
import {
  copyConfiguredRuntimeAccessToken,
  copySecretToClipboard,
  parseRuntimeAccessArgs,
  resolveRuntimeAccessToken,
} from './runtimeAccessToken';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Runtime access token clipboard helper', () => {
  test('parses viewer/operator copy commands with a safe viewer default', () => {
    expect(parseRuntimeAccessArgs([])).toEqual({ action: 'copy', role: 'viewer' });
    expect(parseRuntimeAccessArgs(['copy', 'operator'])).toEqual({ action: 'copy', role: 'operator' });
    expect(() => parseRuntimeAccessArgs(['show', 'viewer'])).toThrow('用法');
  });

  test('prefers SymHarix names and supports legacy aliases', () => {
    expect(resolveRuntimeAccessToken({
      SYMHARIX_RUNTIME_VIEWER_TOKEN: 'viewer-new',
      SYMPHONY_RUNTIME_VIEWER_TOKEN: 'viewer-old',
    }, 'viewer')).toBe('viewer-new');
    expect(resolveRuntimeAccessToken({
      SYMPHONY_RUNTIME_WRITE_TOKEN: 'operator-old',
    }, 'operator')).toBe('operator-old');
  });

  test('passes the secret only through clipboard stdin', () => {
    const calls: Array<{ command: string; input: unknown }> = [];
    const copied = copySecretToClipboard('secret-value', 'darwin', ((command, _args, options) => {
      calls.push({ command, input: options?.input });
      return { status: 0 } as ReturnType<typeof import('node:child_process')['spawnSync']>;
    }) as typeof import('node:child_process')['spawnSync']);

    expect(copied).toEqual({ ok: true, command: 'pbcopy' });
    expect(calls).toEqual([{ command: 'pbcopy', input: 'secret-value' }]);
  });

  test('reads the selected token without returning or printing it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'symharix-runtime-access-'));
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(envPath, 'SYMHARIX_RUNTIME_VIEWER_TOKEN=viewer-secret\nSYMHARIX_RUNTIME_WRITE_TOKEN=operator-secret\n');
    let clipboardInput = '';
    try {
      expect(copyConfiguredRuntimeAccessToken({
        envPath,
        role: 'viewer',
        platform: 'darwin',
        spawnClipboard: ((_command, _args, options) => {
          clipboardInput = String(options?.input ?? '');
          return { status: 0 } as ReturnType<typeof import('node:child_process')['spawnSync']>;
        }) as typeof import('node:child_process')['spawnSync'],
      })).toBeUndefined();
      expect(clipboardInput).toBe('viewer-secret');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
