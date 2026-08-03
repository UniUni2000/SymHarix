import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface OpenCodeRuntimeBootstrapResult {
  attempted: boolean;
  installed: boolean;
  binary: string | null;
  version: string | null;
}

interface OpenCodeCommandResult {
  status: number | null;
  error?: Error | null;
  stderr?: string | null;
  stdout?: string | null;
}

interface OpenCodeRuntimeLock {
  version: string;
  minimumCompatibleVersion: string;
}

interface EnsureOpenCodeRuntimeReadyOptions {
  projectRoot: string;
  codexCommand: string;
  env?: NodeJS.ProcessEnv;
  fileExists?: (targetPath: string) => boolean;
  runCommand?: (
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => OpenCodeCommandResult;
  log?: (message: string) => void;
}

export function shouldBootstrapOpenCodeRuntime(codexCommand: string): boolean {
  return codexCommand.includes('opencode-adapter.cjs');
}

export function getOpenCodeLockPath(projectRoot: string): string {
  return path.join(projectRoot, 'runtime', 'opencode.lock.json');
}

export function readOpenCodeRuntimeLock(projectRoot: string): OpenCodeRuntimeLock {
  const lockPath = getOpenCodeLockPath(projectRoot);
  const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<OpenCodeRuntimeLock>;
  if (!parsed.version || !parsed.minimumCompatibleVersion) {
    throw new Error(`Invalid OpenCode runtime lock: ${lockPath}`);
  }
  return {
    version: parsed.version,
    minimumCompatibleVersion: parsed.minimumCompatibleVersion,
  };
}

export function getPinnedOpenCodeBinary(projectRoot: string, version: string): string {
  return path.join(
    projectRoot,
    '.runtime-cache',
    'opencode',
    `v${version}`,
    process.platform === 'win32' ? 'opencode.exe' : 'opencode',
  );
}

function parseVersion(value: string): number[] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function compareOpenCodeVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    throw new Error(`Cannot compare OpenCode versions: "${left}" and "${right}"`);
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

function verifyBinary(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  runCommand: NonNullable<EnsureOpenCodeRuntimeReadyOptions['runCommand']>,
): { ok: boolean; version: string | null; detail: string | null } {
  const result = runCommand(binary, ['--version'], { cwd, env });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      version: null,
      detail: result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`,
    };
  }
  const output = `${result.stdout || ''} ${result.stderr || ''}`.trim();
  const version = output.split(/\s+/).find((part) => parseVersion(part))?.replace(/^v/, '') || null;
  return {
    ok: Boolean(version),
    version,
    detail: version ? null : `Unexpected version output: ${output}`,
  };
}

export function ensureOpenCodeRuntimeReady(
  options: EnsureOpenCodeRuntimeReadyOptions,
): OpenCodeRuntimeBootstrapResult {
  if (!shouldBootstrapOpenCodeRuntime(options.codexCommand)) {
    return { attempted: false, installed: false, binary: null, version: null };
  }

  const env = options.env ?? process.env;
  const applicationRoot = env.SYMHARIX_APP_ROOT?.trim() || options.projectRoot;
  const fileExists = options.fileExists ?? existsSync;
  const runCommand = options.runCommand ?? ((executable, args, runOptions) => spawnSync(executable, args, {
    cwd: runOptions.cwd,
    env: runOptions.env,
    encoding: 'utf8',
  }));
  const lock = readOpenCodeRuntimeLock(applicationRoot);
  const pinnedBinary = getPinnedOpenCodeBinary(options.projectRoot, lock.version);
  const explicitBinary = env.SYMHARIX_OPENCODE_BIN || env.SYMPHONY_OPENCODE_BIN;

  if (explicitBinary) {
    const verified = verifyBinary(explicitBinary, options.projectRoot, env, runCommand);
    if (!verified.ok || !verified.version) {
      throw new Error(`Configured OpenCode runtime is not runnable: ${verified.detail || explicitBinary}`);
    }
    if (compareOpenCodeVersions(verified.version, lock.minimumCompatibleVersion) < 0) {
      throw new Error(
        `Configured OpenCode ${verified.version} is older than minimum compatible ${lock.minimumCompatibleVersion}`,
      );
    }
    return { attempted: false, installed: false, binary: explicitBinary, version: verified.version };
  }

  if (fileExists(pinnedBinary)) {
    const verified = verifyBinary(pinnedBinary, options.projectRoot, env, runCommand);
    if (verified.ok && verified.version === lock.version) {
      return { attempted: false, installed: false, binary: pinnedBinary, version: verified.version };
    }
  }

  const pathRuntime = verifyBinary('opencode', options.projectRoot, env, runCommand);
  if (pathRuntime.ok && pathRuntime.version === lock.version) {
    return { attempted: false, installed: false, binary: 'opencode', version: pathRuntime.version };
  }

  const installer = path.join(applicationRoot, 'scripts', 'opencode-runtime.cjs');
  if (!fileExists(installer)) {
    throw new Error(`Missing OpenCode installer: ${installer}`);
  }
  options.log?.(
    `[symharix] Installing tested OpenCode v${lock.version}` +
    (pathRuntime.version ? ` (PATH has compatible ${pathRuntime.version})` : ''),
  );
  const installResult = runCommand('node', [installer, 'install'], {
    cwd: options.projectRoot,
    env,
  });
  if (installResult.error || installResult.status !== 0) {
    throw new Error(
      `OpenCode runtime installation failed: ${
        installResult.error?.message ||
        installResult.stderr?.trim() ||
        installResult.stdout?.trim() ||
        `exit ${installResult.status}`
      }`,
    );
  }

  const verified = verifyBinary(pinnedBinary, options.projectRoot, env, runCommand);
  if (!verified.ok || verified.version !== lock.version) {
    throw new Error(`Installed OpenCode runtime verification failed: ${verified.detail || verified.version}`);
  }
  return { attempted: true, installed: true, binary: pinnedBinary, version: verified.version };
}
