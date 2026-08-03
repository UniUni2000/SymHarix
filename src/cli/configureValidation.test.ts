import { describe, expect, test } from 'bun:test';
import {
  validateConfigurationField,
  validateConfigurationFormats,
} from './configureValidation';

describe('configuration format validation', () => {
  test('accepts well-formed keys, IDs, model names, URLs, and distinct Runtime secrets', () => {
    const issues = validateConfigurationFormats({
      SYMHARIX_TRACKER_API_KEY: `lin_api_${'a'.repeat(32)}`,
      GITHUB_TOKEN: `github_pat_${'b'.repeat(32)}`,
      DEEPSEEK_API_KEY: `sk-${'c'.repeat(32)}`,
      SYMHARIX_OPENCODE_MODEL: 'deepseek/deepseek-chat',
      SYMHARIX_BOT_LLM_MODEL: 'deepseek-v4-flash',
      SYMHARIX_OPENCODE_BASE_URL: 'https://api.deepseek.com',
      SYMHARIX_RUNTIME_WRITE_TOKEN: 'w'.repeat(40),
      SYMHARIX_RUNTIME_VIEWER_TOKEN: 'v'.repeat(40),
      SYMHARIX_RUNTIME_SESSION_SECRET: 's'.repeat(40),
      SYMHARIX_RUNTIME_SESSION_TTL_MINUTES: '15',
      SYMHARIX_TELEGRAM_BOT_TOKEN: `123456789:${'A'.repeat(30)}`,
      SYMHARIX_TELEGRAM_WEBHOOK_SECRET: 'h'.repeat(40),
      SYMHARIX_TELEGRAM_OPERATOR_IDS: '123, 456',
      SYMHARIX_FEISHU_APP_ID: 'cli_abcdef123456',
      SYMHARIX_FEISHU_APP_SECRET: 'f'.repeat(32),
      SYMHARIX_FEISHU_OPERATOR_IDS: 'ou_abc123,ou_def456',
      SYMHARIX_PUBLIC_BASE_URL: 'https://runtime.example.com',
    });

    expect(issues.filter((item) => item.severity === 'error')).toEqual([]);
  });

  test('blocks truncated secrets, malformed platform IDs, unsafe URLs, and privilege collisions', () => {
    const issues = validateConfigurationFormats({
      GITHUB_TOKEN: 'short token',
      SYMHARIX_RUNTIME_WRITE_TOKEN: 'x'.repeat(40),
      SYMHARIX_RUNTIME_VIEWER_TOKEN: 'x'.repeat(40),
      SYMHARIX_RUNTIME_SESSION_SECRET: 'x'.repeat(40),
      SYMHARIX_RUNTIME_SESSION_TTL_MINUTES: '0',
      SYMHARIX_TELEGRAM_BOT_TOKEN: 'not-a-bot-token',
      SYMHARIX_TELEGRAM_OPERATOR_IDS: 'user-name',
      SYMHARIX_FEISHU_APP_ID: 'app_123',
      SYMHARIX_FEISHU_OPERATOR_IDS: '12345',
      SYMHARIX_PUBLIC_BASE_URL: 'http://runtime.example.com',
    });
    const fields = issues.filter((item) => item.severity === 'error').map((item) => item.field);

    expect(fields).toContain('GITHUB_TOKEN');
    expect(fields).toContain('SYMHARIX_TELEGRAM_BOT_TOKEN');
    expect(fields).toContain('SYMHARIX_TELEGRAM_OPERATOR_IDS');
    expect(fields).toContain('SYMHARIX_FEISHU_APP_ID');
    expect(fields).toContain('SYMHARIX_FEISHU_OPERATOR_IDS');
    expect(fields).toContain('SYMHARIX_PUBLIC_BASE_URL');
    expect(fields).toContain('SYMHARIX_RUNTIME_VIEWER_TOKEN');
    expect(fields).toContain('SYMHARIX_RUNTIME_SESSION_SECRET');
    expect(fields).toContain('SYMHARIX_RUNTIME_SESSION_TTL_MINUTES');
  });

  test('warns instead of rejecting an unfamiliar future provider key prefix', () => {
    const issues = validateConfigurationField('OPENAI_API_KEY', `future_${'a'.repeat(32)}`);

    expect(issues.some((item) => item.severity === 'error')).toBe(false);
    expect(issues.some((item) => item.severity === 'warning')).toBe(true);
  });

  test('accepts GitHub CLI OAuth and GitHub App access-token prefixes', () => {
    for (const prefix of ['gho_', 'ghu_', 'ghs_']) {
      expect(validateConfigurationField('GITHUB_TOKEN', `${prefix}${'a'.repeat(36)}`)).toEqual([]);
    }
  });

  test('allows HTTP only for loopback-compatible Base URLs', () => {
    expect(validateConfigurationField('SYMHARIX_OPENCODE_BASE_URL', 'http://127.0.0.1:11434/v1')).toEqual([]);
    expect(validateConfigurationField('SYMHARIX_OPENCODE_BASE_URL', 'http://models.example.com/v1')[0]?.severity).toBe('error');
  });

  test('validates numeric budgets and provider/model consistency', () => {
    const issues = validateConfigurationFormats({
      SYMHARIX_OPENCODE_MODEL: 'deepseek/deepseek-chat',
      SYMHARIX_OPENCODE_PROVIDER: 'openai',
      SYMHARIX_MAX_TURN_STEPS: '1.5',
      SYMHARIX_MAX_TASK_USD: '-2',
      SYMHARIX_COST_INPUT_USD_PER_MILLION: '1',
    });

    expect(issues.find((item) => item.field === 'SYMHARIX_OPENCODE_PROVIDER')?.severity).toBe('error');
    expect(issues.find((item) => item.field === 'SYMHARIX_MAX_TURN_STEPS')?.severity).toBe('error');
    expect(issues.find((item) => item.field === 'SYMHARIX_MAX_TASK_USD')?.severity).toBe('error');
    expect(issues.some((item) => item.message.includes('美元护栏'))).toBe(true);
  });

  test('blocks whitespace and shell-like punctuation in custom chat model names', () => {
    expect(validateConfigurationField('SYMHARIX_BOT_LLM_MODEL', 'deepseek v4')[0]?.severity).toBe('error');
    expect(validateConfigurationField('SYMHARIX_BOT_LLM_MODEL', 'model;echo')[0]?.severity).toBe('error');
    expect(validateConfigurationField('SYMHARIX_BOT_LLM_MODEL', 'vendor/model:v4')).toEqual([]);
  });

  test('fails closed when Telegram is enabled without a strong webhook secret', () => {
    const missing = validateConfigurationFormats({
      SYMHARIX_TELEGRAM_BOT_TOKEN: `123456789:${'A'.repeat(30)}`,
    });
    expect(missing.find((item) => item.field === 'SYMHARIX_TELEGRAM_WEBHOOK_SECRET')?.severity).toBe('error');

    const unsafe = validateConfigurationField(
      'SYMHARIX_TELEGRAM_WEBHOOK_SECRET',
      `${'a'.repeat(32)}!`,
    );
    expect(unsafe.find((item) => item.severity === 'error')?.message).toContain('只能包含');

    const oversized = validateConfigurationField(
      'SYMHARIX_TELEGRAM_WEBHOOK_SECRET',
      'a'.repeat(257),
    );
    expect(oversized.find((item) => item.severity === 'error')?.message).toContain('256');
  });
});
