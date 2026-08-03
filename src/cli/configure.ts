#!/usr/bin/env bun

/**
 * Guided local configuration for SymHarix.
 *
 * The application deliberately keeps secrets in a local `.env` file and the
 * repository mapping in `WORKFLOW.md`. This command is a small, repeatable
 * terminal workflow for creating both without asking operators to edit YAML.
 */

import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface, type Interface } from 'readline/promises';
import * as dotenv from 'dotenv';
import * as YAML from 'yaml';
import {
  discoverLinearProjects,
  probeGitHubRepository,
  runConfigurationDoctor,
  type ConfigurationDoctorInput,
  type DiscoveredLinearProject,
} from './configureDoctor';
import {
  printSetupGuide,
  printSetupGuideTopic,
  type SetupGuideTopic,
} from './setupGuide';
import {
  validateConfigurationField,
  validateConfigurationFormats,
} from './configureValidation';
import {
  resolveSymHarixApplicationRoot,
  resolveSymHarixHome,
} from '../config/installationPaths';

const sourceRoot = path.resolve(__dirname, '../..');
const applicationRoot = resolveSymHarixApplicationRoot(sourceRoot);
const projectRoot = resolveSymHarixHome(applicationRoot);
const ENV_EXAMPLE_PATH = path.join(applicationRoot, '.env.example');
const ENV_PATH = path.join(projectRoot, '.env');
const WORKFLOW_EXAMPLE_PATH = path.join(applicationRoot, 'WORKFLOW.md.example');
const WORKFLOW_PATH = path.join(projectRoot, 'WORKFLOW.md');

type EnvValues = Record<string, string | undefined>;
type BotSurface = 'telegram' | 'feishu' | 'both' | 'none';
export type ModelProvider = 'anthropic' | 'openai' | 'deepseek' | 'openai-compatible';
type CodeModelProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'openrouter'
  | 'alibaba-cn'
  | 'openai-compatible'
  | 'existing-auth';

interface WorkflowRoute {
  projectSlug: string;
  githubOwner: string;
  githubRepo: string;
}

interface SetupReadiness {
  label: string;
  ready: boolean;
  detail: string;
}

type GitHubVerificationAction = 'reenter' | 'retry' | 'continue-offline' | 'restart-step';
type InputRecoveryAction = 'retry' | 'restart-step';
type WizardStepRecoveryAction = 'retry' | 'back' | 'cancel';
export type ConfigurationSection =
  | 'connections'
  | 'models'
  | 'telegram'
  | 'feishu'
  | 'budget'
  | 'security';
export type ConfigurationAction =
  | ConfigurationSection
  | 'status'
  | 'doctor'
  | 'guide'
  | 'all'
  | 'exit';

class RestartWizardStepError extends Error {
  constructor(message = '返回本阶段开头重新选择。') {
    super(message);
    this.name = 'RestartWizardStepError';
  }
}

interface PresetChoice {
  value: string;
  label: string;
}

interface GitHubCredentialPrompter {
  askManagedSecret(label: string, current?: string): Promise<ManagedSecretResult>;
  askChoice<T extends string>(
    label: string,
    choices: Array<{ key: string; value: T; label: string }>,
  ): Promise<T>;
}

interface CollectedGitHubCredential extends ManagedSecretResult {
  verified: boolean;
}

const CODE_PROVIDER_PRESETS: Record<
  Exclude<CodeModelProvider, 'existing-auth'>,
  { providerID: string; keyEnv: string; defaultModel: string }
> = {
  anthropic: {
    providerID: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4-5',
  },
  openai: {
    providerID: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    defaultModel: 'openai/gpt-5.1-codex',
  },
  google: {
    providerID: 'google',
    keyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    defaultModel: 'google/gemini-2.5-pro',
  },
  deepseek: {
    providerID: 'deepseek',
    keyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek/deepseek-v4-pro',
  },
  openrouter: {
    providerID: 'openrouter',
    keyEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'openrouter/anthropic/claude-sonnet-4.5',
  },
  'alibaba-cn': {
    providerID: 'alibaba-cn',
    keyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'alibaba-cn/qwen3-coder-plus',
  },
  'openai-compatible': {
    providerID: 'symharix-compatible',
    keyEnv: 'SYMHARIX_OPENCODE_API_KEY',
    defaultModel: 'symharix-compatible/qwen-coder',
  },
};

const CONFIGURATION_ACTION_ALIASES: Record<string, ConfigurationAction> = {
  connections: 'connections',
  connection: 'connections',
  github: 'connections',
  linear: 'connections',
  models: 'models',
  model: 'models',
  llm: 'models',
  telegram: 'telegram',
  tg: 'telegram',
  feishu: 'feishu',
  lark: 'feishu',
  budget: 'budget',
  cost: 'budget',
  costs: 'budget',
  security: 'security',
  secure: 'security',
  status: 'status',
  show: 'status',
  check: 'status',
  doctor: 'doctor',
  guide: 'guide',
  all: 'all',
  full: 'all',
  exit: 'exit',
  quit: 'exit',
};

export function parseConfigurationAction(value: string | undefined): ConfigurationAction | null {
  if (!value) return null;
  return CONFIGURATION_ACTION_ALIASES[value.trim().toLowerCase()] ?? null;
}

function trim(value: string | undefined): string {
  return value?.trim() ?? '';
}

function envValue(env: EnvValues, key: string): string {
  const current = trim(env[key]);
  if (current) {
    return current;
  }
  if (key.startsWith('SYMHARIX_')) {
    return trim(env[`SYMPHONY_${key.slice('SYMHARIX_'.length)}`]);
  }
  return '';
}

export function hasExistingConfiguration(env: EnvValues): boolean {
  return [
    'SYMHARIX_TRACKER_API_KEY',
    'GITHUB_TOKEN',
    'SYMHARIX_OPENCODE_MODEL',
    'SYMHARIX_BOT_LLM_MODEL',
    'SYMHARIX_TELEGRAM_BOT_TOKEN',
    'SYMHARIX_FEISHU_APP_ID',
  ].some((key) => Boolean(envValue(env, key)));
}

export type BudgetPresetName = 'conservative' | 'standard' | 'generous';

export function getBudgetPreset(name: BudgetPresetName): Record<string, string> {
  if (name === 'conservative') {
    return {
      SYMHARIX_MAX_TURN_OUTPUT_TOKENS: '8000',
      SYMHARIX_MAX_TURN_STEPS: '8',
      SYMHARIX_TURN_RESERVE_TOKENS: '100000',
      SYMHARIX_MAX_TASK_TOKENS: '250000',
      SYMHARIX_MAX_REPO_DAILY_TOKENS: '1000000',
      SYMHARIX_MAX_DAILY_TOKENS: '2000000',
      SYMHARIX_MAX_TASK_USD: '10',
      SYMHARIX_MAX_REPO_DAILY_USD: '50',
      SYMHARIX_MAX_DAILY_USD: '100',
      SYMHARIX_COST_OVERRIDE_MINUTES: '30',
    };
  }
  if (name === 'generous') {
    return {
      SYMHARIX_MAX_TURN_OUTPUT_TOKENS: '32000',
      SYMHARIX_MAX_TURN_STEPS: '20',
      SYMHARIX_TURN_RESERVE_TOKENS: '400000',
      SYMHARIX_MAX_TASK_TOKENS: '1000000',
      SYMHARIX_MAX_REPO_DAILY_TOKENS: '5000000',
      SYMHARIX_MAX_DAILY_TOKENS: '10000000',
      SYMHARIX_MAX_TASK_USD: '50',
      SYMHARIX_MAX_REPO_DAILY_USD: '250',
      SYMHARIX_MAX_DAILY_USD: '500',
      SYMHARIX_COST_OVERRIDE_MINUTES: '60',
    };
  }
  return {
    SYMHARIX_MAX_TURN_OUTPUT_TOKENS: '16000',
    SYMHARIX_MAX_TURN_STEPS: '12',
    SYMHARIX_TURN_RESERVE_TOKENS: '200000',
    SYMHARIX_MAX_TASK_TOKENS: '500000',
    SYMHARIX_MAX_REPO_DAILY_TOKENS: '2000000',
    SYMHARIX_MAX_DAILY_TOKENS: '5000000',
    SYMHARIX_MAX_TASK_USD: '25',
    SYMHARIX_MAX_REPO_DAILY_USD: '100',
    SYMHARIX_MAX_DAILY_USD: '250',
    SYMHARIX_COST_OVERRIDE_MINUTES: '60',
  };
}

function validateFieldOrThrow(field: string, value: string): string {
  const issues = validateConfigurationField(field, value);
  const error = issues.find((candidate) => candidate.severity === 'error');
  if (error) {
    throw new Error(error.message);
  }
  for (const warning of issues.filter((candidate) => candidate.severity === 'warning')) {
    console.log(`  ! 格式提醒: ${warning.message}`);
  }
  return value;
}

