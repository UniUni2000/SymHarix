import { describe, expect, test } from 'bun:test';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  collectVerifiedGitHubCredential,
  ensureRuntimeSecurityConfig,
  formatExistingSecretPreview,
  getBudgetPreset,
  getBotModelChoices,
  getBotModelProviderDefaults,
  getCodeModelChoices,
  getSetupReadiness,
  hasExistingConfiguration,
  parseConfigurationAction,
  resolveRecoverableInput,
  resolveManagedSecret,
  upsertEnvAssignments,
  upsertWorkflowRoute,
} from './configure';

describe('terminal configuration', () => {
  test('routes convenient configuration aliases to one selective section', () => {
    expect(parseConfigurationAction('model')).toBe('models');
    expect(parseConfigurationAction('cost')).toBe('budget');
    expect(parseConfigurationAction('tg')).toBe('telegram');
    expect(parseConfigurationAction('lark')).toBe('feishu');
    expect(parseConfigurationAction('unknown')).toBeNull();
  });

  test('opens configuration management only after meaningful setup exists', () => {
    expect(hasExistingConfiguration({
      SYMHARIX_RUNTIME_SESSION_TTL_MINUTES: '15',
      SYMHARIX_TRACKER_PROJECT_SLUG: 'sample-project',
    })).toBe(false);
    expect(hasExistingConfiguration({
      SYMHARIX_OPENCODE_MODEL: 'deepseek/deepseek-v4-pro',
    })).toBe(true);
  });

  test('provides bounded budget presets instead of requiring ten manual values', () => {
    expect(getBudgetPreset('conservative')).toMatchObject({
      SYMHARIX_MAX_TURN_OUTPUT_TOKENS: '8000',
      SYMHARIX_TURN_RESERVE_TOKENS: '100000',
      SYMHARIX_MAX_TASK_USD: '10',
    });
    expect(getBudgetPreset('standard')).toMatchObject({
      SYMHARIX_MAX_TURN_OUTPUT_TOKENS: '16000',
      SYMHARIX_TURN_RESERVE_TOKENS: '200000',
      SYMHARIX_MAX_TASK_USD: '25',
    });
    expect(getBudgetPreset('generous')).toMatchObject({
      SYMHARIX_MAX_TURN_OUTPUT_TOKENS: '32000',
      SYMHARIX_TURN_RESERVE_TOKENS: '400000',
      SYMHARIX_MAX_TASK_USD: '50',
    });
  });

  test('provides a first-class DeepSeek chat preset with the official endpoint', () => {
    expect(getBotModelProviderDefaults('deepseek')).toEqual({
      runtimeProvider: 'openai',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
    });
  });

  test('re-prompts locally malformed GitHub tokens before making a network request', async () => {
    const secrets = ['short', `gho_${'a'.repeat(36)}`];
    const messages: string[] = [];
    let probes = 0;
    const result = await collectVerifiedGitHubCredential({
      async askManagedSecret() {
        return { value: secrets.shift()!, shouldWrite: true };
      },
      async askChoice<T extends string>() {
        return 'retry' as T;
      },
    }, '', { owner: 'acme', repo: 'web-app' }, {
      write: (message) => messages.push(message),
      probe: async () => {
        probes += 1;
        return { label: 'GitHub', status: 'pass', detail: '仓库可访问且可写。' };
      },
    });

    expect(probes).toBe(1);
    expect(result.verified).toBe(true);
    expect(messages.join('\n')).toContain('GitHub token 格式未通过');
    expect(messages.join('\n')).not.toContain(result.value);
  });

  test('retries a malformed local input instead of terminating the wizard', async () => {
    const values = ['bad', 'good'];
    const messages: string[] = [];
    const result = await resolveRecoverableInput(
      async () => values.shift()!,
      (value) => {
        if (value !== 'good') throw new Error('示例格式错误');
        return value;
      },
      async () => 'retry',
      (message) => messages.push(message),
    );

    expect(result).toBe('good');
    expect(messages).toEqual(['  ✗ 输入未通过：示例格式错误']);
  });

  test('can return from a malformed input to the current stage start', async () => {
    await expect(resolveRecoverableInput(
      async () => 'bad',
      () => { throw new Error('示例格式错误'); },
      async () => 'restart-step',
      () => undefined,
    )).rejects.toThrow('返回本阶段开头');
  });

  test('offers numbered DeepSeek code and chat model presets before custom input', () => {
    expect(getCodeModelChoices('deepseek').map((choice) => choice.value)).toEqual([
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash',
    ]);
    expect(getBotModelChoices('deepseek').map((choice) => choice.value)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
  });

  test('requires an explicit choice after live GitHub verification fails', async () => {
    const first = `ghp_${'a'.repeat(36)}`;
    const replacement = `github_pat_${'b'.repeat(36)}`;
    const secrets = [first, replacement];
    const actions = ['reenter'];
    const probed: string[] = [];
    const result = await collectVerifiedGitHubCredential({
      async askManagedSecret() {
        return { value: secrets.shift()!, shouldWrite: true };
      },
      async askChoice<T extends string>() {
        return actions.shift() as T;
      },
    }, '', { owner: 'acme', repo: 'web-app' }, {
      write: () => undefined,
      probe: async ({ token }) => {
        probed.push(token);
        return token === replacement
          ? { label: 'GitHub', status: 'pass', detail: '仓库可访问且可写。' }
          : { label: 'GitHub', status: 'fail', detail: 'HTTP 401；token 无效。' };
      },
    });

    expect(probed).toEqual([first, replacement]);
    expect(result).toEqual({ value: replacement, shouldWrite: true, verified: true });
  });

  test('can continue with an unverified GitHub token only through the offline choice', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const result = await collectVerifiedGitHubCredential({
      async askManagedSecret() {
        return { value: token, shouldWrite: true };
      },
      async askChoice<T extends string>() {
        return 'continue-offline' as T;
      },
    }, '', { owner: 'acme', repo: 'web-app' }, {
      write: () => undefined,
      probe: async () => ({ label: 'GitHub', status: 'fail', detail: '连接失败。' }),
    });

    expect(result).toEqual({ value: token, shouldWrite: true, verified: false });
  });

  test('shows only a masked preview of an existing secret', () => {
    const secret = 'github_pat_example-secret-789';
    const preview = formatExistingSecretPreview('GitHub token', secret);

    expect(preview).toContain('GitHub token 当前已配置');
    expect(preview).toContain('git••••789');
    expect(preview).not.toContain(secret);
  });

  test('keeps an existing secret without reading a replacement or requesting a write', async () => {
    let replacementReads = 0;
    const result = await resolveManagedSecret(
      'existing-secret',
      async () => 'keep',
      async () => {
        replacementReads += 1;
        return 'replacement-secret';
      },
    );

    expect(result).toEqual({ value: 'existing-secret', shouldWrite: false });
    expect(replacementReads).toBe(0);
  });

  test('reads and writes a replacement only after an explicit replace choice', async () => {
    const result = await resolveManagedSecret(
      'existing-secret',
      async () => 'replace',
      async () => 'replacement-secret',
    );

    expect(result).toEqual({ value: 'replacement-secret', shouldWrite: true });
  });

  test('asks for a new secret directly when no current value exists', async () => {
    let choices = 0;
    const result = await resolveManagedSecret(
      '',
      async () => {
        choices += 1;
        return 'keep';
      },
      async () => 'new-secret',
    );

    expect(result).toEqual({ value: 'new-secret', shouldWrite: true });
    expect(choices).toBe(0);
  });

  test('upserts env values while preserving comments and quotes values safely', () => {
    const updated = upsertEnvAssignments(
      '# local settings\nSYMHARIX_TRACKER_API_KEY=old\nOTHER=value\n',
      {
        SYMHARIX_TRACKER_API_KEY: 'new key #1',
        GITHUB_TOKEN: 'ghp_example',
      },
    );

    expect(updated).toContain('# local settings');
    expect(updated).toContain('OTHER=value');
    expect(dotenv.parse(updated).SYMHARIX_TRACKER_API_KEY).toBe('new key #1');
    expect(dotenv.parse(updated).GITHUB_TOKEN).toBe('ghp_example');
  });

  test('adds the selected routing entry without removing existing routes', () => {
    const workflow = `---\ntracker:\n  kind: linear\n  api_key: $OLD_KEY\nrepositories:\n  routing:\n    legacy:\n      github_owner: old\n      github_repo: repo\n---\n\nAgent prompt\n`;
    const updated = upsertWorkflowRoute(workflow, {
      projectSlug: 'my-project',
      githubOwner: 'acme',
      githubRepo: 'web-app',
    });

    expect(updated).toContain('my-project:');
    expect(updated).toContain('github_owner: acme');
    expect(updated).toContain('legacy:');
    expect(updated).toContain('api_key: $SYMHARIX_TRACKER_API_KEY');
    expect(updated).toContain('Agent prompt');
  });

  test('reports incomplete GitHub routing without exposing configured secrets', () => {
    const readiness = getSetupReadiness({
      SYMHARIX_TRACKER_API_KEY: 'linear-key',
      SYMHARIX_TRACKER_PROJECT_SLUG: 'project-a',
      GITHUB_TOKEN: 'github-token',
      SYMHARIX_OPENCODE_MODEL: 'deepseek/deepseek-chat',
      SYMHARIX_OPENCODE_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'deepseek-key',
      SYMHARIX_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMHARIX_TELEGRAM_WEBHOOK_SECRET: 'secret',
      SYMHARIX_TELEGRAM_OPERATOR_IDS: '9',
      SYMHARIX_RUNTIME_WRITE_TOKEN: 'runtime-secret',
      SYMHARIX_RUNTIME_VIEWER_TOKEN: 'viewer-secret',
      SYMHARIX_RUNTIME_SESSION_SECRET: 'session-secret',
    }, '/does-not-exist');

    expect(readiness.find((item) => item.label === '代码运行时')?.ready).toBe(true);
    expect(readiness.find((item) => item.label === 'Telegram')?.ready).toBe(true);
    expect(readiness.find((item) => item.label === 'GitHub')?.ready).toBe(false);
  });

  test('marks Runtime and enabled chat writes unsafe without explicit credentials', () => {
    const readiness = getSetupReadiness({
      SYMHARIX_TELEGRAM_BOT_TOKEN: 'telegram-token',
      SYMHARIX_TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      SYMHARIX_FEISHU_APP_ID: 'cli_app',
      SYMHARIX_FEISHU_APP_SECRET: 'app-secret',
    }, '/does-not-exist');

    expect(readiness.find((item) => item.label === '控制面安全')?.ready).toBe(false);
    expect(readiness.find((item) => item.label === 'Telegram')?.ready).toBe(false);
    expect(readiness.find((item) => item.label === '飞书')?.ready).toBe(false);
  });

  test('surfaces malformed tokens and IDs as a blocking offline format check', () => {
    const readiness = getSetupReadiness({
      GITHUB_TOKEN: 'copied only halfway',
      SYMHARIX_TELEGRAM_BOT_TOKEN: 'not-from-botfather',
      SYMHARIX_TELEGRAM_OPERATOR_IDS: '@username',
      SYMHARIX_RUNTIME_WRITE_TOKEN: 'same-secret-that-is-long-enough-123456',
      SYMHARIX_RUNTIME_VIEWER_TOKEN: 'same-secret-that-is-long-enough-123456',
      SYMHARIX_RUNTIME_SESSION_SECRET: 'same-secret-that-is-long-enough-123456',
    }, '/does-not-exist');

    expect(readiness.find((item) => item.label === '格式预检')?.ready).toBe(false);
    expect(readiness.find((item) => item.label === '格式预检')?.detail).not.toContain('same-secret');
  });

  test('generates only missing local Runtime secrets and never rotates existing values', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symharix-configure-test-'));
    const envPath = path.join(tempRoot, '.env');
    const examplePath = path.join(tempRoot, '.env.example');
    const existingOperator = 'operator-secret-that-must-not-change-123456';
    fs.writeFileSync(examplePath, '# example\n');
    fs.writeFileSync(envPath, `SYMHARIX_RUNTIME_WRITE_TOKEN=${existingOperator}\n`);

    try {
      const generated = ensureRuntimeSecurityConfig(envPath, examplePath);
      const first = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
      expect(generated).toEqual([
        'SYMHARIX_RUNTIME_VIEWER_TOKEN',
        'SYMHARIX_RUNTIME_SESSION_SECRET',
        'SYMHARIX_RUNTIME_SESSION_TTL_MINUTES',
      ]);
      expect(first.SYMHARIX_RUNTIME_WRITE_TOKEN).toBe(existingOperator);
      expect(first.SYMHARIX_RUNTIME_VIEWER_TOKEN).toHaveLength(43);
      expect(first.SYMHARIX_RUNTIME_SESSION_SECRET).toHaveLength(43);
      expect(first.SYMHARIX_RUNTIME_SESSION_TTL_MINUTES).toBe('15');

      expect(ensureRuntimeSecurityConfig(envPath, examplePath)).toEqual([]);
      expect(dotenv.parse(fs.readFileSync(envPath, 'utf8'))).toEqual(first);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
