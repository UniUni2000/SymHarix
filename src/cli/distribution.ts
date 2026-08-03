#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  defaultInstalledSymHarixHome,
  resolveSymHarixApplicationRoot,
  resolveSymHarixHome,
} from '../config/installationPaths';

export type DistributionCommand =
  | { kind: 'configure'; args: string[] }
  | { kind: 'start'; surface: 'telegram' | 'feishu'; args: string[] }
  | { kind: 'stop'; args: string[] }
  | { kind: 'runtime'; args: string[] }
  | { kind: 'access'; args: string[] }
  | { kind: 'smoke'; args: string[] }
  | { kind: 'open' }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'service'; args: string[] };

export function parseDistributionCommand(args: string[]): DistributionCommand {
  const [command, ...rest] = args;
  if (!command || command === 'configure' || command === 'config' || command === 'setup') {
    return { kind: 'configure', args: rest };
  }
  if (command === 'guide') return { kind: 'configure', args: ['--guide', ...rest] };
  if (command === 'check') return { kind: 'configure', args: ['--check', ...rest] };
  if (command === 'doctor') return { kind: 'configure', args: ['--doctor', ...rest] };
  if (command === 'secure') return { kind: 'configure', args: ['--secure', ...rest] };
  if (command === 'start') {
    const requested = rest[0]?.toLowerCase();
    const surface = requested === 'feishu' ? 'feishu' : 'telegram';
    const serviceArgs = requested === 'telegram' || requested === 'feishu' ? rest.slice(1) : rest;
    return { kind: 'start', surface, args: serviceArgs };
  }
  if (command === 'stop') return { kind: 'stop', args: rest };
  if (command === 'runtime') return { kind: 'runtime', args: rest };
  if (command === 'access') return { kind: 'access', args: rest };
  if (command === 'smoke') return { kind: 'smoke', args: rest };
  if (command === 'open') return { kind: 'open' };
  if (command === 'version' || command === '--version' || command === '-v') return { kind: 'version' };
  if (command === 'help' || command === '--help' || command === '-h') return { kind: 'help' };
  return { kind: 'service', args };
}

function printUsage(): void {
  console.log(`
SymHarix downloaded package

Usage:
  symharix                         Start first-run configuration
  symharix config                  Open selective configuration management
  symharix config models           Change only model settings
  symharix config telegram         Change or disable Telegram
  symharix config feishu           Change or disable Feishu
  symharix config budget           Change budgets and model pricing
  symharix config security         Rotate Runtime security settings
  symharix configure all           Run the complete wizard again
  symharix guide                   Show where every key/token comes from
  symharix check                   Run offline configuration checks
  symharix doctor                  Run read-only online credential checks
  symharix start [telegram|feishu] Start the selected local bot surface
  symharix stop                    Stop local SymHarix processes
  symharix open                    Open Runtime Deck in the default browser
  symharix access copy viewer      Copy the read-only Runtime token without printing it
  symharix access copy operator    Copy the write-capable Runtime token without printing it
  symharix runtime install         Install the pinned OpenCode runtime
  symharix runtime models <name>   List models known to OpenCode
  symharix runtime auth login      Configure OpenCode-managed credentials
  symharix smoke                   Make one explicit low-cost model call
  symharix version                 Print the installed package version

Environment:
  SYMHARIX_HOME                    Mutable config/data directory
  SYMHARIX_APP_ROOT                Immutable downloaded package directory
`);
}

function openRuntimeDeck(env: NodeJS.ProcessEnv): number {
  const port = env.PORT?.trim() || '3000';
  const target = `http://127.0.0.1:${port}/runtime`;
  const spec = process.platform === 'darwin'
    ? { command: 'open', args: [target] }
    : process.platform === 'win32'
      ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', target] }
      : { command: 'xdg-open', args: [target] };
  const result = spawnSync(spec.command, spec.args, { stdio: 'ignore', env });
  if (result.error || result.status !== 0) {
    console.log(`请在浏览器打开：${target}`);
    return 1;
  }
  console.log(`已打开 Runtime Deck：${target}`);
  return 0;
}

