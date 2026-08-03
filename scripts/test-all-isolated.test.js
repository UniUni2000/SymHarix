const { describe, expect, test } = require('bun:test');
const path = require('path');
const {
  buildTestEnvironment,
  collectTestFiles,
  readCount,
} = require('./test-all-isolated.cjs');

describe('isolated test runner', () => {
  test('finds project test files without scanning ignored runtime trees', () => {
    const files = collectTestFiles(path.resolve(__dirname, '..'));
    expect(files).toContain('scripts/test-all-isolated.test.js');
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
    expect(files.some((file) => file.includes('.runtime-cache'))).toBe(false);
  });

  test('reads the final Bun test counts', () => {
    expect(readCount('1 pass\n2 pass\n0 fail\n', 'pass')).toBe(2);
    expect(readCount('1 skip\n', 'skip')).toBe(1);
  });

  test('keeps process basics while stripping provider and bot secrets', () => {
    expect(buildTestEnvironment({
      PATH: '/bin',
      HOME: '/tmp/home',
      DEEPSEEK_API_KEY: 'secret',
      SYMHARIX_TELEGRAM_BOT_TOKEN: 'secret',
    })).toEqual({
      NODE_ENV: 'test',
      PATH: '/bin',
      HOME: '/tmp/home',
    });
  });
});