function mask(value: string): string {
  if (!value) {
    return '(未设置)';
  }
  if (value.length <= 8) {
    return '••••••••';
  }
  return `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

export type ExistingSecretAction = 'keep' | 'replace';

export interface ManagedSecretResult {
  value: string;
  shouldWrite: boolean;
}

/** Build a safe preview without ever returning the complete configured secret. */
export function formatExistingSecretPreview(label: string, current: string): string {
  return `${label} 当前已配置：${mask(current)}`;
}

/**
 * Resolve an existing secret without reading or rewriting it when the operator
 * explicitly chooses to keep the current value.
 */
export async function resolveManagedSecret(
  current: string,
  chooseAction: () => Promise<ExistingSecretAction>,
  readReplacement: () => Promise<string>,
): Promise<ManagedSecretResult> {
  if (!current) {
    return { value: await readReplacement(), shouldWrite: true };
  }
  if (await chooseAction() === 'keep') {
    return { value: current, shouldWrite: false };
  }
  return { value: await readReplacement(), shouldWrite: true };
}

function quotedEnvValue(value: string): string {
  if (/\r|\n/.test(value)) {
    throw new Error('环境变量不能包含换行符。');
  }
  return /[\s#"'\\]/.test(value) ? JSON.stringify(value) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Update assignments without dropping comments or unrelated configuration. */
export function upsertEnvAssignments(source: string, updates: EnvValues): string {
  const lines = source.split(/\r?\n/);
  const pending = new Map(
    Object.entries(updates)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value as string]),
  );

  const updated = lines.map((line) => {
    for (const [key, value] of pending) {
      const match = line.match(new RegExp(`^(\\s*(?:export\\s+)?)${escapeRegExp(key)}=.*$`));
      if (!match) {
        continue;
      }
      pending.delete(key);
      return `${match[1] ?? ''}${key}=${quotedEnvValue(value)}`;
    }
    return line;
  });

  if (updated.at(-1) === '') {
    updated.pop();
  }
  for (const [key, value] of pending) {
    updated.push(`${key}=${quotedEnvValue(value)}`);
  }
  return `${updated.join('\n')}\n`;
}

function splitWorkflow(content: string): { frontmatter: string; body: string } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error('WORKFLOW.md 必须以 YAML front matter（---）开头。');
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) {
    throw new Error('WORKFLOW.md 的 YAML front matter 缺少结束的 ---。');
  }
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n').trim(),
  };
}

function validateRoute(route: WorkflowRoute): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(route.projectSlug)) {
    throw new Error('Linear project slug 只能包含字母、数字、点、下划线和连字符。');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(route.githubOwner) || !/^[A-Za-z0-9_.-]+$/.test(route.githubRepo)) {
    throw new Error('GitHub owner 和仓库名只能包含字母、数字、点、下划线和连字符。');
  }
}

/** Add or update only the selected Linear project -> GitHub repository route. */
export function upsertWorkflowRoute(source: string, route: WorkflowRoute): string {
  validateRoute(route);
  const { frontmatter, body } = splitWorkflow(source);
  const document = YAML.parseDocument(frontmatter);
  if (document.errors.length > 0) {
    throw new Error(`WORKFLOW.md 的 YAML 无法解析：${document.errors[0]!.message}`);
  }
  if (!YAML.isMap(document.contents)) {
    throw new Error('WORKFLOW.md 的 YAML front matter 必须是一个对象。');
  }

  document.setIn(['tracker', 'kind'], 'linear');
  document.setIn(['tracker', 'api_key'], '$SYMHARIX_TRACKER_API_KEY');
  document.setIn(['repositories', 'routing', route.projectSlug], {
    github_owner: route.githubOwner,
    github_repo: route.githubRepo,
  });

  return `---\n${document.toString().trimEnd()}\n---\n\n${body}\n`;
}

function readEnvFile(envPath = ENV_PATH): EnvValues {
  return fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
}

function ensureLocalConfigFiles(
  envPath = ENV_PATH,
  envExamplePath = ENV_EXAMPLE_PATH,
  workflowPath = WORKFLOW_PATH,
  workflowExamplePath = WORKFLOW_EXAMPLE_PATH,
): void {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(envExamplePath, envPath);
  }
  if (!fs.existsSync(workflowPath)) {
    fs.copyFileSync(workflowExamplePath, workflowPath);
  }
}

function getRouteForProject(workflowPath: string, projectSlug: string): WorkflowRoute | null {
  if (!fs.existsSync(workflowPath)) {
    return null;
  }
  try {
    const { frontmatter } = splitWorkflow(fs.readFileSync(workflowPath, 'utf8'));
    const parsed = YAML.parse(frontmatter) as {
      repositories?: { routing?: Record<string, { github_owner?: unknown; github_repo?: unknown }> };
    };
    const route = parsed?.repositories?.routing?.[projectSlug];
    if (typeof route?.github_owner !== 'string' || typeof route.github_repo !== 'string') {
      return null;
    }
    return { projectSlug, githubOwner: route.github_owner, githubRepo: route.github_repo };
  } catch {
    return null;
  }
}

export function getSetupReadiness(
  env: EnvValues,
  workflowPath = WORKFLOW_PATH,
): SetupReadiness[] {
  const trackerApiKey = envValue(env, 'SYMHARIX_TRACKER_API_KEY');
  const githubToken = envValue(env, 'GITHUB_TOKEN');
  const legacyAnthropicModel = envValue(env, 'ANTHROPIC_MODEL');
  const runtimeModel = envValue(env, 'SYMHARIX_OPENCODE_MODEL')
    || (legacyAnthropicModel
      ? legacyAnthropicModel.startsWith('anthropic/')
        ? legacyAnthropicModel
        : `anthropic/${legacyAnthropicModel}`
      : '');
  const runtimeProvider = envValue(env, 'SYMHARIX_OPENCODE_PROVIDER') || runtimeModel.split('/')[0];
  const runtimeKeyEnv = Object.values(CODE_PROVIDER_PRESETS)
    .find((preset) => preset.providerID === runtimeProvider)?.keyEnv;
  const runtimeApiKey = runtimeKeyEnv ? envValue(env, runtimeKeyEnv) : '';
  const usesOpenCodeAuth = envValue(env, 'SYMHARIX_OPENCODE_USE_AUTH') === '1';
  const projectSlug = envValue(env, 'SYMHARIX_TRACKER_PROJECT_SLUG');
  const route = projectSlug ? getRouteForProject(workflowPath, projectSlug) : null;
  const telegramToken = envValue(env, 'SYMHARIX_TELEGRAM_BOT_TOKEN');
  const telegramWebhookSecret = envValue(env, 'SYMHARIX_TELEGRAM_WEBHOOK_SECRET');
  const telegramOperatorIds = envValue(env, 'SYMHARIX_TELEGRAM_OPERATOR_IDS');
  const feishuAppId = envValue(env, 'SYMHARIX_FEISHU_APP_ID');
  const feishuAppSecret = envValue(env, 'SYMHARIX_FEISHU_APP_SECRET');
  const feishuOperatorIds = envValue(env, 'SYMHARIX_FEISHU_OPERATOR_IDS');
  const runtimeWriteToken = envValue(env, 'SYMHARIX_RUNTIME_WRITE_TOKEN');
  const runtimeViewerToken = envValue(env, 'SYMHARIX_RUNTIME_VIEWER_TOKEN');
  const runtimeSessionSecret = envValue(env, 'SYMHARIX_RUNTIME_SESSION_SECRET');
  const formatIssues = validateConfigurationFormats(env);
  const formatErrors = formatIssues.filter((issue) => issue.severity === 'error');
  const formatWarnings = formatIssues.filter((issue) => issue.severity === 'warning');

  return [
    {
      label: 'Linear',
      ready: Boolean(trackerApiKey && projectSlug),
      detail: !projectSlug
        ? '缺少 Linear project slug'
        : !trackerApiKey
          ? `缺少 Linear API key；project=${projectSlug}`
          : `project=${projectSlug}`,
    },
    {
      label: 'GitHub',
      ready: Boolean(githubToken && route),
      detail: !route
        ? '缺少与 Linear project slug 对应的 WORKFLOW.md 路由'
        : !githubToken
          ? `缺少 GITHUB_TOKEN；route=${route.githubOwner}/${route.githubRepo}`
          : `${route.githubOwner}/${route.githubRepo}`,
    },
    {
      label: '代码运行时',
      ready: Boolean(runtimeModel && (runtimeApiKey || usesOpenCodeAuth)),
      detail: !runtimeModel
        ? '缺少 provider/model'
        : runtimeApiKey || usesOpenCodeAuth
          ? `${runtimeModel}${usesOpenCodeAuth ? '（使用 opencode auth）' : ''}`
          : `缺少 ${runtimeKeyEnv || 'provider API key'}`,
    },
    {
      label: '控制面安全',
      ready: Boolean(runtimeWriteToken && runtimeViewerToken && runtimeSessionSecret),
      detail: !runtimeWriteToken
        ? '缺少 Runtime operator token；运行 symharix config security 补齐'
        : !runtimeViewerToken
          ? '缺少 Runtime viewer token；运行 symharix config security 补齐'
          : !runtimeSessionSecret
            ? '缺少 Runtime session secret；运行 symharix config security 补齐'
            : `operator=${mask(runtimeWriteToken)}；viewer=${mask(runtimeViewerToken)}；短期会话已启用`,
    },
    {
      label: '格式预检',
      ready: formatErrors.length === 0,
      detail: formatErrors.length > 0
        ? `${formatErrors[0]!.message}${formatErrors.length > 1 ? `；另有 ${formatErrors.length - 1} 个错误` : ''}`
        : formatWarnings.length > 0
          ? `无阻塞错误；${formatWarnings.length} 个 key 前缀提醒将交给联网 doctor 验证`
          : 'token、ID、模型、URL 与本地安全密钥格式正常',
    },
    {
      label: 'Telegram',
      ready: !telegramToken || Boolean(telegramWebhookSecret && telegramOperatorIds),
      detail: telegramToken
        ? !telegramWebhookSecret
          ? '缺少 webhook secret；运行 symharix config telegram 补齐'
          : !telegramOperatorIds
            ? '未配置 operator id；机器人保持只读。向机器人发送写命令可看到 detected user id'
            : `token=${mask(telegramToken)}；operator=${telegramOperatorIds}；${envValue(env, 'SYMHARIX_PUBLIC_BASE_URL') ? '使用固定 HTTPS URL' : '启动时使用临时 tunnel（需要 cloudflared）'}`
        : '未启用',
    },
    {
      label: '飞书',
      ready: !feishuAppId || Boolean(feishuAppSecret && feishuOperatorIds),
      detail: !feishuAppId
        ? '未启用'
        : !feishuAppSecret
          ? `app_id=${feishuAppId}；缺少 App Secret`
          : !feishuOperatorIds
            ? `app_id=${feishuAppId}；未配置 operator open_id，机器人保持只读。向机器人发送 /whoami 可看到 detected user id`
            : `app_id=${feishuAppId}；operator=${feishuOperatorIds}`,
    },
  ];
}

function printReadiness(env = readEnvFile(), workflowPath = WORKFLOW_PATH): boolean {
  const results = getSetupReadiness(env, workflowPath);
  console.log('\nSymHarix 配置检查');
  for (const result of results) {
    console.log(`  ${result.ready ? '✓' : '✗'} ${result.label}: ${result.detail}`);
  }
  for (const warning of validateConfigurationFormats(env).filter((issue) => issue.severity === 'warning')) {
    console.log(`  ! ${warning.message}`);
  }
  const requiredReady = results.every((result) => result.ready);
  const hasSurface = Boolean(envValue(env, 'SYMHARIX_TELEGRAM_BOT_TOKEN') || envValue(env, 'SYMHARIX_FEISHU_APP_ID'));
  if (!hasSurface) {
    console.log('  ! 尚未启用聊天入口；仍可使用 http://localhost:3000/runtime。');
  }
  return requiredReady;
}

class TerminalPrompter {
  private lineReader: Interface = this.createLineReader();

  private createLineReader(): Interface {
    return createInterface({ input: process.stdin, output: process.stdout });
  }

  async ask(label: string, current = ''): Promise<string> {
    const hint = current ? ` [${current}]` : '';
    const answer = (await this.lineReader.question(`${label}${hint}: `)).trim();
    return answer || current;
  }

  async askYesNo(label: string, defaultValue = true): Promise<boolean> {
    console.log(`\n${label}`);
    console.log('  1. 是');
    console.log('  2. 否');
    console.log(`  直接回车：${defaultValue ? '是' : '否'}`);
    while (true) {
      const answer = (await this.lineReader.question('选择: ')).trim().toLowerCase();
      if (!answer) {
        return defaultValue;
      }
      if (['1', 'y', 'yes', '是'].includes(answer)) {
        return true;
      }
      if (['2', 'n', 'no', '否'].includes(answer)) {
        return false;
      }
      console.log('请输入 1 或 2（仍兼容 y/n）。');
    }
  }

  async askChoice<T extends string>(label: string, choices: Array<{ key: string; value: T; label: string }>): Promise<T> {
    console.log(`\n${label}`);
    for (const choice of choices) {
      console.log(`  ${choice.key}. ${choice.label}`);
    }
    while (true) {
      const answer = (await this.lineReader.question('选择: ')).trim();
      const selected = choices.find((choice) => choice.key === answer);
      if (selected) {
        return selected.value;
      }
      console.log(`请输入 ${choices.map((choice) => choice.key).join('、')}。`);
    }
  }

  async askPresetOrCustom(
    label: string,
    presets: PresetChoice[],
    current = '',
    customPrompt = '自定义输入',
  ): Promise<string> {
    const deduped: PresetChoice[] = [];
    const add = (choice: PresetChoice): void => {
      if (!deduped.some((candidate) => candidate.value === choice.value)) {
        deduped.push(choice);
      }
    };
    if (current) {
      add({ value: current, label: `继续使用当前值：${current}` });
    }
    for (const preset of presets) add(preset);

    // A one-item menu containing only “custom” adds a useless extra keystroke.
    // Ask directly when there is nothing enumerable; otherwise keep custom as
    // the final numeric escape hatch.
    if (deduped.length === 0) return this.ask(customPrompt, current);

    const customValue = '__symharix_custom__';
    const choices = [
      ...deduped.map((choice, index) => ({
        key: String(index + 1),
        value: choice.value,
        label: choice.label,
      })),
      {
        key: String(deduped.length + 1),
        value: customValue,
        label: customPrompt,
      },
    ];
    const selected = await this.askChoice(label, choices);
    if (selected !== customValue) return selected;
    return this.ask(customPrompt, current);
  }

  private async askSecret(label: string): Promise<string> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return this.ask(label);
    }
    process.stdout.write(`${label}: `);
    // readline owns stdin while it is open and will echo entered text. Close
    // it briefly, read the key in raw mode, then recreate it for normal prompts.
    // This works for typing and pasting without printing any key characters.
    this.lineReader.close();
    return new Promise((resolve, reject) => {
      let value = '';
      const input = process.stdin;
      const hadRawMode = input.isRaw;
      const cleanup = () => {
        input.off('data', onData);
        if (!hadRawMode) {
          input.setRawMode?.(false);
        }
        input.pause();
        this.lineReader = this.createLineReader();
      };
      const onData = (chunk: Buffer) => {
        for (const character of chunk.toString('utf8')) {
          if (character === '\u0003' || character === '\u0004') {
            cleanup();
            reject(new Error('已取消配置。'));
            return;
          }
          if (character === '\r' || character === '\n') {
            cleanup();
            process.stdout.write('\n');
            resolve(value);
            return;
          }
          if (character === '\u007f' || character === '\b') {
            value = value.slice(0, -1);
            continue;
          }
          value += character;
        }
      };
      input.setRawMode?.(true);
      input.resume();
      input.on('data', onData);
    });
  }

  async askManagedSecret(label: string, current = ''): Promise<ManagedSecretResult> {
    if (current) {
      console.log(`\n${formatExistingSecretPreview(label, current)}`);
    }
    const result = await resolveManagedSecret(
      current,
      () => this.askChoice<ExistingSecretAction>(`如何处理当前 ${label}？`, [
        { key: '1', value: 'keep', label: '继续使用（不改动）' },
        { key: '2', value: 'replace', label: '覆盖当前 key/token' },
      ]),
      () => this.askSecret(`${current ? `${label} 新值` : label}（不回显）`),
    );
    if (current && !result.shouldWrite) {
      console.log(`  ✓ 保留 ${label}，不会改写当前配置项。`);
    } else if (current) {
      console.log(`  ✓ 已接收新的 ${label}，保存前将继续执行格式校验。`);
    }
    return result;
  }

  close(): void {
    this.lineReader.close();
  }
}

export async function resolveRecoverableInput<T>(
  read: () => Promise<T>,
  validate: (value: T) => T,
  chooseRecovery: (message: string) => Promise<InputRecoveryAction>,
  write: (message: string) => void = console.log,
): Promise<T> {
  while (true) {
    try {
      return validate(await read());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write(`  ✗ 输入未通过：${message}`);
      const action = await chooseRecovery(message);
      if (action === 'retry') continue;
      throw new RestartWizardStepError();
    }
  }
}

async function chooseInputRecovery(prompter: TerminalPrompter): Promise<InputRecoveryAction> {
  return prompter.askChoice<InputRecoveryAction>('如何处理这个输入？', [
    { key: '1', value: 'retry', label: '重新输入当前项' },
    { key: '2', value: 'restart-step', label: '返回本阶段开头重新选择' },
  ]);
}

async function collectValidatedText(
  prompter: TerminalPrompter,
  read: () => Promise<string>,
  options: {
    label: string;
    field?: string;
    required?: boolean;
    validate?: (value: string) => string;
  },
): Promise<string> {
  return resolveRecoverableInput(
    read,
    (rawValue) => {
      const value = options.required === false ? rawValue : requireInput(options.label, rawValue);
      const validated = options.field ? validateFieldOrThrow(options.field, value) : value;
      return options.validate ? options.validate(validated) : validated;
    },
    () => chooseInputRecovery(prompter),
  );
}

async function collectValidatedSecret(
  prompter: TerminalPrompter,
  label: string,
  current: string,
  field: string,
): Promise<ManagedSecretResult> {
  let nextCurrent = current;
  return resolveRecoverableInput(
    async () => {
      const secret = await prompter.askManagedSecret(label, nextCurrent);
      nextCurrent = '';
      return secret;
    },
    (secret) => ({
      ...secret,
      value: validateFieldOrThrow(field, requireInput(label, secret.value)),
    }),
    () => chooseInputRecovery(prompter),
  );
}

function requireInput(label: string, value: string): string {
  if (!value) {
    throw new Error(`${label} 不能为空；请重新运行 bun run configure。`);
  }
  return value;
}

export function getBotModelProviderDefaults(provider: ModelProvider): {
  runtimeProvider: 'anthropic' | 'openai';
  model: string;
  baseUrl: string;
} {
  switch (provider) {
    case 'anthropic':
      return { runtimeProvider: 'anthropic', model: 'claude-sonnet-4-5', baseUrl: '' };
    case 'deepseek':
      return {
        runtimeProvider: 'openai',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com',
      };
    case 'openai-compatible':
      return { runtimeProvider: 'openai', model: 'model-id', baseUrl: '' };
    default:
      return { runtimeProvider: 'openai', model: 'gpt-4.1-mini', baseUrl: '' };
  }
}

export function getCodeModelChoices(provider: CodeModelProvider): PresetChoice[] {
  if (provider === 'existing-auth') return [];
  const recommended = CODE_PROVIDER_PRESETS[provider].defaultModel;
  if (provider === 'deepseek') {
    return [
      { value: 'deepseek/deepseek-v4-pro', label: 'deepseek/deepseek-v4-pro（推荐，代码任务）' },
      { value: 'deepseek/deepseek-v4-flash', label: 'deepseek/deepseek-v4-flash（更快、更省）' },
    ];
  }
  return [{ value: recommended, label: `${recommended}（推荐）` }];
}

export function getBotModelChoices(provider: ModelProvider): PresetChoice[] {
  const preset = getBotModelProviderDefaults(provider);
  if (provider === 'deepseek') {
    return [
      { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash（推荐，速度与成本优先）' },
      { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro（能力优先）' },
    ];
  }
  if (provider === 'openai-compatible') return [];
  return [{ value: preset.model, label: `${preset.model}（推荐）` }];
}

function normalizeCodeModel(provider: CodeModelProvider, value: string): string {
  const model = value.trim();
  if (!model.includes('/')) {
    const providerID = provider === 'existing-auth'
      ? ''
      : CODE_PROVIDER_PRESETS[provider].providerID;
    throw new Error(
      `代码模型必须使用 provider/model 格式${providerID ? `，例如 ${providerID}/${model || 'model-id'}` : ''}。`,
    );
  }
  if (provider !== 'existing-auth') {
    const providerID = CODE_PROVIDER_PRESETS[provider].providerID;
    if (model.split('/')[0] !== providerID) {
      throw new Error(`已选择 ${providerID}，模型必须以 ${providerID}/ 开头；也可以返回后重新选择提供方。`);
    }
  }
  return model;
}

async function configureCodeRuntime(
  prompter: TerminalPrompter,
  env: EnvValues,
  updates: EnvValues,
): Promise<void> {
  const provider = await prompter.askChoice<CodeModelProvider>('选择代码执行模型提供方：', [
    { key: '1', value: 'anthropic', label: 'Anthropic / Claude' },
    { key: '2', value: 'openai', label: 'OpenAI / Codex' },
    { key: '3', value: 'google', label: 'Google / Gemini' },
    { key: '4', value: 'deepseek', label: 'DeepSeek' },
    { key: '5', value: 'openrouter', label: 'OpenRouter（统一接入多厂商模型）' },
    { key: '6', value: 'alibaba-cn', label: '阿里云百炼（中国区）' },
    { key: '7', value: 'openai-compatible', label: '自定义 OpenAI-compatible 服务' },
    { key: '8', value: 'existing-auth', label: '使用已有 opencode auth 凭据' },
  ]);
  printSetupGuideTopic(provider as SetupGuideTopic);
  const preset = provider === 'existing-auth' ? null : CODE_PROVIDER_PRESETS[provider];
  const currentModel = envValue(env, 'SYMHARIX_OPENCODE_MODEL');
  const compatibleCurrentModel = provider === 'existing-auth'
    || currentModel.split('/')[0] === preset?.providerID
    ? currentModel
    : '';
  const model = await collectValidatedText(
    prompter,
    () => prompter.askPresetOrCustom(
      '选择代码模型：',
      getCodeModelChoices(provider),
      compatibleCurrentModel,
      '自定义 provider/model（可先运行 bun run runtime:models -- provider 查看）',
    ),
    {
      label: '代码模型',
      field: 'SYMHARIX_OPENCODE_MODEL',
      validate: (value) => normalizeCodeModel(provider, value),
    },
  );
  updates.SYMHARIX_OPENCODE_MODEL = model;
  updates.SYMHARIX_OPENCODE_PROVIDER = preset?.providerID || model.split('/')[0]!;
  updates.SYMHARIX_OPENCODE_USE_AUTH = provider === 'existing-auth' ? '1' : '';

  if (provider === 'existing-auth') {
    console.log('将复用 `opencode auth login` 已保存的凭据；不会把凭据复制到 .env。');
    return;
  }

  const keyEnv = preset!.keyEnv;
  const runtimeSecret = await collectValidatedSecret(prompter, keyEnv, envValue(env, keyEnv), keyEnv);
  if (runtimeSecret.shouldWrite) updates[keyEnv] = runtimeSecret.value;
  if (provider === 'openai-compatible') {
    updates.SYMHARIX_OPENCODE_BASE_URL = await collectValidatedText(
      prompter,
      () => prompter.askPresetOrCustom(
        '选择 OpenAI-compatible Base URL：',
        [],
        envValue(env, 'SYMHARIX_OPENCODE_BASE_URL'),
        '自定义 Base URL（例如 https://example.com/v1）',
      ),
      {
        label: 'OpenAI-compatible Base URL',
        field: 'SYMHARIX_OPENCODE_BASE_URL',
      },
    );
    updates.SYMHARIX_OPENCODE_PROVIDER_NPM = '@ai-sdk/openai-compatible';
  } else {
    const providerBaseURL = provider === 'anthropic'
      ? envValue(env, 'ANTHROPIC_BASE_URL')
      : provider === 'openai'
        ? envValue(env, 'OPENAI_BASE_URL')
        : '';
    const baseURL = await collectValidatedText(
      prompter,
      () => prompter.askPresetOrCustom(
        '选择代码运行时 Base URL：',
        [{ value: '', label: '使用提供方官方地址（推荐）' }],
        providerBaseURL,
        '输入自定义 Base URL',
      ),
      { label: 'Base URL', field: 'SYMHARIX_OPENCODE_BASE_URL', required: false },
    );
    updates.SYMHARIX_OPENCODE_BASE_URL = baseURL;
    if (provider === 'anthropic') updates.ANTHROPIC_BASE_URL = baseURL;
    if (provider === 'openai') updates.OPENAI_BASE_URL = baseURL;
  }
}

function providerToEnv(provider: ModelProvider): 'anthropic' | 'openai' {
  return getBotModelProviderDefaults(provider).runtimeProvider;
}

function parseGitHubRepository(value: string): { owner: string; repo: string } | null {
  const parts = value.split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length === 2 ? { owner: parts[0]!, repo: parts[1]! } : null;
}

async function collectLinearCredential(
  prompter: TerminalPrompter,
  current: string,
): Promise<ManagedSecretResult & {
  projects: DiscoveredLinearProject[];
  verified: boolean;
}> {
  let secret = await collectValidatedSecret(
    prompter,
    'Linear API key',
    current,
    'SYMHARIX_TRACKER_API_KEY',
  );

  while (true) {
    console.log('  … 正在只读验证 Linear key 并读取可见项目。');
    const discovered = await discoverLinearProjects(secret.value);
    if (discovered.ok) {
      console.log(`  ✓ Linear key 验证通过，发现 ${discovered.projects.length} 个可见项目。`);
      return { ...secret, projects: discovered.projects, verified: true };
    }

    console.log(`  ✗ Linear key 验证未通过：${discovered.error}`);
    const action = await prompter.askChoice<'reenter' | 'retry' | 'continue-offline' | 'restart-step'>(
      'Linear 尚未验证，如何处理？',
      [
        { key: '1', value: 'reenter', label: '重新输入 Linear key（推荐）' },
        { key: '2', value: 'retry', label: '使用同一 key 重试联网验证' },
        { key: '3', value: 'continue-offline', label: '明确保留并手工选择项目（标记为未验证）' },
        { key: '4', value: 'restart-step', label: '返回连接阶段开头重新选择' },
      ],
    );
    if (action === 'reenter') {
      secret = await collectValidatedSecret(prompter, 'Linear API key', '', 'SYMHARIX_TRACKER_API_KEY');
      continue;
    }
    if (action === 'retry') continue;
    if (action === 'continue-offline') {
      console.log('  ! 已明确选择离线保留；配置完成后 doctor 仍会验证 Linear。');
      return { ...secret, projects: [], verified: false };
    }
    throw new RestartWizardStepError();
  }
}

/**
 * Collect and immediately verify the GitHub credential before the wizard is
 * allowed to advance to model configuration. A failed check can only be
 * bypassed through an explicit offline choice.
 */
export async function collectVerifiedGitHubCredential(
  prompter: GitHubCredentialPrompter,
  current: string,
  repository: { owner: string; repo: string },
  options: {
    probe?: typeof probeGitHubRepository;
    write?: (message: string) => void;
  } = {},
): Promise<CollectedGitHubCredential> {
  const probe = options.probe ?? probeGitHubRepository;
  const write = options.write ?? console.log;
  let secret = await prompter.askManagedSecret('GitHub token', current);

  while (true) {
    let token: string;
    try {
      token = validateFieldOrThrow('GITHUB_TOKEN', requireInput('GitHub token', secret.value));
    } catch (error) {
      write(`  ✗ GitHub token 格式未通过：${error instanceof Error ? error.message : String(error)}`);
      const action = await prompter.askChoice<InputRecoveryAction>('如何处理 GitHub token？', [
        { key: '1', value: 'retry', label: '重新输入当前 token' },
        { key: '2', value: 'restart-step', label: '返回连接阶段开头重新选择' },
      ]);
      if (action === 'restart-step') throw new RestartWizardStepError();
      secret = await prompter.askManagedSecret('GitHub token', '');
      continue;
    }

    write(`  … 正在只读验证 ${repository.owner}/${repository.repo}，不会 push、建 PR 或写 Issue。`);
    const result = await probe({ token, ...repository }, {});
    if (result.status === 'pass') {
      write(`  ✓ GitHub token 验证通过：${result.detail}`);
      return { ...secret, value: token, verified: true };
    }

    write(`  ✗ GitHub token 验证未通过：${result.detail}`);
    const action = await prompter.askChoice<GitHubVerificationAction>(
      'GitHub 尚未验证，如何处理？',
      [
        { key: '1', value: 'reenter', label: '重新输入 token（推荐）' },
        { key: '2', value: 'retry', label: '使用同一 token 重试联网验证' },
        { key: '3', value: 'continue-offline', label: '明确保留并继续（标记为未验证）' },
        { key: '4', value: 'restart-step', label: '返回连接阶段开头重新选择' },
      ],
    );
    if (action === 'reenter') {
      secret = await prompter.askManagedSecret('GitHub token', '');
      continue;
    }
    if (action === 'retry') {
      continue;
    }
    if (action === 'continue-offline') {
      write('  ! 已由使用者明确选择离线保留；配置完成后 doctor 仍会显示 GitHub 未就绪。');
      return { ...secret, value: token, verified: false };
    }
    throw new RestartWizardStepError();
  }
}

function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function ensureRuntimeSecurityConfig(
  envPath = ENV_PATH,
  envExamplePath = ENV_EXAMPLE_PATH,
): string[] {
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(envExamplePath, envPath);
  }
  const env = readEnvFile(envPath);
  const generated: EnvValues = {};
  const ensureSecret = (key: string): void => {
    if (!envValue(env, key)) generated[key] = generateWebhookSecret();
  };
  ensureSecret('SYMHARIX_RUNTIME_WRITE_TOKEN');
  ensureSecret('SYMHARIX_RUNTIME_VIEWER_TOKEN');
  ensureSecret('SYMHARIX_RUNTIME_SESSION_SECRET');
  if (!envValue(env, 'SYMHARIX_RUNTIME_SESSION_TTL_MINUTES')) {
    generated.SYMHARIX_RUNTIME_SESSION_TTL_MINUTES = '15';
  }
  if (Object.keys(generated).length > 0) {
    const source = fs.readFileSync(envPath, 'utf8');
    fs.writeFileSync(envPath, upsertEnvAssignments(source, generated), { mode: 0o600 });
  }
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // POSIX file modes are not available on every supported filesystem.
  }
  return Object.keys(generated);
}

function buildDoctorInput(env: EnvValues, workflowPath = WORKFLOW_PATH): ConfigurationDoctorInput {
  const projectSlug = envValue(env, 'SYMHARIX_TRACKER_PROJECT_SLUG');
  const route = projectSlug ? getRouteForProject(workflowPath, projectSlug) : null;
  const model = envValue(env, 'SYMHARIX_OPENCODE_MODEL');
  const runtimeProvider = envValue(env, 'SYMHARIX_OPENCODE_PROVIDER') || model.split('/')[0] || '';
  const preset = Object.values(CODE_PROVIDER_PRESETS)
    .find((candidate) => candidate.providerID === runtimeProvider);
  const runtimeKeyEnv = preset?.keyEnv || 'SYMHARIX_OPENCODE_API_KEY';
  return {
    linearApiKey: envValue(env, 'SYMHARIX_TRACKER_API_KEY'),
    linearEndpoint: envValue(env, 'SYMHARIX_TRACKER_ENDPOINT') || 'https://api.linear.app/graphql',
    linearProjectSlug: projectSlug,
    githubToken: envValue(env, 'GITHUB_TOKEN'),
    githubOwner: route?.githubOwner || '',
    githubRepo: route?.githubRepo || '',
    runtimeProvider,
    runtimeApiKey: envValue(env, runtimeKeyEnv),
    runtimeBaseUrl: envValue(env, 'SYMHARIX_OPENCODE_BASE_URL'),
    usesOpenCodeAuth: envValue(env, 'SYMHARIX_OPENCODE_USE_AUTH') === '1',
    telegramToken: envValue(env, 'SYMHARIX_TELEGRAM_BOT_TOKEN'),
    feishuAppId: envValue(env, 'SYMHARIX_FEISHU_APP_ID'),
    feishuAppSecret: envValue(env, 'SYMHARIX_FEISHU_APP_SECRET'),
  };
}

async function printDoctor(env = readEnvFile(), workflowPath = WORKFLOW_PATH): Promise<boolean> {
  console.log('\nSymHarix 联网配置诊断（只读，不执行写操作或模型调用）');
  const formatIssues = validateConfigurationFormats(env);
  for (const item of formatIssues) {
    console.log(`  ${item.severity === 'error' ? '✗' : '!'} 格式: ${item.message}`);
  }
  if (formatIssues.some((item) => item.severity === 'error')) {
    console.log('  - 已跳过联网请求：先修正上面的格式错误。');
    return false;
  }

  const results = await runConfigurationDoctor(buildDoctorInput(env, workflowPath));
  for (const result of results) {
    const mark = result.status === 'pass' ? '✓' : result.status === 'fail' ? '✗' : '-';
    console.log(`  ${mark} ${result.label}: ${result.detail}`);
  }
  const valid = !results.some((result) => result.status === 'fail');
  console.log(valid
    ? '  ✓ 外部凭据诊断完成。模型真实调用仍需显式执行 bun run runtime:smoke。'
    : '  ✗ 存在无效或不可达凭据；修正后重新运行 bun run configure:doctor。');
  return valid;
}

async function configureBotModel(prompter: TerminalPrompter, env: EnvValues, updates: EnvValues): Promise<void> {
  const enabled = await prompter.askYesNo('配置聊天自然语言模型（推荐，可让 Telegram/飞书理解自然语言任务）', true);
  if (!enabled) {
    return;
  }

  const provider = await prompter.askChoice<ModelProvider>('选择聊天模型提供方：', [
    { key: '1', value: 'anthropic', label: 'Anthropic（Claude）' },
    { key: '2', value: 'openai', label: 'OpenAI' },
    { key: '3', value: 'deepseek', label: 'DeepSeek（自动配置官方地址，可复用上面的 key）' },
    { key: '4', value: 'openai-compatible', label: '其他 OpenAI 兼容服务（自定义 Base URL）' },
  ]);
  printSetupGuideTopic(provider);
  const preset = getBotModelProviderDefaults(provider);
  const model = await collectValidatedText(
    prompter,
    () => prompter.askPresetOrCustom(
      '选择聊天理解模型：',
      getBotModelChoices(provider),
      envValue(env, 'SYMHARIX_BOT_LLM_MODEL'),
      '自定义模型名称',
    ),
    { label: '聊天模型名称', field: 'SYMHARIX_BOT_LLM_MODEL' },
  );
  updates.SYMHARIX_BOT_LLM_PROVIDER = providerToEnv(provider);
  updates.SYMHARIX_BOT_LLM_MODEL = model;

  const currentBotModelKey = envValue(env, 'SYMHARIX_BOT_LLM_API_KEY');
  if (provider === 'anthropic' && !currentBotModelKey) {
    const reuseRuntimeKey = await prompter.askYesNo('复用上面输入的代码运行时 API key', true);
    if (reuseRuntimeKey) {
      updates.SYMHARIX_BOT_LLM_API_KEY = '';
      updates.SYMHARIX_BOT_LLM_BASE_URL = '';
      return;
    }
  }

  if (provider === 'deepseek' && !currentBotModelKey) {
    const runtimeDeepSeekKey = trim(updates.DEEPSEEK_API_KEY) || envValue(env, 'DEEPSEEK_API_KEY');
    if (runtimeDeepSeekKey) {
      const reuseRuntimeKey = await prompter.askYesNo('复用上面输入的 DeepSeek 代码运行时 API key', true);
      if (reuseRuntimeKey) {
        updates.SYMHARIX_BOT_LLM_API_KEY = runtimeDeepSeekKey;
        updates.SYMHARIX_BOT_LLM_BASE_URL = preset.baseUrl;
        console.log('  ✓ 已复用 DeepSeek key，并自动配置聊天模型官方 Base URL。');
        return;
      }
    }
  }

  const botModelSecret = await collectValidatedSecret(
    prompter,
    '聊天模型 API key',
    currentBotModelKey,
    'SYMHARIX_BOT_LLM_API_KEY',
  );
  if (botModelSecret.shouldWrite) updates.SYMHARIX_BOT_LLM_API_KEY = botModelSecret.value;
  const baseUrl = await collectValidatedText(
    prompter,
    () => prompter.askPresetOrCustom(
      '选择聊天模型 Base URL：',
      provider === 'openai-compatible'
        ? []
        : [{
            value: preset.baseUrl,
            label: preset.baseUrl ? `使用官方地址 ${preset.baseUrl}（推荐）` : '使用提供方官方地址（推荐）',
          }],
      envValue(env, 'SYMHARIX_BOT_LLM_BASE_URL'),
      provider === 'openai-compatible'
        ? '自定义 Base URL（例如 https://example.com/v1）'
        : '输入自定义 Base URL',
    ),
    {
      label: '聊天模型 Base URL',
      field: 'SYMHARIX_BOT_LLM_BASE_URL',
      required: provider === 'openai-compatible',
    },
  );
  updates.SYMHARIX_BOT_LLM_BASE_URL = baseUrl;
}

async function configureTelegram(prompter: TerminalPrompter, env: EnvValues, updates: EnvValues): Promise<void> {
  printSetupGuideTopic('telegram');
  const telegramSecret = await collectValidatedSecret(
    prompter,
    'Telegram bot token',
    envValue(env, 'SYMHARIX_TELEGRAM_BOT_TOKEN'),
    'SYMHARIX_TELEGRAM_BOT_TOKEN',
  );
  if (telegramSecret.shouldWrite) updates.SYMHARIX_TELEGRAM_BOT_TOKEN = telegramSecret.value;
  updates.SYMHARIX_TELEGRAM_WEBHOOK_SECRET = envValue(env, 'SYMHARIX_TELEGRAM_WEBHOOK_SECRET') || generateWebhookSecret();
  updates.SYMHARIX_TELEGRAM_OPERATOR_IDS = await collectValidatedText(
    prompter,
    () => prompter.askPresetOrCustom(
      '选择 Telegram operator user id：',
      [{ value: '', label: '暂时留空（机器人保持只读，可用 /whoami 显示 Detected user id）' }],
      envValue(env, 'SYMHARIX_TELEGRAM_OPERATOR_IDS'),
      '输入 numeric user id（多人用英文逗号分隔）',
    ),
    { label: 'Telegram operator user id', field: 'SYMHARIX_TELEGRAM_OPERATOR_IDS', required: false },
  );
  updates.SYMHARIX_PUBLIC_BASE_URL = await collectValidatedText(
    prompter,
    () => prompter.askPresetOrCustom(
      '选择 Telegram Runtime 公网地址：',
      [{ value: '', label: '启动时自动创建临时 tunnel（推荐用于首次配置）' }],
      envValue(env, 'SYMHARIX_PUBLIC_BASE_URL'),
      '输入固定公网 HTTPS URL',
    ),
    { label: '公网 HTTPS URL', field: 'SYMHARIX_PUBLIC_BASE_URL', required: false },
  );
  updates.SYMHARIX_TELEGRAM_BOOTSTRAP = 'auto';
}

async function configureFeishu(prompter: TerminalPrompter, env: EnvValues, updates: EnvValues): Promise<void> {
  printSetupGuideTopic('feishu');
  updates.SYMHARIX_FEISHU_APP_ID = await collectValidatedText(
    prompter,
    () => prompter.askPresetOrCustom(
      '选择飞书 App ID：',
      [],
      envValue(env, 'SYMHARIX_FEISHU_APP_ID'),
      '输入飞书 App ID（cli_...）',
    ),
    { label: '飞书 App ID', field: 'SYMHARIX_FEISHU_APP_ID' },
  );
  const feishuSecret = await collectValidatedSecret(
    prompter,
    '飞书 App Secret',
    envValue(env, 'SYMHARIX_FEISHU_APP_SECRET'),
    'SYMHARIX_FEISHU_APP_SECRET',
  );
  if (feishuSecret.shouldWrite) updates.SYMHARIX_FEISHU_APP_SECRET = feishuSecret.value;
  updates.SYMHARIX_FEISHU_OPERATOR_IDS = await collectValidatedText(
    prompter,
    () => prompter.askPresetOrCustom(
      '选择飞书 operator open_id：',
      [{ value: '', label: '暂时留空（机器人保持只读，可用 /whoami 显示 Detected user id）' }],
      envValue(env, 'SYMHARIX_FEISHU_OPERATOR_IDS'),
      '输入 operator open_id（ou_...，多人用英文逗号分隔）',
    ),
    { label: '飞书 operator open_id', field: 'SYMHARIX_FEISHU_OPERATOR_IDS', required: false },
  );
  updates.SYMHARIX_FEISHU_RUNTIME_OPEN_MODE = 'applink_web_url';
  updates.SYMHARIX_FEISHU_RUNTIME_TUNNEL = 'auto';
}

interface WizardState {
  projectSlug: string;
  repository: { owner: string; repo: string } | null;
  surface: BotSurface;
}

interface WizardCheckpoint {
  updates: EnvValues;
  state: WizardState;
}

function cloneWizardState(state: WizardState): WizardState {
  return {
    ...state,
    repository: state.repository ? { ...state.repository } : null,
  };
}

function restoreUpdates(target: EnvValues, source: EnvValues): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function validateProjectSlug(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    throw new Error('Linear project slug 只能包含字母、数字、点、下划线和连字符。');
  }
  return value;
}

async function configureConnections(
  prompter: TerminalPrompter,
  env: EnvValues,
  updates: EnvValues,
): Promise<Pick<WizardState, 'projectSlug' | 'repository'>> {
  console.log('\n1/4 连接 Linear 和 GitHub（任务与目标代码仓库）');
  printSetupGuideTopic('linear');
  const linearSecret = await collectLinearCredential(
    prompter,
    envValue(env, 'SYMHARIX_TRACKER_API_KEY'),
  );
  if (linearSecret.shouldWrite) updates.SYMHARIX_TRACKER_API_KEY = linearSecret.value;

  const projects = [...linearSecret.projects]
    .sort((left, right) => left.name.localeCompare(right.name));
  const currentProjectSlug = envValue(env, 'SYMHARIX_TRACKER_PROJECT_SLUG');
  if (projects.length === 0) {
    console.log(linearSecret.verified
      ? '  ! 该 Linear 账号没有返回可见项目；可创建项目后重试，或选择自定义 slug。'
      : '  ! Linear 尚未联网验证；请选择已有值或输入项目 slug。');
  }
  const projectSlug = await collectValidatedText(
    prompter,
    () => prompter.askPresetOrCustom(
      '选择 Linear 默认项目：',
      projects.map((project) => ({
        value: project.slug,
        label: `${project.name} (${project.slug})`,
      })),
      currentProjectSlug,
      '自定义 Linear project slug',
    ),
    { label: 'Linear project slug', validate: validateProjectSlug },
  );
  updates.SYMHARIX_TRACKER_PROJECT_SLUG = projectSlug;

  const existingRoute = getRouteForProject(WORKFLOW_PATH, projectSlug);
  const existingRepository = existingRoute
    ? `${existingRoute.githubOwner}/${existingRoute.githubRepo}`
    : '';
  printSetupGuideTopic('github');
  const repositoryText = await collectValidatedText(
    prompter,
    () => prompter.askPresetOrCustom(
      '选择 GitHub 目标仓库：',
      [],
      existingRepository,
      '自定义 GitHub repository（owner/repo）',
    ),
    {
      label: 'GitHub repository',
      validate: (value) => {
        const repository = parseGitHubRepository(value);
        if (!repository) {
          throw new Error('GitHub repository 必须写成 owner/repo，例如 acme/web-app。');
        }
        validateRoute({
          projectSlug,
          githubOwner: repository.owner,
          githubRepo: repository.repo,
        });
        return `${repository.owner}/${repository.repo}`;
      },
    },
  );
  const repository = parseGitHubRepository(repositoryText)!;
  const githubSecret = await collectVerifiedGitHubCredential(
    prompter,
    envValue(env, 'GITHUB_TOKEN'),
    repository,
  );
  if (githubSecret.shouldWrite) updates.GITHUB_TOKEN = githubSecret.value;

  return { projectSlug, repository };
}

async function configureModels(
  prompter: TerminalPrompter,
  env: EnvValues,
  updates: EnvValues,
): Promise<void> {
  console.log('\n2/4 配置代码执行模型与聊天理解模型');
  const configureRuntime = await prompter.askYesNo(
    '现在配置 OpenCode 代码运行时（执行代码任务需要）',
    true,
  );
  if (configureRuntime) {
    await configureCodeRuntime(prompter, env, updates);
  }
  await configureBotModel(prompter, env, updates);
}

async function configureSurfaces(
  prompter: TerminalPrompter,
  env: EnvValues,
  updates: EnvValues,
): Promise<BotSurface> {
  console.log('\n3/4 选择聊天入口');
  const surface = await prompter.askChoice<BotSurface>('你要配置哪一个入口？', [
    { key: '1', value: 'telegram', label: 'Telegram' },
    { key: '2', value: 'feishu', label: '飞书' },
    { key: '3', value: 'both', label: '两个都配置' },
    { key: '4', value: 'none', label: '暂不配置（仅使用 Runtime Deck）' },
  ]);
  if (surface === 'telegram' || surface === 'both') {
    await configureTelegram(prompter, env, updates);
  }
  if (surface === 'feishu' || surface === 'both') {
    await configureFeishu(prompter, env, updates);
  }
  return surface;
}

function writeEnvUpdates(updates: EnvValues): void {
  if (Object.keys(updates).length === 0) {
    console.log('\n没有需要写入的改动。');
    return;
  }
  const currentEnv = readEnvFile();
  const mergedEnv = { ...currentEnv, ...updates };
  const previousErrors = new Set(
    validateConfigurationFormats(currentEnv)
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `${issue.field}:${issue.message}`),
  );
  const changedFields = new Set(Object.keys(updates));
  const blocking = validateConfigurationFormats(mergedEnv).filter((issue) => (
    issue.severity === 'error'
    && (changedFields.has(issue.field) || !previousErrors.has(`${issue.field}:${issue.message}`))
  ));
  if (blocking.length > 0) {
    throw new Error(`改动未写入：${blocking.map((issue) => issue.message).join('；')}`);
  }
  const envContent = fs.readFileSync(ENV_PATH, 'utf8');
  fs.writeFileSync(ENV_PATH, upsertEnvAssignments(envContent, updates), { mode: 0o600 });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    // Windows and restricted filesystems may not expose POSIX modes.
  }
  for (const warning of validateConfigurationFormats(mergedEnv).filter((issue) => (
    issue.severity === 'warning' && changedFields.has(issue.field)
  ))) {
    console.log(`  ! ${warning.message}`);
  }
  console.log(`\n✓ 已更新 ${changedFields.size} 个配置项；未改动其他设置。`);
  console.log('  如服务正在运行，请执行 symharix stop，再用 symharix start telegram/feishu 重新启动使改动生效。');
}

async function configureSingleSurface(
  surface: 'telegram' | 'feishu',
  prompter: TerminalPrompter,
  env: EnvValues,
  updates: EnvValues,
): Promise<void> {
  const enabled = surface === 'telegram'
    ? Boolean(envValue(env, 'SYMHARIX_TELEGRAM_BOT_TOKEN'))
    : Boolean(envValue(env, 'SYMHARIX_FEISHU_APP_ID'));
  if (enabled) {
    const action = await prompter.askChoice<'update' | 'disable' | 'cancel'>(
      `${surface === 'telegram' ? 'Telegram' : '飞书'} 当前已启用，选择操作：`,
      [
        { key: '1', value: 'update', label: '修改当前入口配置' },
        { key: '2', value: 'disable', label: '禁用并清除本地入口凭据' },
        { key: '3', value: 'cancel', label: '返回，不做改动' },
      ],
    );
    if (action === 'cancel') return;
    if (action === 'disable') {
      if (surface === 'telegram') {
        updates.SYMHARIX_TELEGRAM_BOT_TOKEN = '';
        updates.SYMHARIX_TELEGRAM_WEBHOOK_SECRET = '';
        updates.SYMHARIX_TELEGRAM_OPERATOR_IDS = '';
        updates.SYMHARIX_PUBLIC_BASE_URL = '';
      } else {
        updates.SYMHARIX_FEISHU_APP_ID = '';
        updates.SYMHARIX_FEISHU_APP_SECRET = '';
        updates.SYMHARIX_FEISHU_OPERATOR_IDS = '';
      }
      return;
    }
  }
  if (surface === 'telegram') {
    await configureTelegram(prompter, env, updates);
  } else {
    await configureFeishu(prompter, env, updates);
  }
}

const CUSTOM_BUDGET_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'SYMHARIX_MAX_TURN_OUTPUT_TOKENS', label: '单轮最大输出 token' },
  { key: 'SYMHARIX_MAX_TURN_STEPS', label: '单轮最大步骤数' },
  { key: 'SYMHARIX_TURN_RESERVE_TOKENS', label: '单轮累计 token 硬上限（同时作为调用前预占）' },
  { key: 'SYMHARIX_MAX_TASK_TOKENS', label: '单任务 token 上限' },
  { key: 'SYMHARIX_MAX_REPO_DAILY_TOKENS', label: '单仓库每日 token 上限' },
  { key: 'SYMHARIX_MAX_DAILY_TOKENS', label: '全局每日 token 上限' },
  { key: 'SYMHARIX_MAX_TASK_USD', label: '单任务美元上限' },
  { key: 'SYMHARIX_MAX_REPO_DAILY_USD', label: '单仓库每日美元上限' },
  { key: 'SYMHARIX_MAX_DAILY_USD', label: '全局每日美元上限' },
  { key: 'SYMHARIX_COST_OVERRIDE_MINUTES', label: '预算审批有效分钟数' },
];

async function configureBudget(
  prompter: TerminalPrompter,
  env: EnvValues,
  updates: EnvValues,
): Promise<void> {
  console.log('\n成本与单轮失控护栏');
  const preset = await prompter.askChoice<BudgetPresetName | 'custom' | 'keep'>(
    '选择预算方案：',
    [
      { key: '1', value: 'keep', label: '保持当前预算，只修改模型价格' },
      { key: '2', value: 'conservative', label: '保守：$10/任务，输出 8k，最多 8 步' },
      { key: '3', value: 'standard', label: '标准（推荐）：$25/任务，输出 16k，最多 12 步' },
      { key: '4', value: 'generous', label: '宽松：$50/任务，输出 32k，最多 20 步' },
      { key: '5', value: 'custom', label: '逐项自定义' },
    ],
  );
  if (preset !== 'keep' && preset !== 'custom') {
    Object.assign(updates, getBudgetPreset(preset));
  }
  if (preset === 'custom') {
    for (const field of CUSTOM_BUDGET_FIELDS) {
      updates[field.key] = await collectValidatedText(
        prompter,
        () => prompter.ask(field.label, envValue(env, field.key) || getBudgetPreset('standard')[field.key] || ''),
        { label: field.label, field: field.key },
      );
    }
  }

  const pricing = await prompter.askChoice<'keep' | 'custom' | 'disable'>(
    '模型价格如何处理？美元硬上限只有配置 input/output 价格后才生效。',
    [
      { key: '1', value: 'keep', label: '保持当前价格配置' },
      { key: '2', value: 'custom', label: '输入当前模型的保守最高单价' },
      { key: '3', value: 'disable', label: '清空价格（仅保留 token 护栏）' },
    ],
  );
  if (pricing === 'disable') {
    updates.SYMHARIX_COST_INPUT_USD_PER_MILLION = '';
    updates.SYMHARIX_COST_OUTPUT_USD_PER_MILLION = '';
    updates.SYMHARIX_COST_CACHE_READ_USD_PER_MILLION = '';
  }
  if (pricing === 'custom') {
    updates.SYMHARIX_COST_INPUT_USD_PER_MILLION = await collectValidatedText(
      prompter,
      () => prompter.ask('每百万 input token 美元价格', envValue(env, 'SYMHARIX_COST_INPUT_USD_PER_MILLION')),
      { label: 'input token 价格', field: 'SYMHARIX_COST_INPUT_USD_PER_MILLION' },
    );
    updates.SYMHARIX_COST_OUTPUT_USD_PER_MILLION = await collectValidatedText(
      prompter,
      () => prompter.ask('每百万 output token 美元价格', envValue(env, 'SYMHARIX_COST_OUTPUT_USD_PER_MILLION')),
      { label: 'output token 价格', field: 'SYMHARIX_COST_OUTPUT_USD_PER_MILLION' },
    );
    updates.SYMHARIX_COST_CACHE_READ_USD_PER_MILLION = await collectValidatedText(
      prompter,
      () => prompter.askPresetOrCustom(
        '缓存读取价格：',
        [{ value: '', label: '留空：按 input 价格计算' }],
        envValue(env, 'SYMHARIX_COST_CACHE_READ_USD_PER_MILLION'),
        '输入每百万 cache-read token 美元价格',
      ),
      { label: 'cache-read token 价格', field: 'SYMHARIX_COST_CACHE_READ_USD_PER_MILLION', required: false },
    );
  }
}

async function configureSecurity(
  prompter: TerminalPrompter,
  env: EnvValues,
  updates: EnvValues,
): Promise<void> {
  const action = await prompter.askChoice<'missing' | 'viewer' | 'operator' | 'session' | 'ttl' | 'all' | 'cancel'>(
    '控制面安全设置：',
    [
      { key: '1', value: 'missing', label: '只补齐缺失密钥（不改变已有值）' },
      { key: '2', value: 'viewer', label: '轮换 Runtime viewer token' },
      { key: '3', value: 'operator', label: '轮换 Runtime operator token' },
      { key: '4', value: 'session', label: '轮换浏览器 session secret（现有登录失效）' },
      { key: '5', value: 'ttl', label: '修改浏览器会话有效时间' },
      { key: '6', value: 'all', label: '轮换全部安全密钥' },
      { key: '7', value: 'cancel', label: '返回，不做改动' },
    ],
  );
  if (action === 'cancel') return;
  if (action === 'missing' || action === 'all') {
    for (const key of [
      'SYMHARIX_RUNTIME_WRITE_TOKEN',
      'SYMHARIX_RUNTIME_VIEWER_TOKEN',
      'SYMHARIX_RUNTIME_SESSION_SECRET',
    ]) {
      if (action === 'all' || !envValue(env, key)) updates[key] = generateWebhookSecret();
    }
    if (!envValue(env, 'SYMHARIX_RUNTIME_SESSION_TTL_MINUTES')) {
      updates.SYMHARIX_RUNTIME_SESSION_TTL_MINUTES = '15';
    }
  }
  if (action === 'viewer') updates.SYMHARIX_RUNTIME_VIEWER_TOKEN = generateWebhookSecret();
  if (action === 'operator') updates.SYMHARIX_RUNTIME_WRITE_TOKEN = generateWebhookSecret();
  if (action === 'session') updates.SYMHARIX_RUNTIME_SESSION_SECRET = generateWebhookSecret();
  if (action === 'ttl') {
    updates.SYMHARIX_RUNTIME_SESSION_TTL_MINUTES = await collectValidatedText(
      prompter,
      () => prompter.askPresetOrCustom(
        '选择 Runtime 浏览器会话有效时间：',
        [
          { value: '15', label: '15 分钟（推荐）' },
          { value: '60', label: '60 分钟' },
          { value: '1440', label: '24 小时' },
        ],
        envValue(env, 'SYMHARIX_RUNTIME_SESSION_TTL_MINUTES'),
        '自定义分钟数（1–1440）',
      ),
      { label: 'Runtime session TTL', field: 'SYMHARIX_RUNTIME_SESSION_TTL_MINUTES' },
    );
  }
  if (Object.keys(updates).length > 0) {
    console.log('  ! 安全密钥改变后请重启 SymHarix；旧 token 或浏览器会话将失效。');
  }
}

async function applyConfigurationSection(
  section: ConfigurationSection,
  prompter: TerminalPrompter,
): Promise<void> {
  ensureLocalConfigFiles();
  const env = readEnvFile();
  const updates: EnvValues = {};
  if (section === 'connections') {
    const connection = await configureConnections(prompter, env, updates);
    const workflowContent = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const workflowUpdate = upsertWorkflowRoute(workflowContent, {
      projectSlug: connection.projectSlug,
      githubOwner: connection.repository!.owner,
      githubRepo: connection.repository!.repo,
    });
    writeEnvUpdates(updates);
    fs.writeFileSync(WORKFLOW_PATH, workflowUpdate);
  } else {
    if (section === 'models') await configureModels(prompter, env, updates);
    if (section === 'telegram') await configureSingleSurface('telegram', prompter, env, updates);
    if (section === 'feishu') await configureSingleSurface('feishu', prompter, env, updates);
    if (section === 'budget') await configureBudget(prompter, env, updates);
    if (section === 'security') await configureSecurity(prompter, env, updates);
    writeEnvUpdates(updates);
  }
  printReadiness();
}

async function runConfigurationSection(
  section: ConfigurationSection,
  prompter: TerminalPrompter,
): Promise<void> {
  while (true) {
    try {
      await applyConfigurationSection(section, prompter);
      return;
    } catch (error) {
      if (error instanceof RestartWizardStepError) {
        console.log('\n↩ 已返回当前配置分类开头，本轮输入尚未写入。');
        continue;
      }
      console.log(`\n✗ 本分类尚未完成：${error instanceof Error ? error.message : String(error)}`);
      const action = await prompter.askChoice<'retry' | 'cancel'>('如何继续？', [
        { key: '1', value: 'retry', label: '重新开始当前分类' },
        { key: '2', value: 'cancel', label: '返回，不写入本轮输入' },
      ]);
      if (action === 'retry') continue;
      return;
    }
  }
}

async function runConfigurationManager(): Promise<boolean> {
  ensureLocalConfigFiles();
  const prompter = new TerminalPrompter();
  try {
    console.log('\nSymHarix 配置管理\n只修改所选分类；已有 key/token 仍只显示首尾掩码。');
    while (true) {
      const action = await prompter.askChoice<ConfigurationAction>('选择要做的事情：', [
        { key: '1', value: 'connections', label: 'Linear 与 GitHub 仓库路由' },
        { key: '2', value: 'models', label: '代码模型与聊天理解模型' },
        { key: '3', value: 'telegram', label: 'Telegram' },
        { key: '4', value: 'feishu', label: '飞书' },
        { key: '5', value: 'budget', label: '预算、模型价格与单轮上限' },
        { key: '6', value: 'security', label: 'Runtime 安全密钥与会话时间' },
        { key: '7', value: 'status', label: '查看掩码配置状态' },
        { key: '8', value: 'doctor', label: '联网只读验证凭据' },
        { key: '9', value: 'all', label: '重新运行完整向导' },
        { key: '0', value: 'exit', label: '退出' },
      ]);
      if (action === 'exit') return false;
      if (action === 'all') return true;
      if (action === 'status') {
        printReadiness();
        continue;
      }
      if (action === 'doctor') {
        printReadiness();
        await printDoctor();
        continue;
      }
      if (action === 'guide') {
        printSetupGuide();
        continue;
      }
      await runConfigurationSection(action, prompter);
    }
  } finally {
    prompter.close();
  }
}

async function chooseWizardStepRecovery(
  prompter: TerminalPrompter,
  stepLabel: string,
  error: unknown,
  canGoBack: boolean,
): Promise<WizardStepRecoveryAction> {
  console.log(`\n  ✗ ${stepLabel}尚未完成：${error instanceof Error ? error.message : String(error)}`);
  const choices: Array<{ key: string; value: WizardStepRecoveryAction; label: string }> = [
    { key: '1', value: 'retry', label: '重新开始当前阶段' },
  ];
  if (canGoBack) {
    choices.push({ key: '2', value: 'back', label: '返回上一个阶段' });
  }
  choices.push({
    key: canGoBack ? '3' : '2',
    value: 'cancel',
    label: '取消配置（不写入本次输入）',
  });
  return prompter.askChoice('如何继续？', choices);
}

async function runWizard(): Promise<void> {
  ensureLocalConfigFiles();
  const env = readEnvFile();
  const prompter = new TerminalPrompter();
  const updates: EnvValues = {
    SYMHARIX_TRACKER_KIND: 'linear',
    SYMHARIX_RUNTIME_WRITE_TOKEN: envValue(env, 'SYMHARIX_RUNTIME_WRITE_TOKEN') || generateWebhookSecret(),
    SYMHARIX_RUNTIME_VIEWER_TOKEN: envValue(env, 'SYMHARIX_RUNTIME_VIEWER_TOKEN') || generateWebhookSecret(),
    SYMHARIX_RUNTIME_SESSION_SECRET: envValue(env, 'SYMHARIX_RUNTIME_SESSION_SECRET') || generateWebhookSecret(),
    SYMHARIX_RUNTIME_SESSION_TTL_MINUTES: envValue(env, 'SYMHARIX_RUNTIME_SESSION_TTL_MINUTES') || '15',
    SYMHARIX_MAX_TURN_OUTPUT_TOKENS: envValue(env, 'SYMHARIX_MAX_TURN_OUTPUT_TOKENS') || '16000',
    SYMHARIX_MAX_TURN_STEPS: envValue(env, 'SYMHARIX_MAX_TURN_STEPS') || '12',
    SYMHARIX_TURN_RESERVE_TOKENS: envValue(env, 'SYMHARIX_TURN_RESERVE_TOKENS') || '200000',
    SYMHARIX_MAX_TASK_TOKENS: envValue(env, 'SYMHARIX_MAX_TASK_TOKENS') || '500000',
    SYMHARIX_MAX_REPO_DAILY_TOKENS: envValue(env, 'SYMHARIX_MAX_REPO_DAILY_TOKENS') || '2000000',
    SYMHARIX_MAX_DAILY_TOKENS: envValue(env, 'SYMHARIX_MAX_DAILY_TOKENS') || '5000000',
    SYMHARIX_MAX_TASK_USD: envValue(env, 'SYMHARIX_MAX_TASK_USD') || '25',
    SYMHARIX_MAX_REPO_DAILY_USD: envValue(env, 'SYMHARIX_MAX_REPO_DAILY_USD') || '100',
    SYMHARIX_MAX_DAILY_USD: envValue(env, 'SYMHARIX_MAX_DAILY_USD') || '250',
    SYMHARIX_COST_OVERRIDE_MINUTES: envValue(env, 'SYMHARIX_COST_OVERRIDE_MINUTES') || '60',
  };

  try {
    console.log([
      '\nSymHarix 终端配置向导',
      '所有可枚举项目优先使用数字选择，最后一项始终保留“自定义输入”。',
      '输入错误时可以重试当前项或返回阶段开头；阶段异常也不会直接终止。',
      '密钥不会显示在终端中，完成最终预检前不会写入本次输入。\n',
    ].join('\n'));

    let state: WizardState = {
      projectSlug: envValue(env, 'SYMHARIX_TRACKER_PROJECT_SLUG'),
      repository: null,
      surface: 'none',
    };
    const checkpoints = new Map<number, WizardCheckpoint>();
    const snapshot = (): WizardCheckpoint => ({
      updates: { ...updates },
      state: cloneWizardState(state),
    });
    checkpoints.set(0, snapshot());

    const stages = [
      {
        label: '连接 Linear 和 GitHub',
        run: async () => {
          const connection = await configureConnections(prompter, env, updates);
          state = { ...state, ...connection };
        },
      },
      {
        label: '配置模型',
        run: async () => configureModels(prompter, env, updates),
      },
      {
        label: '配置聊天入口',
        run: async () => {
          state.surface = await configureSurfaces(prompter, env, updates);
        },
      },
    ];
    let stepIndex = 0;

    while (true) {
      while (stepIndex < stages.length) {
        const checkpoint = checkpoints.get(stepIndex) ?? snapshot();
        restoreUpdates(updates, checkpoint.updates);
        state = cloneWizardState(checkpoint.state);
        try {
          await stages[stepIndex]!.run();
          stepIndex += 1;
          checkpoints.set(stepIndex, snapshot());
        } catch (error) {
          if (error instanceof RestartWizardStepError) {
            console.log(`\n  ↩ 已返回“${stages[stepIndex]!.label}”阶段开头，本阶段输入尚未写入。`);
            continue;
          }
          const action = await chooseWizardStepRecovery(
            prompter,
            stages[stepIndex]!.label,
            error,
            stepIndex > 0,
          );
          if (action === 'retry') continue;
          if (action === 'back') {
            stepIndex -= 1;
            continue;
          }
          console.log('\n配置已取消；本轮输入未写入 .env 或 WORKFLOW.md。');
          return;
        }
      }

      const mergedEnv = { ...env, ...updates };
      const formatErrors = validateConfigurationFormats(mergedEnv)
        .filter((issue) => issue.severity === 'error');
      if (formatErrors.length === 0 && state.projectSlug && state.repository) break;

      console.log('\n  ✗ 最终格式预检未通过，本轮配置尚未写入：');
      for (const error of formatErrors) console.log(`    - ${error.message}`);
      if (!state.projectSlug) console.log('    - 缺少 Linear project slug。');
      if (!state.repository) console.log('    - 缺少 GitHub owner/repo。');
      const target = await prompter.askChoice<'connections' | 'models' | 'surfaces' | 'cancel'>(
        '返回哪个阶段修正？',
        [
          { key: '1', value: 'connections', label: '连接 Linear 和 GitHub' },
          { key: '2', value: 'models', label: '模型配置' },
          { key: '3', value: 'surfaces', label: 'Telegram / 飞书入口' },
          { key: '4', value: 'cancel', label: '取消配置（不写入本次输入）' },
        ],
      );
      if (target === 'cancel') {
        console.log('\n配置已取消；本轮输入未写入 .env 或 WORKFLOW.md。');
        return;
      }
      stepIndex = target === 'connections' ? 0 : target === 'models' ? 1 : 2;
    }

    const repository = state.repository!;
    const projectSlug = state.projectSlug;
    const surface = state.surface;

    const workflowContent = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    fs.writeFileSync(WORKFLOW_PATH, upsertWorkflowRoute(workflowContent, {
      projectSlug,
      githubOwner: repository.owner,
      githubRepo: repository.repo,
    }));
    const envContent = fs.readFileSync(ENV_PATH, 'utf8');
    fs.writeFileSync(ENV_PATH, upsertEnvAssignments(envContent, updates), { mode: 0o600 });
    // `copyFileSync` preserves the public example file's permissions. Tighten
    // them after the first secrets are written on POSIX systems.
    try {
      fs.chmodSync(ENV_PATH, 0o600);
    } catch {
      // Windows and restricted filesystems do not always expose POSIX modes.
    }

    console.log('\n4/4 本地文件已写好（.env 不会被 Git 提交）。');
    console.log('正在安装并校验仓库锁定的 OpenCode 版本...');
    const runtimeInstall = spawnSync(process.execPath, [path.join(applicationRoot, 'scripts', 'opencode-runtime.cjs'), 'install'], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });
    if (runtimeInstall.error || runtimeInstall.status !== 0) {
      console.log('  ! OpenCode 自动安装未完成；联网后运行 bun run runtime:install 重试。');
    }
    const writtenEnv = readEnvFile();
    printReadiness(writtenEnv);
    await printDoctor(writtenEnv);
    console.log('\n下一步：');
    if (surface === 'telegram' || surface === 'both') {
      console.log('  1. Telegram：如未设置固定 HTTPS URL，请安装 cloudflared；然后运行 bun run start:telegram。');
    }
    if (surface === 'feishu' || surface === 'both') {
      console.log('  2. 飞书开放平台：使用「长连接」订阅 im.message.receive_v1 和 card.action.trigger，申请权限并发布应用；然后运行 bun run start:feishu。');
    }
    if (surface === 'none') {
      console.log('  1. 运行 bun run start:telegram 或 bun run start:feishu 前，可再次执行 bun run configure 配置聊天入口。');
    }
    console.log('  3. 运行 bun run configure:check 做离线格式检查；bun run configure:doctor 重新验证外部凭据。');
    console.log('  4. 准备产生一次极少量模型费用时，运行 bun run runtime:smoke 验证完整 OpenCode 调用链。');
  } finally {
    prompter.close();
  }
}

function printUsage(): void {
  console.log(`
SymHarix terminal setup

Usage:
  bun run configure                    Open setup/configuration management
  bun run configure -- models          Change only model settings
  bun run configure -- telegram        Change or disable Telegram
  bun run configure -- feishu          Change or disable Feishu
  bun run configure -- budget          Change budgets and model pricing
  bun run configure -- security        Rotate Runtime security settings
  bun run configure -- connections     Change Linear/GitHub routing
  bun run configure -- all             Run the complete wizard again
  bun run configure:guide   Explain how to obtain every key/token
  bun run configure:secure  Generate only missing local Runtime secrets
  bun run configure:check   Offline field, format, and route validation
  bun run configure:doctor  Read-only live validation of external credentials

The wizard stores secrets only in .env, creates/updates the selected
Linear-project-to-GitHub route in WORKFLOW.md, and never prints secret values.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  if (args.includes('--guide')) {
    printSetupGuide();
    return;
  }
  if (args.includes('--secure')) {
    const generated = ensureRuntimeSecurityConfig();
    console.log(generated.length > 0
      ? `\n已补齐 ${generated.join('、')}；值已安全写入 .env，未在终端显示。`
      : '\nRuntime 安全密钥已经齐全；未修改现有值。');
    printReadiness();
    return;
  }
  if (args.includes('--check')) {
    ensureLocalConfigFiles();
    const valid = printReadiness();
    if (!valid) {
      process.exitCode = 1;
    }
    return;
  }
  if (args.includes('--doctor')) {
    ensureLocalConfigFiles();
    const staticValid = printReadiness();
    const liveValid = await printDoctor();
    if (!staticValid || !liveValid) {
      process.exitCode = 1;
    }
    return;
  }
  const positional = args.find((arg) => !arg.startsWith('-'));
  const action = parseConfigurationAction(positional);
  if (positional && !action) {
    throw new Error(`未知配置分类：${positional}。可用值：connections、models、telegram、feishu、budget、security、status、doctor、all。`);
  }
  if (action === 'status') {
    ensureLocalConfigFiles();
    if (!printReadiness()) process.exitCode = 1;
    return;
  }
  if (action === 'doctor') {
    ensureLocalConfigFiles();
    const staticValid = printReadiness();
    const liveValid = await printDoctor();
    if (!staticValid || !liveValid) process.exitCode = 1;
    return;
  }
  if (action === 'guide') {
    printSetupGuide();
    return;
  }
  if (action === 'exit') return;
  if (!process.stdin.isTTY) {
    throw new Error('配置修改需要交互式终端。请在终端执行：bun run configure');
  }
  if (action === 'all') {
    await runWizard();
    return;
  }
  if (action && ['connections', 'models', 'telegram', 'feishu', 'budget', 'security'].includes(action)) {
    const prompter = new TerminalPrompter();
    try {
      await runConfigurationSection(action as ConfigurationSection, prompter);
    } finally {
      prompter.close();
    }
    return;
  }

  ensureLocalConfigFiles();
  if (hasExistingConfiguration(readEnvFile())) {
    const runFullWizard = await runConfigurationManager();
    if (runFullWizard) await runWizard();
    return;
  }
  await runWizard();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\n配置未完成：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
