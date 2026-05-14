import { describe, expect, it } from 'bun:test';
import {
  deleteSymHarixEnv,
  readSymHarixEnv,
  readSymHarixEnvTrimmed,
  setSymHarixEnv,
  syncSymHarixEnvAliases,
  symHarixEnvName,
} from './env';

describe('SymHarix environment aliases', () => {
  it('maps legacy SYMPHONY names to current SYMHARIX names', () => {
    expect(symHarixEnvName('SYMPHONY_PUBLIC_BASE_URL')).toBe('SYMHARIX_PUBLIC_BASE_URL');
  });

  it('prefers SYMHARIX values over legacy SYMPHONY values', () => {
    const env = {
      SYMHARIX_TRACKER_API_KEY: 'new-key',
      SYMPHONY_TRACKER_API_KEY: 'old-key',
    };

    expect(readSymHarixEnv('SYMPHONY_TRACKER_API_KEY', env)).toBe('new-key');
  });

  it('falls back to legacy SYMPHONY values', () => {
    const env = {
      SYMPHONY_TRACKER_API_KEY: 'old-key',
    };

    expect(readSymHarixEnv('SYMPHONY_TRACKER_API_KEY', env)).toBe('old-key');
  });

  it('treats blank current values as missing', () => {
    const env = {
      SYMHARIX_TRACKER_API_KEY: '  ',
      SYMPHONY_TRACKER_API_KEY: 'old-key',
    };

    expect(readSymHarixEnvTrimmed('SYMPHONY_TRACKER_API_KEY', env)).toBe('old-key');
  });

  it('syncs current aliases into legacy names for downstream compatibility', () => {
    const env = {
      SYMHARIX_PUBLIC_BASE_URL: 'https://bot.example.test',
      SYMPHONY_PUBLIC_BASE_URL: 'https://old.example.test',
    };

    syncSymHarixEnvAliases(env);

    expect(env.SYMPHONY_PUBLIC_BASE_URL).toBe('https://bot.example.test');
  });

  it('sets and deletes both current and legacy names', () => {
    const env: Record<string, string | undefined> = {};

    setSymHarixEnv('SYMPHONY_PUBLIC_BASE_URL', 'https://bot.example.test', env);
    expect(env.SYMHARIX_PUBLIC_BASE_URL).toBe('https://bot.example.test');
    expect(env.SYMPHONY_PUBLIC_BASE_URL).toBe('https://bot.example.test');

    deleteSymHarixEnv('SYMPHONY_PUBLIC_BASE_URL', env);
    expect(env.SYMHARIX_PUBLIC_BASE_URL).toBeUndefined();
    expect(env.SYMPHONY_PUBLIC_BASE_URL).toBeUndefined();
  });
});