function ensureExecutionPrerequisites(
  applicationRoot: string,
  home: string,
  env: NodeJS.ProcessEnv,
): void {
  const git = spawnSync('git', ['--version'], { env, stdio: 'ignore' });
  if (git.error || git.status !== 0) {
    throw new Error('执行代码任务需要 Git。请先安装 Git，然后重新运行 symharix start。');
  }

  const virtualEnv = path.join(home, '.venv');
  const virtualEnvBin = path.join(virtualEnv, process.platform === 'win32' ? 'Scripts' : 'bin');
  const virtualEnvPython = path.join(
    virtualEnvBin,
    process.platform === 'win32' ? 'python.exe' : 'python3',
  );
  const requirementsPath = path.join(applicationRoot, 'scripts', 'requirements.txt');
  const requirementsDigest = createHash('sha256')
    .update(fs.readFileSync(requirementsPath))
    .digest('hex');
  const requirementsMarker = path.join(virtualEnv, '.symharix-requirements-sha256');
  if (!fs.existsSync(virtualEnvPython)) {
    const candidates = process.platform === 'win32'
      ? [
          { command: 'python.exe', args: [] },
          { command: 'py.exe', args: ['-3'] },
        ]
      : [{ command: 'python3', args: [] }];
    const candidate = candidates.find((item) => {
      const result = spawnSync(item.command, [...item.args, '--version'], { env, stdio: 'ignore' });
      return !result.error && result.status === 0;
    });
    if (!candidate) {
      throw new Error('执行代码任务需要 Python 3。请先安装 Python 3，然后重新运行 symharix start。');
    }
    console.log('首次启动：正在创建隔离的 Python 环境...');
    const created = spawnSync(candidate.command, [...candidate.args, '-m', 'venv', virtualEnv], {
      env,
      stdio: 'inherit',
    });
    if (created.error || created.status !== 0) {
      throw new Error('无法创建 Python 虚拟环境；请安装 Python venv 组件后重试。');
    }
  }

  const installedDigest = fs.existsSync(requirementsMarker)
    ? fs.readFileSync(requirementsMarker, 'utf8').trim()
    : '';
  if (installedDigest !== requirementsDigest) {
    console.log('正在安装 Python 运行依赖...');
    const installed = spawnSync(virtualEnvPython, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--quiet',
      '--requirement',
      requirementsPath,
    ], { env, stdio: 'inherit' });
    if (installed.error || installed.status !== 0) {
      throw new Error('Python 运行依赖安装失败；检查网络后重新运行 symharix start。');
    }
    fs.writeFileSync(requirementsMarker, `${requirementsDigest}\n`);
  }
  env.SYMHARIX_PYTHON_BIN = virtualEnvPython;
  env.PATH = `${virtualEnvBin}${path.delimiter}${env.PATH || ''}`;
}

async function main(): Promise<void> {
  const sourceRoot = path.resolve(__dirname, '../..');
  const applicationRoot = resolveSymHarixApplicationRoot(sourceRoot);
  const installedDefaultHome = process.env.SYMHARIX_APP_ROOT
    ? defaultInstalledSymHarixHome()
    : applicationRoot;
  const home = resolveSymHarixHome(installedDefaultHome);
  fs.mkdirSync(home, { recursive: true });

  const bundledBun = path.join(applicationRoot, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  const bun = fs.existsSync(bundledBun) ? bundledBun : process.execPath;
  const virtualEnvBin = path.join(home, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  const virtualEnvPython = path.join(
    virtualEnvBin,
    process.platform === 'win32' ? 'python.exe' : 'python3',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SYMHARIX_APP_ROOT: applicationRoot,
    SYMHARIX_HOME: home,
    ...(fs.existsSync(virtualEnvPython) ? { SYMHARIX_PYTHON_BIN: virtualEnvPython } : {}),
    PATH: [
      ...(fs.existsSync(virtualEnvPython) ? [virtualEnvBin] : []),
      path.join(applicationRoot, 'bin'),
      process.env.PATH || '',
    ].join(path.delimiter),
  };
  const envPath = path.join(home, '.env');
  const run = (script: string, args: string[], useEnvFile = false): number => {
    const bunArgs = [
      ...(useEnvFile && fs.existsSync(envPath) ? [`--env-file=${envPath}`] : []),
      'run',
      path.join(applicationRoot, script),
      ...args,
    ];
    const result = spawnSync(bun, bunArgs, {
      cwd: home,
      env,
      stdio: 'inherit',
    });
    if (result.error) {
      console.error(`SymHarix 启动失败：${result.error.message}`);
      return 1;
    }
    return result.status ?? 1;
  };

  const command = parseDistributionCommand(process.argv.slice(2));
  let status = 0;
  switch (command.kind) {
    case 'configure':
      status = run('src/cli/configure.ts', command.args);
      break;
    case 'start':
      ensureExecutionPrerequisites(applicationRoot, home, env);
      status = run('src/cli/startLocal.ts', [`--bot=${command.surface}`, ...command.args], true);
      break;
    case 'stop':
      status = run('src/cli/index.ts', ['--kill', ...command.args], true);
      break;
    case 'runtime':
      status = run('scripts/opencode-runtime.cjs', command.args, true);
      break;
    case 'access':
      status = run('src/cli/runtimeAccessToken.ts', command.args);
      break;
    case 'smoke':
      status = run('scripts/opencode-live-smoke.cjs', command.args, true);
      break;
    case 'service':
      ensureExecutionPrerequisites(applicationRoot, home, env);
      status = run('src/cli/index.ts', command.args, true);
      break;
    case 'open':
      status = openRuntimeDeck(env);
      break;
    case 'version': {
      const versionPath = path.join(applicationRoot, 'VERSION');
      console.log(fs.existsSync(versionPath)
        ? fs.readFileSync(versionPath, 'utf8').trim()
        : 'development');
      break;
    }
    case 'help':
      printUsage();
      break;
  }
  process.exitCode = status;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`SymHarix launcher error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
